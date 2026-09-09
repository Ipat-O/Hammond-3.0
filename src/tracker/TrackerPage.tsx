import { useEffect, useMemo, useRef, useState } from 'react';

import {
  assertNoParentCycle,
  getTaskAncestorIds,
  getTaskSubtreeIds,
  TASK_STATUSES,
  TaskRevisionConflictError,
  type Database,
} from '../data';
import type { HarnessClassification, InjectionPreview } from '../harness/types';
import { InstructionStudio } from '../instructions/InstructionStudio';
import type { InstructionStudioHandle } from '../instructions/InstructionStudio';
import { INSTRUCTION_ROLES } from '../instructions/types';
import type { ActiveVersionIds, InstructionRole, ProviderFamily } from '../instructions/types';
import { useFocusTrap } from '../instructions/useFocusTrap';
import { AgentAccessPanel } from '../agentAccess/AgentAccessPanel';
import {
  subscribeAgentWriteNotifications,
  type AgentWriteNotification,
} from '../agentAccess/writeNotifications';
import { DirectoryContextPanel } from '../settings/DirectoryContextPanel';
import { labelFromPath } from '../settings/directoryContextManager';
import type { ResumeSelectionPatch } from '../settings/directoryContextManager';
import type { DirectoryContextRecord } from '../settings/state';
import { useDirectoryContextState } from '../settings/useDirectoryContextState';
import type { TrackerServices } from './contracts';
import type { TaskStatus } from '../data';
import { TaskSaveCoordinator } from './taskSaveCoordinator';
import { createTauriWindowLifecycle, type WindowLifecycle } from './windowLifecycle';

const defaultWindowLifecycle = createTauriWindowLifecycle();

type PrimaryView = 'home' | 'workspace' | 'instructions';

type Project = Database['public']['Tables']['projects']['Row'];
type ProjectInsert = Database['public']['Tables']['projects']['Insert'];
type Task = Database['public']['Tables']['tasks']['Row'];
type TaskInsert = Database['public']['Tables']['tasks']['Insert'];
type Comment = Database['public']['Tables']['comments']['Row'];
type ActivityEvent = Database['public']['Tables']['activity']['Row'];
type TaskEvidence = Database['public']['Tables']['task_evidence']['Row'];
type TaskRetry = { kind: 'move' | 'archive'; taskId: string; status?: TaskStatus };
type Reachability = boolean | 'checking';

/**
 * Every kind of unsaved work a project/task switch can put at risk, at once — never a single
 * highest-priority pick. A dirty Studio draft, an open task edit, and an unsent comment can all be
 * true simultaneously (dirty a task in Workspace, switch to Instructions and dirty Studio there —
 * nothing about a plain screen switch discards tracker state), and the guard dialog they share
 * must represent, save, and discard ALL of them, or it silently loses whichever one it ignores
 * (Correction 4, F2a).
 */
type DirtyKind = 'studio' | 'task' | 'comment';

function dirtyKindLabel(kind: DirtyKind): string {
  switch (kind) {
    case 'task':
      return 'an unsaved task edit';
    case 'comment':
      return 'an unsent comment';
    case 'studio':
      return 'unsaved instruction edits';
  }
}

function joinDirtyLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

/** "instruction edits" alone already reads as plural ("Save them"); a lone task edit or comment
 * reads as singular ("Save it") — anything with more than one kind is always plural. */
function dirtyKindsPronoun(kinds: DirtyKind[]): 'it' | 'them' {
  if (kinds.length !== 1) return 'them';
  return kinds[0] === 'studio' ? 'them' : 'it';
}

type OpenDirectoryFlow =
  | { kind: 'ambiguous'; path: string; matches: DirectoryContextRecord[] }
  | { kind: 'unknown'; path: string; mode: 'choose' | 'create' | 'link' }
  | { kind: 'linkRetry'; path: string; projectId: string; error: string };

interface InstructionStatus {
  provider: ProviderFamily | null;
  /** The active selection's version ids, independent of any local directory — always fetchable
   * through the existing typed instructions service, even with no directory linked. */
  activeVersions: ActiveVersionIds | null;
  preview: InjectionPreview | null;
  loading: boolean;
  error: string | null;
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  merged: 'Merged',
  shipped: 'Shipped',
  cancelled: 'Cancelled',
};

const emptyProjectDraft = { name: '', description: '' };
const emptyTaskDraft = {
  title: '',
  description: '',
  status: 'backlog' as TaskStatus,
  priority: 0,
  parent_task_id: null as string | null,
};

let draftCounter = 0;
function draftId(prefix: string) {
  draftCounter += 1;
  return `draft-${prefix}-${Date.now()}-${draftCounter}`;
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The save failed. Your changes are still here.';
}

function roleLabel(role: InstructionRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function providerLabel(provider: ProviderFamily): string {
  return provider
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function classificationBadge(classification: HarnessClassification): string {
  switch (classification.kind) {
    case 'Missing':
      return 'Not set up';
    case 'ManagedValid':
      return 'Configured';
    case 'ManagedForeign':
      return 'Belongs elsewhere';
    case 'ManagedMalformed':
      return 'Needs repair';
    case 'Unmanaged':
      return 'Unmanaged file present';
  }
}

function getChildrenByParent(tasks: Task[]) {
  const childrenByParent = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.parent_task_id) continue;
    const children = childrenByParent.get(task.parent_task_id) ?? [];
    children.push(task);
    childrenByParent.set(task.parent_task_id, children);
  }
  return childrenByParent;
}

interface ProjectFormProps {
  draft: typeof emptyProjectDraft;
  saving: boolean;
  error: string | null;
  onChange: (draft: typeof emptyProjectDraft) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  isNew: boolean;
  onRetry: () => void;
}

function ProjectForm({ draft, saving, error, onChange, onSubmit, onCancel, isNew, onRetry }: ProjectFormProps) {
  return (
    <form className="editor-card" onSubmit={onSubmit}>
      <div className="editor-heading">
        <div>
          <p className="card-kicker">{isNew ? 'New project' : 'Project details'}</p>
          <h2>{isNew ? 'Start a focused workspace.' : 'Shape the project context.'}</h2>
        </div>
        <button className="icon-button" type="button" onClick={onCancel} aria-label="Close project editor">
          ×
        </button>
      </div>
      <label>
        Project name
        <input
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          placeholder="e.g. Hammond 3.0"
          maxLength={200}
          required
        />
      </label>
      <label>
        Description
        <textarea
          value={draft.description}
          onChange={(event) => onChange({ ...draft, description: event.target.value })}
          placeholder="What does this project make possible?"
          rows={4}
        />
      </label>
      {error && (
        <div className="save-error" role="alert">
          <span>{error}</span>
          <button className="button button-small" type="button" onClick={onRetry} disabled={saving}>
            Retry save
          </button>
        </div>
      )}
      <div className="form-actions">
        <button className="button button-primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : isNew ? 'Create project' : 'Save project'}
        </button>
        <button className="button button-quiet" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

interface TaskFormProps {
  draft: typeof emptyTaskDraft;
  tasks: Task[];
  taskId?: string;
  saving: boolean;
  error: string | null;
  isNew: boolean;
  onChange: (draft: typeof emptyTaskDraft) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  onRetry: () => void;
}

function TaskForm({ draft, tasks, taskId, saving, error, isNew, onChange, onSubmit, onCancel, onRetry }: TaskFormProps) {
  return (
    <form className="task-editor" onSubmit={onSubmit}>
      <div className="editor-heading">
        <div>
          <p className="card-kicker">{isNew ? 'New task' : 'Task detail'}</p>
          <h2>{isNew ? 'Add the next piece of work.' : 'Keep the work legible.'}</h2>
        </div>
        <button className="icon-button" type="button" onClick={onCancel} aria-label="Close task editor">
          ×
        </button>
      </div>
      <label>
        Task title
        <input
          value={draft.title}
          onChange={(event) => onChange({ ...draft, title: event.target.value })}
          placeholder="e.g. Build the project detail screen"
          maxLength={300}
          required
        />
      </label>
      <label>
        Description
        <textarea
          value={draft.description}
          onChange={(event) => onChange({ ...draft, description: event.target.value })}
          placeholder="Capture the intent, constraints, and next proof."
          rows={5}
        />
      </label>
      <div className="form-row">
        <label>
          Status
          <select
            value={draft.status}
            onChange={(event) => onChange({ ...draft, status: event.target.value as TaskStatus })}
          >
            {TASK_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select
            value={draft.priority}
            onChange={(event) => onChange({ ...draft, priority: Number(event.target.value) })}
          >
            <option value={0}>None</option>
            <option value={1}>Low</option>
            <option value={2}>Normal</option>
            <option value={3}>High</option>
            <option value={4}>Urgent</option>
          </select>
        </label>
      </div>
      <label>
        Parent task
        <select
          value={draft.parent_task_id ?? ''}
          onChange={(event) => onChange({ ...draft, parent_task_id: event.target.value || null })}
        >
          <option value="">No parent (top-level task)</option>
          {tasks
            .filter((task) => task.id !== taskId)
            .map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
        </select>
      </label>
      {error && (
        <div className="save-error" role="alert">
          <span>{error}</span>
          <button className="button button-small" type="button" onClick={onRetry} disabled={saving}>
            Retry save
          </button>
        </div>
      )}
      <div className="form-actions">
        <button className="button button-primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : isNew ? 'Create task' : 'Save task'}
        </button>
        <button className="button button-quiet" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

interface CommentPanelProps {
  task: Task;
  comments: Comment[];
  draft: string;
  saving: boolean;
  loading: boolean;
  error: string | null;
  onDraftChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onRetry: () => void;
}

function CommentPanel({ task, comments, draft, saving, loading, error, onDraftChange, onSubmit, onRetry }: CommentPanelProps) {
  return (
    <section className="comments-section" aria-labelledby="comments-heading">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">Task memory</p>
          <h2 id="comments-heading">Comments</h2>
        </div>
        <span className="section-count">{comments.length}</span>
      </div>
      <div className="comment-list">
        {comments.length === 0 && <p className="muted-copy">No comments yet. Leave the first useful note.</p>}
        {comments.map((comment) => (
          <article className="comment-card" key={comment.id}>
            <p>{comment.body}</p>
            <time dateTime={comment.created_at}>{displayDate(comment.created_at)}</time>
          </article>
        ))}
      </div>
      <form className="comment-form" onSubmit={onSubmit}>
        <label htmlFor={`comment-${task.id}`}>Add a comment</label>
        <textarea
          id={`comment-${task.id}`}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="What should the next person know?"
          rows={3}
          required
        />
        {error && (
          <div className="save-error" role="alert">
            <span>{error}</span>
            <button className="button button-small" type="button" onClick={onRetry} disabled={saving}>
              Retry save
            </button>
          </div>
        )}
        <button className="button button-secondary" type="submit" disabled={saving || loading}>
          {saving ? 'Saving…' : loading ? 'Loading comments…' : 'Add comment'}
        </button>
      </form>
    </section>
  );
}

interface TaskOutlinerProps {
  tasks: Task[];
  selectedTaskId: string | null;
  expandedTaskIds: Set<string>;
  onToggle: (taskId: string) => void;
  onEdit: (task: Task) => void;
  onFocus: (taskId: string) => void;
  onNewChild: (taskId: string) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onArchive: (task: Task) => void;
}

function TaskOutliner({
  tasks,
  selectedTaskId,
  expandedTaskIds,
  onToggle,
  onEdit,
  onFocus,
  onNewChild,
  onMove,
  onArchive,
}: TaskOutlinerProps) {
  const childrenByParent = getChildrenByParent(tasks);
  const taskIds = new Set(tasks.map((task) => task.id));
  const roots = tasks.filter((task) => !task.parent_task_id || !taskIds.has(task.parent_task_id));

  function renderTask(task: Task): React.ReactNode {
    const children = childrenByParent.get(task.id) ?? [];
    const hasChildren = children.length > 0;
    const isExpanded = expandedTaskIds.has(task.id);
    const isArchived = Boolean(task.archived_at);
    const rowClassName = [
      'outliner-row',
      task.id === selectedTaskId ? 'outliner-row-selected' : '',
      isArchived ? 'outliner-row-archived' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <li className="outliner-item" key={task.id}>
        <div className={rowClassName}>
          {hasChildren ? (
            <button
              className="outliner-toggle"
              type="button"
              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${task.title}`}
              aria-expanded={isExpanded}
              onClick={() => onToggle(task.id)}
            >
              {isExpanded ? '⌄' : '›'}
            </button>
          ) : (
            <span className="outliner-toggle-spacer" aria-hidden="true" />
          )}
          <button className="outliner-task-button" type="button" onClick={() => onEdit(task)}>
            <span className={`outliner-task-title ${isArchived ? 'outliner-task-title-archived' : ''}`}>
              {task.title}
            </span>
            <span className={`outliner-status outliner-status-${task.status}`}>{STATUS_LABELS[task.status]}</span>
          </button>
          {hasChildren && !isExpanded && (
            <span className="child-count-badge">
              {children.length} {children.length === 1 ? 'child' : 'children'}
            </span>
          )}
          <div className="outliner-row-actions">
            <select
              className="outliner-action-status"
              aria-label={`Move ${task.title}`}
              value={task.status}
              onChange={(event) => onMove(task, event.target.value as TaskStatus)}
            >
              {TASK_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {STATUS_LABELS[option]}
                </option>
              ))}
            </select>
            <button className="outliner-action outliner-action-focus" type="button" onClick={() => onFocus(task.id)}>
              Focus
            </button>
            <button
              className="outliner-action outliner-action-child"
              type="button"
              onClick={() => onNewChild(task.id)}
              aria-label="+ child"
            >
              + child
            </button>
            {isArchived ? (
              <span className="outliner-action outliner-action-archived">Archived</span>
            ) : (
              <button
                className="outliner-action outliner-action-archive"
                type="button"
                onClick={() => onArchive(task)}
                aria-label="Archive"
              >
                Archive
              </button>
            )}
          </div>
        </div>
        {hasChildren && isExpanded && <ul className="outliner-children">{children.map((child) => renderTask(child))}</ul>}
      </li>
    );
  }

  return <ul className="task-outliner">{roots.map((task) => renderTask(task))}</ul>;
}

interface NoProjectStateProps {
  onCreateProject: () => void;
  onOpenDirectory: () => void;
  openDirectoryDisabled: boolean;
}

/**
 * The "nothing here yet" landing content, identical whether it is reached from Home or
 * Workspace — there is exactly one project-less empty state, not two subtly different ones.
 */
function NoProjectState({ onCreateProject, onOpenDirectory, openDirectoryDisabled }: NoProjectStateProps) {
  return (
    <div className="empty-state-grid">
      <section className="welcome-card">
        <div className="welcome-copy">
          <p className="card-kicker">Hammond is ready</p>
          <h2>A calm place for project context.</h2>
          <p>Create your first project, then add work that can move from backlog to shipped.</p>
          <div className="form-actions">
            <button className="button button-primary" type="button" onClick={onCreateProject}>
              Create your first project
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={onOpenDirectory}
              disabled={openDirectoryDisabled}
            >
              Open directory
            </button>
          </div>
        </div>
        <div className="welcome-orbit" aria-hidden="true">
          <span className="orbit-ring orbit-ring-large" />
          <span className="orbit-ring orbit-ring-small" />
          <span className="orbit-core">H</span>
        </div>
      </section>
      <section className="boundary-section" aria-labelledby="boundary-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Foundation map</p>
            <h2 id="boundary-heading">Clear boundaries, ready to extend.</h2>
          </div>
          <span className="section-count">03 modules</span>
        </div>
        <div className="boundary-grid">
          <article className="boundary-card">
            <span className="boundary-index">01</span>
            <h3>Local workspace</h3>
            <p>Native filesystem commands stay behind a typed command surface.</p>
          </article>
          <article className="boundary-card">
            <span className="boundary-index">02</span>
            <h3>Project memory</h3>
            <p>Owner-scoped project data stays behind the repository boundary.</p>
          </article>
          <article className="boundary-card">
            <span className="boundary-index">03</span>
            <h3>Local settings</h3>
            <p>Device-specific settings remain separate from durable records.</p>
          </article>
        </div>
      </section>
    </div>
  );
}

interface HomeDashboardProps {
  project: Project;
  activeContext: DirectoryContextRecord | null;
  activeReachable: Reachability | undefined;
  taskStatusCounts: Record<TaskStatus, number>;
  totalTaskCount: number;
  selectedTask: Task | null;
  comments: Comment[];
  commentsLoading: boolean;
  recentComments: Comment[];
  recentCommentsLoading: boolean;
  recentCommentsError: string | null;
  instructionStatuses: Record<InstructionRole, InstructionStatus> | null;
  hasDirectory: boolean;
  recentActivity: ActivityEvent[];
  recentActivityLoading: boolean;
  recentActivityError: string | null;
  recentEvidence: TaskEvidence[];
  recentEvidenceLoading: boolean;
  recentEvidenceError: string | null;
  onOpenDirectory: () => void;
  onCloseDirectory: () => void;
  onOpenWorkspace: () => void;
  onOpenTask: (taskId: string) => void;
  onOpenInstructions: (role?: InstructionRole) => void;
  onRetryInstructionStatus: (role: InstructionRole) => void;
}

function HomeDashboard({
  project,
  activeContext,
  activeReachable,
  taskStatusCounts,
  totalTaskCount,
  selectedTask,
  comments,
  commentsLoading,
  recentComments,
  recentCommentsLoading,
  recentCommentsError,
  instructionStatuses,
  hasDirectory,
  recentActivity,
  recentActivityLoading,
  recentActivityError,
  recentEvidence,
  recentEvidenceLoading,
  recentEvidenceError,
  onOpenDirectory,
  onCloseDirectory,
  onOpenWorkspace,
  onOpenTask,
  onOpenInstructions,
  onRetryInstructionStatus,
}: HomeDashboardProps) {
  return (
    <div className="home-grid">
      <section className="home-identity-card" aria-labelledby="home-identity-heading">
        <p className="eyebrow">Project home {project.archived_at && '· Archived'}</p>
        <h2 id="home-identity-heading">{project.name}</h2>
        <p className="project-description">{project.description || 'No project description yet.'}</p>
      </section>

      <section className="home-directory-section" aria-labelledby="home-directory-heading">
        <div className="section-heading compact-heading">
          <div>
            <p className="eyebrow">Local directory</p>
            <h2 id="home-directory-heading">Where this project lives on disk</h2>
          </div>
        </div>
        {activeContext ? (
          <>
            <p className="directory-context-current">
              Open: <code>{activeContext.path}</code>
              {activeReachable === false && (
                <span className="directory-context-status directory-context-status-missing">
                  {' '}
                  — missing
                </span>
              )}
            </p>
            <div className="form-actions">
              <button className="button button-secondary" type="button" onClick={onOpenDirectory}>
                Open a different directory
              </button>
              <button className="button button-quiet" type="button" onClick={onCloseDirectory}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted-copy">No directory is open for this project.</p>
            <button className="button button-secondary" type="button" onClick={onOpenDirectory}>
              Open directory
            </button>
          </>
        )}
      </section>

      <section className="home-tasks-section" aria-labelledby="home-tasks-heading">
        <div className="section-heading compact-heading">
          <div>
            <p className="eyebrow">Tasks</p>
            <h2 id="home-tasks-heading">{totalTaskCount} tracked</h2>
          </div>
          <button className="button button-secondary" type="button" onClick={onOpenWorkspace}>
            Open workspace
          </button>
        </div>
        <div className="outliner-summary" aria-label="Task status counts">
          {TASK_STATUSES.map((status) => (
            <div key={status} className="outliner-summary-item">
              <h3>{STATUS_LABELS[status]}</h3>
              <strong>{taskStatusCounts[status]}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="home-comments-section" aria-labelledby="home-comments-heading">
        <div className="section-heading compact-heading">
          <div>
            <p className="eyebrow">Comments</p>
            <h2 id="home-comments-heading">{selectedTask ? 'Selected task' : 'Recent in this project'}</h2>
          </div>
        </div>
        {selectedTask ? (
          <>
            <p className="home-selected-task-title">{selectedTask.title}</p>
            {commentsLoading ? (
              <p className="muted-copy">Loading comments…</p>
            ) : comments.length === 0 ? (
              <p className="muted-copy">No comments yet on this task.</p>
            ) : (
              <ul className="comment-list">
                {comments.slice(-3).map((comment) => (
                  <li key={comment.id} className="comment-card">
                    <p>{comment.body}</p>
                  </li>
                ))}
              </ul>
            )}
            <button className="button button-quiet" type="button" onClick={() => onOpenTask(selectedTask.id)}>
              View task
            </button>
          </>
        ) : recentCommentsLoading ? (
          <p className="muted-copy">Loading recent comments…</p>
        ) : recentCommentsError ? (
          <div className="save-error" role="alert">
            {recentCommentsError}
          </div>
        ) : recentComments.length === 0 ? (
          <p className="muted-copy">No comments yet in this project.</p>
        ) : (
          <ul className="comment-list">
            {recentComments.map((comment) => (
              <li key={comment.id} className="comment-card">
                <p>{comment.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="home-instructions-section" aria-labelledby="home-instructions-heading">
        <div className="section-heading compact-heading">
          <div>
            <p className="eyebrow">Instructions</p>
            <h2 id="home-instructions-heading">Active instruction selection</h2>
          </div>
          <button className="button button-quiet" type="button" onClick={() => onOpenInstructions()}>
            Open Instruction Studio
          </button>
        </div>
        <ul className="instruction-status-list">
          {INSTRUCTION_ROLES.map((role) => {
            const status = instructionStatuses?.[role];
            return (
              <li key={role} className="instruction-status-row">
                <span className="instruction-status-role">{roleLabel(role)}</span>
                <span className="instruction-status-provider">
                  {status?.provider ? providerLabel(status.provider) : 'Unassigned'}
                </span>
                {status?.activeVersions && (
                  <span className="instruction-status-selection">
                    {status.activeVersions.overrideVersionId
                      ? 'Project override active'
                      : 'Using shared defaults'}
                  </span>
                )}
                {!hasDirectory ? (
                  <span className="muted-copy">Link a directory to check file status</span>
                ) : status?.loading ? (
                  <span className="muted-copy">Checking…</span>
                ) : status?.error ? (
                  <>
                    <span className="instruction-status-error">{status.error}</span>
                    <button
                      className="button button-small"
                      type="button"
                      onClick={() => onRetryInstructionStatus(role)}
                    >
                      Retry
                    </button>
                  </>
                ) : status?.preview ? (
                  <>
                    <span
                      className={`instruction-status-badge instruction-status-${status.preview.classification.kind}`}
                    >
                      {classificationBadge(status.preview.classification)}
                    </span>
                    {status.preview.classification.kind === 'Missing' && (
                      <button
                        className="button button-small"
                        type="button"
                        onClick={() => onOpenInstructions(role)}
                      >
                        Set up instructions
                      </button>
                    )}
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="home-activity-section" aria-labelledby="home-activity-heading">
        <div className="section-heading compact-heading">
          <div>
            <p className="eyebrow">Recent activity</p>
            <h2 id="home-activity-heading">What happened recently</h2>
          </div>
        </div>
        {recentActivityLoading ? (
          <p className="muted-copy">Loading recent activity…</p>
        ) : recentActivityError ? (
          <div className="save-error" role="alert">
            {recentActivityError}
          </div>
        ) : recentActivity.length === 0 ? (
          <p className="muted-copy">No activity recorded yet.</p>
        ) : (
          <ul className="home-activity-list">
            {recentActivity.map((event) => (
              <li key={event.id}>
                <span>{event.event_type}</span>
                <time dateTime={event.created_at}>{displayDate(event.created_at)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="home-evidence-section" aria-labelledby="home-evidence-heading">
        <div className="section-heading compact-heading">
          <div>
            <p className="eyebrow">Evidence</p>
            <h2 id="home-evidence-heading">Recently recorded</h2>
          </div>
        </div>
        {recentEvidenceLoading ? (
          <p className="muted-copy">Loading recent evidence…</p>
        ) : recentEvidenceError ? (
          <div className="save-error" role="alert">
            {recentEvidenceError}
          </div>
        ) : recentEvidence.length === 0 ? (
          <p className="muted-copy">No evidence recorded yet.</p>
        ) : (
          <ul className="home-evidence-list">
            {recentEvidence.map((evidence) => (
              <li key={evidence.id}>
                <span className="home-evidence-kind">{evidence.kind}</span>
                <span>{evidence.summary || 'No summary provided.'}</span>
                <time dateTime={evidence.created_at}>{displayDate(evidence.created_at)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

interface TrackerPageProps {
  services: TrackerServices;
  ownerId: string;
  ownerEmail?: string;
  onSignOut: () => void;
  /** Injectable for tests; defaults to the real Tauri window-close interception. */
  windowLifecycle?: WindowLifecycle;
}

export function TrackerPage({
  services,
  ownerId,
  ownerEmail,
  onSignOut,
  windowLifecycle = defaultWindowLifecycle,
}: TrackerPageProps) {
  const repositories = services.repositories;
  const directory = useDirectoryContextState(services.directoryContext);
  const resumeAppliedRef = useRef(false);
  const pendingTaskResumeRef = useRef<{ projectId: string; taskId: string } | null>(null);
  // Set the instant the owner explicitly picks a screen (a nav click), so a still-pending device
  // resume that resolves moments later never flips the screen back out from under them. Project
  // selection needs no equivalent flag: reading `selectedProjectId` directly at resume time
  // already tells us whether an explicit pick (e.g. a sidebar project click) beat resume to it.
  const screenNavigatedRef = useRef(false);
  // Kept fresh every render so an in-flight action (task save/move/archive/comment) can tell,
  // once it resolves, whether the owner is still on the project it started against — a stale
  // completion from a project the owner has since left must never select/act under the new one.
  const selectedProjectIdRef = useRef<string | null>(null);
  // Kept fresh every render so a long-running directory-flow await (file picker, guard dialog,
  // activation) can resolve a picked path against whichever projects are ACTUALLY accessible
  // right now — never a snapshot of `projects` captured back when the flow started.
  const projectsRef = useRef<Project[]>([]);
  // Bumped every time the comment thread's owning task changes, so an in-flight `addComment` (or
  // its optimistic update) for a task the owner has since navigated away from can never land in
  // whichever task's comment list happens to be showing now.
  const commentsGenRef = useRef(0);
  // Bumped whenever the open-directory flow is dismissed/reset, so a stale async completion for a
  // flow the owner already cancelled/replaced can never apply itself late.
  const directoryFlowGenRef = useRef(0);
  // Bumped once per run of the instruction-status resolving effect below — i.e. every time the
  // project, directory root, or Home-visit trigger actually changes (including a directory
  // close/reopen, which bumps it twice: once for `null`, once for the reopened root, even when
  // that root's path is the one that was active before). A per-role retry captures this value at
  // call time and refuses to apply its result once it no longer matches, so a stale retry issued
  // against an old root can never win after a newer refresh — even an A -> B -> A sequence, where
  // comparing the root path alone would wrongly treat the stale A retry as still current.
  const instructionResolutionGenRef = useRef(0);
  // Per-role: bumped every time THAT role's own Retry is invoked, so a second retry for the same
  // role supersedes an in-flight first one without needing to wait for a full context refresh.
  const instructionRetryGenRef = useRef<Record<InstructionRole, number>>(
    Object.fromEntries(INSTRUCTION_ROLES.map((role) => [role, 0])) as Record<InstructionRole, number>,
  );
  // The last CONFIRMED-durable field values for whichever task is open in 'edit' mode, captured
  // once at open time — never derived from `tasks`/`selectedTask`, which hold an optimistic
  // (possibly still-rejected) write. `isTaskEditorDirty` compares the live draft against this, not
  // against the optimistic record, so a save rejection can never look "clean" just because the
  // optimistic row happens to match the draft that failed to persist (Correction 4, F2b). `null`
  // whenever nothing is open in 'edit' mode.
  const taskEditorBaselineRef = useRef<typeof emptyTaskDraft | null>(null);
  // Bumped every time the task editor is (re)opened, closed, or discarded — i.e. every time a NEW
  // editing context begins. A save started against one context captures this value; if it changes
  // before that save resolves (a Discard, a switch to a different task, a fresh "new task"), the
  // save's late completion must never rebase or close whatever context is open now (Correction 4,
  // F2b's "delayed success against a newer draft").
  const taskEditorGenRef = useRef(0);
  // Kept fresh every render (assigned below, once `taskDraft` itself is declared) so a delayed
  // `saveTask` completion can tell, once it resolves, whether the live draft still matches exactly
  // what it submitted — see `saveTask`'s success branch.
  const taskDraftRef = useRef(emptyTaskDraft);
  // HAM3-008 Correction 8: the ONE authoritative path for same-task save serialization AND task
  // confirmation, replacing the pair of overlapping refs Correction 7 added (`taskSaveRevisionRef`,
  // a per-task "highest ISSUED revision" watermark used only to decide which of several already
  // concurrently-dispatched responses could win; and `confirmedTasksRef`, the confirmed-row store
  // itself). Round 6 found that the watermark still excluded a genuinely successful older write
  // from confirmation whenever a newer, overlapping revision it raced against was REJECTED (a
  // rejection never releases its revision slot) — the watermark tracked issuance order, not
  // success. Rather than add another exception to that watermark, this coordinator removes the
  // race it was patching: at most one persistence request per task id (or per not-yet-created
  // task's stable local `draft-task-…` id) is ever in flight at a time, dispatched strictly FIFO,
  // so "highest issued" and "highest successful" are the same request by construction. It also
  // owns the confirmed-row store directly (`getConfirmedForKey`/`setConfirmed`/`upsertConfirmed`),
  // updated by every successful dispatch regardless of which editing context is open now, and
  // never by an optimistic or rejected write — `cancelTaskEditor` reads it for exactly the same
  // reason `confirmedTasksRef` used to (Correction 7, Finding B: abandoning a draft must reveal
  // the CURRENT confirmed value, not a baseline frozen at editor-open time). Replaced wholesale
  // (not merely cleared) on a mounted owner change, alongside cancelling every old-owner queued
  // request, so nothing owner-scoped survives the boundary (see the owner-change effect below).
  const taskSaveCoordinatorRef = useRef(new TaskSaveCoordinator<Task>());
  // Kept fresh every render (HAM3-014 F2) so the agent-write notification listener below — a
  // stable subscription registered once, not re-subscribed on every render — can read the
  // CURRENT selection/editor state when a notification arrives, instead of whatever was current
  // when the listener closure was created.
  const selectedTaskIdRef = useRef<string | null>(null);
  const taskEditorRef = useRef<'new' | 'edit' | null>(null);
  const isTaskEditorDirtyRef = useRef(false);
  // Bumped on every project switch and on unmount (see the task-list effect's cleanup) so an
  // agent-write refresh already in flight against the PREVIOUS project can never apply its result
  // after the owner has navigated away — matches `commentsGenRef`'s own pattern.
  const agentWriteRefreshGenRef = useRef(0);

  function taskDraftFieldsEqual(a: typeof emptyTaskDraft, b: typeof emptyTaskDraft): boolean {
    return (
      a.title === b.title &&
      a.description === b.description &&
      a.status === b.status &&
      a.priority === b.priority &&
      a.parent_task_id === b.parent_task_id
    );
  }

  /** Closes the task editor as an explicit end of this editing context — a genuine Cancel/Discard,
   * an archive of the open task, a project switch, or an owner change — never a mid-save rebase
   * (see `saveTask`), which must NOT bump the generation it is itself checking. */
  function closeTaskEditor() {
    taskEditorGenRef.current += 1;
    taskEditorBaselineRef.current = null;
    setTaskEditor(null);
    setExternalTaskUpdateId(null);
  }

  /** Explicit abandon of the currently open task editor — its OWN Cancel button, or Discard on
   * the unsaved-changes guard dialog — never a mid-save rebase (see `saveTask`). If the task being
   * abandoned is an 'edit' still showing a REJECTED (never-persisted) optimistic write, roll the
   * visible row back to CONFIRMED-durable content first: an explicit Cancel/Discard must make the
   * UI visibly return to confirmed content, never leave unsaved text displayed as if saved so a
   * later reopen of the same task recaptures it as a new, falsely-clean baseline (Correction 5,
   * F2b). A pending (already-dispatched) save's own optimistic row is left alone here — its
   * completion (success or failure) governs itself and may still finish durably (Invariant 5: a
   * local Cancel never pretends to roll back a request the repository has already received).
   *
   * Also drops any NOT-yet-dispatched queued save for this same task (HAM3-008 Correction 8): an
   * earlier explicit Save that is still waiting in the coordinator's FIFO queue behind another
   * in-flight request must never fire later and resurrect content the owner just discarded here.
   *
   * Rolls back to the coordinator's confirmed store — the CURRENT confirmed record — rather than
   * `taskEditorBaselineRef`'s snapshot frozen at editor-open time: a DIFFERENT save for this same
   * task (issued before this editor opened, or against an abandoned earlier generation of it) can
   * land while this draft is open, and Cancel must reveal that later confirmed result, never the
   * obsolete value this editor happened to start from (Correction 7, Finding B). `taskEditorBaselineRef`
   * itself is untouched here — it remains the point of comparison `isTaskEditorDirty` uses.
   */
  function cancelTaskEditor() {
    if (taskEditor && selectedTaskId) {
      // Scoped to 'editor' (HAM3-008 Correction 9, Finding 2): drops only this editor's own
      // not-yet-dispatched form/guard-save drafts, never an independently queued outliner move or
      // archive for the same task waiting behind them — that survives to dispatch in its own turn.
      taskSaveCoordinatorRef.current.cancelQueued(selectedTaskId, 'editor');
    }
    if (taskEditor === 'edit' && selectedTaskId) {
      const taskId = selectedTaskId;
      const confirmed = taskSaveCoordinatorRef.current.getConfirmedForKey(taskId);
      if (confirmed) {
        setTasks((current) => current.map((item) => (item.id === taskId ? confirmed : item)));
      } else {
        const baseline = taskEditorBaselineRef.current;
        if (baseline) {
          setTasks((current) => current.map((item) => (item.id === taskId ? { ...item, ...baseline } : item)));
        }
      }
    }
    closeTaskEditor();
  }
  const [resumeReady, setResumeReady] = useState(false);
  // Mirrors `pendingTaskResumeRef` as real state (rather than only a ref) so the resume-persistence
  // effect below re-fires the instant a pending task lookup concludes, even when the concluding
  // `setSelectedTaskId` call happens not to change `selectedTaskId`'s value (e.g. it resolves to
  // still-null because the saved task turned out invalid) and so would not otherwise re-render.
  const [taskResumePendingProjectId, setTaskResumePendingProjectId] = useState<string | null>(null);
  const [primaryView, setPrimaryView] = useState<PrimaryView>('home');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => new Set());
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [contentError, setContentError] = useState<string | null>(null);
  const [projectEditor, setProjectEditor] = useState<'new' | 'edit' | null>(null);
  const [projectDraft, setProjectDraft] = useState(emptyProjectDraft);
  const [projectSaving, setProjectSaving] = useState(false);
  const [projectSaveError, setProjectSaveError] = useState<string | null>(null);
  const [taskEditor, setTaskEditor] = useState<'new' | 'edit' | null>(null);
  const [taskDraft, setTaskDraft] = useState(emptyTaskDraft);
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskSaveError, setTaskSaveError] = useState<string | null>(null);
  const [taskRetry, setTaskRetry] = useState<TaskRetry | null>(null);
  // The id of a task that changed durably (an agent write, HAM3-014 F2) while its editor was open
  // AND dirty, so the refresh below deliberately left the live draft untouched rather than
  // overwriting typed content — surfaced as a banner offering to reload from the new confirmed
  // state instead of silently discarding either side. Cleared on close/save/reload.
  const [externalTaskUpdateId, setExternalTaskUpdateId] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentSaving, setCommentSaving] = useState(false);
  const [commentSaveError, setCommentSaveError] = useState<string | null>(null);
  const [retryCommentDraft, setRetryCommentDraft] = useState<string | null>(null);
  const studioRef = useRef<InstructionStudioHandle>(null);
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);
  // Every dirty kind the currently-showing guard dialog is protecting — captured ONCE, when the
  // guard fires, from the mutable dirty checks below (Correction 4, F2a). Never recomputed on
  // every render: a Save in flight can turn one kind's live "dirty" check false (or, pre-F2b,
  // wrongly so) well before the dialog itself is dismissed, and the dialog's own copy/Discard must
  // keep agreeing on the full scope it opened with regardless. A partial Save success shrinks this
  // to just the kinds still outstanding, so a retry never re-saves (and never re-discards) a kind
  // already durably saved.
  const [pendingNavKinds, setPendingNavKinds] = useState<DirtyKind[]>([]);
  const [navTransitionSaving, setNavTransitionSaving] = useState(false);
  const [navTransitionError, setNavTransitionError] = useState<string | null>(null);
  // Runs if the pending-nav dialog is explicitly cancelled rather than saved/discarded through —
  // used to reject a caller awaiting "may I proceed?" (the window-close guard below).
  const pendingNavCancelRef = useRef<(() => void) | null>(null);
  // Bumped whenever the pending nav is dismissed (Cancel, Discard, or a new nav superseding it),
  // so a Save still in flight at that moment can never execute a nav the owner already backed
  // away from once it resolves.
  const navTransitionTokenRef = useRef(0);
  const navDialogRef = useRef<HTMLDivElement>(null);

  // Directory context reachability, mirrored here (not just inside DirectoryContextPanel) so
  // Home's compact directory summary can show a "missing" state too.
  const [directoryReachability, setDirectoryReachability] = useState<Record<string, Reachability>>(
    {},
  );
  const [openDirectoryBusy, setOpenDirectoryBusy] = useState(false);
  const [openDirectoryError, setOpenDirectoryError] = useState<string | null>(null);
  const [openDirectoryFlow, setOpenDirectoryFlow] = useState<OpenDirectoryFlow | null>(null);
  const [directoryFlowProjectDraft, setDirectoryFlowProjectDraft] = useState(emptyProjectDraft);
  const [directoryFlowSaving, setDirectoryFlowSaving] = useState(false);
  const [directoryFlowError, setDirectoryFlowError] = useState<string | null>(null);

  const [recentComments, setRecentComments] = useState<Comment[]>([]);
  const [recentCommentsLoading, setRecentCommentsLoading] = useState(false);
  const [recentCommentsError, setRecentCommentsError] = useState<string | null>(null);
  const [recentActivity, setRecentActivity] = useState<ActivityEvent[]>([]);
  const [recentActivityLoading, setRecentActivityLoading] = useState(false);
  const [recentActivityError, setRecentActivityError] = useState<string | null>(null);
  const [recentEvidence, setRecentEvidence] = useState<TaskEvidence[]>([]);
  const [recentEvidenceLoading, setRecentEvidenceLoading] = useState(false);
  const [recentEvidenceError, setRecentEvidenceError] = useState<string | null>(null);
  const [instructionStatuses, setInstructionStatuses] = useState<Record<
    InstructionRole,
    InstructionStatus
  > | null>(null);
  // Bumped every time the owner arrives at Home, so its instruction-status summary refreshes to
  // reflect whatever Studio actions happened since the last visit — event-driven, never a poll.
  const [homeVisitToken, setHomeVisitToken] = useState(0);
  // The role a role-scoped "Set up instructions" action should open Instruction Studio on; reset
  // to the default once consumed so a later plain nav to Instructions isn't pinned to a stale role.
  const [pendingInstructionRole, setPendingInstructionRole] = useState<InstructionRole | undefined>(
    undefined,
  );

  function isStudioDirty(): boolean {
    return primaryView === 'instructions' && Boolean(studioRef.current?.isDirty());
  }

  /**
   * An open task edit is "dirty" when its draft differs from a saved baseline — an existing
   * task's own fields in 'edit' mode, or any non-empty field in 'new' mode — never merely
   * "an editor happens to be open," since a freshly opened, untouched editor has nothing to lose.
   *
   * 'edit' mode compares against `taskEditorBaselineRef`, NOT the optimistic `tasks`/`selectedTask`
   * record: a rejected `saveTask` leaves that optimistic row in place (Correction 4, F2b), so
   * comparing against it would make a failed-but-not-yet-abandoned edit look clean the instant the
   * write is rejected. The baseline only ever reflects a CONFIRMED-durable save.
   */
  function isTaskEditorDirty(): boolean {
    if (taskEditor === 'edit') {
      const baseline = taskEditorBaselineRef.current;
      return Boolean(baseline && !taskDraftFieldsEqual(taskDraft, baseline));
    }
    if (taskEditor === 'new') {
      return (
        taskDraft.title.trim() !== '' ||
        taskDraft.description.trim() !== '' ||
        taskDraft.parent_task_id !== emptyTaskDraft.parent_task_id
      );
    }
    return false;
  }

  function isCommentDraftDirty(): boolean {
    return commentDraft.trim() !== '';
  }

  /**
   * Every dirty kind live right now — recomputed fresh on demand, but read ONLY at the moment a
   * guard fires (see callers below); once captured into `pendingNavKinds` the dialog never
   * recomputes this reactively while it's open (Correction 4, F2a). `includeTracker` is opt-in per
   * call site because it is only ever correct where the guarded action is actually a project or
   * task switch (`applyProjectSwitch`, `openEditTask`, `openNewTask`) — a plain primary-nav screen
   * switch never discards tracker state and must not prompt for it.
   */
  function liveDirtyKinds(includeTracker: boolean): DirtyKind[] {
    const kinds: DirtyKind[] = [];
    if (isStudioDirty()) kinds.push('studio');
    if (includeTracker && isTaskEditorDirty()) kinds.push('task');
    if (includeTracker && isCommentDraftDirty()) kinds.push('comment');
    return kinds;
  }

  function guardedNav(action: () => void, onCancel?: () => void, includeTracker = false) {
    const kinds = liveDirtyKinds(includeTracker);
    if (kinds.length > 0) {
      // Busy belongs to the dialog currently open, not to whatever a previous one left behind —
      // a stale Saving state (a prior success or a cancelled-but-still-in-flight save) must never
      // carry into this new dialog and disable its Save button forever.
      setNavTransitionSaving(false);
      setNavTransitionError(null);
      navTransitionTokenRef.current += 1;
      pendingNavCancelRef.current = onCancel ?? null;
      setPendingNavKinds(kinds);
      setPendingNav(() => action);
    } else {
      action();
    }
  }

  /**
   * Promise-based sibling of `guardedNav`, sharing the exact same dirty check and dialog state:
   * resolves `true` immediately when there is nothing to guard, otherwise waits for the owner's
   * Save/Discard/Cancel and resolves whether the caller may proceed. Used by multi-step async
   * transitions (the directory-open flows) that must not mutate ANY local state — active context,
   * resume write, or filesystem target — until the guard has actually been accepted, rather than
   * guarding only a later sub-step after the mutation already happened. Never nest this with
   * `guardedNav`/`switchToProject` for the same transition — one guard checkpoint per transition.
   * Every current caller leads to `applyProjectSwitch`, so tracker-dirty is included by default.
   */
  function guardTransition(includeTracker = true): Promise<boolean> {
    const kinds = liveDirtyKinds(includeTracker);
    if (kinds.length > 0) {
      return new Promise<boolean>((resolve) => {
        setNavTransitionSaving(false);
        setNavTransitionError(null);
        navTransitionTokenRef.current += 1;
        pendingNavCancelRef.current = () => resolve(false);
        setPendingNavKinds(kinds);
        setPendingNav(() => () => resolve(true));
      });
    }
    return Promise.resolve(true);
  }

  /** Dismisses the pending-nav dialog and invalidates any in-flight Save resolution for it. */
  function dismissPendingNav() {
    navTransitionTokenRef.current += 1;
    setPendingNav(null);
    setPendingNavKinds([]);
    pendingNavCancelRef.current = null;
    // The dialog this busy flag belonged to is gone (Cancel, Discard, or a superseding Save
    // success) — clear it here rather than leaving it to the in-flight Save's `.finally()`, which
    // guards on a token this call just invalidated and would otherwise never run.
    setNavTransitionSaving(false);
  }

  function cancelPendingNav() {
    const onCancel = pendingNavCancelRef.current;
    dismissPendingNav();
    onCancel?.();
  }

  useFocusTrap(navDialogRef, pendingNav !== null, cancelPendingNav);

  // Kept fresh every render so the window-close handler below (registered once per
  // `windowLifecycle` identity, not on every render) always sees the current view.
  const primaryViewRef = useRef(primaryView);
  primaryViewRef.current = primaryView;

  // Kept fresh every render so an in-flight action started against one project can tell, once it
  // resolves, whether the owner is still on that same project (see the ref's own declaration).
  selectedProjectIdRef.current = selectedProjectId;
  projectsRef.current = projects;
  taskDraftRef.current = taskDraft;
  selectedTaskIdRef.current = selectedTaskId;
  taskEditorRef.current = taskEditor;
  isTaskEditorDirtyRef.current = isTaskEditorDirty();

  // Kept fresh every render so the resume-persistence effect below always writes against the
  // latest directory-context state without needing it as a dependency (see that effect for why).
  const directoryStateRef = useRef(directory.state);
  directoryStateRef.current = directory.state;

  // App/window-close dirty protection: reuses the same guard and dialog as an in-app primary-nav
  // switch. Not dirty (or not even in Instructions) closes immediately; dirty shows the dialog,
  // and Save/Discard/Cancel there resolve whether the close may actually proceed.
  useEffect(() => {
    return windowLifecycle.onCloseRequested(
      () =>
        new Promise<boolean>((resolve) => {
          if (primaryViewRef.current === 'instructions' && studioRef.current?.isDirty()) {
            setNavTransitionSaving(false);
            setNavTransitionError(null);
            navTransitionTokenRef.current += 1;
            pendingNavCancelRef.current = () => resolve(false);
            setPendingNavKinds(['studio']);
            setPendingNav(() => () => resolve(true));
          } else {
            resolve(true);
          }
        }),
    );
  }, [windowLifecycle]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const visibleProjects = projects.filter((project) => showArchived || !project.archived_at);
  const visibleTasks = tasks.filter((task) => showArchived || !task.archived_at);
  const taskStatusCounts = useMemo(
    () =>
      TASK_STATUSES.reduce<Record<TaskStatus, number>>(
        (counts, status) => ({ ...counts, [status]: visibleTasks.filter((task) => task.status === status).length }),
        {
          backlog: 0,
          ready: 0,
          in_progress: 0,
          blocked: 0,
          done: 0,
          merged: 0,
          shipped: 0,
          cancelled: 0,
        },
      ),
    [visibleTasks],
  );
  const focusedTask = visibleTasks.find((task) => task.id === focusedTaskId) ?? null;
  const outlinerTasks = useMemo(() => {
    if (!focusedTaskId) return visibleTasks;
    const focusedTaskIds = getTaskSubtreeIds(visibleTasks, focusedTaskId);
    return visibleTasks.filter((task) => focusedTaskIds.has(task.id));
  }, [focusedTaskId, visibleTasks]);

  // The one and only active directory for the SELECTED project — never a first-binding guess,
  // and never another project's active context. `null` whenever nothing is currently open here.
  const activeDirectoryContext =
    directory.state && selectedProject
      ? directory.manager.activeContextForProject(directory.state, selectedProject.id)
      : null;
  const activeDirectoryRoot = activeDirectoryContext?.path ?? null;
  const activeDirectoryReachable = activeDirectoryContext
    ? directoryReachability[activeDirectoryContext.id]
    : undefined;

  // Mounted account change (sign out, then a different owner signs in without a full remount of
  // this component): nothing from the previous owner's session may leak into the new one. Full
  // reset of every owner-scoped piece of state; `resumeAppliedRef` reset lets device resume
  // re-evaluate from scratch against the new owner's own projects once they load, below. Device-
  // local directory bindings/resume settings are untouched — they are not owner-specific, and the
  // resume re-evaluation itself is what keeps a stale binding from being applied to the wrong
  // owner (its saved project id simply won't exist in the new owner's freshly-fetched list).
  const previousOwnerIdRef = useRef(ownerId);
  useEffect(() => {
    if (previousOwnerIdRef.current === ownerId) return;
    previousOwnerIdRef.current = ownerId;
    // Any pending-nav guard belongs to the outgoing owner — a showing "Unsaved changes" dialog,
    // an old Save-all still in flight, or a directory flow awaiting `guardTransition`'s promise
    // for a decision nobody has answered yet. Settle that decision as cancelled (never leave its
    // promise dangling) before clearing the dialog/busy/error state itself: bumping the token
    // alone would stop a late Save-all completion from executing `pendingNav` or touching the new
    // owner's own guard (see the combined dialog's token check below), but it would never resolve
    // a caller still awaiting `guardTransition`'s answer (Correction 5, new finding).
    const previousPendingNavCancel = pendingNavCancelRef.current;
    navTransitionTokenRef.current += 1;
    pendingNavCancelRef.current = null;
    setPendingNav(null);
    setPendingNavKinds([]);
    setNavTransitionSaving(false);
    setNavTransitionError(null);
    previousPendingNavCancel?.();
    resumeAppliedRef.current = false;
    pendingTaskResumeRef.current = null;
    screenNavigatedRef.current = false;
    commentsGenRef.current += 1;
    directoryFlowGenRef.current += 1;
    setResumeReady(false);
    setTaskResumePendingProjectId(null);
    setPrimaryView('home');
    setProjects([]);
    setSelectedProjectId(null);
    setTasks([]);
    // Every old-owner queued (not-yet-dispatched) save/mutation is settled as cancelled — never
    // silently dropped, never later dispatched under the new owner — before the coordinator
    // itself is replaced outright: swapping the ref to a brand-new instance is what actually
    // guarantees no old-owner request can ever be issued again, since nothing dispatches from an
    // abandoned instance once nothing holds a live reference to it (a still-in-flight, already
    // DISPATCHED old-owner request is left alone and may still settle durably into that abandoned
    // instance's own confirmed store — harmless, since the new owner's UI reads only the fresh
    // instance below, and `saveTask`/`moveTask`/`archiveTask` gate every UI-visible effect of a
    // completion on `selectedProjectIdRef`, which the new owner's own project list has already
    // replaced by the time any such stale completion could arrive).
    taskSaveCoordinatorRef.current.cancelAllQueued();
    taskSaveCoordinatorRef.current = new TaskSaveCoordinator<Task>();
    setSelectedTaskId(null);
    setFocusedTaskId(null);
    setExpandedTaskIds(new Set());
    setShowArchived(false);
    setComments([]);
    setCommentDraft('');
    setCommentSaveError(null);
    setRetryCommentDraft(null);
    setContentError(null);
    setProjectEditor(null);
    taskEditorGenRef.current += 1;
    taskEditorBaselineRef.current = null;
    setTaskEditor(null);
    setTaskSaving(false);
    setTaskSaveError(null);
    setTaskRetry(null);
    setOpenDirectoryFlow(null);
    setOpenDirectoryError(null);
    setInstructionStatuses(null);
    setRecentComments([]);
    setRecentActivity([]);
    setRecentEvidence([]);
  }, [ownerId]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    void repositories.projects
      .list({ includeArchived: true })
      .then((result) => {
        if (!mounted) return;
        setProjects(result);
      })
      .catch((error: unknown) => mounted && setContentError(errorMessage(error)))
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
    // `ownerId` is not used in the fetch itself (the repository queries whatever the current
    // Supabase session authorizes), but IS a dependency: it forces a refetch on a mounted account
    // change so the new owner's own projects load instead of leaving the previous owner's list
    // (and `loading` state) stale until some unrelated re-render happens to occur.
  }, [repositories.projects, ownerId]);

  // Cold-restart / device resume: once both the project list and local settings state have
  // loaded, restore the saved project, screen, and (once its tasks arrive, below) task — applied
  // at most once per mount, and never by defaulting to a first project before this decides. A
  // project the owner has already explicitly picked (read directly off `selectedProjectId`, e.g.
  // via a sidebar click that beat this effect to it) is never overwritten with the saved/default
  // one; an explicit screen navigation is honored the same way, gated by `screenNavigatedRef`
  // (set by `navigateToScreen`) since `primaryView`'s own default value can't otherwise be told
  // apart from an explicit choice of that same screen.
  useEffect(() => {
    if (loading || !directory.state) return;
    if (!resumeAppliedRef.current) {
      resumeAppliedRef.current = true;
      const saved = directory.state;

      if (selectedProjectId === null) {
        const savedProjectExists = Boolean(
          saved.selectedProjectId && projects.some((project) => project.id === saved.selectedProjectId),
        );
        const activeContext = saved.lastOpenContextId
          ? directory.manager.findContext(saved, saved.lastOpenContextId)
          : null;
        const activeContextProjectExists = Boolean(
          activeContext && projects.some((project) => project.id === activeContext.projectId),
        );

        const resolvedProjectId = savedProjectExists
          ? saved.selectedProjectId
          : activeContextProjectExists
            ? (activeContext as DirectoryContextRecord).projectId
            : (projects.find((project) => !project.archived_at) ?? projects[0])?.id ?? null;

        if (resolvedProjectId && saved.selectedTaskId && resolvedProjectId === saved.selectedProjectId) {
          pendingTaskResumeRef.current = { projectId: resolvedProjectId, taskId: saved.selectedTaskId };
          setTaskResumePendingProjectId(resolvedProjectId);
        }

        setSelectedProjectId(resolvedProjectId);
      }

      if (!screenNavigatedRef.current) {
        setPrimaryView(saved.resumeScreen ?? 'home');
      }
    }
    setResumeReady(true);
  }, [loading, directory.state, directory.manager, projects, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setTasks([]);
      setSelectedTaskId(null);
      setFocusedTaskId(null);
      setExpandedTaskIds(new Set());
      return;
    }
    // Clear immediately (synchronously, before the fetch below even starts) — the previous
    // project's tasks, counts, and clickable row controls must never remain visible/actionable
    // under the newly selected project while its own list is still loading or if it fails. The
    // coordinator's own confirmed store is never wiped here (only ever upserted, below): it is
    // keyed by globally-unique task id, so a stale entry for a task outside this project is inert,
    // and wiping it wholesale on every project switch would risk discarding a confirmed value a
    // still-in-flight save for a task the owner just discarded/navigated away from is about to set
    // (Invariant 3 — every successful write advances confirmed state regardless of navigation).
    setTasks([]);
    let mounted = true;
    setContentError(null);
    setFocusedTaskId(null);
    void repositories.tasks
      .list(selectedProjectId, { includeArchived: true })
      .then((result) => {
        if (!mounted) return;
        setTasks(result);
        // Every row a fresh list load returns is authoritative confirmed content by definition.
        taskSaveCoordinatorRef.current.upsertConfirmed(result);
        const pendingResume = pendingTaskResumeRef.current;
        if (pendingResume && pendingResume.projectId === selectedProjectId) {
          pendingTaskResumeRef.current = null;
          setTaskResumePendingProjectId(null);
          // Archived tasks are hidden by default (`showArchived` off) — resuming into one would
          // silently select a task the outliner does not even show, so it is never a valid target.
          const resumedTask = result.find(
            (task) => task.id === pendingResume.taskId && !task.archived_at,
          );
          if (resumedTask) {
            setSelectedTaskId(resumedTask.id);
            setExpandedTaskIds(getTaskAncestorIds(result, resumedTask.id));
            return;
          }
        }
        setSelectedTaskId((current) => (current && result.some((task) => task.id === current) ? current : null));
        setExpandedTaskIds(new Set());
      })
      .catch((error: unknown) => mounted && setContentError(errorMessage(error)));
    return () => {
      mounted = false;
      // A project switch (or unmount) invalidates any agent-write refresh already in flight
      // against the project this effect is leaving (HAM3-014 F2).
      agentWriteRefreshGenRef.current += 1;
    };
  }, [repositories.tasks, selectedProjectId]);

  // The comment thread's owning task changed: bump the generation token so an `addComment` (or
  // its optimistic/completion updates) started against the PREVIOUS task can never land here —
  // and reset the draft/error/retry state, which belongs to that previous task's context and
  // must never silently carry over and get submitted against whichever task is selected now.
  // `comments` itself is cleared synchronously (before the fetch even starts, not just once it
  // resolves/fails) for the same reason `tasks` is cleared synchronously on a project switch: the
  // previous thread's rows — including any optimistic one still in flight — must never remain
  // visible under the newly selected task even while its own list is still loading.
  useEffect(() => {
    commentsGenRef.current += 1;
    setCommentDraft('');
    setCommentSaveError(null);
    setRetryCommentDraft(null);
    setCommentSaving(false);
    setComments([]);
    if (!selectedTask || selectedTask.id.startsWith('draft-')) {
      setCommentsLoading(false);
      return;
    }
    const gen = commentsGenRef.current;
    let mounted = true;
    setCommentsLoading(true);
    void repositories.memory
      .listComments(selectedTask.id)
      .then((result) => mounted && gen === commentsGenRef.current && setComments(result))
      .catch(
        (error: unknown) =>
          mounted && gen === commentsGenRef.current && setCommentSaveError(errorMessage(error)),
      )
      .finally(() => mounted && gen === commentsGenRef.current && setCommentsLoading(false));
    return () => {
      mounted = false;
    };
  }, [repositories.memory, selectedTask]);

  // Home's project-wide "recent" feed only matters when no single task is selected — a selected
  // task's own comments (above) already cover that case with a navigable summary instead.
  useEffect(() => {
    if (!selectedProjectId || selectedTaskId) {
      setRecentComments([]);
      setRecentCommentsError(null);
      return;
    }
    let mounted = true;
    setRecentCommentsLoading(true);
    setRecentCommentsError(null);
    void repositories.memory
      .listRecentComments(selectedProjectId, 5)
      .then((result) => mounted && setRecentComments(result))
      .catch((error: unknown) => mounted && setRecentCommentsError(errorMessage(error)))
      .finally(() => mounted && setRecentCommentsLoading(false));
    return () => {
      mounted = false;
    };
  }, [repositories.memory, selectedProjectId, selectedTaskId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setRecentActivity([]);
      setRecentActivityError(null);
      return;
    }
    let mounted = true;
    setRecentActivityLoading(true);
    setRecentActivityError(null);
    void repositories.memory
      .listActivity(selectedProjectId, { limit: 10 })
      .then((result) => mounted && setRecentActivity(result))
      .catch((error: unknown) => mounted && setRecentActivityError(errorMessage(error)))
      .finally(() => mounted && setRecentActivityLoading(false));
    return () => {
      mounted = false;
    };
  }, [repositories.memory, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setRecentEvidence([]);
      setRecentEvidenceError(null);
      return;
    }
    let mounted = true;
    setRecentEvidenceLoading(true);
    setRecentEvidenceError(null);
    void repositories.memory
      .listEvidence(selectedProjectId, 5)
      .then((result) => mounted && setRecentEvidence(result))
      .catch((error: unknown) => mounted && setRecentEvidenceError(errorMessage(error)))
      .finally(() => mounted && setRecentEvidenceLoading(false));
    return () => {
      mounted = false;
    };
  }, [repositories.memory, selectedProjectId]);

  /**
   * HAM3-014 F2: refreshes the affected task collection/comments after a durable agent write,
   * scoped to the SAME owner/project/task identity the write actually targeted (`notification`'s
   * own fields) — never whichever project/task the UI happens to have selected once this runs.
   * Never overwrites a dirty editor's own typed draft; instead flags `externalTaskUpdateId` so the
   * owner can explicitly choose to reload it, per the write tools' contract ("refresh visible
   * records without replacing unsaved drafts").
   */
  async function refreshAfterAgentWrite(notification: AgentWriteNotification): Promise<void> {
    if (notification.ownerId !== ownerId) return;
    if (notification.projectId !== selectedProjectIdRef.current) return;
    const gen = agentWriteRefreshGenRef.current;

    let freshTasks: Task[];
    try {
      freshTasks = await repositories.tasks.list(notification.projectId, { includeArchived: true });
    } catch {
      // Best-effort background refresh: a transient failure here just leaves the UI exactly as it
      // was — never a user-facing error for a refresh nobody explicitly asked for.
      return;
    }
    // Re-checked after the await: a project switch (or unmount) while this fetch was in flight
    // must never apply a now-stale result on top of whatever the owner has navigated to since.
    if (agentWriteRefreshGenRef.current !== gen) return;
    if (selectedProjectIdRef.current !== notification.projectId) return;

    taskSaveCoordinatorRef.current.upsertConfirmed(freshTasks);
    const dirtyTaskId =
      taskEditorRef.current === 'edit' && isTaskEditorDirtyRef.current
        ? selectedTaskIdRef.current
        : null;
    setTasks((current) => {
      if (!dirtyTaskId) return freshTasks;
      // The one row the owner is actively typing over is exempt from this refresh entirely —
      // every other row (including a brand-new agent-created one) still advances to fresh state.
      const openDirtyRow = current.find((task) => task.id === dirtyTaskId);
      return freshTasks.map((task) =>
        task.id === dirtyTaskId && openDirtyRow ? openDirtyRow : task,
      );
    });
    // Only surface the banner when it was THIS write that the open draft is now behind — a dirty
    // edit on some OTHER task is merely exempted above, not flagged as conflicting.
    if (dirtyTaskId && dirtyTaskId === notification.taskId) {
      setExternalTaskUpdateId(dirtyTaskId);
    }

    if (notification.tool === 'add_comment' && selectedTaskIdRef.current === notification.taskId) {
      const commentsGen = commentsGenRef.current;
      try {
        const freshComments = await repositories.memory.listComments(notification.taskId);
        if (commentsGenRef.current === commentsGen && selectedTaskIdRef.current === notification.taskId) {
          setComments(freshComments);
        }
      } catch {
        // Same best-effort reasoning as the task refresh above.
      }
    }
  }

  // Registered once (stable deps): the facade handler runs independent of this page ever having
  // mounted (see App.tsx), so a write completed while this page was unmounted is simply missed —
  // there is nothing to catch up on reconnect here, only future notifications while mounted.
  // `refreshAfterAgentWrite` is intentionally omitted: it closes over no per-render state directly
  // (every value it reads comes from a ref kept fresh above, or a stable setter/repository), so
  // including it (a new function identity every render) would re-subscribe on every render
  // instead of only when one of these actual triggers changes.
  useEffect(() => {
    return subscribeAgentWriteNotifications((notification) => {
      void refreshAfterAgentWrite(notification);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositories.tasks, repositories.memory, ownerId]);

  /**
   * Resolves one role's full Home status: assignment (and, once known, its truthful active
   * version selection — fetchable through the typed instructions service independent of any
   * directory) always shown once known; classification (which needs a directory to inspect)
   * only attempted when one is actually linked for THIS project. Shared by the effect below and
   * `retryInstructionStatus` so a single-role retry runs the exact same resolution.
   */
  async function fetchInstructionStatus(
    projectId: string,
    root: string | null,
    role: InstructionRole,
  ): Promise<InstructionStatus> {
    try {
      const assignment = await services.assignments.getAssignment({ projectId, role });
      if (!assignment) {
        return { provider: null, activeVersions: null, preview: null, loading: false, error: null };
      }
      const activeVersions = await services.instructions
        .resolveActiveVersionIds({ projectId, role, provider: assignment.provider })
        .catch(() => null);
      if (!root) {
        return { provider: assignment.provider, activeVersions, preview: null, loading: false, error: null };
      }
      try {
        const preview = await services.harness.preview({ root, projectId, role });
        return { provider: assignment.provider, activeVersions, preview, loading: false, error: null };
      } catch (error) {
        return {
          provider: assignment.provider,
          activeVersions,
          preview: null,
          loading: false,
          error: errorMessage(error),
        };
      }
    } catch (error) {
      return { provider: null, activeVersions: null, preview: null, loading: false, error: errorMessage(error) };
    }
  }

  // Instruction presence per role, refreshed whenever the owner arrives at Home (`homeVisitToken`)
  // — event-driven, never a poll — in addition to the project/directory identity actually
  // changing. A single failed role's own Retry re-resolves just that role directly (see
  // `retryInstructionStatus` below) rather than re-running this whole effect. The closure-scoped
  // `mounted` flag (React runs this effect's cleanup before its own next run) is what keeps a
  // refresh request from a previous context from ever overwriting a newer one.
  useEffect(() => {
    // A new resolution context — even one that will resolve to the same root/project as before
    // (a close followed by a reopen of the same path) — supersedes every retry issued against the
    // previous one; see `instructionResolutionGenRef`'s own declaration.
    instructionResolutionGenRef.current += 1;
    if (!selectedProject) {
      setInstructionStatuses(null);
      return;
    }
    let mounted = true;
    const projectId = selectedProject.id;
    const root = activeDirectoryRoot;
    setInstructionStatuses(
      Object.fromEntries(
        INSTRUCTION_ROLES.map((role) => [
          role,
          { provider: null, activeVersions: null, preview: null, loading: true, error: null },
        ]),
      ) as Record<InstructionRole, InstructionStatus>,
    );
    void Promise.all(
      INSTRUCTION_ROLES.map(
        async (role) => [role, await fetchInstructionStatus(projectId, root, role)] as const,
      ),
    ).then((entries) => {
      if (!mounted) return;
      setInstructionStatuses(Object.fromEntries(entries) as Record<InstructionRole, InstructionStatus>);
    });
    return () => {
      mounted = false;
    };
    // `fetchInstructionStatus` is intentionally omitted: it is a plain wrapper over the three
    // services already listed below and closes over no per-render state, so including it (a new
    // function identity every render) would re-run this effect on every render instead of only
    // when one of these actual triggers changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject, activeDirectoryRoot, services.assignments, services.instructions, services.harness, homeVisitToken]);

  /**
   * Home's per-role Retry action: re-resolves just that one role, leaving the others as-is.
   * Scoped to the FULL context this retry was issued against — project, and (via
   * `instructionResolutionGenRef`) the directory root/generation — not merely the project id: a
   * same-project directory switch, a close/reopen, or any other trigger that reruns the main
   * resolving effect above must always win over a slower, now-stale retry, and a second retry for
   * this same role (`instructionRetryGenRef`) must always win over a slower first one.
   */
  function retryInstructionStatus(role: InstructionRole) {
    if (!selectedProject) return;
    const projectId = selectedProject.id;
    const root = activeDirectoryRoot;
    const resolutionGen = instructionResolutionGenRef.current;
    const retryGen = (instructionRetryGenRef.current[role] += 1);
    setInstructionStatuses((current) => {
      const base =
        current ??
        (Object.fromEntries(
          INSTRUCTION_ROLES.map((r) => [
            r,
            { provider: null, activeVersions: null, preview: null, loading: false, error: null },
          ]),
        ) as Record<InstructionRole, InstructionStatus>);
      return { ...base, [role]: { ...base[role], loading: true, error: null } };
    });
    void fetchInstructionStatus(projectId, root, role).then((status) => {
      // A retry for a project the owner has since left must never land under whichever
      // project's summary is showing now.
      if (selectedProjectIdRef.current !== projectId) return;
      // A newer refresh (directory switch, close/reopen, Home revisit) has already resolved this
      // role against the current context — this retry's result is for a superseded context and
      // must never overwrite it, even if the root it targeted happens to match the current one.
      if (instructionResolutionGenRef.current !== resolutionGen) return;
      // A second, later retry for this same role has already been issued — only the newest retry
      // may apply its result.
      if (instructionRetryGenRef.current[role] !== retryGen) return;
      setInstructionStatuses((current) => (current ? { ...current, [role]: status } : current));
    });
  }

  // Bumps `homeVisitToken` whenever the owner arrives at (or returns to) Home, so the
  // instruction-status effect above refreshes to reflect whatever Studio actions happened since
  // the last visit, without ever polling on an interval.
  useEffect(() => {
    if (primaryView === 'home') setHomeVisitToken((token) => token + 1);
  }, [primaryView]);

  // Persists the resume position (project/task/screen) whenever it actually changes, but only
  // once the initial restore above has applied — never overwriting a not-yet-restored saved
  // position with the pre-restore defaults. `directory.state` is read through a ref (kept fresh
  // every render, above) rather than listed as a dependency: including it would re-fire this
  // effect the moment its own write updates that state, looping forever.
  useEffect(() => {
    if (!resumeReady) return;
    const state = directoryStateRef.current;
    if (!state) return;
    // A saved task is still being looked up for the just-restored project (its task list fetch
    // above hasn't concluded one way or the other yet) — `selectedTaskId` is still this render's
    // pre-restore `null`, not a real decision, so it must not overwrite the still-valid stored
    // value with that placeholder. Omitting the field from the patch leaves whatever is already
    // persisted untouched until the lookup actually concludes (found or conclusively invalid).
    const taskResumePending = taskResumePendingProjectId === selectedProjectId;
    const patch: ResumeSelectionPatch = { selectedProjectId, resumeScreen: primaryView };
    if (!taskResumePending) patch.selectedTaskId = selectedTaskId;
    // Never mirrors this call's own resolved state back with `.then(directory.setState)` — the
    // manager's `subscribe` (wired up in `useDirectoryContextState`) is the one and only publisher
    // of canonical state; a second publisher fed by this specific write's own promise can resolve
    // out of order relative to a NEWER mutation's synchronous publish (e.g. a Close issued while
    // this write is still pending) and regress the UI back to this stale snapshot. See Correction
    // 2, F3.
    void directory.manager
      .updateResumeSelection(state, patch)
      // Best-effort device-local convenience state: a failed write here (e.g. disk full) must
      // never surface as an unhandled rejection or block navigation — the owner simply resumes
      // to an older position next launch, the same graceful degradation `loadState` already uses.
      .catch(() => undefined);
  }, [
    resumeReady,
    selectedProjectId,
    selectedTaskId,
    primaryView,
    directory.manager,
    taskResumePendingProjectId,
  ]);

  // Directory reachability for whichever contexts belong to the selected project — mirrors the
  // check DirectoryContextPanel runs on its own, so Home's compact summary can show "missing" too.
  useEffect(() => {
    if (!directory.state || !selectedProject) {
      setDirectoryReachability({});
      return;
    }
    const contexts = directory.manager.contextsForProject(directory.state, selectedProject.id);
    let mounted = true;
    setDirectoryReachability((current) => {
      const next: Record<string, Reachability> = {};
      for (const context of contexts) next[context.id] = current[context.id] ?? 'checking';
      return next;
    });
    void Promise.all(
      contexts.map(async (context) => {
        const reachable = await directory.manager.checkReachable(context.path).catch(() => false);
        return [context.id, reachable] as const;
      }),
    ).then((results) => {
      if (!mounted) return;
      setDirectoryReachability((current) => {
        const next = { ...current };
        for (const [id, reachable] of results) next[id] = reachable;
        return next;
      });
    });
    return () => {
      mounted = false;
    };
  }, [directory.state, directory.manager, selectedProject]);

  function openNewProject() {
    setProjectDraft(emptyProjectDraft);
    setProjectSaveError(null);
    setProjectEditor('new');
  }

  function openEditProject() {
    if (!selectedProject) return;
    setProjectDraft({ name: selectedProject.name, description: selectedProject.description });
    setProjectSaveError(null);
    setProjectEditor('edit');
  }

  async function saveProject(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const draft = { name: projectDraft.name.trim(), description: projectDraft.description.trim() };
    if (!draft.name) {
      setProjectSaveError('Project name is required.');
      return;
    }
    setProjectSaving(true);
    setProjectSaveError(null);
    const editingProject = projectEditor === 'edit' ? selectedProject : null;
    const existingProjectDraft =
      projectEditor === 'new' && selectedProject?.id.startsWith('draft-project-') ? selectedProject : null;
    const input: ProjectInsert = { name: draft.name, description: draft.description };
    const optimisticId = editingProject?.id ?? existingProjectDraft?.id ?? draftId('project');
    const optimisticProject: Project = {
      id: optimisticId,
      owner_id: ownerId,
      name: draft.name,
      description: draft.description,
      archived_at: editingProject?.archived_at ?? null,
      created_at: editingProject?.created_at ?? existingProjectDraft?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    setProjects((current) => {
      const existing = current.some((project) => project.id === optimisticId);
      return existing ? current.map((project) => (project.id === optimisticId ? optimisticProject : project)) : [optimisticProject, ...current];
    });
    setSelectedProjectId(optimisticId);
    try {
      const saved = editingProject
        ? await repositories.projects.update(editingProject.id, input)
        : await repositories.projects.create(input);
      setProjects((current) => current.map((project) => (project.id === optimisticId ? saved : project)));
      setSelectedProjectId(saved.id);
      setProjectEditor(null);
    } catch (error) {
      setProjectSaveError(errorMessage(error));
    } finally {
      setProjectSaving(false);
    }
  }

  async function archiveProject() {
    if (!selectedProject) return;
    setProjectSaveError(null);
    const archivedAt = new Date().toISOString();
    setProjects((current) => current.map((project) => project.id === selectedProject.id ? { ...project, archived_at: archivedAt } : project));
    try {
      const saved = await repositories.projects.archive(selectedProject.id);
      setProjects((current) => current.map((project) => project.id === saved.id ? saved : project));
    } catch (error) {
      setProjectSaveError(errorMessage(error));
    }
  }

  async function restoreProject() {
    if (!selectedProject) return;
    setProjectSaveError(null);
    setProjects((current) => current.map((project) => project.id === selectedProject.id ? { ...project, archived_at: null } : project));
    try {
      const saved = await repositories.projects.update(selectedProject.id, { archived_at: null });
      setProjects((current) => current.map((project) => project.id === saved.id ? saved : project));
    } catch (error) {
      setProjectSaveError(errorMessage(error));
    }
  }

  function openNewTask(parentTaskId: string | null = null) {
    taskEditorGenRef.current += 1;
    taskEditorBaselineRef.current = null;
    setTaskDraft({ ...emptyTaskDraft, parent_task_id: parentTaskId });
    setTaskSaveError(null);
    setTaskRetry(null);
    // A freshly opened editing context never inherits a `taskSaving` flag some OTHER, abandoned
    // context's still-in-flight save left set — that save's own completion is generation-gated and
    // will not touch it, but nothing else would ever clear it either (Invariant 2: a different
    // task's save must never leave the currently open, unrelated editor showing "Saving…").
    setTaskSaving(false);
    setTaskEditor('new');
    setExternalTaskUpdateId(null);
  }

  /** Guarded entry point for "New task"/"+ child" — a dirty task edit or unsent comment for
   * whichever task is currently showing must never be silently replaced by a blank new-task draft. */
  function requestNewTask(parentTaskId: string | null = null) {
    guardedNav(() => openNewTask(parentTaskId), undefined, true);
  }

  function toggleTask(taskId: string) {
    setExpandedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  function focusTask(taskId: string) {
    setFocusedTaskId(taskId);
    setExpandedTaskIds((current) => new Set(current).add(taskId));
  }

  function unfocusTask() {
    setFocusedTaskId(null);
  }

  function openEditTask(task: Task) {
    taskEditorGenRef.current += 1;
    const baseline = {
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      parent_task_id: task.parent_task_id,
    };
    taskEditorBaselineRef.current = baseline;
    setSelectedTaskId(task.id);
    setTaskDraft(baseline);
    setTaskSaveError(null);
    setTaskRetry(null);
    // See `openNewTask`'s matching reset: a different, abandoned task's still-in-flight save must
    // never leave THIS freshly opened editor showing a busy state it never actually entered.
    setTaskSaving(false);
    setTaskEditor('edit');
    setExternalTaskUpdateId(null);
  }

  /** Guarded entry point for selecting a task to edit (outliner rows, "Edit task") — a dirty edit
   * or unsent comment for whichever task/draft is currently showing must never be silently
   * replaced by the newly clicked task's own fields. */
  function requestEditTask(task: Task) {
    guardedNav(() => openEditTask(task), undefined, true);
  }

  /** HAM3-014 F2: the external-update banner's explicit "Reload" action — replaces the open
   * draft with the confirmed row an agent write just produced, without closing the editor. Never
   * invoked automatically: overwriting typed content is only ever the owner's own explicit
   * choice, never an auto-refresh. */
  function reloadTaskEditorFromConfirmed() {
    if (!selectedTaskId) return;
    const confirmed = taskSaveCoordinatorRef.current.getConfirmedForKey(selectedTaskId);
    if (!confirmed) return;
    const baseline = {
      title: confirmed.title,
      description: confirmed.description,
      status: confirmed.status,
      priority: confirmed.priority,
      parent_task_id: confirmed.parent_task_id,
    };
    taskEditorBaselineRef.current = baseline;
    setTaskDraft(baseline);
    setExternalTaskUpdateId(null);
  }

  /**
   * Returns `true` once the save has actually succeeded (so a caller — the tracker-dirty branch of
   * the unsaved-changes guard dialog below — knows whether it may proceed with the navigation that
   * triggered the guard), `false` on validation failure, a rejected write, or a queued snapshot the
   * owner Cancelled/Discarded before it ever reached the repository.
   *
   * HAM3-008 Correction 8: dispatch itself is submitted to `taskSaveCoordinatorRef` rather than
   * called directly — at most one repository call for this task id is ever in flight at a time; a
   * second overlapping call (a normal Save while a guard Save-all is issued for the very same open
   * editor, or vice versa) queues FIFO instead of racing a concurrent request, and confirmation
   * always advances on whichever request actually SUCCEEDS, never on whichever happened to be
   * issued most recently (see the coordinator's own doc comment for why that distinction matters).
   */
  async function saveTask(event?: React.FormEvent<HTMLFormElement>): Promise<boolean> {
    event?.preventDefault();
    const draft = { ...taskDraft, title: taskDraft.title.trim(), description: taskDraft.description.trim() };
    if (!draft.title) {
      setTaskSaveError('Task title is required.');
      return false;
    }
    if (!selectedProject) return false;
    // Captured now, checked again once the write resolves: a completion for a project the owner
    // has since navigated away from must never select a task under whichever project is current.
    const projectIdAtStart = selectedProject.id;
    // Captured now, checked again once the write resolves: a save started against THIS editing
    // context must never close or rebase a DIFFERENT one a Discard/re-open/new-task since replaced
    // it with (Correction 4, F2b's "delayed success against a newer draft").
    const editorGenAtStart = taskEditorGenRef.current;
    const editingTask = taskEditor === 'edit' ? selectedTask : null;
    if (editingTask) {
      try {
        assertNoParentCycle(tasks, editingTask.id, draft.parent_task_id);
      } catch (error) {
        setTaskSaveError(errorMessage(error));
        return false;
      }
    }
    setTaskSaving(true);
    setTaskSaveError(null);
    setTaskRetry(null);
    const existingTaskDraft = taskEditor === 'new' && selectedTask?.id.startsWith('draft-task-') ? selectedTask : null;
    // Stable per-task coordinator key: the real id once one exists, otherwise the SAME local
    // `draft-task-…` id reused across every overlapping save attempt for this not-yet-created task
    // (see the coordinator's create/update remapping — never two draft ids for one new task).
    const key = editingTask?.id ?? existingTaskDraft?.id ?? draftId('task');
    const optimisticTask: Task = {
      id: key,
      owner_id: ownerId,
      project_id: selectedProject.id,
      title: draft.title,
      description: draft.description,
      status: draft.status,
      priority: draft.priority,
      parent_task_id: draft.parent_task_id,
      due_at: editingTask?.due_at ?? null,
      archived_at: editingTask?.archived_at ?? null,
      created_at: editingTask?.created_at ?? existingTaskDraft?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      // A display-only placeholder for a not-yet-durable row; the coordinator's `confirmed` store
      // (never this optimistic object) is the source of truth `expectedRevision` reads from below.
      revision: editingTask?.revision ?? 1,
    };
    setTasks((current) => {
      const existing = current.some((task) => task.id === key);
      return existing ? current.map((task) => (task.id === key ? optimisticTask : task)) : [...current, optimisticTask];
    });
    setSelectedTaskId(key);
    const input: TaskInsert = {
      project_id: selectedProject.id,
      title: draft.title,
      description: draft.description,
      status: draft.status,
      priority: draft.priority,
      parent_task_id: draft.parent_task_id,
    };
    // Identical resubmits of this exact snapshot (a double Save click, or a guard Save-all firing
    // for a draft the form's own Save already dispatched) share the same pending result rather than
    // issuing a second, duplicate request.
    const dedupeToken = JSON.stringify(input);
    // An EXISTING task's `key` is already durable from this call's own first dispatch — the
    // coordinator's own `durableId` tracking only ever remaps a key that started out non-durable
    // (a brand-new task's local `draft-task-…` id), so an editing task must never wait on it.
    const initiallyDurableId = editingTask?.id ?? null;
    const outcome = await taskSaveCoordinatorRef.current.submit(
      key,
      ({ durableId }) => {
        const targetId = initiallyDurableId ?? durableId;
        if (!targetId) return repositories.tasks.create(input);
        // The coordinator's own `confirmed` store is the freshest revision this UI knows about
        // for the row, updated by every successful dispatch for it regardless of which editor is
        // open (HAM3-008 Correction 8) — reading it here, at dispatch time rather than submit
        // time, catches a revision an earlier queued write (or an agent connection) already
        // advanced past `editingTask`'s own snapshot.
        const expectedRevision =
          taskSaveCoordinatorRef.current.getConfirmed(targetId)?.revision ?? editingTask?.revision ?? 1;
        return repositories.tasks.update(targetId, input, expectedRevision);
      },
      dedupeToken,
      'editor',
    );
    if (taskEditorGenRef.current === editorGenAtStart) setTaskSaving(false);
    if (outcome.status === 'cancelled') {
      // The owner explicitly Cancelled/Discarded this task before this queued snapshot ever
      // reached the repository (`cancelTaskEditor`'s own `cancelQueued` call) — nothing was sent,
      // so there is nothing to reconcile or report; the rollback already happened there.
      return false;
    }
    if (outcome.status === 'error') {
      // A rejection for an editing context the owner has already Cancelled/Discarded/replaced must
      // never surface its error on whatever (unrelated) editor is open now. Nor may it surface at
      // all while a NEWER save for this exact task is already queued or in flight behind it — the
      // owner has already explicitly moved past this attempt by requesting a further one, and its
      // outcome (not this stale one) is the last word; showing this error here would be a flash of
      // stale, misleading interim state the newer attempt is about to override regardless.
      if (
        selectedProjectIdRef.current === projectIdAtStart &&
        taskEditorGenRef.current === editorGenAtStart &&
        !taskSaveCoordinatorRef.current.hasPending(key)
      ) {
        if (outcome.error instanceof TaskRevisionConflictError) {
          await reconcileRevisionConflict(key, selectedProject.id, projectIdAtStart);
          setTaskSaveError(
            'This task changed elsewhere while you were editing. The latest version has been loaded — review it, then Save again to reapply your changes.',
          );
        } else {
          setTaskSaveError(errorMessage(outcome.error));
        }
      }
      return false;
    }
    const saved = Array.isArray(outcome.result) ? outcome.result[0] : outcome.result;
    // Reconcile the confirmed, durable record into the collection regardless of which editing
    // context is open now — a stale completion must never redirect the owner's attention, but it
    // also must never be treated as if it never happened (the saved row itself is always safe to
    // reconcile; only the UI focus/selection below is context-bound).
    if (selectedProjectIdRef.current === projectIdAtStart) {
      setTasks((current) => current.map((task) => (task.id === key || task.id === saved.id ? saved : task)));
    }
    // The owner's own save just became the new confirmed state for this task, superseding
    // whatever agent write the banner (HAM3-014 F2) was flagging — nothing left to reload.
    setExternalTaskUpdateId((current) => (current === key || current === saved.id ? null : current));
    // Only move the owner's selection/editor onto this saved record if this is still the SAME
    // editing context this save started against — a Cancel, a switch to a different task, or a
    // fresh "new task" opened while this write was in flight must never have the owner's current
    // selection silently redirected onto a record they are no longer looking at, nor have its own
    // (unrelated) context closed or rebased by a stale completion (Correction 4, F2b).
    if (taskEditorGenRef.current === editorGenAtStart) {
      setSelectedTaskId(saved.id);
      const savedAsDraft = {
        title: saved.title,
        description: saved.description,
        status: saved.status,
        priority: saved.priority,
        parent_task_id: saved.parent_task_id,
      };
      if (taskDraftFieldsEqual(taskDraftRef.current, draft)) {
        // The live draft still matches exactly what was submitted — nothing further to protect.
        // Close the editor and clear its baseline (Correction 4, F2b).
        taskEditorBaselineRef.current = null;
        setTaskEditor(null);
      } else {
        // A newer, unsaved edit landed while this write was in flight. Save success clears
        // protection ONLY for the exact draft it persisted — the newer edit must remain dirty, so
        // rebase onto the just-saved record instead of discarding it (Correction 4, F2b).
        setTaskEditor('edit');
        taskEditorBaselineRef.current = savedAsDraft;
      }
    }
    return true;
  }

  /**
   * A checked write's `expectedRevision` was stale (HAM3-014): another session or an agent
   * connection saved a newer version of `taskId` first. Refetches the task's current durable
   * state and updates BOTH the coordinator's `confirmed` store (so the next attempt for this task
   * checks against the fresh revision instead of repeating the same conflict) and the visible
   * `tasks` row — but never touches any open editor's draft, which is what "retain the UI draft"
   * requires: the owner's unsaved edits stay exactly as they typed them, only the baseline they
   * are being compared/saved against moves forward. Best-effort: a failed refetch here still
   * leaves the caller's own conflict message telling the owner what happened.
   */
  async function reconcileRevisionConflict(
    taskId: string,
    projectId: string,
    projectIdAtStart: string | null,
  ) {
    try {
      const freshTasks = await repositories.tasks.list(projectId, { includeArchived: true });
      const freshRow = freshTasks.find((task) => task.id === taskId);
      if (!freshRow) return;
      taskSaveCoordinatorRef.current.setConfirmed(freshRow);
      if (selectedProjectIdRef.current === projectIdAtStart) {
        setTasks((current) => current.map((task) => (task.id === taskId ? freshRow : task)));
      }
    } catch {
      // Best-effort only; see doc comment above.
    }
  }

  /** `task.id` for an already-durable task; `null` for one that still carries its synthetic
   * `draft-task-…` local id and has not (yet, as of `durableId`) been durably created — the
   * caller must never send that synthetic id to a durable repository call (HAM3-008 Correction 9).
   * `durableId` is the coordinator's own dispatch-time knowledge of this exact logical task's real
   * id, current as of the moment this specific request actually runs (never stale: FIFO ordering
   * under the shared canonical queue guarantees any create for this same task has already settled
   * by then, one way or the other). */
  function resolveDurableTaskId(task: Task, durableId: string | null): string | null {
    return task.id.startsWith('draft-task-') ? durableId : task.id;
  }

  /**
   * A status move is routed through the SAME per-task coordinator queue as a form Save/Retry
   * (HAM3-008 Correction 8) — keyed by `task.id` and resolved through its current draft/real alias
   * like every other submission (HAM3-008 Correction 9) — so an edit-form save for this exact task
   * and an outliner status move can never race each other's confirmed result: whichever was
   * actually requested first is applied first, and the other only dispatches once it settles. A
   * move requested while the task is STILL synthetic (its create not yet settled) queues behind
   * that create and, once the create succeeds, updates the real id it produced rather than the
   * synthetic one — never a bogus request against an id nothing durable was ever assigned. If the
   * create instead fails, there is no durable id to move, and the attempt fails truthfully rather
   * than silently doing nothing or reporting success.
   *
   * HAM3-008 Correction 10: the repository call above already targets the row's real id once its
   * pending create has settled — but `task` here is the CALLER's own captured reference, still
   * carrying the synthetic `draft-task-…` id it had at the moment this move was requested. Reusing
   * that stale id for the outcome below (rather than the coordinator's own current durable
   * identity) is a display/retry bug, not a persistence one. Captured once, up front, so both
   * outcome branches resolve through the exact SAME coordinator instance this move was submitted
   * to — never whatever `taskSaveCoordinatorRef.current` happens to hold if an owner change has
   * since swapped it out (that case never reaches this code anyway, via the project guard below,
   * but the capture makes "the operation's own coordinator" the only one ever consulted here).
   */
  async function moveTask(task: Task, status: TaskStatus) {
    const coordinator = taskSaveCoordinatorRef.current;
    const projectIdAtStart = selectedProjectIdRef.current;
    const optimistic = { ...task, status, updated_at: new Date().toISOString() };
    setTasks((current) => current.map((item) => item.id === task.id ? optimistic : item));
    setTaskSaveError(null);
    setTaskRetry({ kind: 'move', taskId: task.id, status });
    const outcome = await coordinator.submit(
      task.id,
      ({ durableId }) => {
        const targetId = resolveDurableTaskId(task, durableId);
        if (!targetId) {
          return Promise.reject(new Error('This task was never created, so its status cannot be saved.'));
        }
        // Freshest known revision at DISPATCH time, same reasoning as `saveTask` (HAM3-014): the
        // coordinator's own `confirmed` store, falling back to this call's own captured `task`
        // only when nothing newer has been recorded for it yet.
        const expectedRevision = coordinator.getConfirmed(targetId)?.revision ?? task.revision;
        return repositories.tasks.update(targetId, { status }, expectedRevision);
      },
      null,
      'outliner',
    );
    // A completion for a project the owner has since left must never touch whichever project's
    // retry banner/task list is showing now — the moved task no longer even exists in `tasks`
    // once that project switch cleared and reloaded it, but the shared `taskRetry` flag does. A
    // 'cancelled' outcome never reaches this move (nothing here ever cancels a queued mutation),
    // but is handled the same inert way as a stale-project completion, for completeness.
    if (selectedProjectIdRef.current !== projectIdAtStart) return;
    if (outcome.status === 'success') {
      const saved = Array.isArray(outcome.result) ? outcome.result[0] : outcome.result;
      // Matched by the ORIGINAL captured id (the row may still be showing it, if this move's own
      // create-reconciliation raced ahead of `saveTask`'s) OR by `saved.id` (the row may already
      // have been rewritten to its real id by then) — the same either-alias reconciliation
      // `saveTask` itself already relies on, so this durably-correct write is never dropped on the
      // floor just because the rendered row's id moved on from what was captured at call time
      // (HAM3-008 Correction 10).
      setTasks((current) => current.map((item) => (item.id === task.id || item.id === saved.id ? saved : item)));
      setTaskRetry(null);
    } else if (outcome.status === 'error') {
      // The row this failure belongs to may no longer be the synthetic id captured at call time —
      // resolve its CURRENT durable identity through this same operation's own coordinator before
      // pointing the selection at it, so the detail panel follows the row actually on screen
      // rather than a vanished draft id (HAM3-008 Correction 10). `taskRetry` itself keeps the
      // originally-captured id set above; `retryTaskSave` normalizes it the same way at retry time.
      const currentTaskId = coordinator.getDurableId(task.id) ?? task.id;
      if (outcome.error instanceof TaskRevisionConflictError) {
        await reconcileRevisionConflict(currentTaskId, task.project_id, projectIdAtStart);
        setTaskSaveError(
          'This task changed elsewhere. The latest version has been loaded — choose the status again to reapply your change.',
        );
      } else {
        setTaskSaveError(errorMessage(outcome.error));
      }
      setSelectedTaskId(currentTaskId);
    }
  }

  /** Same per-task coordinator queue as `moveTask`/`saveTask`, resolved through the archived
   * task's current draft/real alias like every other submission (HAM3-008 Correction 9) — an
   * edit-form save or status move for this exact task already in flight or queued settles first,
   * so a stale save response can never resurrect a row this archive already durably removed, and
   * vice versa (HAM3-008 Correction 8). Archiving a still-synthetic row (its create not yet
   * settled) queues behind that create the same way `moveTask` does, and targets the real id the
   * create produces rather than the synthetic one — see `resolveDurableTaskId`. */
  async function archiveTask(task: Task) {
    // Captured now, checked again once the archive resolves: a completion for a project the
    // owner has since navigated away from must never clear/overwrite whichever project's own
    // task-action state (retry banner, save error) is showing now.
    const projectIdAtStart = selectedProjectIdRef.current;
    const subtreeIds = getTaskSubtreeIds(tasks, task.id);
    const archivedAt = new Date().toISOString();
    setTasks((current) =>
      current.map((item) => (subtreeIds.has(item.id) ? { ...item, archived_at: archivedAt } : item)),
    );
    setTaskRetry({ kind: 'archive', taskId: task.id });
    setTaskSaveError(null);
    if (!showArchived) {
      if (selectedTaskId && subtreeIds.has(selectedTaskId)) {
        setSelectedTaskId(null);
        closeTaskEditor();
      }
      if (focusedTaskId && subtreeIds.has(focusedTaskId)) {
        setFocusedTaskId(null);
      }
    }
    const outcome = await taskSaveCoordinatorRef.current.submit(
      task.id,
      ({ durableId }) => {
        const targetId = resolveDurableTaskId(task, durableId);
        if (!targetId) {
          return Promise.reject(new Error('This task was never created, so it cannot be archived.'));
        }
        const expectedRevision =
          taskSaveCoordinatorRef.current.getConfirmed(targetId)?.revision ?? task.revision;
        return repositories.tasks.archive(targetId, expectedRevision);
      },
      null,
      'outliner',
    );
    if (selectedProjectIdRef.current !== projectIdAtStart) return;
    if (outcome.status === 'success') {
      const saved = Array.isArray(outcome.result) ? outcome.result : [outcome.result];
      const savedById = new Map(saved.map((item) => [item.id, item]));
      setTasks((current) => current.map((item) => savedById.get(item.id) ?? item));
      setTaskRetry(null);
    } else if (outcome.status === 'error') {
      if (outcome.error instanceof TaskRevisionConflictError) {
        await reconcileRevisionConflict(task.id, task.project_id, projectIdAtStart);
        setTaskSaveError(
          'This task changed elsewhere. The latest version has been loaded — archive again to reapply.',
        );
      } else {
        setTaskSaveError(errorMessage(outcome.error));
      }
    }
  }

  /**
   * `taskRetry.taskId` may still be the synthetic `draft-task-…` id captured when the failed
   * move/archive was originally requested — its create can have durably completed, under a
   * completely different real id, any time between then and now. Normalize it through the SAME
   * draft/real alias the coordinator itself uses (HAM3-008 Correction 9) BEFORE looking the task
   * up, so a legacy/synthetic retry id still resolves to the row actually on screen instead of
   * silently finding nothing and no-opping. This is the consumer's own resolution — it holds
   * regardless of whether the originating failure handler happened to record a resolved id or not
   * (HAM3-008 Correction 10).
   */
  async function retryTaskSave() {
    if (!taskRetry) return;
    const targetId = taskSaveCoordinatorRef.current.getDurableId(taskRetry.taskId) ?? taskRetry.taskId;
    const task = tasks.find((item) => item.id === targetId);
    if (!task) return;
    if (taskRetry.kind === 'move' && taskRetry.status) {
      await moveTask(task, taskRetry.status);
    } else {
      await archiveTask(task);
    }
  }

  /**
   * Returns `true` once the comment has actually been saved (so the tracker-dirty branch of the
   * unsaved-changes guard dialog below knows whether it may proceed), `false` when there is
   * nothing to save or the write is rejected.
   */
  async function addComment(event?: React.FormEvent<HTMLFormElement>): Promise<boolean> {
    event?.preventDefault();
    if (!selectedTask || !selectedProject || !commentDraft.trim()) return false;
    const body = commentDraft.trim();
    // Captured now, checked again once the write resolves: a completion for a thread the owner
    // has since navigated away from (a different task, or the same task reloaded elsewhere) must
    // never land in whichever comment thread is showing now — see `commentsGenRef`'s declaration.
    const gen = commentsGenRef.current;
    const projectId = selectedProject.id;
    const taskId = selectedTask.id;
    setCommentSaving(true);
    setCommentSaveError(null);
    setRetryCommentDraft(body);
    const optimisticId = draftId('comment');
    const optimisticComment: Comment = {
      id: optimisticId,
      owner_id: ownerId,
      project_id: projectId,
      task_id: taskId,
      body,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    setComments((current) => [...current, optimisticComment]);
    try {
      const saved = await repositories.memory.addComment({ project_id: projectId, task_id: taskId, body });
      if (gen === commentsGenRef.current) {
        setComments((current) => current.map((comment) => comment.id === optimisticId ? saved : comment));
        setCommentDraft('');
        setRetryCommentDraft(null);
      }
      return true;
    } catch (error) {
      if (gen === commentsGenRef.current) setCommentSaveError(errorMessage(error));
      return false;
    } finally {
      // Unconditional: this is a simple in-flight flag for whichever thread is showing right now,
      // not content tied to the stale thread — leaving it stuck at `true` after navigating away
      // would wrongly disable the new thread's own, otherwise-idle composer.
      setCommentSaving(false);
    }
  }

  const retryComment = () => {
    if (retryCommentDraft !== null) void addComment();
  };

  /**
   * The actual project-switch reset, with no guarding of its own. A directory-flow function that
   * already ran its own `guardTransition()` for this same transition must call this directly
   * (never `switchToProject`) — going through the guarded wrapper too would check the dirty
   * Studio state a second time for one logical transition (see `guardTransition`'s doc comment).
   */
  function applyProjectSwitch(projectId: string) {
    setSelectedProjectId(projectId);
    setSelectedTaskId(null);
    setFocusedTaskId(null);
    setExpandedTaskIds(new Set());
    closeTaskEditor();
  }

  function switchToProject(projectId: string) {
    guardedNav(() => applyProjectSwitch(projectId), undefined, true);
  }

  /** Every explicit screen pick goes through here, so device resume never flips it back out. */
  function navigateToScreen(view: PrimaryView) {
    screenNavigatedRef.current = true;
    setPrimaryView(view);
  }

  function goToWorkspace() {
    guardedNav(() => navigateToScreen('workspace'));
  }

  function goToWorkspaceTask(taskId: string) {
    guardedNav(() => {
      navigateToScreen('workspace');
      setSelectedTaskId(taskId);
      setExpandedTaskIds((current) => {
        const next = new Set(current);
        for (const ancestorId of getTaskAncestorIds(tasks, taskId)) next.add(ancestorId);
        return next;
      });
    });
  }

  /**
   * `role` pins which role Instruction Studio opens on for this ONE visit (a role-scoped
   * "Set up instructions" action) — consumed by `InstructionStudio`'s `initialRole` prop, which
   * only takes effect on a fresh mount, so it is reset the moment Studio actually mounts,
   * ensuring a later plain nav to Instructions is never pinned to a stale role.
   */
  function goToInstructions(role?: InstructionRole) {
    setPendingInstructionRole(role);
    guardedNav(() => navigateToScreen('instructions'));
  }

  function closeActiveDirectory() {
    if (!directory.state) return;
    const state = directory.state;
    guardedNav(() => {
      void directory.manager
        .closeActive(state)
        .catch((error: unknown) => setOpenDirectoryError(errorMessage(error)));
    });
  }

  /**
   * Cancels the open-directory dialog (any kind) and invalidates whatever async work it still
   * had in flight — a guard wait, a project creation, a directory link — so a completion that
   * arrives after this Cancel can never still apply itself. Use this for every explicit
   * dismissal; a step-to-step transition within a still-live flow (e.g. choosing "Create
   * project") sets `openDirectoryFlow` directly instead, since nothing needs invalidating there.
   */
  function cancelDirectoryFlow() {
    directoryFlowGenRef.current += 1;
    setOpenDirectoryFlow(null);
  }

  async function openDirectory() {
    if (!directory.state) return;
    const state = directory.state;
    setOpenDirectoryError(null);
    setOpenDirectoryBusy(true);
    const gen = directoryFlowGenRef.current;
    try {
      const path = await directory.manager.pickDirectory();
      if (path === null || gen !== directoryFlowGenRef.current) return;
      // Resolved against whichever projects are ACTUALLY accessible right now (Correction 5): a
      // remembered binding for a project that no longer exists/is no longer authorized (deleted,
      // or simply another owner's data after a mounted account change) must never be treated as
      // a known match and silently switched to — it falls through to the unknown-directory flow
      // below instead, offering the same explicit create/link recovery as a truly new directory.
      const matches = directory.manager
        .findContextsForPath(state, path)
        .filter((match) => projectsRef.current.some((project) => project.id === match.projectId));
      if (matches.length === 1) {
        const match = matches[0];
        // Guarded — and nothing above this point has changed any active context, resume
        // position, or filesystem target — before the actual activation below, so a dirty
        // Instruction Studio's Cancel/failed Save leaves every bit of that state untouched.
        const proceed = await guardTransition();
        if (!proceed || gen !== directoryFlowGenRef.current) return;
        try {
          await directory.manager.setActive(state, match.id);
          if (gen !== directoryFlowGenRef.current) return;
          // Reuses the unguarded reset directly (never `switchToProject`): the guard above
          // already covers this whole transition — routing through the guarded wrapper too would
          // re-check the same now-possibly-different dirty state a second time.
          applyProjectSwitch(match.projectId);
        } catch (error) {
          // Never switch the selected project on a failed activation — the owner would land on
          // a project whose directory context silently didn't actually change to match it.
          if (gen === directoryFlowGenRef.current) setOpenDirectoryError(errorMessage(error));
        }
        return;
      }
      if (matches.length > 1) {
        setOpenDirectoryFlow({ kind: 'ambiguous', path, matches });
        return;
      }
      setDirectoryFlowProjectDraft({ name: labelFromPath(path), description: '' });
      setDirectoryFlowError(null);
      setOpenDirectoryFlow({ kind: 'unknown', path, mode: 'choose' });
    } catch (error) {
      if (gen === directoryFlowGenRef.current) setOpenDirectoryError(errorMessage(error));
    } finally {
      setOpenDirectoryBusy(false);
    }
  }

  async function resolveAmbiguousMatch(match: DirectoryContextRecord) {
    if (!directory.state) return;
    const state = directory.state;
    const gen = directoryFlowGenRef.current;
    if (!projectsRef.current.some((project) => project.id === match.projectId)) {
      setOpenDirectoryFlow(null);
      setOpenDirectoryError('That project is no longer available.');
      return;
    }
    // Guarded before the dialog closes or anything below mutates — a dirty Studio's Cancel here
    // leaves the ambiguous-match dialog and every directory/project binding exactly as they were.
    const proceed = await guardTransition();
    if (!proceed || gen !== directoryFlowGenRef.current) return;
    setOpenDirectoryFlow(null);
    try {
      await directory.manager.setActive(state, match.id);
      if (gen !== directoryFlowGenRef.current) return;
      applyProjectSwitch(match.projectId);
    } catch (error) {
      if (gen === directoryFlowGenRef.current) setOpenDirectoryError(errorMessage(error));
    }
  }

  async function submitDirectoryFlowCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!openDirectoryFlow || openDirectoryFlow.kind !== 'unknown' || !directory.state) return;
    const state = directory.state;
    const path = openDirectoryFlow.path;
    const name = directoryFlowProjectDraft.name.trim();
    if (!name) {
      setDirectoryFlowError('Project name is required.');
      return;
    }
    const gen = directoryFlowGenRef.current;
    setDirectoryFlowSaving(true);
    setDirectoryFlowError(null);
    try {
      // Guarded before ANY of this flow's real side effects — project creation, directory
      // linking, or the eventual project switch. Cancel or a failed Save on a dirty Studio must
      // leave this dialog, every project record, and every directory binding exactly as they
      // were before Create was clicked; nothing above this line has mutated anything.
      const proceed = await guardTransition();
      if (!proceed || gen !== directoryFlowGenRef.current) return;
      const created = await repositories.projects.create({
        name,
        description: directoryFlowProjectDraft.description.trim(),
      });
      // The project now durably exists regardless of whether this flow is still current — it
      // must never disappear from the list, and (via the linkRetry fallback below) must never be
      // silently duplicated by a retry, even if the flow that created it was since cancelled.
      setProjects((current) => [created, ...current]);
      try {
        await directory.manager.linkDirectory(state, created.id, path);
        if (gen !== directoryFlowGenRef.current) return;
        setOpenDirectoryFlow(null);
        applyProjectSwitch(created.id);
      } catch (linkError) {
        // The project already exists — never re-create it on retry, only retry the link.
        if (gen === directoryFlowGenRef.current) {
          setOpenDirectoryFlow({
            kind: 'linkRetry',
            path,
            projectId: created.id,
            error: errorMessage(linkError),
          });
        }
      }
    } catch (error) {
      if (gen === directoryFlowGenRef.current) setDirectoryFlowError(errorMessage(error));
    } finally {
      setDirectoryFlowSaving(false);
    }
  }

  async function retryDirectoryFlowLink() {
    if (!openDirectoryFlow || openDirectoryFlow.kind !== 'linkRetry' || !directory.state) return;
    const state = directory.state;
    const { path, projectId } = openDirectoryFlow;
    // The project this retry targets was already durably created by a prior submit — linking is
    // the only outstanding side effect, so it is safe (and required, per the guard-first rule) to
    // guard it the same way before touching the directory binding or switching projects.
    const gen = directoryFlowGenRef.current;
    const proceed = await guardTransition();
    if (!proceed || gen !== directoryFlowGenRef.current) return;
    try {
      await directory.manager.linkDirectory(state, projectId, path);
      if (gen !== directoryFlowGenRef.current) return;
      setOpenDirectoryFlow(null);
      applyProjectSwitch(projectId);
    } catch (error) {
      if (gen === directoryFlowGenRef.current) {
        setOpenDirectoryFlow({ kind: 'linkRetry', path, projectId, error: errorMessage(error) });
      }
    }
  }

  async function submitDirectoryFlowLink(projectId: string) {
    if (!openDirectoryFlow || openDirectoryFlow.kind !== 'unknown' || !directory.state) return;
    const state = directory.state;
    const path = openDirectoryFlow.path;
    const gen = directoryFlowGenRef.current;
    setDirectoryFlowSaving(true);
    setDirectoryFlowError(null);
    try {
      // Guarded before the link (and the switch it leads to) — linking to the SAME project
      // Studio's dirty draft is currently for must not silently change Studio's target before
      // the owner accepts leaving it.
      const proceed = await guardTransition();
      if (!proceed || gen !== directoryFlowGenRef.current) return;
      await directory.manager.linkDirectory(state, projectId, path);
      if (gen !== directoryFlowGenRef.current) return;
      setOpenDirectoryFlow(null);
      applyProjectSwitch(projectId);
    } catch (error) {
      if (gen === directoryFlowGenRef.current) setDirectoryFlowError(errorMessage(error));
    } finally {
      setDirectoryFlowSaving(false);
    }
  }

  const initializing = loading || !resumeReady;

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Application navigation">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">H</span>
          <span className="brand-name">Hammond</span>
        </div>
        <nav className="primary-nav" aria-label="Primary">
          <button
            type="button"
            className={`nav-item ${primaryView === 'home' ? 'nav-item-active' : ''}`}
            onClick={() => guardedNav(() => navigateToScreen('home'))}
          >
            <span className="nav-icon" aria-hidden="true">⌂</span>Home
          </button>
          <button
            type="button"
            className={`nav-item ${primaryView === 'workspace' ? 'nav-item-active' : ''}`}
            onClick={() => guardedNav(() => navigateToScreen('workspace'))}
          >
            <span className="nav-icon" aria-hidden="true">◈</span>Workspace
          </button>
          <button
            type="button"
            className={`nav-item ${primaryView === 'instructions' ? 'nav-item-active' : ''}`}
            onClick={() => goToInstructions()}
          >
            <span className="nav-icon" aria-hidden="true">▤</span>Instructions
          </button>
          <span className="nav-item nav-item-muted"><span className="nav-icon" aria-hidden="true">⚙</span>Settings</span>
        </nav>
        <button
          className="button button-secondary sidebar-open-directory"
          type="button"
          onClick={() => void openDirectory()}
          disabled={!directory.state || openDirectoryBusy}
        >
          {openDirectoryBusy ? 'Choosing…' : 'Open directory'}
        </button>
        {openDirectoryError && (
          <div className="save-error" role="alert">
            <span>{openDirectoryError}</span>
          </div>
        )}
        <div className="project-list-heading">
          <span className="eyebrow">Projects</span>
          <button className="icon-button" type="button" onClick={openNewProject} aria-label="Create project">+</button>
        </div>
        <div className="project-list">
          {visibleProjects.map((project) => (
            <button
              className={`project-nav-item ${project.id === selectedProjectId ? 'project-nav-item-active' : ''}`}
              key={project.id}
              type="button"
              onClick={() => switchToProject(project.id)}
            >
              <span className="project-nav-dot" aria-hidden="true" />
              <span>{project.name}</span>
              {project.archived_at && <span className="archived-mark">archived</span>}
            </button>
          ))}
          {visibleProjects.length === 0 && <p className="sidebar-empty">No projects yet.</p>}
        </div>
        <label className="archive-toggle">
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
          Show archived
        </label>
        <div className="sidebar-footer">
          <span className="status-dot" aria-hidden="true" />
          <span title={ownerEmail}>{ownerEmail ?? 'Owner'} · synced</span>
        </div>
        <button className="sign-out-button" type="button" onClick={onSignOut}>Sign out</button>
      </aside>

      <section className="content-area" id="workspace">
      {primaryView === 'home' && (
        <>
        <header className="topbar">
          <div>
            <p className="eyebrow">Project home</p>
            <h1>{selectedProject ? selectedProject.name : 'Good morning, owner.'}</h1>
          </div>
          <div className="topbar-actions">
            <span className="version-pill">v0.1.0</span>
            {!selectedProject && (
              <button className="button button-primary" type="button" onClick={openNewProject}>
                New project
              </button>
            )}
          </div>
        </header>

        {contentError && <div className="global-error" role="alert">{contentError}</div>}
        {initializing ? (
          <div className="empty-state"><p className="eyebrow">Loading workspace</p><h2>Gathering your projects…</h2></div>
        ) : !selectedProject ? (
          <NoProjectState
            onCreateProject={openNewProject}
            onOpenDirectory={() => void openDirectory()}
            openDirectoryDisabled={!directory.state || openDirectoryBusy}
          />
        ) : (
          <HomeDashboard
            project={selectedProject}
            activeContext={activeDirectoryContext}
            activeReachable={activeDirectoryReachable}
            taskStatusCounts={taskStatusCounts}
            totalTaskCount={visibleTasks.length}
            selectedTask={selectedTask}
            comments={comments}
            commentsLoading={commentsLoading}
            recentComments={recentComments}
            recentCommentsLoading={recentCommentsLoading}
            recentCommentsError={recentCommentsError}
            instructionStatuses={instructionStatuses}
            hasDirectory={Boolean(activeDirectoryRoot)}
            recentActivity={recentActivity}
            recentActivityLoading={recentActivityLoading}
            recentActivityError={recentActivityError}
            recentEvidence={recentEvidence}
            recentEvidenceLoading={recentEvidenceLoading}
            recentEvidenceError={recentEvidenceError}
            onOpenDirectory={() => void openDirectory()}
            onCloseDirectory={closeActiveDirectory}
            onOpenWorkspace={goToWorkspace}
            onOpenTask={goToWorkspaceTask}
            onOpenInstructions={goToInstructions}
            onRetryInstructionStatus={retryInstructionStatus}
          />
        )}

        {projectEditor && (
          <div className="modal-backdrop">
            <div className="modal-card" role="dialog" aria-modal="true" aria-label={projectEditor === 'new' ? 'Create project' : 'Edit project'}>
              <ProjectForm draft={projectDraft} saving={projectSaving} error={projectSaveError} onChange={setProjectDraft} onSubmit={(event) => void saveProject(event)} onCancel={() => setProjectEditor(null)} isNew={projectEditor === 'new'} onRetry={() => void saveProject()} />
            </div>
          </div>
        )}
        </>
      )}

      {primaryView === 'workspace' && (
        <>
        <header className="topbar">
          <div>
            <p className="eyebrow">Project and task tracker</p>
            <h1>{selectedProject ? selectedProject.name : 'Good morning, owner.'}</h1>
          </div>
          <div className="topbar-actions">
            <span className="version-pill">v0.1.0</span>
            <button className="button button-primary" type="button" onClick={openNewProject}>New project</button>
          </div>
        </header>

        {contentError && <div className="global-error" role="alert">{contentError}</div>}
        {initializing ? (
          <div className="empty-state"><p className="eyebrow">Loading workspace</p><h2>Gathering your projects…</h2></div>
        ) : !selectedProject ? (
          <NoProjectState
            onCreateProject={openNewProject}
            onOpenDirectory={() => void openDirectory()}
            openDirectoryDisabled={!directory.state || openDirectoryBusy}
          />
        ) : (
          <div className="workspace-grid">
            <div className="project-workspace">
              <section className="project-detail-card">
                <div>
                  <p className="eyebrow">Project detail {selectedProject.archived_at && '· Archived'}</p>
                  <h2>{selectedProject.name}</h2>
                  <p className="project-description">{selectedProject.description || 'No project description yet.'}</p>
                </div>
                <div className="detail-actions">
                  <button className="button button-quiet" type="button" onClick={openEditProject}>Edit project</button>
                  {selectedProject.archived_at ? <button className="button button-quiet" type="button" onClick={() => void restoreProject()}>Restore</button> : <button className="button button-danger" type="button" onClick={() => void archiveProject()}>Archive</button>}
                </div>
                {projectSaveError && <div className="save-error" role="alert"><span>{projectSaveError}</span>{!projectEditor && <button className="button button-small" type="button" onClick={() => selectedProject.archived_at ? void restoreProject() : void archiveProject()}>Retry save</button>}</div>}
              </section>
              {directory.state && (
                <DirectoryContextPanel
                  manager={directory.manager}
                  state={directory.state}
                  // No `onStateChange`: `directory.state` already mirrors the manager's canonical
                  // state via its own `subscribe` (see `useDirectoryContextState`), which publishes
                  // synchronously and in the correct order for every commit. Wiring this panel's
                  // own per-call `onStateChange` to the same setter would add a second, competing
                  // publisher that can resolve out of order relative to the subscription — the
                  // exact regression Correction 2 (F3) removed from the resume-persistence effect.
                  projectId={selectedProject.id}
                  beforeChange={guardedNav}
                />
              )}
              <AgentAccessPanel projectId={selectedProject.id} projectName={selectedProject.name} />
              <section className="outliner-section" aria-labelledby="outliner-heading">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Task hierarchy</p>
                    <h2 id="outliner-heading">See the work in context.</h2>
                  </div>
                  <button className="button button-secondary" type="button" onClick={() => requestNewTask()}>
                    New task
                  </button>
                </div>
                {focusedTask && (
                  <div className="focus-breadcrumb" aria-label="Task focus">
                    <span>Focused task</span>
                    <strong>{focusedTask.title}</strong>
                    <button className="button button-quiet" type="button" onClick={unfocusTask}>
                      Back to all tasks
                    </button>
                  </div>
                )}
                <div className="outliner-summary" aria-label="Task status counts">
                  {TASK_STATUSES.map((status) => (
                    <div key={status} className="outliner-summary-item">
                      <h3>{STATUS_LABELS[status]}</h3>
                      <strong>{taskStatusCounts[status]}</strong>
                    </div>
                  ))}
                </div>
                {outlinerTasks.length > 0 ? (
                  <TaskOutliner
                    tasks={outlinerTasks}
                    selectedTaskId={selectedTaskId}
                    expandedTaskIds={expandedTaskIds}
                    onToggle={toggleTask}
                    onEdit={requestEditTask}
                    onFocus={focusTask}
                    onNewChild={requestNewTask}
                    onMove={(task, status) => void moveTask(task, status)}
                    onArchive={(task) => void archiveTask(task)}
                  />
                ) : (
                  <p className="outliner-empty">No tasks in this view yet.</p>
                )}
                {taskSaveError && (
                  <div className="save-error" role="alert">
                    <span>{taskSaveError}</span>
                    {(taskRetry || taskEditor) && (
                      <button className="button button-small" type="button" onClick={() => taskRetry ? void retryTaskSave() : void saveTask()}>
                        Retry save
                      </button>
                    )}
                  </div>
                )}
              </section>
            </div>
            <aside className="detail-panel" aria-label="Selected task detail">
              {taskEditor ? <>
                {taskEditor === 'edit' && externalTaskUpdateId === selectedTask?.id && (
                  <div className="external-update-banner" role="status">
                    <span>This task was updated elsewhere (e.g. by a connected agent) while you were editing. Your unsaved changes are untouched — reload to see the latest, or Save to keep your changes and overwrite it.</span>
                    <button className="button button-small" type="button" onClick={reloadTaskEditorFromConfirmed}>
                      Reload latest
                    </button>
                  </div>
                )}
                <TaskForm draft={taskDraft} tasks={visibleTasks} taskId={taskEditor === 'edit' ? selectedTask?.id : undefined} saving={taskSaving} error={taskSaveError} isNew={taskEditor === 'new'} onChange={setTaskDraft} onSubmit={(event) => void saveTask(event)} onCancel={cancelTaskEditor} onRetry={() => void saveTask()} />
              </> : selectedTask ? <>
                <div className="task-summary"><p className="eyebrow">Selected task</p><h2>{selectedTask.title}</h2><p>{selectedTask.description || 'No task description yet.'}</p><button className="button button-secondary" type="button" onClick={() => requestEditTask(selectedTask)}>Edit task</button></div>
                <CommentPanel task={selectedTask} comments={comments} draft={commentDraft} saving={commentSaving} loading={commentsLoading} error={commentSaveError} onDraftChange={setCommentDraft} onSubmit={(event) => void addComment(event)} onRetry={retryComment} />
              </> : <div className="detail-placeholder"><span className="placeholder-mark">✦</span><h2>Task detail</h2><p>Select a task to inspect its context, hierarchy, and comments.</p></div>}
            </aside>
          </div>
        )}

        {projectEditor && (
          <div className="modal-backdrop">
            <div className="modal-card" role="dialog" aria-modal="true" aria-label={projectEditor === 'new' ? 'Create project' : 'Edit project'}>
              <ProjectForm draft={projectDraft} saving={projectSaving} error={projectSaveError} onChange={setProjectDraft} onSubmit={(event) => void saveProject(event)} onCancel={() => setProjectEditor(null)} isNew={projectEditor === 'new'} onRetry={() => void saveProject()} />
            </div>
          </div>
        )}
        </>
      )}

      {primaryView === 'instructions' && (
        <>
        <header className="topbar">
          <div>
            <p className="eyebrow">Instruction Studio</p>
            <h1>Assign, customize, and inject effective instructions.</h1>
          </div>
        </header>
        {selectedProject ? (
          <InstructionStudio
            ref={studioRef}
            instructionsService={services.instructions}
            assignmentsService={services.assignments}
            harnessService={services.harness}
            project={selectedProject}
            directoryRoot={activeDirectoryRoot}
            initialRole={pendingInstructionRole}
          />
        ) : (
          <p className="sidebar-empty">Select a project to manage its instructions.</p>
        )}
        </>
      )}
      </section>

      {openDirectoryFlow?.kind === 'ambiguous' && !pendingNav && (
        <div className="modal-backdrop">
          <div className="modal-card" role="dialog" aria-modal="true" aria-label="Choose a project">
            <h2>This directory is linked to more than one project</h2>
            <p className="muted-copy">
              <code>{openDirectoryFlow.path}</code> is bound to more than one Hammond project.
              Choose which one to open.
            </p>
            <ul className="directory-choice-list">
              {openDirectoryFlow.matches.map((match) => {
                const owner = projects.find((project) => project.id === match.projectId);
                return (
                  <li key={match.id}>
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={() => void resolveAmbiguousMatch(match)}
                    >
                      {owner?.name ?? match.projectId}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="form-actions">
              <button className="button button-quiet" type="button" onClick={cancelDirectoryFlow}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {openDirectoryFlow?.kind === 'unknown' && !pendingNav && (
        <div className="modal-backdrop">
          <div className="modal-card" role="dialog" aria-modal="true" aria-label="Unlinked directory">
            <h2>This directory isn&apos;t linked to a project yet</h2>
            <p className="muted-copy">
              <code>{openDirectoryFlow.path}</code>
            </p>
            {openDirectoryFlow.mode === 'choose' && (
              <div className="form-actions">
                <button
                  className="button button-primary"
                  type="button"
                  onClick={() =>
                    setOpenDirectoryFlow(
                      openDirectoryFlow.kind === 'unknown' ? { ...openDirectoryFlow, mode: 'create' } : openDirectoryFlow,
                    )
                  }
                >
                  Create project
                </button>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() =>
                    setOpenDirectoryFlow(
                      openDirectoryFlow.kind === 'unknown' ? { ...openDirectoryFlow, mode: 'link' } : openDirectoryFlow,
                    )
                  }
                >
                  Link to existing project
                </button>
                <button className="button button-quiet" type="button" onClick={cancelDirectoryFlow}>
                  Cancel
                </button>
              </div>
            )}
            {openDirectoryFlow.mode === 'create' && (
              <form onSubmit={(event) => void submitDirectoryFlowCreate(event)}>
                <label>
                  Project name
                  <input
                    value={directoryFlowProjectDraft.name}
                    onChange={(event) =>
                      setDirectoryFlowProjectDraft({ ...directoryFlowProjectDraft, name: event.target.value })
                    }
                    maxLength={200}
                    required
                  />
                </label>
                <label>
                  Description
                  <textarea
                    value={directoryFlowProjectDraft.description}
                    onChange={(event) =>
                      setDirectoryFlowProjectDraft({
                        ...directoryFlowProjectDraft,
                        description: event.target.value,
                      })
                    }
                    rows={3}
                  />
                </label>
                {directoryFlowError && (
                  <div className="save-error" role="alert">
                    {directoryFlowError}
                  </div>
                )}
                <div className="form-actions">
                  <button className="button button-primary" type="submit" disabled={directoryFlowSaving}>
                    {directoryFlowSaving ? 'Creating…' : 'Create and link'}
                  </button>
                  <button className="button button-quiet" type="button" onClick={cancelDirectoryFlow}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {openDirectoryFlow.mode === 'link' && (
              <>
                {projects.length === 0 ? (
                  <p className="muted-copy">No existing projects to link to.</p>
                ) : (
                  <ul className="directory-choice-list">
                    {projects.map((project) => (
                      <li key={project.id}>
                        <button
                          className="button button-secondary"
                          type="button"
                          disabled={directoryFlowSaving}
                          onClick={() => void submitDirectoryFlowLink(project.id)}
                        >
                          {project.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {directoryFlowError && (
                  <div className="save-error" role="alert">
                    {directoryFlowError}
                  </div>
                )}
                <div className="form-actions">
                  <button className="button button-quiet" type="button" onClick={cancelDirectoryFlow}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {openDirectoryFlow?.kind === 'linkRetry' && !pendingNav && (
        <div className="modal-backdrop">
          <div className="modal-card" role="dialog" aria-modal="true" aria-label="Finish linking the new project">
            <h2>Project created, but linking the directory failed</h2>
            <p className="muted-copy">
              The new project was created successfully. Retry linking{' '}
              <code>{openDirectoryFlow.path}</code> to it — this will not create a duplicate
              project.
            </p>
            <div className="save-error" role="alert">
              {openDirectoryFlow.error}
            </div>
            <div className="form-actions">
              <button className="button button-primary" type="button" onClick={() => void retryDirectoryFlowLink()}>
                Retry linking
              </button>
              <button
                className="button button-quiet"
                type="button"
                onClick={() => {
                  const projectId = openDirectoryFlow.projectId;
                  cancelDirectoryFlow();
                  switchToProject(projectId);
                }}
              >
                Open project without linking
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingNav && (
        <div className="modal-backdrop">
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-label="Unsaved changes"
            ref={navDialogRef}
            tabIndex={-1}
          >
            <h2>Unsaved changes</h2>
            <p className="muted-copy">
              You have {joinDirtyLabels(pendingNavKinds.map(dirtyKindLabel))}. Save{' '}
              {dirtyKindsPronoun(pendingNavKinds)}, discard {dirtyKindsPronoun(pendingNavKinds)}, or
              stay here.
            </p>
            {navTransitionError && (
              <div className="save-error" role="alert">
                {navTransitionError}
              </div>
            )}
            <div className="form-actions">
              <button
                className="button button-primary"
                type="button"
                disabled={navTransitionSaving}
                onClick={() => {
                  setNavTransitionSaving(true);
                  setNavTransitionError(null);
                  const token = navTransitionTokenRef.current;
                  const kindsToSave = pendingNavKinds;
                  const runSave = (kind: DirtyKind): Promise<boolean> =>
                    kind === 'task'
                      ? saveTask()
                      : kind === 'comment'
                        ? addComment()
                        : (studioRef.current?.save() ?? Promise.resolve(true));
                  void Promise.all(
                    kindsToSave.map((kind) => runSave(kind).then((ok) => ({ kind, ok }))),
                  )
                    .then((results) => {
                      // Cancelled or discarded past while this save was in flight: never let a
                      // late success execute a nav the owner already backed away from.
                      if (navTransitionTokenRef.current !== token) return;
                      const failedKinds = results
                        .filter((result) => !result.ok)
                        .map((result) => result.kind);
                      if (failedKinds.length === 0) {
                        const run = pendingNav;
                        dismissPendingNav();
                        run?.();
                      } else {
                        // Stay in the source context: whichever kind(s) already saved successfully
                        // are done — never re-saved, never re-discarded on a later retry. Only the
                        // failed kind(s) remain outstanding, so Save-all here retries just those,
                        // with no duplicate comment/task-creation/version (Correction 4, F2a).
                        setPendingNavKinds(failedKinds);
                        setNavTransitionError(
                          failedKinds.includes('studio')
                            ? 'Save failed — see the error in Instruction Studio for details.'
                            : 'Save failed — see the error above for details.',
                        );
                      }
                    })
                    .finally(() => {
                      if (navTransitionTokenRef.current === token) setNavTransitionSaving(false);
                    });
                }}
              >
                {navTransitionSaving ? 'Saving…' : 'Save changes'}
              </button>
              <button
                className="button button-danger"
                type="button"
                onClick={() => {
                  for (const kind of pendingNavKinds) {
                    if (kind === 'task') {
                      cancelTaskEditor();
                      setTaskSaveError(null);
                      setTaskRetry(null);
                    } else if (kind === 'comment') {
                      setCommentDraft('');
                      setCommentSaveError(null);
                      setRetryCommentDraft(null);
                    } else {
                      studioRef.current?.discard();
                    }
                  }
                  const run = pendingNav;
                  dismissPendingNav();
                  run?.();
                }}
              >
                Discard changes
              </button>
              <button className="button button-quiet" type="button" onClick={cancelPendingNav}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

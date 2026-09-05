import { useEffect, useMemo, useRef, useState } from 'react';

import {
  assertNoParentCycle,
  getTaskAncestorIds,
  getTaskSubtreeIds,
  TASK_STATUSES,
  type Database,
} from '../data';
import type { HarnessClassification, InjectionPreview } from '../harness/types';
import { InstructionStudio } from '../instructions/InstructionStudio';
import type { InstructionStudioHandle } from '../instructions/InstructionStudio';
import { INSTRUCTION_ROLES } from '../instructions/types';
import type { ActiveVersionIds, InstructionRole, ProviderFamily } from '../instructions/types';
import { useFocusTrap } from '../instructions/useFocusTrap';
import { DirectoryContextPanel } from '../settings/DirectoryContextPanel';
import { labelFromPath } from '../settings/directoryContextManager';
import type { ResumeSelectionPatch } from '../settings/directoryContextManager';
import type { DirectoryContextRecord } from '../settings/state';
import { useDirectoryContextState } from '../settings/useDirectoryContextState';
import type { TrackerServices } from './contracts';
import type { TaskStatus } from '../data';
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
  const [commentDraft, setCommentDraft] = useState('');
  const [commentSaving, setCommentSaving] = useState(false);
  const [commentSaveError, setCommentSaveError] = useState<string | null>(null);
  const [retryCommentDraft, setRetryCommentDraft] = useState<string | null>(null);
  const studioRef = useRef<InstructionStudioHandle>(null);
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);
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

  function guardedNav(action: () => void, onCancel?: () => void) {
    if (primaryView === 'instructions' && studioRef.current?.isDirty()) {
      // Busy belongs to the dialog currently open, not to whatever a previous one left behind —
      // a stale Saving state (a prior success or a cancelled-but-still-in-flight save) must never
      // carry into this new dialog and disable its Save button forever.
      setNavTransitionSaving(false);
      setNavTransitionError(null);
      navTransitionTokenRef.current += 1;
      pendingNavCancelRef.current = onCancel ?? null;
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
   */
  function guardTransition(): Promise<boolean> {
    if (primaryView === 'instructions' && studioRef.current?.isDirty()) {
      return new Promise<boolean>((resolve) => {
        setNavTransitionSaving(false);
        setNavTransitionError(null);
        navTransitionTokenRef.current += 1;
        pendingNavCancelRef.current = () => resolve(false);
        setPendingNav(() => () => resolve(true));
      });
    }
    return Promise.resolve(true);
  }

  /** Dismisses the pending-nav dialog and invalidates any in-flight Save resolution for it. */
  function dismissPendingNav() {
    navTransitionTokenRef.current += 1;
    setPendingNav(null);
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
    setTaskEditor(null);
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
    // under the newly selected project while its own list is still loading or if it fails.
    setTasks([]);
    let mounted = true;
    setContentError(null);
    setFocusedTaskId(null);
    void repositories.tasks
      .list(selectedProjectId, { includeArchived: true })
      .then((result) => {
        if (!mounted) return;
        setTasks(result);
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

  /** Home's per-role Retry action: re-resolves just that one role, leaving the others as-is. */
  function retryInstructionStatus(role: InstructionRole) {
    if (!selectedProject) return;
    const projectId = selectedProject.id;
    const root = activeDirectoryRoot;
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
    void directory.manager
      .updateResumeSelection(state, patch)
      .then(directory.setState)
      // Best-effort device-local convenience state: a failed write here (e.g. disk full) must
      // never surface as an unhandled rejection or block navigation — the owner simply resumes
      // to an older position next launch, the same graceful degradation `loadState` already uses.
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setTaskDraft({ ...emptyTaskDraft, parent_task_id: parentTaskId });
    setTaskSaveError(null);
    setTaskRetry(null);
    setTaskEditor('new');
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
    setSelectedTaskId(task.id);
    setTaskDraft({
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      parent_task_id: task.parent_task_id,
    });
    setTaskSaveError(null);
    setTaskRetry(null);
    setTaskEditor('edit');
  }

  async function saveTask(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const draft = { ...taskDraft, title: taskDraft.title.trim(), description: taskDraft.description.trim() };
    if (!draft.title) {
      setTaskSaveError('Task title is required.');
      return;
    }
    if (!selectedProject) return;
    // Captured now, checked again once the write resolves: a completion for a project the owner
    // has since navigated away from must never select a task under whichever project is current.
    const projectIdAtStart = selectedProject.id;
    const editingTask = taskEditor === 'edit' ? selectedTask : null;
    if (editingTask) {
      try {
        assertNoParentCycle(tasks, editingTask.id, draft.parent_task_id);
      } catch (error) {
        setTaskSaveError(errorMessage(error));
        return;
      }
    }
    setTaskSaving(true);
    setTaskSaveError(null);
    setTaskRetry(null);
    const existingTaskDraft = taskEditor === 'new' && selectedTask?.id.startsWith('draft-task-') ? selectedTask : null;
    const optimisticId = editingTask?.id ?? existingTaskDraft?.id ?? draftId('task');
    const optimisticTask: Task = {
      id: optimisticId,
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
    };
    setTasks((current) => {
      const existing = current.some((task) => task.id === optimisticId);
      return existing ? current.map((task) => (task.id === optimisticId ? optimisticTask : task)) : [...current, optimisticTask];
    });
    setSelectedTaskId(optimisticId);
    const input: TaskInsert = {
      project_id: selectedProject.id,
      title: draft.title,
      description: draft.description,
      status: draft.status,
      priority: draft.priority,
      parent_task_id: draft.parent_task_id,
    };
    try {
      const saved = editingTask
        ? await repositories.tasks.update(editingTask.id, input)
        : await repositories.tasks.create(input);
      setTasks((current) => current.map((task) => (task.id === optimisticId ? saved : task)));
      if (selectedProjectIdRef.current === projectIdAtStart) {
        setSelectedTaskId(saved.id);
        setTaskEditor(null);
      }
    } catch (error) {
      if (selectedProjectIdRef.current === projectIdAtStart) setTaskSaveError(errorMessage(error));
    } finally {
      setTaskSaving(false);
    }
  }

  async function moveTask(task: Task, status: TaskStatus) {
    const projectIdAtStart = selectedProjectIdRef.current;
    const optimistic = { ...task, status, updated_at: new Date().toISOString() };
    setTasks((current) => current.map((item) => item.id === task.id ? optimistic : item));
    setTaskSaveError(null);
    setTaskRetry({ kind: 'move', taskId: task.id, status });
    try {
      const saved = await repositories.tasks.update(task.id, { status });
      // A completion for a project the owner has since left must never touch whichever project's
      // retry banner/task list is showing now — the moved task no longer even exists in `tasks`
      // once that project switch cleared and reloaded it, but the shared `taskRetry` flag does.
      if (selectedProjectIdRef.current === projectIdAtStart) {
        setTasks((current) => current.map((item) => item.id === task.id ? saved : item));
        setTaskRetry(null);
      }
    } catch (error) {
      if (selectedProjectIdRef.current === projectIdAtStart) {
        setTaskSaveError(errorMessage(error));
        setSelectedTaskId(task.id);
      }
    }
  }

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
        setTaskEditor(null);
      }
      if (focusedTaskId && subtreeIds.has(focusedTaskId)) {
        setFocusedTaskId(null);
      }
    }
    try {
      const saved = await repositories.tasks.archive(task.id);
      if (selectedProjectIdRef.current === projectIdAtStart) {
        const savedById = new Map(saved.map((item) => [item.id, item]));
        setTasks((current) => current.map((item) => savedById.get(item.id) ?? item));
        setTaskRetry(null);
      }
    } catch (error) {
      if (selectedProjectIdRef.current === projectIdAtStart) setTaskSaveError(errorMessage(error));
    }
  }

  async function retryTaskSave() {
    if (!taskRetry) return;
    const task = tasks.find((item) => item.id === taskRetry.taskId);
    if (!task) return;
    if (taskRetry.kind === 'move' && taskRetry.status) {
      await moveTask(task, taskRetry.status);
    } else {
      await archiveTask(task);
    }
  }

  async function addComment(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!selectedTask || !selectedProject || !commentDraft.trim()) return;
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
    } catch (error) {
      if (gen === commentsGenRef.current) setCommentSaveError(errorMessage(error));
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
    setTaskEditor(null);
  }

  function switchToProject(projectId: string) {
    guardedNav(() => applyProjectSwitch(projectId));
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
                  onStateChange={directory.setState}
                  projectId={selectedProject.id}
                  beforeChange={guardedNav}
                />
              )}
              <section className="outliner-section" aria-labelledby="outliner-heading">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Task hierarchy</p>
                    <h2 id="outliner-heading">See the work in context.</h2>
                  </div>
                  <button className="button button-secondary" type="button" onClick={() => openNewTask()}>
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
                    onEdit={openEditTask}
                    onFocus={focusTask}
                    onNewChild={openNewTask}
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
              {taskEditor ? <TaskForm draft={taskDraft} tasks={visibleTasks} taskId={taskEditor === 'edit' ? selectedTask?.id : undefined} saving={taskSaving} error={taskSaveError} isNew={taskEditor === 'new'} onChange={setTaskDraft} onSubmit={(event) => void saveTask(event)} onCancel={() => setTaskEditor(null)} onRetry={() => void saveTask()} /> : selectedTask ? <>
                <div className="task-summary"><p className="eyebrow">Selected task</p><h2>{selectedTask.title}</h2><p>{selectedTask.description || 'No task description yet.'}</p><button className="button button-secondary" type="button" onClick={() => openEditTask(selectedTask)}>Edit task</button></div>
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
              You have unsaved instruction edits. Save them, discard them, or stay here.
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
                  void (studioRef.current?.save() ?? Promise.resolve(true))
                    .then((ok) => {
                      // Cancelled or discarded past while this save was in flight: never let a
                      // late success execute a nav the owner already backed away from.
                      if (navTransitionTokenRef.current !== token) return;
                      if (ok) {
                        const run = pendingNav;
                        dismissPendingNav();
                        run?.();
                      } else {
                        setNavTransitionError('Save failed — see the error in Instruction Studio for details.');
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
                  studioRef.current?.discard();
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

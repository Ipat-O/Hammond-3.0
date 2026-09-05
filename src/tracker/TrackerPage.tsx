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
import type { InstructionRole, ProviderFamily } from '../instructions/types';
import { useFocusTrap } from '../instructions/useFocusTrap';
import { DirectoryContextPanel } from '../settings/DirectoryContextPanel';
import { labelFromPath } from '../settings/directoryContextManager';
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
  onOpenInstructions: () => void;
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
          <button className="button button-quiet" type="button" onClick={onOpenInstructions}>
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
                {!hasDirectory ? (
                  <span className="muted-copy">Link a directory to check status</span>
                ) : status?.loading ? (
                  <span className="muted-copy">Checking…</span>
                ) : status?.error ? (
                  <span className="instruction-status-error">{status.error}</span>
                ) : status?.preview ? (
                  <>
                    <span
                      className={`instruction-status-badge instruction-status-${status.preview.classification.kind}`}
                    >
                      {classificationBadge(status.preview.classification)}
                    </span>
                    {status.preview.classification.kind === 'Missing' && (
                      <button className="button button-small" type="button" onClick={onOpenInstructions}>
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
  const [resumeReady, setResumeReady] = useState(false);
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
  }, [repositories.projects]);

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
          const resumedTask = result.find((task) => task.id === pendingResume.taskId);
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

  useEffect(() => {
    if (!selectedTask || selectedTask.id.startsWith('draft-')) {
      setComments([]);
      setCommentsLoading(false);
      return;
    }
    let mounted = true;
    setCommentsLoading(true);
    void repositories.memory
      .listComments(selectedTask.id)
      .then((result) => mounted && setComments(result))
      .catch((error: unknown) => mounted && setCommentSaveError(errorMessage(error)))
      .finally(() => mounted && setCommentsLoading(false));
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

  // Instruction presence per role: assignment always shown once known; classification (which
  // needs a directory to inspect) only attempted when one is actually linked for THIS project.
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
        INSTRUCTION_ROLES.map((role) => [role, { provider: null, preview: null, loading: true, error: null }]),
      ) as Record<InstructionRole, InstructionStatus>,
    );
    void Promise.all(
      INSTRUCTION_ROLES.map(async (role) => {
        try {
          const assignment = await services.assignments.getAssignment({ projectId, role });
          if (!assignment) {
            return [role, { provider: null, preview: null, loading: false, error: null }] as const;
          }
          if (!root) {
            return [
              role,
              { provider: assignment.provider, preview: null, loading: false, error: null },
            ] as const;
          }
          try {
            const preview = await services.harness.preview({ root, projectId, role });
            return [
              role,
              { provider: assignment.provider, preview, loading: false, error: null },
            ] as const;
          } catch (error) {
            return [
              role,
              { provider: assignment.provider, preview: null, loading: false, error: errorMessage(error) },
            ] as const;
          }
        } catch (error) {
          return [role, { provider: null, preview: null, loading: false, error: errorMessage(error) }] as const;
        }
      }),
    ).then((entries) => {
      if (!mounted) return;
      setInstructionStatuses(Object.fromEntries(entries) as Record<InstructionRole, InstructionStatus>);
    });
    return () => {
      mounted = false;
    };
  }, [selectedProject, activeDirectoryRoot, services.assignments, services.harness]);

  // Persists the resume position (project/task/screen) whenever it actually changes, but only
  // once the initial restore above has applied — never overwriting a not-yet-restored saved
  // position with the pre-restore defaults. `directory.state` is read through a ref (kept fresh
  // every render, above) rather than listed as a dependency: including it would re-fire this
  // effect the moment its own write updates that state, looping forever.
  useEffect(() => {
    if (!resumeReady) return;
    const state = directoryStateRef.current;
    if (!state) return;
    void directory.manager
      .updateResumeSelection(state, {
        selectedProjectId,
        selectedTaskId,
        resumeScreen: primaryView,
      })
      .then(directory.setState)
      // Best-effort device-local convenience state: a failed write here (e.g. disk full) must
      // never surface as an unhandled rejection or block navigation — the owner simply resumes
      // to an older position next launch, the same graceful degradation `loadState` already uses.
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeReady, selectedProjectId, selectedTaskId, primaryView, directory.manager]);

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
      setSelectedTaskId(saved.id);
      setTaskEditor(null);
    } catch (error) {
      setTaskSaveError(errorMessage(error));
    } finally {
      setTaskSaving(false);
    }
  }

  async function moveTask(task: Task, status: TaskStatus) {
    const optimistic = { ...task, status, updated_at: new Date().toISOString() };
    setTasks((current) => current.map((item) => item.id === task.id ? optimistic : item));
    setTaskSaveError(null);
    setTaskRetry({ kind: 'move', taskId: task.id, status });
    try {
      const saved = await repositories.tasks.update(task.id, { status });
      setTasks((current) => current.map((item) => item.id === task.id ? saved : item));
      setTaskRetry(null);
    } catch (error) {
      setTaskSaveError(errorMessage(error));
      setSelectedTaskId(task.id);
    }
  }

  async function archiveTask(task: Task) {
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
      const savedById = new Map(saved.map((item) => [item.id, item]));
      setTasks((current) => current.map((item) => savedById.get(item.id) ?? item));
      setTaskRetry(null);
    } catch (error) {
      setTaskSaveError(errorMessage(error));
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
    setCommentSaving(true);
    setCommentSaveError(null);
    setRetryCommentDraft(body);
    const optimisticId = draftId('comment');
    const optimisticComment: Comment = {
      id: optimisticId,
      owner_id: ownerId,
      project_id: selectedProject.id,
      task_id: selectedTask.id,
      body,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    setComments((current) => [...current, optimisticComment]);
    try {
      const saved = await repositories.memory.addComment({ project_id: selectedProject.id, task_id: selectedTask.id, body });
      setComments((current) => current.map((comment) => comment.id === optimisticId ? saved : comment));
      setCommentDraft('');
      setRetryCommentDraft(null);
    } catch (error) {
      setCommentSaveError(errorMessage(error));
    } finally {
      setCommentSaving(false);
    }
  }

  const retryComment = () => {
    if (retryCommentDraft !== null) void addComment();
  };

  function switchToProject(projectId: string) {
    guardedNav(() => {
      setSelectedProjectId(projectId);
      setSelectedTaskId(null);
      setFocusedTaskId(null);
      setExpandedTaskIds(new Set());
      setTaskEditor(null);
    });
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

  function goToInstructions() {
    guardedNav(() => navigateToScreen('instructions'));
  }

  function closeActiveDirectory() {
    if (!directory.state) return;
    const state = directory.state;
    guardedNav(() => {
      void directory.manager
        .closeActive(state)
        .then(directory.setState)
        .catch((error: unknown) => setOpenDirectoryError(errorMessage(error)));
    });
  }

  async function openDirectory() {
    if (!directory.state) return;
    setOpenDirectoryError(null);
    setOpenDirectoryBusy(true);
    try {
      const path = await directory.manager.pickDirectory();
      if (path === null) return;
      const state = directory.state;
      const matches = directory.manager.findContextsForPath(state, path);
      if (matches.length === 1) {
        const match = matches[0];
        guardedNav(() => {
          void directory.manager
            .setActive(state, match.id)
            .then(directory.setState)
            .catch((error: unknown) => setOpenDirectoryError(errorMessage(error)));
          switchToProject(match.projectId);
        });
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
      setOpenDirectoryError(errorMessage(error));
    } finally {
      setOpenDirectoryBusy(false);
    }
  }

  function resolveAmbiguousMatch(match: DirectoryContextRecord) {
    if (!directory.state) return;
    const state = directory.state;
    setOpenDirectoryFlow(null);
    guardedNav(() => {
      void directory.manager
        .setActive(state, match.id)
        .then(directory.setState)
        .catch((error: unknown) => setOpenDirectoryError(errorMessage(error)));
      switchToProject(match.projectId);
    });
  }

  async function submitDirectoryFlowCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!openDirectoryFlow || openDirectoryFlow.kind !== 'unknown' || !directory.state) return;
    const path = openDirectoryFlow.path;
    const name = directoryFlowProjectDraft.name.trim();
    if (!name) {
      setDirectoryFlowError('Project name is required.');
      return;
    }
    setDirectoryFlowSaving(true);
    setDirectoryFlowError(null);
    try {
      const created = await repositories.projects.create({
        name,
        description: directoryFlowProjectDraft.description.trim(),
      });
      setProjects((current) => [created, ...current]);
      try {
        const { state: nextState } = await directory.manager.linkDirectory(
          directory.state,
          created.id,
          path,
        );
        directory.setState(nextState);
        setOpenDirectoryFlow(null);
        switchToProject(created.id);
      } catch (linkError) {
        // The project already exists — never re-create it on retry, only retry the link.
        setOpenDirectoryFlow({
          kind: 'linkRetry',
          path,
          projectId: created.id,
          error: errorMessage(linkError),
        });
      }
    } catch (error) {
      setDirectoryFlowError(errorMessage(error));
    } finally {
      setDirectoryFlowSaving(false);
    }
  }

  async function retryDirectoryFlowLink() {
    if (!openDirectoryFlow || openDirectoryFlow.kind !== 'linkRetry' || !directory.state) return;
    const { path, projectId } = openDirectoryFlow;
    try {
      const { state: nextState } = await directory.manager.linkDirectory(directory.state, projectId, path);
      directory.setState(nextState);
      setOpenDirectoryFlow(null);
      switchToProject(projectId);
    } catch (error) {
      setOpenDirectoryFlow({ kind: 'linkRetry', path, projectId, error: errorMessage(error) });
    }
  }

  async function submitDirectoryFlowLink(projectId: string) {
    if (!openDirectoryFlow || openDirectoryFlow.kind !== 'unknown' || !directory.state) return;
    const path = openDirectoryFlow.path;
    setDirectoryFlowSaving(true);
    setDirectoryFlowError(null);
    try {
      const { state: nextState } = await directory.manager.linkDirectory(directory.state, projectId, path);
      directory.setState(nextState);
      setOpenDirectoryFlow(null);
      switchToProject(projectId);
    } catch (error) {
      setDirectoryFlowError(errorMessage(error));
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
            onClick={() => guardedNav(() => navigateToScreen('instructions'))}
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
          />
        ) : (
          <p className="sidebar-empty">Select a project to manage its instructions.</p>
        )}
        </>
      )}
      </section>

      {openDirectoryFlow?.kind === 'ambiguous' && (
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
                      onClick={() => resolveAmbiguousMatch(match)}
                    >
                      {owner?.name ?? match.projectId}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="form-actions">
              <button className="button button-quiet" type="button" onClick={() => setOpenDirectoryFlow(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {openDirectoryFlow?.kind === 'unknown' && (
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
                <button className="button button-quiet" type="button" onClick={() => setOpenDirectoryFlow(null)}>
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
                  <button className="button button-quiet" type="button" onClick={() => setOpenDirectoryFlow(null)}>
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
                  <button className="button button-quiet" type="button" onClick={() => setOpenDirectoryFlow(null)}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {openDirectoryFlow?.kind === 'linkRetry' && (
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
                  setOpenDirectoryFlow(null);
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

import { useEffect, useMemo, useRef, useState } from 'react';

import { assertNoParentCycle, getTaskSubtreeIds, TASK_STATUSES, type Database } from '../data';
import { InstructionStudio } from '../instructions/InstructionStudio';
import type { InstructionStudioHandle } from '../instructions/InstructionStudio';
import { DirectoryContextPanel } from '../settings/DirectoryContextPanel';
import { useDirectoryContextState } from '../settings/useDirectoryContextState';
import type { TrackerServices } from './contracts';
import type { TaskStatus } from '../data';

type PrimaryView = 'workspace' | 'instructions';

type Project = Database['public']['Tables']['projects']['Row'];
type ProjectInsert = Database['public']['Tables']['projects']['Insert'];
type Task = Database['public']['Tables']['tasks']['Row'];
type TaskInsert = Database['public']['Tables']['tasks']['Insert'];
type Comment = Database['public']['Tables']['comments']['Row'];
type TaskRetry = { kind: 'move' | 'archive'; taskId: string; status?: TaskStatus };

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

interface TrackerPageProps {
  services: TrackerServices;
  ownerId: string;
  ownerEmail?: string;
  onSignOut: () => void;
}

export function TrackerPage({ services, ownerId, ownerEmail, onSignOut }: TrackerPageProps) {
  const repositories = services.repositories;
  const directory = useDirectoryContextState(services.directoryContext);
  const resumeAppliedRef = useRef(false);
  const [primaryView, setPrimaryView] = useState<PrimaryView>('workspace');
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

  function guardedNav(action: () => void) {
    if (primaryView === 'instructions' && studioRef.current?.isDirty()) {
      setNavTransitionError(null);
      setPendingNav(() => action);
    } else {
      action();
    }
  }

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

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    void repositories.projects
      .list({ includeArchived: true })
      .then((result) => {
        if (!mounted) return;
        setProjects(result);
        setSelectedProjectId((current) => current ?? result.find((project) => !project.archived_at)?.id ?? result[0]?.id ?? null);
      })
      .catch((error: unknown) => mounted && setContentError(errorMessage(error)))
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, [repositories.projects]);

  // Cold-restart resume: once both the project list and local directory-context state have
  // loaded, prefer whichever project the last-open directory context belongs to over the
  // ordinary "first project" default. Applied at most once per mount.
  useEffect(() => {
    if (resumeAppliedRef.current) return;
    if (!directory.state || projects.length === 0) return;
    resumeAppliedRef.current = true;
    const lastContextId = directory.state.lastOpenContextId;
    if (!lastContextId) return;
    const lastContext = directory.manager.findContext(directory.state, lastContextId);
    if (lastContext && projects.some((project) => project.id === lastContext.projectId)) {
      setSelectedProjectId(lastContext.projectId);
    }
  }, [directory.state, directory.manager, projects]);

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
    setExpandedTaskIds(new Set());
    void repositories.tasks
      .list(selectedProjectId, { includeArchived: true })
      .then((result) => {
        if (!mounted) return;
        setTasks(result);
        setSelectedTaskId((current) => (current && result.some((task) => task.id === current) ? current : null));
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
            className={`nav-item ${primaryView === 'workspace' ? 'nav-item-active' : ''}`}
            onClick={() => guardedNav(() => setPrimaryView('workspace'))}
          >
            <span className="nav-icon" aria-hidden="true">◈</span>Workspace
          </button>
          <button
            type="button"
            className={`nav-item ${primaryView === 'instructions' ? 'nav-item-active' : ''}`}
            onClick={() => guardedNav(() => setPrimaryView('instructions'))}
          >
            <span className="nav-icon" aria-hidden="true">▤</span>Instructions
          </button>
          <span className="nav-item nav-item-muted"><span className="nav-icon" aria-hidden="true">⚙</span>Settings</span>
        </nav>
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
              onClick={() =>
                guardedNav(() => {
                  setSelectedProjectId(project.id);
                  setSelectedTaskId(null);
                  setFocusedTaskId(null);
                  setExpandedTaskIds(new Set());
                  setTaskEditor(null);
                })
              }
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
        {loading ? (
          <div className="empty-state"><p className="eyebrow">Loading workspace</p><h2>Gathering your projects…</h2></div>
        ) : !selectedProject ? (
          <div className="empty-state-grid">
            <section className="welcome-card">
              <div className="welcome-copy">
                <p className="card-kicker">Hammond is ready</p>
                <h2>A calm place for project context.</h2>
                <p>Create your first project, then add work that can move from backlog to shipped.</p>
                <button className="button button-primary" type="button" onClick={openNewProject}>Create your first project</button>
              </div>
              <div className="welcome-orbit" aria-hidden="true"><span className="orbit-ring orbit-ring-large" /><span className="orbit-ring orbit-ring-small" /><span className="orbit-core">H</span></div>
            </section>
            <section className="boundary-section" aria-labelledby="boundary-heading">
              <div className="section-heading"><div><p className="eyebrow">Foundation map</p><h2 id="boundary-heading">Clear boundaries, ready to extend.</h2></div><span className="section-count">03 modules</span></div>
              <div className="boundary-grid">
                <article className="boundary-card"><span className="boundary-index">01</span><h3>Local workspace</h3><p>Native filesystem commands stay behind a typed command surface.</p></article>
                <article className="boundary-card"><span className="boundary-index">02</span><h3>Project memory</h3><p>Owner-scoped project data stays behind the repository boundary.</p></article>
                <article className="boundary-card"><span className="boundary-index">03</span><h3>Local settings</h3><p>Device-specific settings remain separate from durable records.</p></article>
              </div>
            </section>
          </div>
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
            directoryRoot={
              directory.state
                ? (directory.manager
                    .contextsForProject(directory.state, selectedProject.id)
                    .find((context) => context.id === directory.state?.lastOpenContextId) ??
                    directory.manager.contextsForProject(directory.state, selectedProject.id)[0] ??
                    null)?.path ?? null
                : null
            }
          />
        ) : (
          <p className="sidebar-empty">Select a project to manage its instructions.</p>
        )}
        </>
      )}
      </section>

      {pendingNav && (
        <div className="modal-backdrop">
          <div className="modal-card" role="dialog" aria-modal="true" aria-label="Unsaved changes">
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
                  void (studioRef.current?.save() ?? Promise.resolve(true))
                    .then((ok) => {
                      if (ok) {
                        const run = pendingNav;
                        setPendingNav(null);
                        run?.();
                      } else {
                        setNavTransitionError('Save failed — see the error in Instruction Studio for details.');
                      }
                    })
                    .finally(() => setNavTransitionSaving(false));
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
                  setPendingNav(null);
                  run?.();
                }}
              >
                Discard changes
              </button>
              <button className="button button-quiet" type="button" onClick={() => setPendingNav(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

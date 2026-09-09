import type { Database } from './database.types';

export const TASK_STATUSES = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'done',
  'merged',
  'shipped',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskRecord = Database['public']['Tables']['tasks']['Row'];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && TASK_STATUSES.includes(value as TaskStatus);
}

export function assertValidTaskStatus(value: unknown): asserts value is TaskStatus {
  if (!isTaskStatus(value)) {
    throw new Error(`Invalid task status: ${String(value)}`);
  }
}

/**
 * Thrown when a checked task write's `expectedRevision` no longer matches the durable row —
 * someone else (another UI session, or an agent connection) saved a newer version first. Maps
 * from Postgres's standard "could not serialize" SQLSTATE (40001), which `tasks_update_checked`/
 * `tasks_archive_subtree_checked` raise deliberately for exactly this case.
 */
export class TaskRevisionConflictError extends Error {
  readonly code = 'task_revision_conflict';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TaskRevisionConflictError';
  }
}

/** Maps a raw Postgres/PostgREST error from a checked task-write RPC into a typed conflict error;
 * any other error passes through unchanged (the caller's existing generic error handling still
 * applies to it). */
export function toTaskWriteError(error: unknown): unknown {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
  if (code === '40001') {
    return new TaskRevisionConflictError(
      'This task changed elsewhere since it was loaded. Reload it, then try saving again.',
      { cause: error },
    );
  }
  return error;
}

export function assertNoParentCycle(
  tasks: ReadonlyArray<Pick<TaskRecord, 'id' | 'parent_task_id'>>,
  taskId: string,
  parentTaskId: string | null | undefined,
): void {
  if (parentTaskId == null) return;
  if (parentTaskId === taskId) {
    throw new Error('A task cannot be its own parent');
  }

  const parentById = new Map(tasks.map((task) => [task.id, task.parent_task_id]));
  parentById.set(taskId, parentTaskId);

  const visited = new Set<string>();
  let currentId: string | null = parentTaskId;
  while (currentId) {
    if (currentId === taskId) {
      throw new Error('Parent relationship would create a cycle');
    }
    if (visited.has(currentId)) {
      throw new Error('Parent relationships already contain a cycle');
    }
    visited.add(currentId);
    currentId = parentById.get(currentId) ?? null;
  }
}

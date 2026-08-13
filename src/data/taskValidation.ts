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

export const MAX_TASK_NESTING_DEPTH = 1;

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && TASK_STATUSES.includes(value as TaskStatus);
}

export function assertValidTaskStatus(value: unknown): asserts value is TaskStatus {
  if (!isTaskStatus(value)) {
    throw new Error(`Invalid task status: ${String(value)}`);
  }
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

export function assertTaskDepth(
  tasks: ReadonlyArray<Pick<TaskRecord, 'id' | 'parent_task_id'>>,
  parentTaskId: string | null | undefined,
): void {
  if (parentTaskId == null) return;

  const parentById = new Map(tasks.map((task) => [task.id, task.parent_task_id]));
  const visited = new Set<string>();
  let currentId: string | null = parentTaskId;
  let depth = 0;

  while (currentId) {
    if (visited.has(currentId)) {
      throw new Error('Parent relationships already contain a cycle');
    }
    visited.add(currentId);
    depth += 1;
    if (depth > MAX_TASK_NESTING_DEPTH) {
      throw new Error(
        'Tasks can have at most one level of subtasks. Choose a top-level task as the parent.',
      );
    }
    currentId = parentById.get(currentId) ?? null;
  }
}

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

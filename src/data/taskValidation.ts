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

function measureAncestorDepth(parentById: Map<string, string | null>, taskId: string): number {
  const visited = new Set<string>();
  let depth = 0;
  let currentId: string | null = taskId;

  while (currentId) {
    if (visited.has(currentId)) {
      throw new Error('Parent relationships already contain a cycle');
    }
    visited.add(currentId);
    depth += 1;
    currentId = parentById.get(currentId) ?? null;
  }

  return depth;
}

function measureSubtreeHeight(
  tasks: ReadonlyArray<Pick<TaskRecord, 'id' | 'parent_task_id'>>,
  rootId: string,
): number {
  const childrenById = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.parent_task_id == null) continue;
    const siblings = childrenById.get(task.parent_task_id);
    if (siblings) siblings.push(task.id);
    else childrenById.set(task.parent_task_id, [task.id]);
  }

  const visited = new Set<string>();
  const stack: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  let height = 0;

  while (stack.length > 0) {
    const { id, depth } = stack.pop()!;
    if (visited.has(id)) {
      throw new Error('Parent relationships already contain a cycle');
    }
    visited.add(id);
    height = Math.max(height, depth);
    for (const childId of childrenById.get(id) ?? []) {
      stack.push({ id: childId, depth: depth + 1 });
    }
  }

  return height;
}

export function assertTaskDepth(
  tasks: ReadonlyArray<Pick<TaskRecord, 'id' | 'parent_task_id'>>,
  parentTaskId: string | null | undefined,
  movingTaskId?: string | null,
): void {
  if (parentTaskId == null) return;

  const parentById = new Map(tasks.map((task) => [task.id, task.parent_task_id]));
  const parentChainLength = measureAncestorDepth(parentById, parentTaskId);
  const subtreeHeight = movingTaskId ? measureSubtreeHeight(tasks, movingTaskId) : 0;

  if (parentChainLength + subtreeHeight > MAX_TASK_NESTING_DEPTH) {
    if (subtreeHeight > 0) {
      throw new Error(
        'This task has subtasks and must stay top-level. Move or remove its subtasks before re-parenting it.',
      );
    }
    throw new Error(
      'Tasks can have at most one level of subtasks. Choose a top-level task as the parent.',
    );
  }
}

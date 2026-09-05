import type { TaskRecord } from './taskValidation';

type SubtreeTask = Pick<TaskRecord, 'id' | 'parent_task_id'>;

/**
 * Returns rootTaskId plus every transitive descendant id, walking parent_task_id
 * links from the supplied snapshot. Visited ids are never re-queued, so a
 * pre-existing cycle in stored data terminates instead of looping.
 */
export function getTaskSubtreeIds(
  tasks: ReadonlyArray<SubtreeTask>,
  rootTaskId: string,
): Set<string> {
  const childIdsByParent = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.parent_task_id) continue;
    const childIds = childIdsByParent.get(task.parent_task_id) ?? [];
    childIds.push(task.id);
    childIdsByParent.set(task.parent_task_id, childIds);
  }

  const subtreeIds = new Set<string>([rootTaskId]);
  const pending = [rootTaskId];
  while (pending.length > 0) {
    const parentId = pending.pop();
    if (!parentId) continue;
    for (const childId of childIdsByParent.get(parentId) ?? []) {
      if (subtreeIds.has(childId)) continue;
      subtreeIds.add(childId);
      pending.push(childId);
    }
  }
  return subtreeIds;
}

/**
 * Returns every ancestor id of `taskId` (not including `taskId` itself), walking
 * `parent_task_id` links up from the supplied snapshot. Used to expand a resumed nested task's
 * whole ancestor chain in an outliner so it is actually visible rather than hidden behind
 * collapsed rows. Visited ids are never re-queued, so a pre-existing cycle terminates instead of
 * looping; an unresolvable parent id simply ends the walk early.
 */
export function getTaskAncestorIds(tasks: ReadonlyArray<SubtreeTask>, taskId: string): Set<string> {
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const ancestorIds = new Set<string>();
  let current = byId.get(taskId)?.parent_task_id ?? null;
  while (current && !ancestorIds.has(current)) {
    ancestorIds.add(current);
    current = byId.get(current)?.parent_task_id ?? null;
  }
  return ancestorIds;
}

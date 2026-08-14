import { getTaskSubtreeIds } from './taskSubtree';

type MinimalTask = { id: string; parent_task_id: string | null };

describe('getTaskSubtreeIds', () => {
  it('returns the root plus every descendant at four or more levels', () => {
    const tasks: MinimalTask[] = [
      { id: 'l1', parent_task_id: null },
      { id: 'l2', parent_task_id: 'l1' },
      { id: 'l3', parent_task_id: 'l2' },
      { id: 'l4', parent_task_id: 'l3' },
      { id: 'l5', parent_task_id: 'l4' },
    ];

    expect(getTaskSubtreeIds(tasks, 'l1')).toEqual(new Set(['l1', 'l2', 'l3', 'l4', 'l5']));
  });

  it('computes a mid-tree subtree that excludes ancestors and siblings', () => {
    const tasks: MinimalTask[] = [
      { id: 'root', parent_task_id: null },
      { id: 'sibling', parent_task_id: null },
      { id: 'mid', parent_task_id: 'root' },
      { id: 'mid-sibling', parent_task_id: 'root' },
      { id: 'grandchild', parent_task_id: 'mid' },
    ];

    expect(getTaskSubtreeIds(tasks, 'mid')).toEqual(new Set(['mid', 'grandchild']));
  });

  it('returns only the task itself for a leaf', () => {
    const tasks: MinimalTask[] = [
      { id: 'root', parent_task_id: null },
      { id: 'leaf', parent_task_id: 'root' },
    ];

    expect(getTaskSubtreeIds(tasks, 'leaf')).toEqual(new Set(['leaf']));
  });

  it('reaches active descendants past an already archived intermediate', () => {
    const tasks = [
      { id: 'root', parent_task_id: null, archived_at: null },
      { id: 'archived-mid', parent_task_id: 'root', archived_at: '2026-08-01T00:00:00.000Z' },
      { id: 'active-child', parent_task_id: 'archived-mid', archived_at: null },
    ];

    expect(getTaskSubtreeIds(tasks, 'root')).toEqual(
      new Set(['root', 'archived-mid', 'active-child']),
    );
  });

  it('terminates without looping or duplicating ids on a malformed pre-existing cycle', () => {
    const tasks: MinimalTask[] = [
      { id: 'a', parent_task_id: 'c' },
      { id: 'b', parent_task_id: 'a' },
      { id: 'c', parent_task_id: 'b' },
    ];

    const result = getTaskSubtreeIds(tasks, 'a');
    expect(result).toEqual(new Set(['a', 'b', 'c']));
    expect(result.size).toBe(3);
  });
});

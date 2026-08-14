import { assertNoParentCycle, assertValidTaskStatus } from '../data';

describe('tracker validation', () => {
  it('rejects a parent relationship that would create a cycle', () => {
    const tasks = [
      { id: 'parent', parent_task_id: null },
      { id: 'child', parent_task_id: 'parent' },
      { id: 'grandchild', parent_task_id: 'child' },
    ];

    expect(() => assertNoParentCycle(tasks, 'parent', 'grandchild')).toThrow(/cycle/);
    expect(() => assertNoParentCycle(tasks, 'child', 'child')).toThrow(/own parent/);
  });

  it('rejects invalid statuses while retaining distinct merged and shipped values', () => {
    expect(() => assertValidTaskStatus('queued')).toThrow('Invalid task status: queued');
    expect(() => assertValidTaskStatus('merged')).not.toThrow();
    expect(() => assertValidTaskStatus('shipped')).not.toThrow();
  });

  it('allows a legal hierarchy to nest at least four levels deep', () => {
    const tasks = [
      { id: 'l1', parent_task_id: null },
      { id: 'l2', parent_task_id: 'l1' },
      { id: 'l3', parent_task_id: 'l2' },
      { id: 'l4', parent_task_id: 'l3' },
    ];

    expect(() => assertNoParentCycle(tasks, 'l5', 'l4')).not.toThrow();
    expect(() => assertNoParentCycle(tasks, 'l6', 'l5')).not.toThrow();
  });

  it('rejects a direct self-parent at any nesting depth', () => {
    const tasks = [
      { id: 'l1', parent_task_id: null },
      { id: 'l2', parent_task_id: 'l1' },
      { id: 'l3', parent_task_id: 'l2' },
      { id: 'l4', parent_task_id: 'l3' },
    ];

    expect(() => assertNoParentCycle(tasks, 'l4', 'l4')).toThrow(/own parent/);
  });

  it('rejects re-parenting a task under its own deep descendant', () => {
    const tasks = [
      { id: 'l1', parent_task_id: null },
      { id: 'l2', parent_task_id: 'l1' },
      { id: 'l3', parent_task_id: 'l2' },
      { id: 'l4', parent_task_id: 'l3' },
    ];

    expect(() => assertNoParentCycle(tasks, 'l1', 'l4')).toThrow(/cycle/);
  });

  it('rejects a parent relationship built on a pre-existing cycle in stored data', () => {
    const tasks = [
      { id: 'a', parent_task_id: 'b' },
      { id: 'b', parent_task_id: 'a' },
    ];

    expect(() => assertNoParentCycle(tasks, 'new-task', 'a')).toThrow(/already contain a cycle/);
  });
});

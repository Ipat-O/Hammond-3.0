import { assertNoParentCycle, assertTaskDepth, assertValidTaskStatus } from '../data';

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

  it('rejects a parent that would place a task beyond the two-level product cap', () => {
    const tasks = [
      { id: 'parent', parent_task_id: null },
      { id: 'child', parent_task_id: 'parent' },
    ];

    expect(() => assertTaskDepth(tasks, 'parent')).not.toThrow();
    expect(() => assertTaskDepth(tasks, 'child')).toThrow(
      'Tasks can have at most one level of subtasks',
    );
  });
});

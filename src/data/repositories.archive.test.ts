import type { SupabaseClient } from '@supabase/supabase-js';
import { vi } from 'vitest';

import { TaskRepository } from './repositories';
import type { Database } from './database.types';

type TaskRow = Database['public']['Tables']['tasks']['Row'];

function task(overrides: Partial<TaskRow> & Pick<TaskRow, 'id'>): TaskRow {
  return {
    owner_id: 'owner-1',
    project_id: 'project-1',
    title: overrides.id,
    description: '',
    status: 'backlog',
    priority: 0,
    parent_task_id: null,
    due_at: null,
    archived_at: null,
    created_at: '2026-08-13T08:00:00.000Z',
    updated_at: '2026-08-13T08:00:00.000Z',
    ...overrides,
  };
}

/**
 * Builds a fake Supabase client that resolves `findProjectId`'s
 * `.select('project_id').eq('id', id).single()` chain, resolves the
 * plain `.select('*').eq(...).order(...)` list chain with `tasks`, and
 * records/serves the bulk `.update(...).in('id', ids).select()` chain.
 * `.is()` is intentionally NOT implemented, so a regression that drops
 * `includeArchived: true` from the subtree-discovery list call fails
 * loudly instead of silently filtering archived rows out.
 */
function createArchiveClientMock(options: { tasks: TaskRow[]; projectId: string }) {
  const updateSpy = vi.fn();
  const inSpy = vi.fn();

  function selectChain(data: unknown, singleData?: unknown) {
    return {
      eq: () => selectChain(data, singleData),
      order: () => selectChain(data, singleData),
      single: () => Promise.resolve({ data: singleData, error: null }),
      then: (resolve: (value: { data: unknown; error: null }) => void) =>
        resolve({ data, error: null }),
    };
  }

  const client = {
    from: vi.fn(() => ({
      select: (columns?: string) =>
        columns === 'project_id'
          ? selectChain(undefined, { project_id: options.projectId })
          : selectChain(options.tasks),
      update: (input: Record<string, unknown>) => {
        updateSpy(input);
        return {
          in: (column: string, ids: string[]) => {
            inSpy(column, ids);
            const updatedRows = options.tasks
              .filter((row) => ids.includes(row.id))
              .map((row) => ({ ...row, ...input }));
            return { select: () => Promise.resolve({ data: updatedRows, error: null }) };
          },
        };
      },
    })),
  } as unknown as SupabaseClient<Database>;

  return { client, updateSpy, inSpy };
}

describe('TaskRepository.archive cascades to the complete subtree', () => {
  it('computes the exact transitive id set for a parent at least four levels deep', async () => {
    const tasks = [
      task({ id: 'l1', parent_task_id: null }),
      task({ id: 'l2', parent_task_id: 'l1' }),
      task({ id: 'l3', parent_task_id: 'l2' }),
      task({ id: 'l4', parent_task_id: 'l3' }),
      task({ id: 'l5', parent_task_id: 'l4' }),
    ];
    const { client, inSpy } = createArchiveClientMock({ tasks, projectId: 'project-1' });
    const repository = new TaskRepository(client);

    await repository.archive('l1');

    expect(inSpy).toHaveBeenCalledTimes(1);
    const [, ids] = inSpy.mock.calls[0] as [string, string[]];
    expect(new Set(ids)).toEqual(new Set(['l1', 'l2', 'l3', 'l4', 'l5']));
  });

  it('excludes ancestors and siblings for a mid-tree archive', async () => {
    const tasks = [
      task({ id: 'root', parent_task_id: null }),
      task({ id: 'sibling', parent_task_id: null }),
      task({ id: 'mid', parent_task_id: 'root' }),
      task({ id: 'mid-sibling', parent_task_id: 'root' }),
      task({ id: 'grandchild', parent_task_id: 'mid' }),
    ];
    const { client, inSpy } = createArchiveClientMock({ tasks, projectId: 'project-1' });
    const repository = new TaskRepository(client);

    await repository.archive('mid');

    const [, ids] = inSpy.mock.calls[0] as [string, string[]];
    expect(new Set(ids)).toEqual(new Set(['mid', 'grandchild']));
  });

  it('archives exactly one id for a leaf task', async () => {
    const tasks = [
      task({ id: 'root', parent_task_id: null }),
      task({ id: 'leaf', parent_task_id: 'root' }),
    ];
    const { client, inSpy } = createArchiveClientMock({ tasks, projectId: 'project-1' });
    const repository = new TaskRepository(client);

    await repository.archive('leaf');

    const [, ids] = inSpy.mock.calls[0] as [string, string[]];
    expect(ids).toEqual(['leaf']);
  });

  it('issues exactly one bulk update with one shared timestamp and no per-row update loop', async () => {
    const tasks = [
      task({ id: 'root', parent_task_id: null }),
      task({ id: 'child-1', parent_task_id: 'root' }),
      task({ id: 'child-2', parent_task_id: 'root' }),
    ];
    const { client, updateSpy, inSpy } = createArchiveClientMock({ tasks, projectId: 'project-1' });
    const repository = new TaskRepository(client);

    await repository.archive('root');

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(inSpy).toHaveBeenCalledTimes(1);
    const [updateInput] = updateSpy.mock.calls[0] as [{ archived_at: string }];
    expect(typeof updateInput.archived_at).toBe('string');
    const [column, ids] = inSpy.mock.calls[0] as [string, string[]];
    expect(column).toBe('id');
    expect(new Set(ids)).toEqual(new Set(['root', 'child-1', 'child-2']));
  });

  it('returns every affected row through the updated contract, each stamped with the shared timestamp', async () => {
    const tasks = [
      task({ id: 'root', parent_task_id: null }),
      task({ id: 'child', parent_task_id: 'root' }),
    ];
    const { client } = createArchiveClientMock({ tasks, projectId: 'project-1' });
    const repository = new TaskRepository(client);

    const result = await repository.archive('root');

    expect(result).toHaveLength(2);
    expect(new Set(result.map((row) => row.id))).toEqual(new Set(['root', 'child']));
    const [first, second] = result;
    expect(first.archived_at).toBe(second.archived_at);
    expect(first.archived_at).not.toBeNull();
  });

  it('uses includeArchived: true so an already archived intermediate still reaches active descendants', async () => {
    const tasks = [
      task({ id: 'root', parent_task_id: null }),
      task({ id: 'archived-mid', parent_task_id: 'root', archived_at: '2026-08-01T00:00:00.000Z' }),
      task({ id: 'active-leaf', parent_task_id: 'archived-mid' }),
    ];
    const { client, inSpy } = createArchiveClientMock({ tasks, projectId: 'project-1' });
    const repository = new TaskRepository(client);

    await repository.archive('root');

    const [, ids] = inSpy.mock.calls[0] as [string, string[]];
    expect(new Set(ids)).toEqual(new Set(['root', 'archived-mid', 'active-leaf']));
  });
});

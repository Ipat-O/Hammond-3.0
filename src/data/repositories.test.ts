import type { SupabaseClient } from '@supabase/supabase-js';
import { vi } from 'vitest';

import { ProjectRepository, TaskRepository } from './repositories';
import type { Database } from './database.types';

type TaskRow = Pick<Database['public']['Tables']['tasks']['Row'], 'id' | 'parent_task_id'>;

/**
 * Builds a fake Supabase client whose `tasks` table chain resolves
 * `listResult` for read chains (select/eq/order) and records every
 * insert/update payload, resolving `writeResult` for the final `.single()`.
 */
function createTaskClientMock(options: { listResult: TaskRow[]; writeResult?: unknown }) {
  const insertSpy = vi.fn();
  const updateSpy = vi.fn();

  function awaitable(data: unknown): unknown {
    const node = {
      select: () => awaitable(data),
      eq: () => awaitable(data),
      order: () => awaitable(data),
      single: () => Promise.resolve({ data, error: null }),
      then: (resolve: (value: { data: unknown; error: null }) => void) =>
        resolve({ data, error: null }),
    };
    return node;
  }

  const client = {
    from: vi.fn(() => ({
      select: () => awaitable(options.listResult),
      insert: (input: unknown) => {
        insertSpy(input);
        return awaitable(options.writeResult ?? input);
      },
      update: (input: unknown) => {
        updateSpy(input);
        return awaitable(options.writeResult ?? input);
      },
    })),
  } as unknown as SupabaseClient<Database>;

  return { client, insertSpy, updateSpy };
}

describe('tracker repository write guards', () => {
  it('rejects absolute local paths before a project write reaches Supabase', async () => {
    const client = { from: vi.fn() } as unknown as SupabaseClient<Database>;
    const repository = new ProjectRepository(client);

    await expect(
      repository.create({ name: 'Unsafe project', description: 'C:\\Users\\owner\\repo' }),
    ).rejects.toThrow(/absolute local paths/);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('rejects invalid task statuses before a task write reaches Supabase', async () => {
    const client = { from: vi.fn() } as unknown as SupabaseClient<Database>;
    const repository = new TaskRepository(client);

    await expect(repository.update('task-1', { status: 'queued' as never })).rejects.toThrow(
      'Invalid task status: queued',
    );
    expect(client.from).not.toHaveBeenCalled();
  });

  it('persists a newly created task nested at least four levels deep', async () => {
    const existingTasks: TaskRow[] = [
      { id: 'l1', parent_task_id: null },
      { id: 'l2', parent_task_id: 'l1' },
      { id: 'l3', parent_task_id: 'l2' },
      { id: 'l4', parent_task_id: 'l3' },
    ];
    const { client, insertSpy } = createTaskClientMock({ listResult: existingTasks });
    const repository = new TaskRepository(client);

    await repository.create({
      id: 'l5',
      project_id: 'project-1',
      title: 'Fifth level task',
      parent_task_id: 'l4',
    });

    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ parent_task_id: 'l4' }));
  });

  it('persists re-parenting a task at least four levels deep under a legal ancestor', async () => {
    const existingTasks: TaskRow[] = [
      { id: 'l1', parent_task_id: null },
      { id: 'l2', parent_task_id: 'l1' },
      { id: 'l3', parent_task_id: 'l2' },
      { id: 'l4', parent_task_id: 'l3' },
      { id: 'l5', parent_task_id: null },
    ];
    const { client, updateSpy } = createTaskClientMock({ listResult: existingTasks });
    const repository = new TaskRepository(client);

    await repository.update('l5', { project_id: 'project-1', parent_task_id: 'l4' });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ parent_task_id: 'l4' }));
  });

  it('rejects a task re-parented to itself before the write reaches Supabase', async () => {
    const existingTasks: TaskRow[] = [{ id: 'task-1', parent_task_id: null }];
    const { client, updateSpy } = createTaskClientMock({ listResult: existingTasks });
    const repository = new TaskRepository(client);

    await expect(
      repository.update('task-1', { project_id: 'project-1', parent_task_id: 'task-1' }),
    ).rejects.toThrow(/own parent/);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects re-parenting a task under its own descendant before the write reaches Supabase', async () => {
    const existingTasks: TaskRow[] = [
      { id: 'l1', parent_task_id: null },
      { id: 'l2', parent_task_id: 'l1' },
      { id: 'l3', parent_task_id: 'l2' },
      { id: 'l4', parent_task_id: 'l3' },
    ];
    const { client, updateSpy } = createTaskClientMock({ listResult: existingTasks });
    const repository = new TaskRepository(client);

    await expect(
      repository.update('l1', { project_id: 'project-1', parent_task_id: 'l4' }),
    ).rejects.toThrow(/cycle/);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

import type { SupabaseClient } from '@supabase/supabase-js';
import { vi } from 'vitest';

import { ProjectRepository, TaskRepository } from './repositories';
import { TaskRevisionConflictError } from './taskValidation';
import type { Database } from './database.types';

/**
 * Builds a fake Supabase client whose `.rpc(name, args)` records every call and resolves
 * `result` (or rejects with `error` if given) — `TaskRepository`'s checked writes (HAM3-014) go
 * through `tasks_create_checked`/`tasks_update_checked`/`tasks_archive_subtree_checked` rather
 * than plain `.from().insert()/.update()`, so this is the boundary these tests mock.
 */
function createRpcClientMock(options: { result?: unknown; error?: unknown } = {}) {
  const rpcSpy = vi.fn(() =>
    Promise.resolve(
      options.error
        ? { data: null, error: options.error }
        : { data: options.result ?? null, error: null },
    ),
  );
  const client = { rpc: rpcSpy } as unknown as SupabaseClient<Database>;
  return { client, rpcSpy };
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
    const { client, rpcSpy } = createRpcClientMock();
    const repository = new TaskRepository(client);

    await expect(repository.update('task-1', { status: 'queued' as never }, 1)).rejects.toThrow(
      'Invalid task status: queued',
    );
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it('creates a task via tasks_create_checked with the parent it was given', async () => {
    const { client, rpcSpy } = createRpcClientMock({ result: { id: 'l5' } });
    const repository = new TaskRepository(client);

    await repository.create(
      { project_id: 'project-1', title: 'Fifth level task', parent_task_id: 'l4' },
      'req-1',
    );

    expect(rpcSpy).toHaveBeenCalledWith('tasks_create_checked', {
      p_project_id: 'project-1',
      p_title: 'Fifth level task',
      p_description: null,
      p_parent_task_id: 'l4',
      p_request_id: 'req-1',
    });
  });

  it('updates a task via tasks_update_checked with the given expected revision', async () => {
    const { client, rpcSpy } = createRpcClientMock({ result: { id: 'task-1' } });
    const repository = new TaskRepository(client);

    await repository.update('task-1', { title: 'Renamed' }, 3, 'req-2');

    expect(rpcSpy).toHaveBeenCalledWith('tasks_update_checked', {
      p_task_id: 'task-1',
      p_expected_revision: 3,
      p_title: 'Renamed',
      p_description: null,
      p_status: null,
      p_request_id: 'req-2',
      p_change_parent: false,
      p_parent_task_id: null,
    });
  });

  it('reparents a task via tasks_update_checked only when parent_task_id is explicitly given', async () => {
    const { client, rpcSpy } = createRpcClientMock({ result: { id: 'task-1' } });
    const repository = new TaskRepository(client);

    await repository.update('task-1', { parent_task_id: null }, 3, 'req-3');

    expect(rpcSpy).toHaveBeenCalledWith(
      'tasks_update_checked',
      expect.objectContaining({ p_change_parent: true, p_parent_task_id: null }),
    );
  });

  it('archives a task via tasks_archive_subtree_checked with the given expected revision', async () => {
    const { client, rpcSpy } = createRpcClientMock({ result: [{ id: 'task-1' }] });
    const repository = new TaskRepository(client);

    await repository.archive('task-1', 5);

    expect(rpcSpy).toHaveBeenCalledWith('tasks_archive_subtree_checked', {
      p_root_task_id: 'task-1',
      p_expected_revision: 5,
      p_request_id: expect.any(String),
    });
  });

  it('maps a stale-revision (40001) error into TaskRevisionConflictError', async () => {
    const { client } = createRpcClientMock({ error: { code: '40001', message: 'stale' } });
    const repository = new TaskRepository(client);

    await expect(repository.update('task-1', { title: 'x' }, 1, 'req-4')).rejects.toBeInstanceOf(
      TaskRevisionConflictError,
    );
  });

  it('leaves an unrelated write error unchanged', async () => {
    const { client } = createRpcClientMock({ error: { code: '23514', message: 'nope' } });
    const repository = new TaskRepository(client);

    const error = await repository
      .update('task-1', { title: 'x' }, 1, 'req-5')
      .catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(TaskRevisionConflictError);
  });
});

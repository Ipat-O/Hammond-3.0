import type { SupabaseClient } from '@supabase/supabase-js';
import { vi } from 'vitest';

import { TaskRepository } from './repositories';
import type { Database } from './database.types';

/**
 * HAM3-014 moved subtree discovery and the archive write itself into the
 * `tasks_archive_subtree_checked` RPC (a recursive CTE under a per-project hierarchy lock,
 * re-derived from durable state on every call rather than a client-supplied snapshot — see the
 * migration and `supabase/tests/`). `TaskRepository.archive` is now a thin, checked wrapper around
 * that RPC; these tests cover its own contract (arguments, revision-conflict mapping, pass-through
 * of the RPC's result) rather than the tree-shape math, which the database tests own for real
 * against Postgres.
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

describe('TaskRepository.archive', () => {
  it('calls tasks_archive_subtree_checked with the root id, expected revision, and a request id', async () => {
    const { client, rpcSpy } = createRpcClientMock({ result: [] });
    const repository = new TaskRepository(client);

    await repository.archive('root', 4, 'req-1');

    expect(rpcSpy).toHaveBeenCalledWith('tasks_archive_subtree_checked', {
      p_root_task_id: 'root',
      p_expected_revision: 4,
      p_request_id: 'req-1',
    });
  });

  it('defaults to a fresh request id per call when none is supplied', async () => {
    const { client, rpcSpy } = createRpcClientMock({ result: [] });
    const repository = new TaskRepository(client);

    await repository.archive('root', 4);

    const call = rpcSpy.mock.calls[0] as unknown as [string, { p_request_id: string }];
    expect(typeof call[1].p_request_id).toBe('string');
    expect(call[1].p_request_id.length).toBeGreaterThan(0);
  });

  it('returns every archived row the RPC reports, unmodified', async () => {
    const rows = [
      { id: 'root', archived_at: '2026-09-09T00:00:00.000Z' },
      { id: 'child', archived_at: '2026-09-09T00:00:00.000Z' },
    ];
    const { client } = createRpcClientMock({ result: rows });
    const repository = new TaskRepository(client);

    const result = await repository.archive('root', 1);

    expect(result).toEqual(rows);
  });

  it('maps a stale-revision (40001) conflict into TaskRevisionConflictError', async () => {
    const { client } = createRpcClientMock({ error: { code: '40001', message: 'stale' } });
    const repository = new TaskRepository(client);

    await expect(repository.archive('root', 1)).rejects.toMatchObject({
      code: 'task_revision_conflict',
    });
  });
});

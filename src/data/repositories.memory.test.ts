import type { SupabaseClient } from '@supabase/supabase-js';
import { vi } from 'vitest';

import { ProjectMemoryRepository } from './repositories';
import type { Database } from './database.types';

/**
 * Builds a fake Supabase client that records every `.eq`, `.order`, and `.limit` call on the
 * chain and resolves with `rows`. Used to prove the new project-scoped dashboard reads filter,
 * order, and cap results exactly as intended, never drifting into an unscoped or task-scoped
 * query.
 */
function createChainClientMock(rows: unknown[]) {
  const eqSpy = vi.fn();
  const orderSpy = vi.fn();
  const limitSpy = vi.fn();

  function chain(): unknown {
    return {
      eq: (...args: unknown[]) => {
        eqSpy(...args);
        return chain();
      },
      order: (...args: unknown[]) => {
        orderSpy(...args);
        return chain();
      },
      limit: (...args: unknown[]) => {
        limitSpy(...args);
        return chain();
      },
      then: (resolve: (value: { data: unknown; error: null }) => void) =>
        resolve({ data: rows, error: null }),
    };
  }

  const client = {
    from: vi.fn(() => ({ select: () => chain() })),
  } as unknown as SupabaseClient<Database>;

  return { client, eqSpy, orderSpy, limitSpy };
}

describe('ProjectMemoryRepository dashboard reads', () => {
  it('listRecentComments scopes strictly to the project, newest first, capped to the given limit', async () => {
    const { client, eqSpy, orderSpy, limitSpy } = createChainClientMock([]);
    const repository = new ProjectMemoryRepository(client);

    await repository.listRecentComments('project-1', 3);

    expect(client.from).toHaveBeenCalledWith('comments');
    expect(eqSpy).toHaveBeenCalledWith('project_id', 'project-1');
    expect(orderSpy).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(limitSpy).toHaveBeenCalledWith(3);
  });

  it('listRecentComments defaults to a bounded page size when none is given', async () => {
    const { client, limitSpy } = createChainClientMock([]);
    const repository = new ProjectMemoryRepository(client);

    await repository.listRecentComments('project-1');

    expect(limitSpy).toHaveBeenCalledWith(5);
  });

  it('listEvidence scopes strictly to the project, newest first, capped to the given limit', async () => {
    const { client, eqSpy, orderSpy, limitSpy } = createChainClientMock([]);
    const repository = new ProjectMemoryRepository(client);

    await repository.listEvidence('project-1', 2);

    expect(client.from).toHaveBeenCalledWith('task_evidence');
    expect(eqSpy).toHaveBeenCalledWith('project_id', 'project-1');
    expect(orderSpy).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(limitSpy).toHaveBeenCalledWith(2);
  });

  it('listActivity applies an optional limit without capping the unbounded default call', async () => {
    const unbounded = createChainClientMock([]);
    await new ProjectMemoryRepository(unbounded.client).listActivity('project-1');
    expect(unbounded.limitSpy).not.toHaveBeenCalled();

    const bounded = createChainClientMock([]);
    await new ProjectMemoryRepository(bounded.client).listActivity('project-1', { limit: 10 });
    expect(bounded.limitSpy).toHaveBeenCalledWith(10);
  });

  it('listComments stays task-scoped rather than drifting onto the new project-scoped column', async () => {
    const { client, eqSpy } = createChainClientMock([]);
    const repository = new ProjectMemoryRepository(client);

    await repository.listComments('task-1');

    expect(eqSpy).toHaveBeenCalledWith('task_id', 'task-1');
    expect(eqSpy).not.toHaveBeenCalledWith('project_id', expect.anything());
  });
});

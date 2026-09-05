import type { SupabaseClient } from '@supabase/supabase-js';
import { vi } from 'vitest';

import { SupabaseAssignmentRepository } from './assignmentsRepository';
import type { Database } from './database.types';

/**
 * Builds a fake Supabase client whose query chain resolves `result` for any
 * terminal call (`single`/`maybeSingle`/awaited directly) and records every
 * method call plus its arguments so a test can assert on the exact query
 * shape (filters, target table) the repository issued.
 */
function createChainMock(result: unknown) {
  const calls: { method: string; args: unknown[] }[] = [];
  const chainMethods = ['select', 'eq', 'update', 'order'] as const;

  function node(): Record<string, unknown> {
    const record: Record<string, unknown> = {
      single: () => Promise.resolve({ data: result, error: null }),
      maybeSingle: () => Promise.resolve({ data: result, error: null }),
      then: (resolve: (value: { data: unknown; error: null }) => void) =>
        resolve({ data: result, error: null }),
    };
    for (const method of chainMethods) {
      record[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return node();
      };
    }
    return record;
  }

  const client = { from: vi.fn(() => node()) } as unknown as SupabaseClient<Database>;
  return { client, calls };
}

const row = {
  id: 'assignment-1',
  owner_id: 'owner-1',
  project_id: 'project-1',
  role: 'worker' as const,
  provider: 'claude_code' as const,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

describe('SupabaseAssignmentRepository', () => {
  it('maps an assignment row from snake_case columns to the camelCase domain shape', async () => {
    const { client } = createChainMock(row);
    const repository = new SupabaseAssignmentRepository(client);

    const assignment = await repository.getAssignment({ projectId: 'project-1', role: 'worker' });

    expect(assignment).toEqual({
      id: 'assignment-1',
      ownerId: 'owner-1',
      projectId: 'project-1',
      role: 'worker',
      provider: 'claude_code',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('getAssignment returns null instead of throwing when Supabase finds no row', async () => {
    const { client } = createChainMock(null);
    const repository = new SupabaseAssignmentRepository(client);

    expect(await repository.getAssignment({ projectId: 'project-1', role: 'worker' })).toBeNull();
  });

  it('listForProject orders the three roles orchestrator/worker/auditor regardless of row order returned', async () => {
    const auditorRow = {
      ...row,
      id: 'assignment-3',
      role: 'auditor' as const,
      provider: 'kilo_code' as const,
    };
    const orchestratorRow = {
      ...row,
      id: 'assignment-2',
      role: 'orchestrator' as const,
      provider: 'codex' as const,
    };
    const { client } = createChainMock([auditorRow, row, orchestratorRow]);
    const repository = new SupabaseAssignmentRepository(client);

    const assignments = await repository.listForProject('project-1');

    expect(assignments.map((a) => a.role)).toEqual(['orchestrator', 'worker', 'auditor']);
  });

  it('updateAssignment targets the (project_id, role) pair and only sends the new provider', async () => {
    const { client, calls } = createChainMock({ ...row, provider: 'kilo_code' as const });
    const repository = new SupabaseAssignmentRepository(client);

    const updated = await repository.updateAssignment({
      projectId: 'project-1',
      role: 'worker',
      provider: 'kilo_code',
    });

    expect(updated.provider).toBe('kilo_code');
    expect(client.from).toHaveBeenCalledWith('project_agent_assignments');
    const updateCall = calls.find((call) => call.method === 'update');
    expect(updateCall?.args).toEqual([{ provider: 'kilo_code' }]);
    const eqCalls = calls.filter((call) => call.method === 'eq');
    expect(eqCalls).toEqual([
      { method: 'eq', args: ['project_id', 'project-1'] },
      { method: 'eq', args: ['role', 'worker'] },
    ]);
  });

  it('updateAssignment propagates the raw error instead of fabricating a saved assignment', async () => {
    const client = {
      from: vi.fn(() => ({
        update: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: null,
                    error: Object.assign(new Error('permission denied'), { code: '42501' }),
                  }),
              }),
            }),
          }),
        }),
      })),
    } as unknown as SupabaseClient<Database>;
    const repository = new SupabaseAssignmentRepository(client);

    await expect(
      repository.updateAssignment({ projectId: 'project-1', role: 'worker', provider: 'codex' }),
    ).rejects.toThrow('permission denied');
  });
});

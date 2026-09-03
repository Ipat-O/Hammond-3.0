import type { SupabaseClient } from '@supabase/supabase-js';
import { vi } from 'vitest';

import type { Database } from './database.types';
import { SupabaseInstructionRepository } from './instructionsRepository';

/**
 * Builds a fake Supabase client whose query chain resolves `result` for any
 * terminal call (`single`/`maybeSingle`/awaited directly) and records every
 * method call plus its arguments so a test can assert on the exact query
 * shape (filters, onConflict target) the repository issued.
 */
function createChainMock(result: unknown) {
  const calls: { method: string; args: unknown[] }[] = [];
  const chainMethods = ['select', 'eq', 'is', 'order', 'limit', 'in', 'insert', 'upsert'] as const;

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

describe('SupabaseInstructionRepository write guards', () => {
  it('rejects an absolute local path in a new template name before it reaches Supabase', async () => {
    const client = { from: vi.fn() } as unknown as SupabaseClient<Database>;
    const repository = new SupabaseInstructionRepository(client);

    await expect(
      repository.createOwnerTemplate({
        role: 'worker',
        provider: 'claude_code',
        layer: 'provider',
        projectId: null,
        name: 'C:\\Users\\owner\\repo',
      }),
    ).rejects.toThrow(/absolute local paths/);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('rejects an absolute local path in version content before it reaches Supabase', async () => {
    const client = { from: vi.fn() } as unknown as SupabaseClient<Database>;
    const repository = new SupabaseInstructionRepository(client);

    await expect(
      repository.insertVersion({ templateId: 'template-1', content: '/etc/passwd leaked here' }),
    ).rejects.toThrow(/absolute local paths/);
    expect(client.from).not.toHaveBeenCalled();
  });
});

describe('SupabaseInstructionRepository query shape and mapping', () => {
  it('maps a template row from snake_case columns to the camelCase domain shape', async () => {
    const { client } = createChainMock({
      id: 'template-1',
      owner_id: 'owner-1',
      role: 'worker',
      provider: 'claude_code',
      layer: 'provider',
      project_id: null,
      name: 'Worker / Claude Code',
      is_base: false,
    });
    const repository = new SupabaseInstructionRepository(client);

    const template = await repository.getOwnerTemplate({
      role: 'worker',
      provider: 'claude_code',
      layer: 'provider',
      projectId: null,
    });

    expect(template).toEqual({
      id: 'template-1',
      ownerId: 'owner-1',
      role: 'worker',
      provider: 'claude_code',
      layer: 'provider',
      projectId: null,
      name: 'Worker / Claude Code',
      isBase: false,
    });
  });

  it('upserts a selection targeting the (project_id, role, provider) unique constraint', async () => {
    const { client, calls } = createChainMock({
      id: 'selection-1',
      owner_id: 'owner-1',
      project_id: 'project-1',
      role: 'worker',
      provider: 'claude_code',
      shared_role_version_id: 'shared-1',
      provider_version_id: 'provider-1',
      override_version_id: null,
    });
    const repository = new SupabaseInstructionRepository(client);

    const selection = await repository.upsertSelection({
      projectId: 'project-1',
      role: 'worker',
      provider: 'claude_code',
      sharedRoleVersionId: 'shared-1',
      providerVersionId: 'provider-1',
      overrideVersionId: null,
    });

    expect(selection.overrideVersionId).toBeNull();
    const upsertCall = calls.find((call) => call.method === 'upsert');
    expect(upsertCall?.args[1]).toEqual({ onConflict: 'project_id,role,provider' });
  });

  it('returns an empty list without querying Supabase when getVersionsByIds is given no ids', async () => {
    const client = { from: vi.fn() } as unknown as SupabaseClient<Database>;
    const repository = new SupabaseInstructionRepository(client);

    const versions = await repository.getVersionsByIds([]);

    expect(versions).toEqual([]);
    expect(client.from).not.toHaveBeenCalled();
  });
});

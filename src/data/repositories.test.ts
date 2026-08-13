import type { SupabaseClient } from '@supabase/supabase-js';
import { vi } from 'vitest';

import { ProjectRepository, TaskRepository } from './repositories';
import type { Database } from './database.types';

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
});

import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseClient } from './client';
import type { Database } from './database.types';
import { assertNoAbsoluteLocalPaths } from './pathGuard';
import { getTaskSubtreeIds } from './taskSubtree';
import { assertNoParentCycle, assertValidTaskStatus } from './taskValidation';

type Tables = Database['public']['Tables'];
type ProjectInsert = Tables['projects']['Insert'];
type ProjectUpdate = Tables['projects']['Update'];
type TaskInsert = Tables['tasks']['Insert'];
type TaskUpdate = Tables['tasks']['Update'];

function dataOrThrow<T>(result: { data: T; error: Error | null }): NonNullable<T> {
  if (result.error) throw result.error;
  if (result.data === null) throw new Error('Supabase returned no data');
  return result.data as NonNullable<T>;
}

export class ProjectRepository {
  constructor(private readonly client: SupabaseClient<Database> = getSupabaseClient()) {}

  async list(options: { includeArchived?: boolean } = {}) {
    let query = this.client.from('projects').select('*').order('updated_at', { ascending: false });
    if (!options.includeArchived) query = query.is('archived_at', null);
    return dataOrThrow(await query);
  }
  async create(input: ProjectInsert) {
    assertNoAbsoluteLocalPaths(input);
    return dataOrThrow(await this.client.from('projects').insert(input).select().single());
  }
  async update(id: string, input: ProjectUpdate) {
    assertNoAbsoluteLocalPaths(input);
    return dataOrThrow(
      await this.client.from('projects').update(input).eq('id', id).select().single(),
    );
  }
  async remove(id: string) {
    return dataOrThrow(
      await this.client.from('projects').delete().eq('id', id).select('id').single(),
    );
  }

  async archive(id: string) {
    return this.update(id, { archived_at: new Date().toISOString() });
  }
}

export class TaskRepository {
  constructor(private readonly client: SupabaseClient<Database> = getSupabaseClient()) {}

  async list(projectId: string, options: { includeArchived?: boolean } = {}) {
    let query = this.client
      .from('tasks')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at');
    if (!options.includeArchived) query = query.is('archived_at', null);
    return dataOrThrow(await query);
  }
  async create(input: TaskInsert) {
    assertNoAbsoluteLocalPaths(input);
    if (input.status !== undefined) assertValidTaskStatus(input.status);
    if (input.parent_task_id && input.id) {
      const existingTasks = await this.list(input.project_id, { includeArchived: true });
      assertNoParentCycle(existingTasks, input.id, input.parent_task_id);
    }
    return dataOrThrow(await this.client.from('tasks').insert(input).select().single());
  }
  async update(id: string, input: TaskUpdate) {
    assertNoAbsoluteLocalPaths(input);
    if (input.status !== undefined) assertValidTaskStatus(input.status);
    if (input.parent_task_id !== undefined || input.project_id !== undefined) {
      const projectId = input.project_id ?? (await this.findProjectId(id));
      const existingTasks = await this.list(projectId, { includeArchived: true });
      const currentTask = existingTasks.find((task) => task.id === id);
      const parentTaskId =
        input.parent_task_id !== undefined
          ? input.parent_task_id
          : (currentTask?.parent_task_id ?? null);
      assertNoParentCycle(existingTasks, id, parentTaskId);
    }
    return dataOrThrow(
      await this.client.from('tasks').update(input).eq('id', id).select().single(),
    );
  }
  async remove(id: string) {
    return dataOrThrow(await this.client.from('tasks').delete().eq('id', id).select('id').single());
  }

  /**
   * Archives id plus every transitive descendant in one bulk write so a
   * still-active child can never be orphaned as a top-level row once the
   * normal view filters archived tasks out.
   */
  async archive(id: string): Promise<Tables['tasks']['Row'][]> {
    const projectId = await this.findProjectId(id);
    const projectTasks = await this.list(projectId, { includeArchived: true });
    const subtreeIds = Array.from(getTaskSubtreeIds(projectTasks, id));
    const archivedAt = new Date().toISOString();
    return dataOrThrow(
      await this.client
        .from('tasks')
        .update({ archived_at: archivedAt })
        .in('id', subtreeIds)
        .select(),
    );
  }

  private async findProjectId(id: string): Promise<string> {
    return dataOrThrow(await this.client.from('tasks').select('project_id').eq('id', id).single())
      .project_id;
  }
}

export class ProjectMemoryRepository {
  constructor(private readonly client: SupabaseClient<Database> = getSupabaseClient()) {}

  async listComments(taskId: string) {
    return dataOrThrow(
      await this.client.from('comments').select('*').eq('task_id', taskId).order('created_at'),
    );
  }
  async addComment(input: Tables['comments']['Insert']) {
    assertNoAbsoluteLocalPaths(input);
    return dataOrThrow(await this.client.from('comments').insert(input).select().single());
  }
  async addRelation(input: Tables['task_relations']['Insert']) {
    return dataOrThrow(await this.client.from('task_relations').insert(input).select().single());
  }
  async addEvidence(input: Tables['task_evidence']['Insert']) {
    assertNoAbsoluteLocalPaths(input);
    return dataOrThrow(await this.client.from('task_evidence').insert(input).select().single());
  }
  async recordActivity(input: Tables['activity']['Insert']) {
    assertNoAbsoluteLocalPaths(input);
    return dataOrThrow(await this.client.from('activity').insert(input).select().single());
  }
  async listActivity(projectId: string) {
    return dataOrThrow(
      await this.client
        .from('activity')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false }),
    );
  }
}

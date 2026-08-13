import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseClient } from './client';
import type { Database } from './database.types';
import { assertNoAbsoluteLocalPaths } from './pathGuard';

type Tables = Database['public']['Tables'];
type ProjectInsert = Tables['projects']['Insert'];
type ProjectUpdate = Tables['projects']['Update'];
type TaskInsert = Tables['tasks']['Insert'];
type TaskUpdate = Tables['tasks']['Update'];

function dataOrThrow<T>(result: { data: T; error: Error | null }): T {
  if (result.error) throw result.error;
  return result.data;
}

export class ProjectRepository {
  constructor(private readonly client: SupabaseClient<Database> = getSupabaseClient()) {}

  async list() {
    return dataOrThrow(
      await this.client.from('projects').select('*').order('updated_at', { ascending: false }),
    );
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
}

export class TaskRepository {
  constructor(private readonly client: SupabaseClient<Database> = getSupabaseClient()) {}

  async list(projectId: string) {
    return dataOrThrow(
      await this.client.from('tasks').select('*').eq('project_id', projectId).order('created_at'),
    );
  }
  async create(input: TaskInsert) {
    assertNoAbsoluteLocalPaths(input);
    return dataOrThrow(await this.client.from('tasks').insert(input).select().single());
  }
  async update(id: string, input: TaskUpdate) {
    assertNoAbsoluteLocalPaths(input);
    return dataOrThrow(
      await this.client.from('tasks').update(input).eq('id', id).select().single(),
    );
  }
  async remove(id: string) {
    return dataOrThrow(await this.client.from('tasks').delete().eq('id', id).select('id').single());
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
  async listTemplates() {
    return dataOrThrow(
      await this.client
        .from('instruction_templates')
        .select('*, instruction_template_versions(*)')
        .order('name'),
    );
  }
  async createTemplate(input: Tables['instruction_templates']['Insert']) {
    assertNoAbsoluteLocalPaths(input);
    return dataOrThrow(
      await this.client.from('instruction_templates').insert(input).select().single(),
    );
  }
  async createTemplateVersion(input: Tables['instruction_template_versions']['Insert']) {
    assertNoAbsoluteLocalPaths(input);
    return dataOrThrow(
      await this.client.from('instruction_template_versions').insert(input).select().single(),
    );
  }
  async selectProjectInstruction(input: Tables['project_instruction_selections']['Insert']) {
    return dataOrThrow(
      await this.client
        .from('project_instruction_selections')
        .upsert(input, { onConflict: 'project_id,role' })
        .select()
        .single(),
    );
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

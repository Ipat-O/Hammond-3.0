import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseClient } from './client';
import { publishDataChange } from './dataChangeBus';
import type { Database } from './database.types';
import { assertNoAbsoluteLocalPaths } from './pathGuard';
import {
  clampLimit,
  decodeCursor,
  keysetPredicate,
  toPage,
  type Page,
  type PageParams,
} from './pagination';
import { dataOrThrow } from './supabaseError';
import { getTaskSubtreeIds } from './taskSubtree';
import { assertNoParentCycle, assertValidTaskStatus } from './taskValidation';

type Tables = Database['public']['Tables'];
type ProjectInsert = Tables['projects']['Insert'];
type ProjectUpdate = Tables['projects']['Update'];
type TaskInsert = Tables['tasks']['Insert'];
type TaskUpdate = Tables['tasks']['Update'];

export class ProjectRepository {
  constructor(private readonly client: SupabaseClient<Database> = getSupabaseClient()) {}

  async list(options: { includeArchived?: boolean } = {}) {
    let query = this.client.from('projects').select('*').order('updated_at', { ascending: false });
    if (!options.includeArchived) query = query.is('archived_at', null);
    return dataOrThrow(await query);
  }

  /** Bounded, deterministically-ordered page of projects (`created_at`/`id` keyset — never `updated_at`, which can change out from under a page boundary). */
  async listPage(
    options: { includeArchived?: boolean } & PageParams = {},
  ): Promise<Page<Tables['projects']['Row']>> {
    const limit = clampLimit(options.limit);
    const after = decodeCursor(options.cursor);
    let query = this.client
      .from('projects')
      .select('*')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (!options.includeArchived) query = query.is('archived_at', null);
    if (after) query = query.or(keysetPredicate(after, true));
    const rows = dataOrThrow(await query.limit(limit + 1));
    return toPage(rows, limit);
  }

  async getById(id: string) {
    return dataOrThrow(await this.client.from('projects').select('*').eq('id', id).single());
  }

  async create(input: ProjectInsert) {
    assertNoAbsoluteLocalPaths(input);
    const row = dataOrThrow(await this.client.from('projects').insert(input).select().single());
    publishDataChange({ resource: 'project', op: 'create', row });
    return row;
  }
  async update(id: string, input: ProjectUpdate) {
    assertNoAbsoluteLocalPaths(input);
    const row = dataOrThrow(
      await this.client.from('projects').update(input).eq('id', id).select().single(),
    );
    publishDataChange({ resource: 'project', op: 'update', row });
    return row;
  }
  async remove(id: string) {
    const row = dataOrThrow(
      await this.client.from('projects').delete().eq('id', id).select('id').single(),
    );
    publishDataChange({ resource: 'project', op: 'delete', row });
    return row;
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

  /** Bounded, deterministically-ordered (`created_at`, `id`) page of one project's tasks. */
  async listPage(
    projectId: string,
    options: { includeArchived?: boolean } & PageParams = {},
  ): Promise<Page<Tables['tasks']['Row']>> {
    const limit = clampLimit(options.limit);
    const after = decodeCursor(options.cursor);
    let query = this.client
      .from('tasks')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (!options.includeArchived) query = query.is('archived_at', null);
    if (after) query = query.or(keysetPredicate(after, true));
    const rows = dataOrThrow(await query.limit(limit + 1));
    return toPage(rows, limit);
  }

  async getById(id: string) {
    return dataOrThrow(await this.client.from('tasks').select('*').eq('id', id).single());
  }

  async create(input: TaskInsert) {
    assertNoAbsoluteLocalPaths(input);
    if (input.status !== undefined) assertValidTaskStatus(input.status);
    if (input.parent_task_id && input.id) {
      const existingTasks = await this.list(input.project_id, { includeArchived: true });
      assertNoParentCycle(existingTasks, input.id, input.parent_task_id);
    }
    const row = dataOrThrow(await this.client.from('tasks').insert(input).select().single());
    publishDataChange({ resource: 'task', op: 'create', row });
    return row;
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
    const row = dataOrThrow(
      await this.client.from('tasks').update(input).eq('id', id).select().single(),
    );
    publishDataChange({ resource: 'task', op: 'update', row });
    return row;
  }
  async remove(id: string) {
    const row = dataOrThrow(
      await this.client.from('tasks').delete().eq('id', id).select('id').single(),
    );
    publishDataChange({ resource: 'task', op: 'delete', row });
    return row;
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
    const rows = dataOrThrow(
      await this.client
        .from('tasks')
        .update({ archived_at: archivedAt })
        .in('id', subtreeIds)
        .select(),
    );
    for (const row of rows) publishDataChange({ resource: 'task', op: 'archive', row });
    return rows;
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

  /**
   * Bounded, deterministically-ordered (`created_at`, `id`) page of one task's comments, oldest
   * first. The `id` tiebreaker is what keeps a page boundary landing between two comments saved
   * in the same instant from ever dropping or repeating one.
   */
  async listCommentsPage(
    taskId: string,
    options: PageParams = {},
  ): Promise<Page<Tables['comments']['Row']>> {
    const limit = clampLimit(options.limit);
    const after = decodeCursor(options.cursor);
    let query = this.client
      .from('comments')
      .select('*')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (after) query = query.or(keysetPredicate(after, true));
    const rows = dataOrThrow(await query.limit(limit + 1));
    return toPage(rows, limit);
  }

  /** One comment by id, scoped to the caller's own rows by RLS — a foreign or unknown id fails identically ("not found"), never distinguishably. */
  async getCommentById(id: string) {
    return dataOrThrow(await this.client.from('comments').select('*').eq('id', id).single());
  }

  /** Newest-first comments across the whole project, for a project-level recent feed (never task-scoped). */
  async listRecentComments(projectId: string, limit = 5) {
    return dataOrThrow(
      await this.client
        .from('comments')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .limit(limit),
    );
  }

  /** Bounded, deterministically-ordered (`created_at` desc, `id` desc) page of a project's comment feed. */
  async listRecentCommentsPage(
    projectId: string,
    options: PageParams = {},
  ): Promise<Page<Tables['comments']['Row']>> {
    const limit = clampLimit(options.limit);
    const after = decodeCursor(options.cursor);
    let query = this.client
      .from('comments')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (after) query = query.or(keysetPredicate(after, false));
    const rows = dataOrThrow(await query.limit(limit + 1));
    return toPage(rows, limit);
  }

  async addComment(input: Tables['comments']['Insert']) {
    assertNoAbsoluteLocalPaths(input);
    const row = dataOrThrow(await this.client.from('comments').insert(input).select().single());
    publishDataChange({ resource: 'comment', op: 'create', row });
    return row;
  }
  async addRelation(input: Tables['task_relations']['Insert']) {
    return dataOrThrow(await this.client.from('task_relations').insert(input).select().single());
  }

  /** Every relation touching `taskId` from either side (as `task_id` or `related_task_id`), oldest first. */
  async listRelations(taskId: string) {
    return dataOrThrow(
      await this.client
        .from('task_relations')
        .select('*')
        .or(`task_id.eq.${taskId},related_task_id.eq.${taskId}`)
        .order('created_at'),
    );
  }

  async addEvidence(input: Tables['task_evidence']['Insert']) {
    assertNoAbsoluteLocalPaths(input);
    return dataOrThrow(await this.client.from('task_evidence').insert(input).select().single());
  }

  /** Newest-first evidence for one task (never mixed with the rest of the project's). */
  async listEvidenceForTask(taskId: string, limit = 20) {
    return dataOrThrow(
      await this.client
        .from('task_evidence')
        .select('*')
        .eq('task_id', taskId)
        .order('created_at', { ascending: false })
        .limit(limit),
    );
  }

  /** Newest-first evidence across the whole project, for a project-level recent summary. */
  async listEvidence(projectId: string, limit = 5) {
    return dataOrThrow(
      await this.client
        .from('task_evidence')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .limit(limit),
    );
  }

  /** Bounded, deterministically-ordered (`created_at` desc, `id` desc) page of a project's evidence feed. */
  async listEvidencePage(
    projectId: string,
    options: PageParams = {},
  ): Promise<Page<Tables['task_evidence']['Row']>> {
    const limit = clampLimit(options.limit);
    const after = decodeCursor(options.cursor);
    let query = this.client
      .from('task_evidence')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (after) query = query.or(keysetPredicate(after, false));
    const rows = dataOrThrow(await query.limit(limit + 1));
    return toPage(rows, limit);
  }

  async recordActivity(input: Tables['activity']['Insert']) {
    assertNoAbsoluteLocalPaths(input);
    return dataOrThrow(await this.client.from('activity').insert(input).select().single());
  }
  async listActivity(projectId: string, options: { limit?: number } = {}) {
    let query = this.client
      .from('activity')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    if (options.limit !== undefined) query = query.limit(options.limit);
    return dataOrThrow(await query);
  }

  /** Newest-first activity recorded against one specific task. */
  async listActivityForTask(taskId: string, limit = 20) {
    return dataOrThrow(
      await this.client
        .from('activity')
        .select('*')
        .eq('task_id', taskId)
        .order('created_at', { ascending: false })
        .limit(limit),
    );
  }

  /** Bounded, deterministically-ordered (`created_at` desc, `id` desc) page of a project's activity feed. */
  async listActivityPage(
    projectId: string,
    options: PageParams = {},
  ): Promise<Page<Tables['activity']['Row']>> {
    const limit = clampLimit(options.limit);
    const after = decodeCursor(options.cursor);
    let query = this.client
      .from('activity')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (after) query = query.or(keysetPredicate(after, false));
    const rows = dataOrThrow(await query.limit(limit + 1));
    return toPage(rows, limit);
  }
}

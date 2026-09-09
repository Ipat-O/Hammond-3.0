import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseClient } from './client';
import type { Database } from './database.types';
import { assertNoAbsoluteLocalPaths } from './pathGuard';
import { assertValidTaskStatus, toTaskWriteError } from './taskValidation';

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

  /**
   * Creates a task in `input.project_id`, optionally under `input.parent_task_id`. Routes through
   * the `tasks_create_checked` RPC (HAM3-014), which validates the parent belongs to the same
   * project/owner and is not archived, serialized against a concurrent archive of that exact
   * parent so an active child can never end up under an already-archived one. `requestId` is a
   * caller-chosen idempotency key: retrying with the exact same id and field values durably
   * replays the original result instead of creating a second task; the same id with different
   * values is rejected. Defaults to a fresh id per call for callers (desktop UI paths) that do not
   * need to survive a lost-response retry themselves.
   */
  async create(input: TaskInsert, requestId: string = crypto.randomUUID()) {
    assertNoAbsoluteLocalPaths(input);
    if (input.status !== undefined) assertValidTaskStatus(input.status);
    try {
      return dataOrThrow(
        await this.client.rpc('tasks_create_checked', {
          p_project_id: input.project_id,
          p_title: input.title,
          p_description: input.description ?? null,
          p_parent_task_id: input.parent_task_id ?? null,
          p_request_id: requestId,
        }),
      );
    } catch (error) {
      throw toTaskWriteError(error);
    }
  }

  /**
   * Updates title/description/status (whichever of those keys are present in `input`) on an
   * existing task, atomically checked against `expectedRevision` — the revision the caller last
   * read. A stale `expectedRevision` throws `TaskRevisionConflictError` (HAM3-014) instead of
   * silently overwriting a newer write from another session or an agent connection; callers
   * should reload the current row (revision + fields) and let the owner decide whether to reapply
   * their draft. Including `parent_task_id` in `input` (even as explicit `null`, to clear it)
   * reparents the task — checked server-side for cycles and archived/foreign parents, serialized
   * against a concurrent archive the same way `create` is; omitting the key entirely leaves the
   * current parent untouched, which is what every MCP `update_task` call does (reparenting is
   * outside that tool's first version).
   */
  async update(
    id: string,
    input: TaskUpdate,
    expectedRevision: number,
    requestId: string = crypto.randomUUID(),
  ) {
    assertNoAbsoluteLocalPaths(input);
    if (input.status !== undefined) assertValidTaskStatus(input.status);
    const changeParent = Object.hasOwn(input, 'parent_task_id');
    try {
      return dataOrThrow(
        await this.client.rpc('tasks_update_checked', {
          p_task_id: id,
          p_expected_revision: expectedRevision,
          p_title: input.title ?? null,
          p_description: input.description ?? null,
          p_status: input.status ?? null,
          p_request_id: requestId,
          p_change_parent: changeParent,
          p_parent_task_id: changeParent ? (input.parent_task_id ?? null) : null,
        }),
      );
    } catch (error) {
      throw toTaskWriteError(error);
    }
  }

  async remove(id: string) {
    return dataOrThrow(await this.client.from('tasks').delete().eq('id', id).select('id').single());
  }

  /**
   * Archives id plus every transitive descendant, atomically checked against `expectedRevision`
   * for the root. Routes through `tasks_archive_subtree_checked` (HAM3-014), which recomputes the
   * subtree from durable state under the same hierarchy lock `create`/`update` use, rather than
   * trusting a client-supplied snapshot — so a still-active child created concurrently under any
   * task in this subtree is either included in the archive or, if created after this archive
   * already committed, correctly refused by `create`'s own archived-parent check. A stale
   * `expectedRevision` throws `TaskRevisionConflictError`, same as `update`. `requestId` is the
   * same durable-dedup idempotency key `create`/`update`/`addComment` take: defaults to a fresh id
   * per call for callers that do not need to survive a lost-response retry themselves.
   */
  async archive(
    id: string,
    expectedRevision: number,
    requestId: string = crypto.randomUUID(),
  ): Promise<Tables['tasks']['Row'][]> {
    try {
      return dataOrThrow(
        await this.client.rpc('tasks_archive_subtree_checked', {
          p_root_task_id: id,
          p_expected_revision: expectedRevision,
          p_request_id: requestId,
        }),
      );
    } catch (error) {
      throw toTaskWriteError(error);
    }
  }
}

export class ProjectMemoryRepository {
  constructor(private readonly client: SupabaseClient<Database> = getSupabaseClient()) {}

  async listComments(taskId: string) {
    return dataOrThrow(
      await this.client.from('comments').select('*').eq('task_id', taskId).order('created_at'),
    );
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
  /**
   * Appends one durable comment. Routes through the `comments_add_checked` RPC (HAM3-014) for the
   * same durable request-id deduplication `TaskRepository.create`/`update` use: retrying with the
   * exact same `requestId` and body replays the original comment instead of creating a duplicate.
   * `requestId` defaults to a fresh id per call for callers that do not need to survive a
   * lost-response retry themselves.
   */
  async addComment(input: Tables['comments']['Insert'], requestId: string = crypto.randomUUID()) {
    assertNoAbsoluteLocalPaths(input);
    try {
      return dataOrThrow(
        await this.client.rpc('comments_add_checked', {
          p_task_id: input.task_id,
          p_body: input.body,
          p_request_id: requestId,
        }),
      );
    } catch (error) {
      throw toTaskWriteError(error);
    }
  }
  async addRelation(input: Tables['task_relations']['Insert']) {
    return dataOrThrow(await this.client.from('task_relations').insert(input).select().single());
  }
  async addEvidence(input: Tables['task_evidence']['Insert']) {
    assertNoAbsoluteLocalPaths(input);
    return dataOrThrow(await this.client.from('task_evidence').insert(input).select().single());
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
}

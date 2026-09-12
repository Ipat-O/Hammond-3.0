import type { AgentAccessDeps } from '../deps';

/**
 * A `taskId`/`projectId` (or `relatedTaskId`/`projectId`) pair that does not refer to tasks in
 * the same project. Carries `name === 'TargetConsistencyError'` so `toAgentAccessError`
 * (`src/agentAccess/errors.ts`) classifies it as `validation_error` (HTTP 400).
 *
 * The database already refuses to *persist* a mismatched row: `comments`, `task_relations`, and
 * `task_evidence` each carry a composite `(task_id, owner_id, project_id)` foreign key onto
 * `tasks(id, owner_id, project_id)` — and `task_relations` a second one for `related_task_id` —
 * see `supabase/migrations/20260813075651_create_project_memory_schema.sql` lines 20-32, 53-58.
 * This service-layer pre-check exists so the caller gets a clear, stable 400 instead of a raw
 * constraint-violation 500, and so a mismatch is rejected before a multi-step handler with
 * non-database side effects does any partial work.
 */
export class TargetConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetConsistencyError';
  }
}

/**
 * Verifies every `taskId` given resolves to a task in `projectId`. A missing or foreign task id
 * surfaces as `not_found` (RLS makes "not yours" and "does not exist" indistinguishable, and
 * `getById`'s `.single()` raises `PGRST116` for both) — never as a consistency error, which
 * would confirm the row exists. A real, owned task in a *different* project is the only case that
 * yields `TargetConsistencyError`.
 */
export async function assertTasksInProject(
  deps: AgentAccessDeps,
  projectId: string,
  taskIds: string[],
): Promise<void> {
  for (const taskId of taskIds) {
    const task = (await deps.tasks.getById(taskId)) as { project_id: string };
    if (task.project_id !== projectId) {
      throw new TargetConsistencyError(`Task ${taskId} does not belong to project ${projectId}.`);
    }
  }
}

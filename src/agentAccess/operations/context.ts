import { z } from 'zod';

import { defineOperation } from '../types';

const pageParams = {
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
};

const relationKind = z.enum(['depends_on', 'blocks', 'relates_to', 'duplicates']);

export const contextOperations = [
  defineOperation(
    'context.listRelations',
    'List every relation touching a task, from either side.',
    z.object({ taskId: z.string().min(1) }),
    (deps, input) => deps.memory.listRelations(input.taskId),
  ),

  defineOperation(
    'context.addRelation',
    'Record a relation between two tasks (depends_on, blocks, relates_to, duplicates).',
    z.object({
      taskId: z.string().min(1),
      projectId: z.string().min(1),
      relatedTaskId: z.string().min(1),
      kind: relationKind,
    }),
    (deps, input) =>
      deps.memory.addRelation({
        task_id: input.taskId,
        project_id: input.projectId,
        related_task_id: input.relatedTaskId,
        kind: input.kind,
      }),
  ),

  defineOperation(
    'context.listEvidenceForTask',
    'List evidence recorded against one task, newest first.',
    z.object({ taskId: z.string().min(1), limit: z.number().int().min(1).max(200).optional() }),
    (deps, input) => deps.memory.listEvidenceForTask(input.taskId, input.limit),
  ),

  defineOperation(
    'context.addEvidence',
    'Attach a piece of evidence (a link, artifact, or note) to a task.',
    z.object({
      taskId: z.string().min(1),
      projectId: z.string().min(1),
      kind: z.string().min(1),
      summary: z.string().optional(),
      sourceUrl: z.string().optional(),
      metadata: z.unknown().optional(),
    }),
    (deps, input) =>
      deps.memory.addEvidence({
        task_id: input.taskId,
        project_id: input.projectId,
        kind: input.kind,
        summary: input.summary,
        source_url: input.sourceUrl ?? null,
        metadata: (input.metadata as never) ?? {},
      }),
  ),

  defineOperation(
    'context.listActivity',
    "A project's activity feed, newest first, bounded and deterministically ordered. Returns { items, nextCursor }.",
    z.object({ projectId: z.string().min(1), ...pageParams }),
    (deps, input) => deps.memory.listActivityPage(input.projectId, input),
  ),

  defineOperation(
    'context.listActivityForTask',
    'Activity recorded against one specific task, newest first.',
    z.object({ taskId: z.string().min(1), limit: z.number().int().min(1).max(200).optional() }),
    (deps, input) => deps.memory.listActivityForTask(input.taskId, input.limit),
  ),

  defineOperation(
    'context.recordActivity',
    'Records a project (optionally task-scoped) activity entry. This is an append-only log, not proof of who — human or agent — performed the action.',
    z.object({
      projectId: z.string().min(1),
      taskId: z.string().min(1).nullable().optional(),
      eventType: z.string().min(1),
      details: z.unknown().optional(),
    }),
    (deps, input) =>
      deps.memory.recordActivity({
        project_id: input.projectId,
        task_id: input.taskId ?? null,
        event_type: input.eventType,
        details: (input.details as never) ?? {},
      }),
  ),

  defineOperation(
    'context.getProjectContext',
    'Composed project context in one call: the project record plus recent comments/evidence/activity. Each list carries nextCursor when truncated.',
    z.object({
      projectId: z.string().min(1),
      recentLimit: z.number().int().min(1).max(50).optional(),
    }),
    async (deps, input) => {
      const limit = input.recentLimit ?? 10;
      const [project, recentComments, recentEvidence, recentActivity] = await Promise.all([
        deps.projects.getById(input.projectId),
        deps.memory.listRecentCommentsPage(input.projectId, { limit }),
        deps.memory.listEvidencePage(input.projectId, { limit }),
        deps.memory.listActivityPage(input.projectId, { limit }),
      ]);
      return { project, recentComments, recentEvidence, recentActivity };
    },
  ),

  defineOperation(
    'context.getTaskContext',
    'Composed task context in one call: the task record plus its comments (first page), relations, evidence, and activity. `comments` carries nextCursor when the thread is truncated.',
    z.object({
      taskId: z.string().min(1),
      commentsLimit: z.number().int().min(1).max(200).optional(),
    }),
    async (deps, input) => {
      const limit = input.commentsLimit ?? 50;
      const [task, comments, relations, evidence, activity] = await Promise.all([
        deps.tasks.getById(input.taskId),
        deps.memory.listCommentsPage(input.taskId, { limit }),
        deps.memory.listRelations(input.taskId),
        deps.memory.listEvidenceForTask(input.taskId),
        deps.memory.listActivityForTask(input.taskId),
      ]);
      return { task, comments, relations, evidence, activity };
    },
  ),
];

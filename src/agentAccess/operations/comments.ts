import { z } from 'zod';

import { defineOperation } from '../types';

const pageParams = {
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
};

export const commentOperations = [
  defineOperation(
    'comments.listForTask',
    "List one task's comments, oldest first, bounded and deterministically ordered (created_at, id tiebreaker — never omits or repeats a row at a page boundary shared by equal timestamps). Returns { items, nextCursor }.",
    z.object({ taskId: z.string().min(1), ...pageParams }),
    (deps, input) => deps.memory.listCommentsPage(input.taskId, input),
  ),

  defineOperation(
    'comments.get',
    'Retrieve one comment by id (its task/project ids and body).',
    z.object({ commentId: z.string().min(1) }),
    (deps, input) => deps.memory.getCommentById(input.commentId),
  ),

  defineOperation(
    'comments.add',
    'Add a comment to a task.',
    z.object({ taskId: z.string().min(1), projectId: z.string().min(1), body: z.string().min(1) }),
    (deps, input) =>
      deps.memory.addComment({
        task_id: input.taskId,
        project_id: input.projectId,
        body: input.body,
      }),
  ),

  defineOperation(
    'comments.listRecentForProject',
    'Project-wide recent comment feed, newest first, bounded and deterministically ordered. Returns { items, nextCursor }.',
    z.object({ projectId: z.string().min(1), ...pageParams }),
    (deps, input) => deps.memory.listRecentCommentsPage(input.projectId, input),
  ),
];

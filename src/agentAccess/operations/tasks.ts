import { z } from 'zod';

import { TASK_STATUSES } from '../../data';
import { defineOperation } from '../types';

const pageParams = {
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
};

const taskStatus = z.enum(TASK_STATUSES);

export const taskOperations = [
  defineOperation(
    'tasks.list',
    "List one project's tasks, bounded and deterministically ordered (oldest first, id-tiebroken). Returns { items, nextCursor }.",
    z.object({
      projectId: z.string().min(1),
      includeArchived: z.boolean().optional(),
      ...pageParams,
    }),
    (deps, input) => deps.tasks.listPage(input.projectId, input),
  ),

  defineOperation(
    'tasks.get',
    'Retrieve one task by id.',
    z.object({ taskId: z.string().min(1) }),
    (deps, input) => deps.tasks.getById(input.taskId),
  ),

  defineOperation(
    'tasks.create',
    'Create a task inside a project, optionally nested under a parent (rejected if it would create a cycle).',
    z.object({
      id: z.string().min(1).optional(),
      projectId: z.string().min(1),
      title: z.string().min(1),
      description: z.string().optional(),
      status: taskStatus.optional(),
      priority: z.number().int().optional(),
      parentTaskId: z.string().min(1).nullable().optional(),
      dueAt: z.string().nullable().optional(),
    }),
    (deps, input) =>
      deps.tasks.create({
        id: input.id,
        project_id: input.projectId,
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        parent_task_id: input.parentTaskId,
        due_at: input.dueAt,
      }),
  ),

  defineOperation(
    'tasks.update',
    'Edit a task: fields, status transition, hierarchy (parentTaskId), or move to another project (projectId). Re-validates status and parent-cycle rules exactly like the UI.',
    z.object({
      taskId: z.string().min(1),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      status: taskStatus.optional(),
      priority: z.number().int().optional(),
      parentTaskId: z.string().min(1).nullable().optional(),
      dueAt: z.string().nullable().optional(),
      projectId: z.string().min(1).optional(),
    }),
    (deps, input) => {
      const { taskId, ...rest } = input;
      const update: Record<string, unknown> = {};
      if ('title' in rest) update.title = rest.title;
      if ('description' in rest) update.description = rest.description;
      if ('status' in rest) update.status = rest.status;
      if ('priority' in rest) update.priority = rest.priority;
      if ('parentTaskId' in rest) update.parent_task_id = rest.parentTaskId;
      if ('dueAt' in rest) update.due_at = rest.dueAt;
      if ('projectId' in rest) update.project_id = rest.projectId;
      return deps.tasks.update(taskId, update);
    },
  ),

  defineOperation(
    'tasks.archive',
    'Archive a task and its entire descendant subtree in one bulk write. Returns every archived row.',
    z.object({ taskId: z.string().min(1) }),
    (deps, input) => deps.tasks.archive(input.taskId),
  ),

  defineOperation(
    'tasks.delete',
    'Permanently delete a task.',
    z.object({ taskId: z.string().min(1) }),
    (deps, input) => deps.tasks.remove(input.taskId),
  ),
];

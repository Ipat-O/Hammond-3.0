import { z } from 'zod';

import { defineOperation } from '../types';

const pageParams = {
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
};

export const projectOperations = [
  defineOperation(
    'projects.list',
    'List projects, bounded and deterministically ordered (oldest first, id-tiebroken). Returns { items, nextCursor }; pass nextCursor back as `cursor` to continue.',
    z.object({ includeArchived: z.boolean().optional(), ...pageParams }),
    (deps, input) => deps.projects.listPage(input),
  ),

  defineOperation(
    'projects.get',
    'Retrieve one project by id.',
    z.object({ projectId: z.string().min(1) }),
    (deps, input) => deps.projects.getById(input.projectId),
  ),

  defineOperation(
    'projects.create',
    'Create a new project.',
    z.object({ name: z.string().min(1), description: z.string().optional() }),
    (deps, input) =>
      deps.projects.create({ name: input.name, description: input.description ?? '' }),
  ),

  defineOperation(
    'projects.update',
    "Edit a project's name and/or description.",
    z
      .object({
        projectId: z.string().min(1),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
      })
      .refine((value) => value.name !== undefined || value.description !== undefined, {
        message: 'At least one of name or description must be provided.',
      }),
    (deps, input) =>
      deps.projects.update(input.projectId, { name: input.name, description: input.description }),
  ),

  defineOperation(
    'projects.archive',
    'Archive a project.',
    z.object({ projectId: z.string().min(1) }),
    (deps, input) => deps.projects.archive(input.projectId),
  ),

  defineOperation(
    'projects.delete',
    'Permanently delete a project.',
    z.object({ projectId: z.string().min(1) }),
    (deps, input) => deps.projects.remove(input.projectId),
  ),
];

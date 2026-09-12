import { z } from 'zod';

import { INSTRUCTION_ROLES, PROVIDER_FAMILIES } from '../../instructions/types';
import { defineOperation } from '../types';

const role = z.enum(INSTRUCTION_ROLES);
const provider = z.enum(PROVIDER_FAMILIES);

export const assignmentOperations = [
  defineOperation(
    'assignments.list',
    'All three role assignments (orchestrator, worker, auditor) for a project.',
    z.object({ projectId: z.string().min(1) }),
    (deps, input) => deps.assignments.listForProject(input.projectId),
  ),

  defineOperation(
    'assignments.get',
    'One role assignment for a project.',
    z.object({ projectId: z.string().min(1), role }),
    (deps, input) => deps.assignments.getAssignment(input),
  ),

  defineOperation(
    'assignments.update',
    'Changes which provider performs a role — including orchestrator. Records the before/after provider in project activity as a best-effort audit trail (never proof of who requested the change); a logging failure never rolls back the already-committed assignment.',
    z.object({ projectId: z.string().min(1), role, provider }),
    async (deps, input) => {
      const previous = await deps.assignments.getAssignment({
        projectId: input.projectId,
        role: input.role,
      });
      const assignment = await deps.assignments.updateAssignment(input);
      try {
        await deps.memory.recordActivity({
          project_id: input.projectId,
          task_id: null,
          event_type: 'assignment_updated',
          details: {
            role: input.role,
            previousProvider: previous?.provider ?? null,
            nextProvider: input.provider,
          },
        });
        return { assignment, activityLogged: true };
      } catch (activityError) {
        return {
          assignment,
          activityLogged: false,
          activityError:
            activityError instanceof Error ? activityError.message : String(activityError),
        };
      }
    },
  ),
];

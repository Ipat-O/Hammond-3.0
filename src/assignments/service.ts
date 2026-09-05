import type { AssignmentRepository } from './contracts';
import { AssignmentDomainError, toAssignmentDomainError } from './errors';
import type { AgentAssignment, InstructionRole, ProviderFamily } from './types';

/**
 * Orchestrates the agent-assignment domain over an injected
 * `AssignmentRepository`. Resolving "which execution provider performs
 * this role" for the composition/injection flow (HAM3-006 section 4) goes
 * through `requireAssignment`, never a client-guessed default.
 */
export class AssignmentsService {
  constructor(private readonly repo: AssignmentRepository) {}

  async listForProject(projectId: string): Promise<AgentAssignment[]> {
    return this.repo.listForProject(projectId);
  }

  async getAssignment(params: {
    projectId: string;
    role: InstructionRole;
  }): Promise<AgentAssignment | null> {
    return this.repo.getAssignment(params);
  }

  /** Throws `missing_assignment` instead of returning null, for callers that require a resolved provider. */
  async requireAssignment(params: {
    projectId: string;
    role: InstructionRole;
  }): Promise<AgentAssignment> {
    const assignment = await this.repo.getAssignment(params);
    if (!assignment) {
      throw new AssignmentDomainError(
        'missing_assignment',
        `No agent assignment for project ${params.projectId}, role ${params.role}`,
      );
    }
    return assignment;
  }

  async updateAssignment(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
  }): Promise<AgentAssignment> {
    try {
      return await this.repo.updateAssignment(params);
    } catch (error) {
      throw toAssignmentDomainError(error);
    }
  }
}

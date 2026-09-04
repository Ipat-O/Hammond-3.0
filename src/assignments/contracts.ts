import type { AgentAssignment, InstructionRole, ProviderFamily } from './types';

/**
 * The typed persistence boundary the agent-assignment domain is built
 * from. The concrete Supabase-backed implementation lives in
 * `src/data/assignmentsRepository.ts`; tests inject an in-memory fake (see
 * `testFakes.ts`) so the service is verifiable with plain values, no
 * network involved.
 */
export interface AssignmentRepository {
  /** All three role assignments for one project, ordered orchestrator/worker/auditor. */
  listForProject(projectId: string): Promise<AgentAssignment[]>;

  getAssignment(params: {
    projectId: string;
    role: InstructionRole;
  }): Promise<AgentAssignment | null>;

  /** Changes which execution provider a role points at. The row always exists (seeded at project creation); this never creates or removes one. */
  updateAssignment(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
  }): Promise<AgentAssignment>;
}

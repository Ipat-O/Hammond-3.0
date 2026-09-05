import type { InstructionRole, ProviderFamily } from '../instructions/types';

export {
  INSTRUCTION_ROLES as AGENT_ASSIGNMENT_ROLES,
  PROVIDER_FAMILIES,
} from '../instructions/types';
export type { InstructionRole, ProviderFamily };

/**
 * Which execution provider (Codex, Claude Code, or Kilo Code) performs one
 * project role. This answers "which AI performs this role" (D-017) and is
 * deliberately distinct from `InstructionSelection`
 * (`src/instructions/types.ts`), which pins instruction *versions* for a
 * role/provider combination once a provider is already chosen.
 */
export interface AgentAssignment {
  id: string;
  ownerId: string;
  projectId: string;
  role: InstructionRole;
  provider: ProviderFamily;
  createdAt: string;
  updatedAt: string;
}

/** The D-014 routing defaults every project is seeded with at creation time. */
export const DEFAULT_AGENT_ASSIGNMENTS: Readonly<Record<InstructionRole, ProviderFamily>> = {
  orchestrator: 'codex',
  worker: 'claude_code',
  auditor: 'kilo_code',
};

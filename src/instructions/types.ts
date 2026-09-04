export const INSTRUCTION_ROLES = ['orchestrator', 'worker', 'auditor'] as const;
export type InstructionRole = (typeof INSTRUCTION_ROLES)[number];

export const PROVIDER_FAMILIES = ['codex', 'claude_code', 'kilo_code'] as const;
export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

export const INSTRUCTION_LAYERS = ['shared_role', 'provider', 'project_override'] as const;
export type InstructionLayer = (typeof INSTRUCTION_LAYERS)[number];

export interface InstructionVersion {
  id: string;
  templateId: string;
  ownerId: string | null;
  version: number;
  content: string;
  restoredFromVersionId: string | null;
  createdAt: string;
}

export interface InstructionTemplate {
  id: string;
  ownerId: string | null;
  role: InstructionRole;
  provider: ProviderFamily | null;
  layer: InstructionLayer;
  projectId: string | null;
  name: string;
  isBase: boolean;
}

export interface InstructionSelection {
  id: string;
  ownerId: string;
  projectId: string;
  role: InstructionRole;
  provider: ProviderFamily;
  sharedRoleVersionId: string;
  providerVersionId: string;
  overrideVersionId: string | null;
}

/** The exact composition inputs, in the order they are joined. Each is the empty string when that layer is omitted. */
export interface ComposedLayers {
  sharedRole: string;
  provider: string;
  projectOverride: string;
  taskWorkOrder: string;
}

export interface ActiveVersionIds {
  sharedRoleVersionId: string;
  providerVersionId: string;
  overrideVersionId: string | null;
}

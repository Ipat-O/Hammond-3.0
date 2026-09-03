import type {
  InstructionLayer,
  InstructionRole,
  InstructionSelection,
  InstructionTemplate,
  InstructionVersion,
  ProviderFamily,
} from './types';

/**
 * The typed persistence boundary the instruction domain is built from. The
 * concrete Supabase-backed implementation lives in `src/data/`; tests inject
 * an in-memory fake (see `testFakes.ts`) so composition, save, restore, and
 * selection logic are verifiable with plain values, no network involved.
 */
export interface InstructionRepository {
  /** The immutable seeded version for a base shared-role or provider template. Always exists. */
  getBaseVersion(params: {
    role: InstructionRole;
    provider: ProviderFamily | null;
    layer: 'shared_role' | 'provider';
  }): Promise<InstructionVersion>;

  /** The caller's own editable template for one slot, or null if it has never been created. */
  getOwnerTemplate(params: {
    role: InstructionRole;
    provider: ProviderFamily | null;
    layer: InstructionLayer;
    projectId: string | null;
  }): Promise<InstructionTemplate | null>;

  createOwnerTemplate(params: {
    role: InstructionRole;
    provider: ProviderFamily | null;
    layer: InstructionLayer;
    projectId: string | null;
    name: string;
  }): Promise<InstructionTemplate>;

  /** Appends a new version. `restoredFromVersionId` marks a restore rather than an ordinary save. */
  insertVersion(params: {
    templateId: string;
    content: string;
    restoredFromVersionId?: string | null;
  }): Promise<InstructionVersion>;

  /** Newest-first version history for one template. */
  listVersions(templateId: string): Promise<InstructionVersion[]>;

  getVersion(id: string): Promise<InstructionVersion>;
  getVersionsByIds(ids: readonly string[]): Promise<InstructionVersion[]>;

  getSelection(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
  }): Promise<InstructionSelection | null>;

  upsertSelection(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
    sharedRoleVersionId: string;
    providerVersionId: string;
    overrideVersionId: string | null;
  }): Promise<InstructionSelection>;
}

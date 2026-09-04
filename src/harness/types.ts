import type {
  HarnessClassification,
  HarnessInjectOutcome,
  HarnessRemoveOutcome,
  ManagedHeaderFields,
} from '../api/contracts';
import type { InstructionRole, ProviderFamily } from '../instructions/types';

export type {
  HarnessClassification,
  HarnessInjectOutcome,
  HarnessRemoveOutcome,
  ManagedHeaderFields,
};
export const MANAGED_HEADER_FORMAT_VERSION = 1;

/** What action Inject/Update would take, derived from the target's current classification. */
export type PendingAction = 'create' | 'update' | 'repair' | 'requires_decision';

export function deriveAction(classification: HarnessClassification): PendingAction {
  switch (classification.kind) {
    case 'Missing':
      return 'create';
    case 'ManagedValid':
      return 'update';
    case 'ManagedMalformed':
      return 'repair';
    case 'Unmanaged':
      return 'requires_decision';
  }
}

/**
 * Everything the minimal task UI needs to show for one role/provider: the assigned role and
 * provider (never labeled merely "Provider" — see HAM3-006 section 5), the exact relative
 * target path, its current ownership classification, the effective composed content, and the
 * action Inject/Update would take right now.
 */
export interface InjectionPreview {
  role: InstructionRole;
  provider: ProviderFamily;
  relativePath: string;
  classification: HarnessClassification;
  effectiveContent: string;
  action: PendingAction;
}

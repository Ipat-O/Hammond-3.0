import type {
  HarnessClassifyResult,
  HarnessInjectOutcome,
  HarnessRemoveOutcome,
  ManagedHeaderFields,
} from '../api/contracts';
import type { InstructionRole } from '../instructions/types';

/**
 * The one explicit adapter contract shared by the Codex, Claude Code, and Kilo Code harness
 * integrations (HAM3-006 section 2). A single implementation (`NativeHarnessAdapter`) is reused
 * for all three, each instance bound to one provider, rather than three near-duplicate classes.
 *
 * Correction 1: `classify` and `remove` take the exact `projectId`/`role` the caller expects to
 * currently occupy the target. A structurally valid Hammond document belonging to a different
 * project or role comes back as `ManagedForeign`, never `ManagedValid` — recording identity in a
 * header is not an ownership boundary unless something actually compares it.
 */
export interface HarnessAdapter {
  /** The exact relative target path this adapter's provider owns. */
  targetPath(): Promise<string>;

  /** Raw inspection: what currently occupies the target, classified against the caller's own expected (project, role). */
  classify(root: string, projectId: string, role: InstructionRole): Promise<HarnessClassifyResult>;

  /** Creates or updates the managed document. `fields`' own project/role is the expected identity: refuses (`RequiresConfirmation`) an Unmanaged target *or* a valid document belonging to a different project/role, unless `forceReplace` is set. */
  inject(
    root: string,
    fields: Omit<ManagedHeaderFields, 'provider' | 'formatVersion'>,
    composedContent: string,
    forceReplace: boolean,
  ): Promise<HarnessInjectOutcome>;

  /** Removes the target only when its current on-disk content is Hammond-managed and valid for exactly this project/role. */
  remove(root: string, projectId: string, role: InstructionRole): Promise<HarnessRemoveOutcome>;

  /**
   * The exact managed-document text `inject` would write for these fields and content, without
   * touching the filesystem. `fields`' own project/role is embedded the same way `inject` embeds
   * it; the result is guaranteed byte-identical to a real Inject/Update since both reuse the same
   * canonical formatter.
   */
  renderDocumentPreview(
    fields: Omit<ManagedHeaderFields, 'provider' | 'formatVersion'>,
    composedContent: string,
  ): Promise<string>;
}

import type {
  HarnessClassifyResult,
  HarnessInjectOutcome,
  HarnessRemoveOutcome,
  ManagedHeaderFields,
} from '../api/contracts';

/**
 * The one explicit adapter contract shared by the Codex, Claude Code, and Kilo Code harness
 * integrations (HAM3-006 section 2). A single implementation (`NativeHarnessAdapter`) is reused
 * for all three, each instance bound to one provider, rather than three near-duplicate classes.
 */
export interface HarnessAdapter {
  /** The exact relative target path this adapter's provider owns. */
  targetPath(): Promise<string>;

  /** Raw inspection: what currently occupies the target and how it classifies. */
  classify(root: string): Promise<HarnessClassifyResult>;

  /** Creates or updates the managed document. Refuses (`RequiresConfirmation`) an Unmanaged target unless `forceReplace` is set. */
  inject(
    root: string,
    fields: Omit<ManagedHeaderFields, 'provider' | 'formatVersion'>,
    composedContent: string,
    forceReplace: boolean,
  ): Promise<HarnessInjectOutcome>;

  /** Removes the target only when its current on-disk content is Hammond-managed and valid. */
  remove(root: string): Promise<HarnessRemoveOutcome>;
}

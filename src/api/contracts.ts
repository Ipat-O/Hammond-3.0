/**
 * Filesystem commands operate on a relative target inside an owner-authorized root
 * directory. The native layer rejects absolute targets, traversal, and symlink/reparse
 * escapes; it never accepts an arbitrary unscoped path. Pass `''` as `relativePath` to
 * address the root itself (used by `revealDirectory`).
 */
export type FilesystemErrorKind =
  'InvalidRoot' | 'AbsoluteTarget' | 'Traversal' | 'Escape' | 'NotFound' | 'Io';

export class FilesystemCommandError extends Error {
  readonly kind: FilesystemErrorKind;

  constructor(kind: FilesystemErrorKind, message: string) {
    super(message);
    this.name = 'FilesystemCommandError';
    this.kind = kind;
  }
}

export interface FilesystemCommands {
  /** Opens the native folder picker. Resolves to `null` promptly if the owner cancels. */
  selectDirectory(): Promise<string | null>;
  readTextFile(root: string, relativePath: string): Promise<string>;
  writeTextFile(root: string, relativePath: string, contents: string): Promise<void>;
  /** Removes exactly the requested file or empty directory; never recurses. */
  removePath(root: string, relativePath: string): Promise<void>;
  pathExists(root: string, relativePath: string): Promise<boolean>;
  /** Reveals `root` (or a relative target inside it) in the OS file manager. */
  revealDirectory(root: string, relativePath?: string): Promise<void>;
}

/** Local settings are device-scoped and must not be confused with Supabase project records. */
export interface LocalSettingsStore {
  read<T>(key: string): Promise<T | null>;
  write<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * The harness-adapter command surface: one shared native contract for the Codex, Claude Code,
 * and Kilo Code project-scoped instruction entry points. Every command resolves a target
 * relative to an owner-authorized root through the same confinement guard the filesystem
 * commands use; `provider` alone determines the exact relative path (see `native.ts`).
 */
export type HarnessProvider = 'codex' | 'claude_code' | 'kilo_code';
export type HarnessRole = 'orchestrator' | 'worker' | 'auditor';

/** The non-secret metadata every Hammond-generated document begins with. */
export interface ManagedHeaderFields {
  formatVersion: number;
  projectId: string;
  role: HarnessRole;
  provider: HarnessProvider;
  sharedRoleVersionId: string;
  providerVersionId: string;
  overrideVersionId: string | null;
  generatedAt: string;
}

/**
 * `ManagedForeign` is distinct from `ManagedValid`: both carry a structurally valid Hammond
 * header, but a foreign one belongs to a different project and/or role than the caller's own
 * expected identity (passed into `classify`/`remove`, or embedded in the `header` passed into
 * `inject`) and must never be silently overwritten or removed the way the caller's own current
 * document is (Correction 1 — recording identity in a header is not an ownership boundary
 * unless something actually compares it).
 */
export type HarnessClassification =
  | { kind: 'Missing' }
  | { kind: 'ManagedValid'; header: ManagedHeaderFields }
  | { kind: 'ManagedForeign'; header: ManagedHeaderFields }
  | { kind: 'ManagedMalformed' }
  | { kind: 'Unmanaged' };

export interface HarnessClassifyResult {
  relativePath: string;
  classification: HarnessClassification;
}

export type HarnessInjectOutcome =
  | { kind: 'Written'; relativePath: string }
  | { kind: 'RequiresConfirmation'; relativePath: string };

export type HarnessRemoveOutcome =
  | { kind: 'Removed'; relativePath: string }
  | { kind: 'NotFound'; relativePath: string }
  | { kind: 'Refused'; relativePath: string };

export interface HarnessCommands {
  targetPath(provider: HarnessProvider): Promise<string>;
  /** Classifies the target against the exact project/role this caller expects to currently occupy it; a valid document for a different project or role comes back `ManagedForeign`, not `ManagedValid`. */
  classify(
    root: string,
    projectId: string,
    role: HarnessRole,
    provider: HarnessProvider,
  ): Promise<HarnessClassifyResult>;
  /** Creates or updates the managed document. `header`'s own project/role/provider is the expected identity: refuses (`RequiresConfirmation`) an Unmanaged target *or* a valid document belonging to a different project/role, unless `forceReplace` is set. */
  inject(
    root: string,
    header: ManagedHeaderFields,
    composedContent: string,
    forceReplace: boolean,
  ): Promise<HarnessInjectOutcome>;
  /** Removes the target only when its current on-disk content is Hammond-managed and valid for exactly this project/role/provider. */
  remove(
    root: string,
    projectId: string,
    role: HarnessRole,
    provider: HarnessProvider,
  ): Promise<HarnessRemoveOutcome>;
  /**
   * Pure preview rendering: the exact managed-document text `inject` would write for these
   * fields and content, without touching the filesystem or requiring a root at all. Lets the
   * owner inspect the complete generated document before ever writing it, guaranteed
   * byte-identical to a real Inject/Update because both go through the same native formatter.
   */
  renderDocumentPreview(header: ManagedHeaderFields, composedContent: string): Promise<string>;
}

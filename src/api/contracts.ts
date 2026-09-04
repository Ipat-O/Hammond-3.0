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

export type HarnessClassification =
  | { kind: 'Missing' }
  | { kind: 'ManagedValid'; header: ManagedHeaderFields }
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
  classify(root: string, provider: HarnessProvider): Promise<HarnessClassifyResult>;
  /** Creates or updates the managed document. Refuses (`RequiresConfirmation`) an Unmanaged target unless `forceReplace` is set. */
  inject(
    root: string,
    header: ManagedHeaderFields,
    composedContent: string,
    forceReplace: boolean,
  ): Promise<HarnessInjectOutcome>;
  /** Removes the target only when its current on-disk content is Hammond-managed and valid. */
  remove(root: string, provider: HarnessProvider): Promise<HarnessRemoveOutcome>;
  setGitExclude(root: string, relativePath: string, excluded: boolean): Promise<void>;
  gitExcludeContains(root: string, relativePath: string): Promise<boolean>;
}

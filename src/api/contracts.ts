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

/**
 * Future native filesystem work must implement this contract without leaking filesystem details
 * into React components. The foundation intentionally provides no directory-picker behavior.
 */
export interface FilesystemCommands {
  selectDirectory(): Promise<string | null>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, contents: string): Promise<void>;
  removePath(path: string): Promise<void>;
  pathExists(path: string): Promise<boolean>;
  revealDirectory(path: string): Promise<void>;
}

/** Local settings are device-scoped and must not be confused with Supabase project records. */
export interface LocalSettingsStore {
  read<T>(key: string): Promise<T | null>;
  write<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

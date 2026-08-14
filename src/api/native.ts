import { invoke } from '@tauri-apps/api/core';

import {
  FilesystemCommandError,
  type FilesystemCommands,
  type LocalSettingsStore,
} from './contracts';

/** The stable, serializable information the desktop shell exposes to the UI. */
export interface AppInfo {
  name: string;
  version: string;
}

/** Typed entry points for commands implemented by the Tauri process. */
export interface NativeCommands {
  getAppInfo(): Promise<AppInfo>;
}

/** The only command wired in the foundation slice; feature commands should be added deliberately. */
export const nativeCommands: NativeCommands = {
  getAppInfo: () => invoke<AppInfo>('get_app_info'),
};

interface RawFilesystemError {
  kind: string;
  message: string;
}

function isRawFilesystemError(error: unknown): error is RawFilesystemError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'kind' in error &&
    'message' in error &&
    typeof (error as RawFilesystemError).kind === 'string' &&
    typeof (error as RawFilesystemError).message === 'string'
  );
}

async function invokeFs<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (isRawFilesystemError(error)) {
      throw new FilesystemCommandError(error.kind as FilesystemCommandError['kind'], error.message);
    }
    throw error;
  }
}

/** Tauri-backed implementation of the confined filesystem command surface. */
export const nativeFilesystem: FilesystemCommands = {
  selectDirectory: () => invokeFs<string | null>('select_directory', {}),
  readTextFile: (root, relativePath) => invokeFs<string>('read_text_file', { root, relativePath }),
  writeTextFile: (root, relativePath, contents) =>
    invokeFs<void>('write_text_file', { root, relativePath, contents }),
  removePath: (root, relativePath) => invokeFs<void>('remove_path', { root, relativePath }),
  pathExists: (root, relativePath) => invokeFs<boolean>('path_exists', { root, relativePath }),
  revealDirectory: (root, relativePath = '') =>
    invokeFs<void>('reveal_path', { root, relativePath }),
};

/** Tauri-backed implementation of device-local key/value settings storage. */
export const nativeLocalSettings: LocalSettingsStore = {
  read: <T>(key: string) => invoke<T | null>('local_settings_read', { key }),
  write: <T>(key: string, value: T) => invoke<void>('local_settings_write', { key, value }),
  remove: (key: string) => invoke<void>('local_settings_remove', { key }),
};

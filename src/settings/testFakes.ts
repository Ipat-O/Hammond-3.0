import { vi } from 'vitest';

import type { FilesystemCommands, LocalSettingsStore } from '../api/contracts';
import type { DirectoryContextServices } from './contracts';

/** In-memory `FilesystemCommands` fake for tests. Every real path is just a Map key. */
export function createFakeFilesystem(
  overrides: Partial<FilesystemCommands> = {},
): FilesystemCommands & { existingRoots: Set<string> } {
  const existingRoots = new Set<string>();
  return {
    existingRoots,
    selectDirectory: vi.fn().mockResolvedValue(null),
    readTextFile: vi.fn().mockResolvedValue(''),
    writeTextFile: vi.fn().mockResolvedValue(undefined),
    removePath: vi.fn().mockResolvedValue(undefined),
    pathExists: vi.fn(async (root: string) => existingRoots.has(root)),
    revealDirectory: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** In-memory `LocalSettingsStore` fake for tests. */
export function createFakeLocalSettings(): LocalSettingsStore {
  const store = new Map<string, unknown>();
  return {
    read: vi.fn(async (key: string) =>
      store.has(key) ? store.get(key) : null,
    ) as LocalSettingsStore['read'],
    write: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }) as LocalSettingsStore['write'],
    remove: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

export function createFakeDirectoryContextServices(
  overrides: Partial<DirectoryContextServices> = {},
): DirectoryContextServices {
  return {
    filesystem: createFakeFilesystem(),
    settings: createFakeLocalSettings(),
    ...overrides,
  };
}

import type { FilesystemCommands, LocalSettingsStore } from '../api/contracts';

/** The two device-local adapters the directory-context feature is built from. */
export interface DirectoryContextServices {
  filesystem: FilesystemCommands;
  settings: LocalSettingsStore;
}

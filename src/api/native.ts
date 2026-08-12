import { invoke } from '@tauri-apps/api/core';

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

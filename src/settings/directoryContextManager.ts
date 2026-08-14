import type { DirectoryContextServices } from './contracts';
import {
  createDefaultLocalSettingsState,
  LOCAL_SETTINGS_KEY,
  migrateLocalSettingsState,
  type DirectoryContextRecord,
  type LocalSettingsStateV1,
} from './state';

let idCounter = 0;
function generateContextId(): string {
  idCounter += 1;
  return `dir-${Date.now()}-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function labelFromPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/);
  return segments[segments.length - 1] || normalized;
}

/**
 * Owns device-local directory-context bindings: linking, switching, unlinking, and
 * replacing a moved directory. Pure logic over injected [`DirectoryContextServices`] so it
 * is testable without Tauri; the UI layer is a thin consumer of this manager's state and
 * actions.
 */
export class DirectoryContextManager {
  constructor(private readonly services: DirectoryContextServices) {}

  async loadState(): Promise<LocalSettingsStateV1> {
    const raw = await this.services.settings.read<unknown>(LOCAL_SETTINGS_KEY);
    return raw === null ? createDefaultLocalSettingsState() : migrateLocalSettingsState(raw);
  }

  private async saveState(state: LocalSettingsStateV1): Promise<void> {
    await this.services.settings.write(LOCAL_SETTINGS_KEY, state);
  }

  contextsForProject(state: LocalSettingsStateV1, projectId: string): DirectoryContextRecord[] {
    return state.directoryContexts.filter((context) => context.projectId === projectId);
  }

  findContext(state: LocalSettingsStateV1, contextId: string): DirectoryContextRecord | null {
    return state.directoryContexts.find((context) => context.id === contextId) ?? null;
  }

  /**
   * Binds `path` as a directory context for `projectId`, or reactivates an existing binding
   * for the same project and path. Two distinct paths (including two worktrees of the same
   * repository) always produce two distinct, stable context identities.
   */
  async linkDirectory(
    state: LocalSettingsStateV1,
    projectId: string,
    path: string,
  ): Promise<{ state: LocalSettingsStateV1; context: DirectoryContextRecord }> {
    const now = new Date().toISOString();
    const existing = state.directoryContexts.find(
      (context) => context.projectId === projectId && context.path === path,
    );
    if (existing) {
      const touched: DirectoryContextRecord = { ...existing, lastOpenedAt: now };
      const nextState: LocalSettingsStateV1 = {
        ...state,
        directoryContexts: state.directoryContexts.map((context) =>
          context.id === touched.id ? touched : context,
        ),
        lastOpenContextId: touched.id,
        resumeScreen: 'workspace',
      };
      await this.saveState(nextState);
      return { state: nextState, context: touched };
    }

    const context: DirectoryContextRecord = {
      id: generateContextId(),
      projectId,
      path,
      label: labelFromPath(path),
      createdAt: now,
      lastOpenedAt: now,
    };
    const nextState: LocalSettingsStateV1 = {
      ...state,
      directoryContexts: [...state.directoryContexts, context],
      lastOpenContextId: context.id,
      resumeScreen: 'workspace',
    };
    await this.saveState(nextState);
    return { state: nextState, context };
  }

  /** Makes an already-bound context the active/last-open one (the "change" action). */
  async setActive(state: LocalSettingsStateV1, contextId: string): Promise<LocalSettingsStateV1> {
    const now = new Date().toISOString();
    const nextState: LocalSettingsStateV1 = {
      ...state,
      directoryContexts: state.directoryContexts.map((context) =>
        context.id === contextId ? { ...context, lastOpenedAt: now } : context,
      ),
      lastOpenContextId: contextId,
      resumeScreen: 'workspace',
    };
    await this.saveState(nextState);
    return nextState;
  }

  /** Closes (unlinks) a binding. Never deletes the directory or its contents. */
  async unlink(state: LocalSettingsStateV1, contextId: string): Promise<LocalSettingsStateV1> {
    const nextState: LocalSettingsStateV1 = {
      ...state,
      directoryContexts: state.directoryContexts.filter((context) => context.id !== contextId),
      lastOpenContextId: state.lastOpenContextId === contextId ? null : state.lastOpenContextId,
    };
    await this.saveState(nextState);
    return nextState;
  }

  /**
   * Recovery action: points a stale binding at a replacement path without changing its
   * identity or Hammond project association.
   */
  async replacePath(
    state: LocalSettingsStateV1,
    contextId: string,
    path: string,
  ): Promise<LocalSettingsStateV1> {
    const now = new Date().toISOString();
    const nextState: LocalSettingsStateV1 = {
      ...state,
      directoryContexts: state.directoryContexts.map((context) =>
        context.id === contextId
          ? { ...context, path, label: labelFromPath(path), lastOpenedAt: now }
          : context,
      ),
    };
    await this.saveState(nextState);
    return nextState;
  }

  async checkReachable(path: string): Promise<boolean> {
    return this.services.filesystem.pathExists(path, '');
  }

  async reveal(path: string): Promise<void> {
    await this.services.filesystem.revealDirectory(path);
  }

  async pickDirectory(): Promise<string | null> {
    return this.services.filesystem.selectDirectory();
  }
}

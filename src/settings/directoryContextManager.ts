import type { DirectoryContextServices } from './contracts';
import {
  createDefaultLocalSettingsState,
  LOCAL_SETTINGS_KEY,
  migrateLocalSettingsState,
  type DirectoryContextRecord,
  type LocalSettingsStateV2,
  type ResumeScreen,
} from './state';

let idCounter = 0;
function generateContextId(): string {
  idCounter += 1;
  return `dir-${Date.now()}-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function labelFromPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/);
  return segments[segments.length - 1] || normalized;
}

/**
 * Normalizes equivalent path spelling (mixed `/`/`\` separators, a trailing separator, doubled
 * separators) for comparison only — the stored `path` value is never rewritten. Deliberately
 * bounded: it never folds case, since that would incorrectly collapse two genuinely distinct
 * worktrees on a case-sensitive filesystem while this pure-TS layer has no reliable way to know
 * the target platform's actual case sensitivity.
 */
export function normalizePathForComparison(path: string): string {
  const withForwardSlashes = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (withForwardSlashes.length > 1 && withForwardSlashes.endsWith('/')) {
    return withForwardSlashes.slice(0, -1);
  }
  return withForwardSlashes;
}

export interface ResumeSelectionPatch {
  selectedProjectId?: string | null;
  selectedTaskId?: string | null;
  resumeScreen?: ResumeScreen;
}

/**
 * Owns device-local directory-context bindings and the owner's resume position: linking,
 * switching, closing, forgetting, replacing a moved directory, and persisting which project,
 * task, and screen to resume into. Pure logic over injected [`DirectoryContextServices`] so it
 * is testable without Tauri; the UI layer is a thin consumer of this manager's state and
 * actions.
 */
export class DirectoryContextManager {
  // Every `settings.write` call is chained onto this so writes always complete in the exact
  // order they were issued, regardless of how long any individual write takes — rapid
  // navigation always leaves the LAST issued write as the last one applied, never an earlier
  // one landing late and clobbering it. A failed write does not poison the chain for later
  // callers (each link swallows its own rejection before the next one is appended).
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly services: DirectoryContextServices) {}

  async loadState(): Promise<LocalSettingsStateV2> {
    const raw = await this.services.settings.read<unknown>(LOCAL_SETTINGS_KEY);
    return raw === null ? createDefaultLocalSettingsState() : migrateLocalSettingsState(raw);
  }

  private async saveState(state: LocalSettingsStateV2): Promise<void> {
    const write = this.writeChain.then(() =>
      this.services.settings.write(LOCAL_SETTINGS_KEY, state),
    );
    this.writeChain = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
  }

  contextsForProject(state: LocalSettingsStateV2, projectId: string): DirectoryContextRecord[] {
    return state.directoryContexts.filter((context) => context.projectId === projectId);
  }

  findContext(state: LocalSettingsStateV2, contextId: string): DirectoryContextRecord | null {
    return state.directoryContexts.find((context) => context.id === contextId) ?? null;
  }

  /** The active context belonging to `projectId`, or `null` — never a first-binding guess. */
  activeContextForProject(
    state: LocalSettingsStateV2,
    projectId: string,
  ): DirectoryContextRecord | null {
    if (!state.lastOpenContextId) return null;
    const active = this.findContext(state, state.lastOpenContextId);
    return active && active.projectId === projectId ? active : null;
  }

  /**
   * Every remembered binding (in any project) whose path is an equivalent spelling of `path`.
   * Used by the top-level "Open directory" flow to resolve a picked path before knowing which
   * project it belongs to. Returns more than one entry only for an ambiguous legacy binding
   * (the same path linked to more than one project) — callers must resolve that explicitly
   * rather than guessing which project to open.
   */
  findContextsForPath(state: LocalSettingsStateV2, path: string): DirectoryContextRecord[] {
    const normalized = normalizePathForComparison(path);
    return state.directoryContexts.filter(
      (context) => normalizePathForComparison(context.path) === normalized,
    );
  }

  /**
   * Binds `path` as a directory context for `projectId`, or reactivates an existing binding
   * for the same project and an equivalent path. Two distinct paths (including two worktrees of
   * the same repository) always produce two distinct, stable context identities.
   */
  async linkDirectory(
    state: LocalSettingsStateV2,
    projectId: string,
    path: string,
  ): Promise<{ state: LocalSettingsStateV2; context: DirectoryContextRecord }> {
    const now = new Date().toISOString();
    const normalized = normalizePathForComparison(path);
    const existing = state.directoryContexts.find(
      (context) =>
        context.projectId === projectId && normalizePathForComparison(context.path) === normalized,
    );
    if (existing) {
      const touched: DirectoryContextRecord = { ...existing, lastOpenedAt: now };
      const nextState: LocalSettingsStateV2 = {
        ...state,
        directoryContexts: state.directoryContexts.map((context) =>
          context.id === touched.id ? touched : context,
        ),
        lastOpenContextId: touched.id,
        selectedProjectId: projectId,
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
    const nextState: LocalSettingsStateV2 = {
      ...state,
      directoryContexts: [...state.directoryContexts, context],
      lastOpenContextId: context.id,
      selectedProjectId: projectId,
    };
    await this.saveState(nextState);
    return { state: nextState, context };
  }

  /** Makes an already-bound context the active one (the "Change"/"Open" action). */
  async setActive(state: LocalSettingsStateV2, contextId: string): Promise<LocalSettingsStateV2> {
    const now = new Date().toISOString();
    const context = this.findContext(state, contextId);
    const nextState: LocalSettingsStateV2 = {
      ...state,
      directoryContexts: state.directoryContexts.map((entry) =>
        entry.id === contextId ? { ...entry, lastOpenedAt: now } : entry,
      ),
      lastOpenContextId: contextId,
      selectedProjectId: context?.projectId ?? state.selectedProjectId,
    };
    await this.saveState(nextState);
    return nextState;
  }

  /**
   * Closes the active directory: clears the "currently open" pointer while preserving the
   * remembered binding (and every other remembered binding) exactly as-is. This is the
   * reversible "Close" action — distinct from `forget`, which actually removes a binding.
   * A no-op (but still resolves normally) if nothing is currently active.
   */
  async closeActive(state: LocalSettingsStateV2): Promise<LocalSettingsStateV2> {
    if (!state.lastOpenContextId) return state;
    const nextState: LocalSettingsStateV2 = { ...state, lastOpenContextId: null };
    await this.saveState(nextState);
    return nextState;
  }

  /**
   * Forgets (permanently removes) a remembered binding. Never deletes the directory or its
   * contents — this only forgets the local pointer to it.
   */
  async forget(state: LocalSettingsStateV2, contextId: string): Promise<LocalSettingsStateV2> {
    const nextState: LocalSettingsStateV2 = {
      ...state,
      directoryContexts: state.directoryContexts.filter((context) => context.id !== contextId),
      lastOpenContextId: state.lastOpenContextId === contextId ? null : state.lastOpenContextId,
    };
    await this.saveState(nextState);
    return nextState;
  }

  /** @deprecated Use {@link forget}; kept as an alias so existing call sites keep compiling. */
  async unlink(state: LocalSettingsStateV2, contextId: string): Promise<LocalSettingsStateV2> {
    return this.forget(state, contextId);
  }

  /**
   * Recovery action: points a stale binding at a replacement path without changing its
   * identity or Hammond project association.
   */
  async replacePath(
    state: LocalSettingsStateV2,
    contextId: string,
    path: string,
  ): Promise<LocalSettingsStateV2> {
    const now = new Date().toISOString();
    const nextState: LocalSettingsStateV2 = {
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

  /**
   * Persists the owner's resume position (selected project/task/screen) device-locally.
   * Only the fields present in `patch` change; directory bindings and the active context are
   * carried through untouched. Writes are queued through the same serialized chain as every
   * other change here, so a rapid sequence of navigations always finishes with the last one
   * issued, never an earlier one landing late.
   */
  async updateResumeSelection(
    state: LocalSettingsStateV2,
    patch: ResumeSelectionPatch,
  ): Promise<LocalSettingsStateV2> {
    const nextState: LocalSettingsStateV2 = { ...state, ...patch };
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

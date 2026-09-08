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
 *
 * Every mutating method still accepts an explicit `state` parameter (so a caller/test can operate
 * without ever calling `loadState()` first), but the ACTUAL base used to compute the next state is
 * this manager's own tracked `latestState` whenever one exists, never the caller's possibly-stale
 * snapshot. That snapshot is only a fallback for the very first mutation this instance ever makes.
 * This is what makes concurrent operations safe: two calls issued back-to-back always compose
 * (each building on the other's already-applied change) instead of the second one racing to
 * overwrite the first with data computed before the first had happened. `latestState` (and the
 * notification to `subscribe`rs) updates synchronously the moment a mutation is computed — never
 * gated behind the slower, serialized on-disk write — so any other code reading "the current
 * state" immediately afterward (even before that write settles) sees the fully merged result.
 */
export class DirectoryContextManager {
  private latestState: LocalSettingsStateV2 | null = null;
  private readonly listeners = new Set<(state: LocalSettingsStateV2) => void>();
  // Every `settings.write` call is chained onto this so writes always complete in the exact
  // order they were issued, regardless of how long any individual write takes. A failed write
  // does not poison the chain for later callers (each link swallows its own rejection before the
  // next one is appended) — but IS surfaced to whichever caller's own `commit()` produced it.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly services: DirectoryContextServices) {}

  /**
   * Registers a listener notified synchronously every time this manager's canonical state
   * changes (on `loadState()` success and after every mutation), independent of and ahead of
   * whichever specific call triggered it settling its own on-disk write. This is the mechanism a
   * host UI should use to mirror this manager's state — never a caller's own `.then(setState)` on
   * an individual mutating call, which can resolve out of order relative to others and regress
   * the UI to a stale value.
   */
  subscribe(listener: (state: LocalSettingsStateV2) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setLatestState(state: LocalSettingsStateV2): void {
    this.latestState = state;
    for (const listener of this.listeners) listener(state);
  }

  /** The most current known state: this manager's own tracked value once it has one, else `fallback`. */
  private baseState(fallback: LocalSettingsStateV2): LocalSettingsStateV2 {
    return this.latestState ?? fallback;
  }

  async loadState(): Promise<LocalSettingsStateV2> {
    const raw = await this.services.settings.read<unknown>(LOCAL_SETTINGS_KEY);
    const state = raw === null ? createDefaultLocalSettingsState() : migrateLocalSettingsState(raw);
    this.setLatestState(state);
    return state;
  }

  /**
   * Commits `nextState` as the new canonical state (synchronously, notifying subscribers
   * immediately) and queues the durable write behind every earlier one still in flight. The
   * returned promise settles with the write's own outcome, so a caller can still detect and
   * surface a persistence failure — but that failure never un-does the in-memory commit already
   * made: the next successful write (computed from `latestState`, which still includes this
   * change) naturally carries it through.
   */
  private commit(nextState: LocalSettingsStateV2): Promise<LocalSettingsStateV2> {
    this.setLatestState(nextState);
    const write = this.writeChain.then(() =>
      this.services.settings.write(LOCAL_SETTINGS_KEY, nextState),
    );
    this.writeChain = write.then(
      () => undefined,
      () => undefined,
    );
    return write.then(() => nextState);
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
   * rather than guessing which project to open. Callers are responsible for filtering the result
   * against whichever projects are actually accessible right now (this manager has no notion of
   * Supabase-authorized projects) before treating a match as "known".
   */
  findContextsForPath(state: LocalSettingsStateV2, path: string): DirectoryContextRecord[] {
    const current = this.baseState(state);
    const normalized = normalizePathForComparison(path);
    return current.directoryContexts.filter(
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
    const current = this.baseState(state);
    const now = new Date().toISOString();
    const normalized = normalizePathForComparison(path);
    const existing = current.directoryContexts.find(
      (context) =>
        context.projectId === projectId && normalizePathForComparison(context.path) === normalized,
    );
    if (existing) {
      const touched: DirectoryContextRecord = { ...existing, lastOpenedAt: now };
      const nextState: LocalSettingsStateV2 = {
        ...current,
        directoryContexts: current.directoryContexts.map((context) =>
          context.id === touched.id ? touched : context,
        ),
        lastOpenContextId: touched.id,
        selectedProjectId: projectId,
      };
      const committed = await this.commit(nextState);
      return { state: committed, context: touched };
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
      ...current,
      directoryContexts: [...current.directoryContexts, context],
      lastOpenContextId: context.id,
      selectedProjectId: projectId,
    };
    const committed = await this.commit(nextState);
    return { state: committed, context };
  }

  /** Makes an already-bound context the active one (the "Change"/"Open" action). */
  async setActive(state: LocalSettingsStateV2, contextId: string): Promise<LocalSettingsStateV2> {
    const current = this.baseState(state);
    const now = new Date().toISOString();
    const context = this.findContext(current, contextId);
    const nextState: LocalSettingsStateV2 = {
      ...current,
      directoryContexts: current.directoryContexts.map((entry) =>
        entry.id === contextId ? { ...entry, lastOpenedAt: now } : entry,
      ),
      lastOpenContextId: contextId,
      selectedProjectId: context?.projectId ?? current.selectedProjectId,
    };
    return this.commit(nextState);
  }

  /**
   * Closes the active directory: clears the "currently open" pointer while preserving the
   * remembered binding (and every other remembered binding) exactly as-is. This is the
   * reversible "Close" action — distinct from `forget`, which actually removes a binding.
   * A no-op (but still resolves normally) if nothing is currently active.
   */
  async closeActive(state: LocalSettingsStateV2): Promise<LocalSettingsStateV2> {
    const current = this.baseState(state);
    if (!current.lastOpenContextId) return current;
    const nextState: LocalSettingsStateV2 = { ...current, lastOpenContextId: null };
    return this.commit(nextState);
  }

  /**
   * Forgets (permanently removes) a remembered binding. Never deletes the directory or its
   * contents — this only forgets the local pointer to it.
   */
  async forget(state: LocalSettingsStateV2, contextId: string): Promise<LocalSettingsStateV2> {
    const current = this.baseState(state);
    const nextState: LocalSettingsStateV2 = {
      ...current,
      directoryContexts: current.directoryContexts.filter((context) => context.id !== contextId),
      lastOpenContextId: current.lastOpenContextId === contextId ? null : current.lastOpenContextId,
    };
    return this.commit(nextState);
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
    const current = this.baseState(state);
    const now = new Date().toISOString();
    const nextState: LocalSettingsStateV2 = {
      ...current,
      directoryContexts: current.directoryContexts.map((context) =>
        context.id === contextId
          ? { ...context, path, label: labelFromPath(path), lastOpenedAt: now }
          : context,
      ),
    };
    return this.commit(nextState);
  }

  /**
   * Persists the owner's resume position (selected project/task/screen) device-locally.
   * Only the fields present in `patch` change; directory bindings and the active context are
   * carried through untouched (merged onto this manager's own canonical state, not the caller's
   * possibly-stale snapshot — see the class doc comment).
   */
  async updateResumeSelection(
    state: LocalSettingsStateV2,
    patch: ResumeSelectionPatch,
  ): Promise<LocalSettingsStateV2> {
    const current = this.baseState(state);
    const nextState: LocalSettingsStateV2 = { ...current, ...patch };
    return this.commit(nextState);
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

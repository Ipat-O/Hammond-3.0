/**
 * Device-local, versioned state for project-to-directory bindings and the owner's resume
 * position. This never touches Supabase: absolute local paths and the last-open UI position
 * live here only, keyed by Supabase ids as local foreign keys (see docs/MODULE_BOUNDARIES.md).
 */
export const LOCAL_SETTINGS_VERSION = 2 as const;
export const LOCAL_SETTINGS_KEY = 'hammond.directoryContexts';

export interface DirectoryContextRecord {
  id: string;
  projectId: string;
  path: string;
  label: string;
  createdAt: string;
  lastOpenedAt: string;
}

/** The primary screen the owner was last looking at. `home` is the default landing screen. */
export type ResumeScreen = 'home' | 'workspace' | 'instructions';

/** The persisted v1 shape (HAM3-004): directory bindings plus a single `workspace` resume marker. */
export interface LocalSettingsStateV1 {
  version: 1;
  directoryContexts: DirectoryContextRecord[];
  lastOpenContextId: string | null;
  resumeScreen: 'workspace' | null;
}

export interface LocalSettingsStateV2 {
  version: typeof LOCAL_SETTINGS_VERSION;
  directoryContexts: DirectoryContextRecord[];
  /** The one currently active (open) directory context, if any. Never a "default" guess. */
  lastOpenContextId: string | null;
  /** The project the owner was last looking at, device-locally. */
  selectedProjectId: string | null;
  /** The task selected within `selectedProjectId`, if any. */
  selectedTaskId: string | null;
  /** The primary screen to resume into. `null` means "not recorded yet" — resume to `home`. */
  resumeScreen: ResumeScreen | null;
}

export type LocalSettingsState = LocalSettingsStateV2;

export function createDefaultLocalSettingsState(): LocalSettingsStateV2 {
  return {
    version: LOCAL_SETTINGS_VERSION,
    directoryContexts: [],
    lastOpenContextId: null,
    selectedProjectId: null,
    selectedTaskId: null,
    resumeScreen: null,
  };
}

function isDirectoryContextRecord(value: unknown): value is DirectoryContextRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.projectId === 'string' &&
    typeof record.path === 'string' &&
    typeof record.label === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.lastOpenedAt === 'string'
  );
}

function isResumeScreen(value: unknown): value is ResumeScreen {
  return value === 'home' || value === 'workspace' || value === 'instructions';
}

function readDirectoryContexts(value: Record<string, unknown>): DirectoryContextRecord[] {
  return Array.isArray(value.directoryContexts)
    ? value.directoryContexts.filter(isDirectoryContextRecord)
    : [];
}

function readLastOpenContextId(
  value: Record<string, unknown>,
  directoryContexts: DirectoryContextRecord[],
): string | null {
  const contextIds = new Set(directoryContexts.map((context) => context.id));
  return typeof value.lastOpenContextId === 'string' && contextIds.has(value.lastOpenContextId)
    ? value.lastOpenContextId
    : null;
}

/**
 * Migrates a well-formed v1 record forward: bindings and the active directory survive as-is;
 * `selectedProjectId` is inferred from whichever project the active directory belonged to (v1
 * never tracked a selected project independent of its directory); there was never a persisted
 * task selection; the old single `'workspace'` marker maps onto the same v2 screen value.
 */
function migrateV1(value: Record<string, unknown>): LocalSettingsStateV2 {
  const directoryContexts = readDirectoryContexts(value);
  const lastOpenContextId = readLastOpenContextId(value, directoryContexts);
  const activeContext = directoryContexts.find((context) => context.id === lastOpenContextId);
  return {
    version: LOCAL_SETTINGS_VERSION,
    directoryContexts,
    lastOpenContextId,
    selectedProjectId: activeContext?.projectId ?? null,
    selectedTaskId: null,
    resumeScreen: value.resumeScreen === 'workspace' ? 'workspace' : null,
  };
}

function migrateV2(value: Record<string, unknown>): LocalSettingsStateV2 {
  const directoryContexts = readDirectoryContexts(value);
  const lastOpenContextId = readLastOpenContextId(value, directoryContexts);
  const selectedProjectId =
    typeof value.selectedProjectId === 'string' ? value.selectedProjectId : null;
  const selectedTaskId = typeof value.selectedTaskId === 'string' ? value.selectedTaskId : null;
  const resumeScreen = isResumeScreen(value.resumeScreen) ? value.resumeScreen : null;
  return {
    version: LOCAL_SETTINGS_VERSION,
    directoryContexts,
    lastOpenContextId,
    selectedProjectId,
    selectedTaskId,
    resumeScreen,
  };
}

/**
 * Normalizes whatever was read back from local settings storage into a valid current state.
 * Missing keys, corrupt values, unversioned legacy data, or an unknown future version all fall
 * back to a fresh default rather than throwing: local settings must never block startup, and a
 * lost binding surfaces later as an ordinary "missing directory" recovery state once the owner
 * re-links their project. A well-formed v1 record is migrated forward instead of discarded, so
 * an upgrade never forgets the owner's existing directory bindings.
 */
export function migrateLocalSettingsState(raw: unknown): LocalSettingsStateV2 {
  if (!raw || typeof raw !== 'object') return createDefaultLocalSettingsState();
  const value = raw as Record<string, unknown>;
  if (value.version === 1) return migrateV1(value);
  if (value.version !== LOCAL_SETTINGS_VERSION) return createDefaultLocalSettingsState();
  return migrateV2(value);
}

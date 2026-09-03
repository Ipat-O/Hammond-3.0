/**
 * Device-local, versioned state for project-to-directory bindings. This never touches
 * Supabase: absolute local paths live here only, keyed by the Supabase project id as a
 * local foreign key (see docs/MODULE_BOUNDARIES.md).
 */
export const LOCAL_SETTINGS_VERSION = 1 as const;
export const LOCAL_SETTINGS_KEY = 'hammond.directoryContexts';

export interface DirectoryContextRecord {
  id: string;
  projectId: string;
  path: string;
  label: string;
  createdAt: string;
  lastOpenedAt: string;
}

export type ResumeScreen = 'workspace';

export interface LocalSettingsStateV1 {
  version: typeof LOCAL_SETTINGS_VERSION;
  directoryContexts: DirectoryContextRecord[];
  lastOpenContextId: string | null;
  resumeScreen: ResumeScreen | null;
}

export function createDefaultLocalSettingsState(): LocalSettingsStateV1 {
  return {
    version: LOCAL_SETTINGS_VERSION,
    directoryContexts: [],
    lastOpenContextId: null,
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

/**
 * Normalizes whatever was read back from local settings storage into a valid v1 state.
 * Missing keys, corrupt values, unversioned legacy data, or an unknown future version all
 * fall back to a fresh default rather than throwing: local settings must never block
 * startup, and a lost binding surfaces later as an ordinary "missing directory" recovery
 * state once the owner re-links their project.
 */
export function migrateLocalSettingsState(raw: unknown): LocalSettingsStateV1 {
  if (!raw || typeof raw !== 'object') return createDefaultLocalSettingsState();
  const value = raw as Record<string, unknown>;
  if (value.version !== LOCAL_SETTINGS_VERSION) return createDefaultLocalSettingsState();

  const directoryContexts = Array.isArray(value.directoryContexts)
    ? value.directoryContexts.filter(isDirectoryContextRecord)
    : [];
  const contextIds = new Set(directoryContexts.map((context) => context.id));
  const lastOpenContextId =
    typeof value.lastOpenContextId === 'string' && contextIds.has(value.lastOpenContextId)
      ? value.lastOpenContextId
      : null;
  const resumeScreen: ResumeScreen | null = value.resumeScreen === 'workspace' ? 'workspace' : null;

  return {
    version: LOCAL_SETTINGS_VERSION,
    directoryContexts,
    lastOpenContextId,
    resumeScreen,
  };
}

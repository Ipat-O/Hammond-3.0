import {
  createDefaultLocalSettingsState,
  LOCAL_SETTINGS_VERSION,
  migrateLocalSettingsState,
  type LocalSettingsStateV1,
} from './state';

describe('createDefaultLocalSettingsState', () => {
  it('starts with no bindings, no active context, no selection, and no resume marker', () => {
    expect(createDefaultLocalSettingsState()).toEqual({
      version: LOCAL_SETTINGS_VERSION,
      directoryContexts: [],
      lastOpenContextId: null,
      selectedProjectId: null,
      selectedTaskId: null,
      resumeScreen: null,
    });
  });
});

describe('migrateLocalSettingsState', () => {
  it('defaults when there is nothing stored yet', () => {
    expect(migrateLocalSettingsState(null)).toEqual(createDefaultLocalSettingsState());
    expect(migrateLocalSettingsState(undefined)).toEqual(createDefaultLocalSettingsState());
  });

  it('defaults for non-object garbage instead of throwing', () => {
    expect(migrateLocalSettingsState('not an object')).toEqual(createDefaultLocalSettingsState());
    expect(migrateLocalSettingsState(42)).toEqual(createDefaultLocalSettingsState());
    expect(migrateLocalSettingsState(['a', 'b'])).toEqual(createDefaultLocalSettingsState());
  });

  it('defaults for unversioned legacy data', () => {
    expect(migrateLocalSettingsState({ directoryContexts: [] })).toEqual(
      createDefaultLocalSettingsState(),
    );
  });

  it('defaults for an unknown future version rather than guessing its shape', () => {
    expect(migrateLocalSettingsState({ version: 99, directoryContexts: [] })).toEqual(
      createDefaultLocalSettingsState(),
    );
  });

  it('round-trips a well-formed current-version state', () => {
    const state = {
      version: LOCAL_SETTINGS_VERSION,
      directoryContexts: [
        {
          id: 'ctx-1',
          projectId: 'project-1',
          path: '/home/owner/repo',
          label: 'repo',
          createdAt: '2026-08-01T00:00:00.000Z',
          lastOpenedAt: '2026-08-02T00:00:00.000Z',
        },
      ],
      lastOpenContextId: 'ctx-1',
      selectedProjectId: 'project-1',
      selectedTaskId: 'task-1',
      resumeScreen: 'workspace',
    };
    expect(migrateLocalSettingsState(state)).toEqual(state);
  });

  it('drops malformed directory context entries instead of crashing the whole state', () => {
    const migrated = migrateLocalSettingsState({
      version: LOCAL_SETTINGS_VERSION,
      directoryContexts: [
        { id: 'ctx-1', projectId: 'project-1', path: '/x', label: 'x' }, // missing timestamps
        {
          id: 'ctx-2',
          projectId: 'project-1',
          path: '/y',
          label: 'y',
          createdAt: '2026-08-01T00:00:00.000Z',
          lastOpenedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
      lastOpenContextId: 'ctx-2',
      selectedProjectId: null,
      selectedTaskId: null,
      resumeScreen: 'workspace',
    });
    expect(migrated.directoryContexts).toHaveLength(1);
    expect(migrated.directoryContexts[0].id).toBe('ctx-2');
  });

  it('clears an active-context pointer that no longer resolves to a surviving context', () => {
    const migrated = migrateLocalSettingsState({
      version: LOCAL_SETTINGS_VERSION,
      directoryContexts: [],
      lastOpenContextId: 'ghost-context',
      selectedProjectId: null,
      selectedTaskId: null,
      resumeScreen: 'workspace',
    });
    expect(migrated.lastOpenContextId).toBeNull();
  });

  it('ignores an unrecognized resume screen value', () => {
    const migrated = migrateLocalSettingsState({
      version: LOCAL_SETTINGS_VERSION,
      directoryContexts: [],
      lastOpenContextId: null,
      selectedProjectId: null,
      selectedTaskId: null,
      resumeScreen: 'some-future-screen',
    });
    expect(migrated.resumeScreen).toBeNull();
  });

  it('ignores a non-string selectedProjectId/selectedTaskId instead of crashing', () => {
    const migrated = migrateLocalSettingsState({
      version: LOCAL_SETTINGS_VERSION,
      directoryContexts: [],
      lastOpenContextId: null,
      selectedProjectId: 42,
      selectedTaskId: { nope: true },
      resumeScreen: null,
    });
    expect(migrated.selectedProjectId).toBeNull();
    expect(migrated.selectedTaskId).toBeNull();
  });

  describe('v1 -> v2 migration', () => {
    function v1State(overrides: Partial<LocalSettingsStateV1> = {}): LocalSettingsStateV1 {
      return {
        version: 1,
        directoryContexts: [],
        lastOpenContextId: null,
        resumeScreen: null,
        ...overrides,
      };
    }

    it('carries every directory binding forward without loss', () => {
      const context = {
        id: 'ctx-1',
        projectId: 'project-1',
        path: '/home/owner/repo',
        label: 'repo',
        createdAt: '2026-08-01T00:00:00.000Z',
        lastOpenedAt: '2026-08-02T00:00:00.000Z',
      };
      const migrated = migrateLocalSettingsState(
        v1State({ directoryContexts: [context], lastOpenContextId: 'ctx-1' }),
      );
      expect(migrated.version).toBe(LOCAL_SETTINGS_VERSION);
      expect(migrated.directoryContexts).toEqual([context]);
      expect(migrated.lastOpenContextId).toBe('ctx-1');
    });

    it('infers selectedProjectId from the active context, since v1 had no independent selection', () => {
      const context = {
        id: 'ctx-1',
        projectId: 'project-b',
        path: '/home/owner/repo-b',
        label: 'repo-b',
        createdAt: '2026-08-01T00:00:00.000Z',
        lastOpenedAt: '2026-08-02T00:00:00.000Z',
      };
      const migrated = migrateLocalSettingsState(
        v1State({ directoryContexts: [context], lastOpenContextId: 'ctx-1' }),
      );
      expect(migrated.selectedProjectId).toBe('project-b');
      expect(migrated.selectedTaskId).toBeNull();
    });

    it('leaves selectedProjectId null when v1 never had an active directory', () => {
      const migrated = migrateLocalSettingsState(v1State());
      expect(migrated.selectedProjectId).toBeNull();
    });

    it('maps the old "workspace" resume marker onto the same v2 screen value', () => {
      const migrated = migrateLocalSettingsState(v1State({ resumeScreen: 'workspace' }));
      expect(migrated.resumeScreen).toBe('workspace');
    });

    it('drops malformed bindings during the v1 upgrade instead of crashing', () => {
      const migrated = migrateLocalSettingsState(
        v1State({
          directoryContexts: [{ id: 'bad', projectId: 'p', path: '/x', label: 'x' } as never],
          lastOpenContextId: 'bad',
        }),
      );
      expect(migrated.directoryContexts).toHaveLength(0);
      expect(migrated.lastOpenContextId).toBeNull();
      expect(migrated.selectedProjectId).toBeNull();
    });
  });
});

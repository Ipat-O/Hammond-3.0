import {
  createDefaultLocalSettingsState,
  LOCAL_SETTINGS_VERSION,
  migrateLocalSettingsState,
} from './state';

describe('createDefaultLocalSettingsState', () => {
  it('starts with no bindings, no last-open context, and no resume marker', () => {
    expect(createDefaultLocalSettingsState()).toEqual({
      version: LOCAL_SETTINGS_VERSION,
      directoryContexts: [],
      lastOpenContextId: null,
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

  it('round-trips a well-formed v1 state', () => {
    const state = {
      version: 1,
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
      resumeScreen: 'workspace',
    };
    expect(migrateLocalSettingsState(state)).toEqual(state);
  });

  it('drops malformed directory context entries instead of crashing the whole state', () => {
    const migrated = migrateLocalSettingsState({
      version: 1,
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
      resumeScreen: 'workspace',
    });
    expect(migrated.directoryContexts).toHaveLength(1);
    expect(migrated.directoryContexts[0].id).toBe('ctx-2');
  });

  it('clears a last-open pointer that no longer resolves to a surviving context', () => {
    const migrated = migrateLocalSettingsState({
      version: 1,
      directoryContexts: [],
      lastOpenContextId: 'ghost-context',
      resumeScreen: 'workspace',
    });
    expect(migrated.lastOpenContextId).toBeNull();
  });

  it('ignores an unrecognized resume screen value', () => {
    const migrated = migrateLocalSettingsState({
      version: 1,
      directoryContexts: [],
      lastOpenContextId: null,
      resumeScreen: 'some-future-screen',
    });
    expect(migrated.resumeScreen).toBeNull();
  });
});

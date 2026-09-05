import { DirectoryContextManager, normalizePathForComparison } from './directoryContextManager';
import { createDefaultLocalSettingsState } from './state';
import { createFakeDirectoryContextServices } from './testFakes';

const projectId = 'project-1';

describe('DirectoryContextManager', () => {
  it('links a new directory as a distinct, stable context for a project', async () => {
    const services = createFakeDirectoryContextServices();
    const manager = new DirectoryContextManager(services);
    const state = createDefaultLocalSettingsState();

    const { state: nextState, context } = await manager.linkDirectory(
      state,
      projectId,
      '/home/owner/repo',
    );

    expect(context.projectId).toBe(projectId);
    expect(context.path).toBe('/home/owner/repo');
    expect(nextState.directoryContexts).toHaveLength(1);
    expect(nextState.lastOpenContextId).toBe(context.id);
    expect(nextState.selectedProjectId).toBe(projectId);
    expect(services.settings.write).toHaveBeenCalledWith(
      'hammond.directoryContexts',
      expect.objectContaining({ lastOpenContextId: context.id }),
    );
  });

  it('keeps two distinct paths under one project as two stable, independent contexts', async () => {
    const services = createFakeDirectoryContextServices();
    const manager = new DirectoryContextManager(services);
    let state = createDefaultLocalSettingsState();

    const first = await manager.linkDirectory(state, projectId, '/home/owner/repo');
    state = first.state;
    const second = await manager.linkDirectory(state, projectId, '/home/owner/repo-worktree-2');
    state = second.state;

    expect(state.directoryContexts).toHaveLength(2);
    expect(first.context.id).not.toBe(second.context.id);
    expect(manager.contextsForProject(state, projectId)).toHaveLength(2);
    // The most recently linked context deterministically becomes active.
    expect(state.lastOpenContextId).toBe(second.context.id);
  });

  it('reactivates an existing binding instead of creating a duplicate for the same path', async () => {
    const services = createFakeDirectoryContextServices();
    const manager = new DirectoryContextManager(services);
    let state = createDefaultLocalSettingsState();

    const first = await manager.linkDirectory(state, projectId, '/home/owner/repo');
    state = first.state;
    const relinked = await manager.linkDirectory(state, projectId, '/home/owner/repo');

    expect(relinked.context.id).toBe(first.context.id);
    expect(relinked.state.directoryContexts).toHaveLength(1);
  });

  it('reactivates the same binding for an equivalent-but-differently-spelled path', async () => {
    const services = createFakeDirectoryContextServices();
    const manager = new DirectoryContextManager(services);
    let state = createDefaultLocalSettingsState();

    const first = await manager.linkDirectory(state, projectId, '/home/owner/repo');
    state = first.state;
    const relinked = await manager.linkDirectory(state, projectId, '/home/owner/repo/');

    expect(relinked.context.id).toBe(first.context.id);
    expect(relinked.state.directoryContexts).toHaveLength(1);
  });

  it('setActive deterministically switches which context is active and its owning project', async () => {
    const services = createFakeDirectoryContextServices();
    const manager = new DirectoryContextManager(services);
    let state = createDefaultLocalSettingsState();
    const first = await manager.linkDirectory(state, projectId, '/home/owner/a');
    state = first.state;
    const second = await manager.linkDirectory(state, 'project-2', '/home/owner/b');
    state = second.state;

    expect(state.lastOpenContextId).toBe(second.context.id);
    state = await manager.setActive(state, first.context.id);
    expect(state.lastOpenContextId).toBe(first.context.id);
    expect(state.selectedProjectId).toBe(projectId);
  });

  describe('closeActive vs forget', () => {
    it('closeActive clears the active pointer but preserves the binding', async () => {
      const services = createFakeDirectoryContextServices();
      const manager = new DirectoryContextManager(services);
      let state = createDefaultLocalSettingsState();
      const { state: linkedState, context } = await manager.linkDirectory(
        state,
        projectId,
        '/home/owner/repo',
      );
      state = linkedState;

      state = await manager.closeActive(state);

      expect(state.lastOpenContextId).toBeNull();
      expect(state.directoryContexts).toHaveLength(1);
      expect(manager.findContext(state, context.id)).not.toBeNull();
      expect(services.filesystem.removePath).not.toHaveBeenCalled();
    });

    it('closeActive is a no-op when nothing is currently active', async () => {
      const services = createFakeDirectoryContextServices();
      const manager = new DirectoryContextManager(services);
      const state = createDefaultLocalSettingsState();

      const result = await manager.closeActive(state);

      expect(result).toBe(state);
    });

    it('forget removes the binding entirely and never calls a filesystem delete operation', async () => {
      const services = createFakeDirectoryContextServices();
      const manager = new DirectoryContextManager(services);
      let state = createDefaultLocalSettingsState();
      const { state: linkedState, context } = await manager.linkDirectory(
        state,
        projectId,
        '/home/owner/repo',
      );
      state = linkedState;

      state = await manager.forget(state, context.id);

      expect(state.directoryContexts).toHaveLength(0);
      expect(state.lastOpenContextId).toBeNull();
      expect(services.filesystem.removePath).not.toHaveBeenCalled();
    });

    it('forget clears the active pointer only when it pointed at the removed context', async () => {
      const services = createFakeDirectoryContextServices();
      const manager = new DirectoryContextManager(services);
      let state = createDefaultLocalSettingsState();
      const first = await manager.linkDirectory(state, projectId, '/home/owner/a');
      state = first.state;
      const second = await manager.linkDirectory(state, projectId, '/home/owner/b');
      state = second.state;

      state = await manager.forget(state, first.context.id);

      expect(state.directoryContexts).toHaveLength(1);
      expect(state.lastOpenContextId).toBe(second.context.id);
    });

    it('closing then forgetting a different binding never resurrects the closed one as active', async () => {
      const services = createFakeDirectoryContextServices();
      const manager = new DirectoryContextManager(services);
      let state = createDefaultLocalSettingsState();
      const first = await manager.linkDirectory(state, projectId, '/home/owner/a');
      state = first.state;
      const second = await manager.linkDirectory(state, projectId, '/home/owner/b');
      state = second.state;

      state = await manager.closeActive(state);
      expect(state.lastOpenContextId).toBeNull();

      state = await manager.forget(state, first.context.id);
      expect(state.lastOpenContextId).toBeNull();
      expect(manager.findContext(state, second.context.id)).not.toBeNull();
    });
  });

  it('replacePath updates the path of a stale binding without changing its identity or project', async () => {
    const services = createFakeDirectoryContextServices();
    const manager = new DirectoryContextManager(services);
    let state = createDefaultLocalSettingsState();
    const { state: linkedState, context } = await manager.linkDirectory(
      state,
      projectId,
      '/home/owner/old-path',
    );
    state = linkedState;

    state = await manager.replacePath(state, context.id, '/home/owner/new-path');

    expect(state.directoryContexts).toHaveLength(1);
    const updated = manager.findContext(state, context.id);
    expect(updated?.id).toBe(context.id);
    expect(updated?.projectId).toBe(projectId);
    expect(updated?.path).toBe('/home/owner/new-path');
  });

  it('checkReachable reflects the filesystem adapter without throwing for a missing root', async () => {
    const fakeFilesystem = createFakeDirectoryContextServices().filesystem;
    const manager = new DirectoryContextManager({
      filesystem: fakeFilesystem,
      settings: createFakeDirectoryContextServices().settings,
    });

    await expect(manager.checkReachable('/never/existed')).resolves.toBe(false);
  });

  describe('activeContextForProject', () => {
    it("never falls back to a project's first binding when none is active", async () => {
      const services = createFakeDirectoryContextServices();
      const manager = new DirectoryContextManager(services);
      let state = createDefaultLocalSettingsState();
      state = (await manager.linkDirectory(state, projectId, '/home/owner/a')).state;
      state = await manager.closeActive(state);

      expect(manager.activeContextForProject(state, projectId)).toBeNull();
    });

    it("never returns another project's active context", async () => {
      const services = createFakeDirectoryContextServices();
      const manager = new DirectoryContextManager(services);
      let state = createDefaultLocalSettingsState();
      state = (await manager.linkDirectory(state, 'project-other', '/home/owner/other')).state;

      expect(manager.activeContextForProject(state, projectId)).toBeNull();
    });
  });

  describe('findContextsForPath', () => {
    it('finds a binding regardless of which project it belongs to', async () => {
      const services = createFakeDirectoryContextServices();
      const manager = new DirectoryContextManager(services);
      let state = createDefaultLocalSettingsState();
      const { state: linkedState, context } = await manager.linkDirectory(
        state,
        projectId,
        '/home/owner/repo',
      );
      state = linkedState;

      expect(manager.findContextsForPath(state, '/home/owner/repo')).toEqual([context]);
    });

    it('matches an equivalent spelling (mixed separators, trailing slash)', async () => {
      const services = createFakeDirectoryContextServices();
      const manager = new DirectoryContextManager(services);
      let state = createDefaultLocalSettingsState();
      state = (await manager.linkDirectory(state, projectId, 'C:/owner/repo')).state;

      expect(manager.findContextsForPath(state, 'C:\\owner\\repo\\')).toHaveLength(1);
    });

    it('returns an empty array for a genuinely unknown path', async () => {
      const services = createFakeDirectoryContextServices();
      const manager = new DirectoryContextManager(services);
      const state = createDefaultLocalSettingsState();

      expect(manager.findContextsForPath(state, '/never/linked')).toEqual([]);
    });

    it('surfaces every match for an ambiguous legacy binding shared by two projects', async () => {
      const services = createFakeDirectoryContextServices();
      const manager = new DirectoryContextManager(services);
      let state = createDefaultLocalSettingsState();
      state = (await manager.linkDirectory(state, 'project-a', '/shared/path')).state;
      state = (await manager.linkDirectory(state, 'project-b', '/shared/path')).state;

      const matches = manager.findContextsForPath(state, '/shared/path');
      expect(matches).toHaveLength(2);
      expect(matches.map((match) => match.projectId).sort()).toEqual(['project-a', 'project-b']);
    });

    it('never collapses two genuinely different worktrees', async () => {
      const services = createFakeDirectoryContextServices();
      const manager = new DirectoryContextManager(services);
      let state = createDefaultLocalSettingsState();
      state = (await manager.linkDirectory(state, projectId, '/home/owner/repo')).state;
      state = (await manager.linkDirectory(state, projectId, '/home/owner/repo-worktree-2')).state;

      expect(manager.findContextsForPath(state, '/home/owner/repo')).toHaveLength(1);
      expect(manager.findContextsForPath(state, '/home/owner/repo-worktree-2')).toHaveLength(1);
    });
  });

  describe('normalizePathForComparison', () => {
    it('collapses backslashes, doubled separators, and a trailing separator', () => {
      expect(normalizePathForComparison('C:\\owner\\\\repo\\')).toBe('C:/owner/repo');
      expect(normalizePathForComparison('/home/owner/repo/')).toBe('/home/owner/repo');
    });

    it('preserves case, since case sensitivity is platform-dependent and unknown here', () => {
      expect(normalizePathForComparison('/Home/Owner/Repo')).toBe('/Home/Owner/Repo');
    });

    it('leaves a bare root separator intact rather than trimming it to empty', () => {
      expect(normalizePathForComparison('/')).toBe('/');
    });
  });

  describe('updateResumeSelection', () => {
    it('persists only the given fields, leaving bindings and the active context untouched', async () => {
      const services = createFakeDirectoryContextServices();
      const manager = new DirectoryContextManager(services);
      let state = createDefaultLocalSettingsState();
      state = (await manager.linkDirectory(state, projectId, '/home/owner/repo')).state;

      state = await manager.updateResumeSelection(state, {
        selectedTaskId: 'task-1',
        resumeScreen: 'workspace',
      });

      expect(state.selectedProjectId).toBe(projectId);
      expect(state.selectedTaskId).toBe('task-1');
      expect(state.resumeScreen).toBe('workspace');
      expect(state.directoryContexts).toHaveLength(1);
      expect(state.lastOpenContextId).not.toBeNull();
    });

    it('completes writes in issue order so the most recently issued update always wins', async () => {
      const services = createFakeDirectoryContextServices();
      const manager = new DirectoryContextManager(services);
      const state = createDefaultLocalSettingsState();

      let resolveFirstWrite!: () => void;
      const firstWriteStarted = new Promise<void>((resolve) => {
        (services.settings.write as ReturnType<typeof vi.fn>).mockImplementationOnce(
          () =>
            new Promise<void>((resolveWrite) => {
              resolve();
              resolveFirstWrite = resolveWrite;
            }),
        );
      });

      const firstCall = manager.updateResumeSelection(state, { selectedProjectId: 'project-a' });
      await firstWriteStarted;
      const secondCall = manager.updateResumeSelection(state, { selectedProjectId: 'project-b' });

      // The second write must not even start until the first one (still pending) settles.
      expect(services.settings.write).toHaveBeenCalledTimes(1);
      resolveFirstWrite();
      await firstCall;
      await secondCall;

      expect(services.settings.write).toHaveBeenLastCalledWith(
        'hammond.directoryContexts',
        expect.objectContaining({ selectedProjectId: 'project-b' }),
      );
    });
  });
});

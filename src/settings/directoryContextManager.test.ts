import { DirectoryContextManager } from './directoryContextManager';
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
    // The most recently linked context deterministically becomes last-open.
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

  it('setActive deterministically switches which context is last-open', async () => {
    const services = createFakeDirectoryContextServices();
    const manager = new DirectoryContextManager(services);
    let state = createDefaultLocalSettingsState();
    const first = await manager.linkDirectory(state, projectId, '/home/owner/a');
    state = first.state;
    const second = await manager.linkDirectory(state, projectId, '/home/owner/b');
    state = second.state;

    expect(state.lastOpenContextId).toBe(second.context.id);
    state = await manager.setActive(state, first.context.id);
    expect(state.lastOpenContextId).toBe(first.context.id);
  });

  it('unlink removes the binding but never calls a filesystem delete operation', async () => {
    const services = createFakeDirectoryContextServices();
    const manager = new DirectoryContextManager(services);
    let state = createDefaultLocalSettingsState();
    const { state: linkedState, context } = await manager.linkDirectory(
      state,
      projectId,
      '/home/owner/repo',
    );
    state = linkedState;

    state = await manager.unlink(state, context.id);

    expect(state.directoryContexts).toHaveLength(0);
    expect(state.lastOpenContextId).toBeNull();
    expect(services.filesystem.removePath).not.toHaveBeenCalled();
  });

  it('unlink clears the last-open pointer only when it pointed at the removed context', async () => {
    const services = createFakeDirectoryContextServices();
    const manager = new DirectoryContextManager(services);
    let state = createDefaultLocalSettingsState();
    const first = await manager.linkDirectory(state, projectId, '/home/owner/a');
    state = first.state;
    const second = await manager.linkDirectory(state, projectId, '/home/owner/b');
    state = second.state;

    state = await manager.unlink(state, first.context.id);

    expect(state.directoryContexts).toHaveLength(1);
    expect(state.lastOpenContextId).toBe(second.context.id);
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
});

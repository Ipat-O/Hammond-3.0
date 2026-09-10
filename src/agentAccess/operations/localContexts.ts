import { z } from 'zod';

import { defineOperation } from '../types';

export const localContextOperations = [
  defineOperation(
    'localContexts.list',
    'List device-local directory bindings, optionally filtered to one project, plus which one is currently active.',
    z.object({ projectId: z.string().min(1).optional() }),
    async (deps, input) => {
      const state = await deps.directoryContext.loadState();
      const contexts = input.projectId
        ? deps.directoryContext.contextsForProject(state, input.projectId)
        : state.directoryContexts;
      return { contexts, activeContextId: state.lastOpenContextId };
    },
  ),

  defineOperation(
    'localContexts.link',
    'Binds an explicit local directory path to a project (or reactivates an existing binding for the same project and an equivalent path). The UI never resolves this from a "currently selected" directory picker state — callers must pass the path explicitly.',
    z.object({ projectId: z.string().min(1), path: z.string().min(1) }),
    async (deps, input) => {
      const state = await deps.directoryContext.loadState();
      const { context } = await deps.directoryContext.linkDirectory(
        state,
        input.projectId,
        input.path,
      );
      return context;
    },
  ),

  defineOperation(
    'localContexts.replace',
    'Repoints an existing binding at a replacement path (recovery after a moved/renamed worktree) without changing its identity or project association.',
    z.object({ contextId: z.string().min(1), path: z.string().min(1) }),
    async (deps, input) => {
      const state = await deps.directoryContext.loadState();
      const next = await deps.directoryContext.replacePath(state, input.contextId, input.path);
      return deps.directoryContext.findContext(next, input.contextId);
    },
  ),

  defineOperation(
    'localContexts.forget',
    'Forgets a remembered directory binding. Never deletes the directory or its contents.',
    z.object({ contextId: z.string().min(1) }),
    async (deps, input) => {
      const state = await deps.directoryContext.loadState();
      await deps.directoryContext.forget(state, input.contextId);
      return { contextId: input.contextId, forgotten: true };
    },
  ),

  defineOperation(
    'localContexts.setActive',
    'Marks an already-bound context as the active one.',
    z.object({ contextId: z.string().min(1) }),
    async (deps, input) => {
      const state = await deps.directoryContext.loadState();
      const next = await deps.directoryContext.setActive(state, input.contextId);
      return deps.directoryContext.findContext(next, input.contextId);
    },
  ),

  defineOperation(
    'localContexts.resolvePath',
    'Resolves an explicit filesystem path to any known directory-context bindings (their project/context ids). More than one match means the same path was bound under more than one project; a caller must not guess which is intended.',
    z.object({ path: z.string().min(1) }),
    async (deps, input) => {
      const state = await deps.directoryContext.loadState();
      return { matches: deps.directoryContext.findContextsForPath(state, input.path) };
    },
  ),
];

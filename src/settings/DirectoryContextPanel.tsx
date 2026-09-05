import { useEffect, useState } from 'react';

import type { DirectoryContextManager } from './directoryContextManager';
import type { DirectoryContextRecord, LocalSettingsStateV2 } from './state';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'That action failed. Nothing was changed.';
}

interface DirectoryContextPanelProps {
  manager: DirectoryContextManager;
  state: LocalSettingsStateV2;
  onStateChange: (next: LocalSettingsStateV2) => void;
  projectId: string;
  /**
   * Wraps a state-changing action (Open/Change, Close) so a host screen can guard it against
   * unsaved Instruction Studio edits before it runs, the same way primary navigation is guarded.
   * Omit to run every action immediately (the default in isolated/standalone use).
   */
  beforeChange?: (action: () => void) => void;
}

type Reachability = boolean | 'checking';

export function DirectoryContextPanel({
  manager,
  state,
  onStateChange,
  projectId,
  beforeChange,
}: DirectoryContextPanelProps) {
  const contexts = manager.contextsForProject(state, projectId);
  const contextsKey = contexts.map((context) => `${context.id}:${context.path}`).join('|');
  const [reachability, setReachability] = useState<Record<string, Reachability>>({});
  const [linking, setLinking] = useState(false);
  const [busyContextId, setBusyContextId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setReachability((current) => {
      const next: Record<string, Reachability> = {};
      for (const context of contexts) next[context.id] = current[context.id] ?? 'checking';
      return next;
    });
    void Promise.all(
      contexts.map(async (context) => {
        const reachable = await manager.checkReachable(context.path).catch(() => false);
        return [context.id, reachable] as const;
      }),
    ).then((results) => {
      if (!mounted) return;
      setReachability((current) => {
        const next = { ...current };
        for (const [id, reachable] of results) next[id] = reachable;
        return next;
      });
    });
    return () => {
      mounted = false;
    };
    // contextsKey captures every id+path pair for this project; re-check when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, contextsKey]);

  function runGuarded(action: () => void) {
    if (beforeChange) beforeChange(action);
    else action();
  }

  function linkNewDirectory() {
    setActionError(null);
    setLinking(true);
    void manager
      .pickDirectory()
      .then((path) => {
        if (path === null) return;
        runGuarded(() => {
          void manager
            .linkDirectory(state, projectId, path)
            .then(({ state: nextState }) => onStateChange(nextState))
            .catch((error: unknown) => setActionError(errorMessage(error)));
        });
      })
      .catch((error: unknown) => setActionError(errorMessage(error)))
      .finally(() => setLinking(false));
  }

  function changeActive(contextId: string) {
    setActionError(null);
    runGuarded(() => {
      setBusyContextId(contextId);
      void manager
        .setActive(state, contextId)
        .then(onStateChange)
        .catch((error: unknown) => setActionError(errorMessage(error)))
        .finally(() => setBusyContextId(null));
    });
  }

  function closeContext(contextId: string) {
    setActionError(null);
    runGuarded(() => {
      setBusyContextId(contextId);
      void manager
        .closeActive(state)
        .then(onStateChange)
        .catch((error: unknown) => setActionError(errorMessage(error)))
        .finally(() => setBusyContextId(null));
    });
  }

  async function forgetContext(contextId: string) {
    setActionError(null);
    setBusyContextId(contextId);
    try {
      onStateChange(await manager.forget(state, contextId));
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyContextId(null);
    }
  }

  async function locateReplacement(contextId: string) {
    setActionError(null);
    setBusyContextId(contextId);
    try {
      const path = await manager.pickDirectory();
      if (path === null) return;
      onStateChange(await manager.replacePath(state, contextId, path));
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyContextId(null);
    }
  }

  async function revealContext(context: DirectoryContextRecord) {
    setActionError(null);
    try {
      await manager.reveal(context.path);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  const activeContext = manager.activeContextForProject(state, projectId);
  const activeReachable = activeContext ? reachability[activeContext.id] : undefined;

  return (
    <section className="directory-context-section" aria-labelledby="directory-context-heading">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">Local workspace</p>
          <h2 id="directory-context-heading">Directory contexts</h2>
        </div>
        <button
          className="button button-secondary"
          type="button"
          onClick={linkNewDirectory}
          disabled={linking}
        >
          {linking ? 'Choosing…' : 'Link directory'}
        </button>
      </div>

      {activeContext ? (
        <p className="directory-context-current">
          Current path: <code>{activeContext.path}</code>
          {activeReachable === false && (
            <span className="directory-context-status directory-context-status-missing">
              {' '}
              — missing
            </span>
          )}
        </p>
      ) : (
        <p className="muted-copy">No directory is open for this project yet.</p>
      )}

      {actionError && (
        <div className="save-error" role="alert">
          <span>{actionError}</span>
        </div>
      )}

      {contexts.length > 0 && (
        <ul className="directory-context-list">
          {contexts.map((context) => {
            const reachable = reachability[context.id];
            const isActive = context.id === activeContext?.id;
            const isBusy = busyContextId === context.id;
            return (
              <li
                key={context.id}
                className={`directory-context-item ${isActive ? 'directory-context-item-active' : ''}`}
              >
                <div className="directory-context-info">
                  <span className="directory-context-label">{context.label}</span>
                  <code className="directory-context-path">{context.path}</code>
                  {reachable === 'checking' && (
                    <span className="directory-context-status">Checking…</span>
                  )}
                  {reachable === false && (
                    <span className="directory-context-status directory-context-status-missing">
                      Missing — this directory could not be found.
                    </span>
                  )}
                  {isActive && (
                    <span className="directory-context-status directory-context-status-active">
                      Current
                    </span>
                  )}
                </div>
                <div className="directory-context-actions">
                  {reachable === false ? (
                    <>
                      <button
                        className="button button-small"
                        type="button"
                        onClick={() => void locateReplacement(context.id)}
                        disabled={isBusy}
                      >
                        Locate replacement
                      </button>
                      <button
                        className="button button-small button-quiet"
                        type="button"
                        onClick={() => void forgetContext(context.id)}
                        disabled={isBusy}
                        aria-label={`Forget ${context.label}`}
                      >
                        Forget
                      </button>
                    </>
                  ) : isActive ? (
                    <>
                      <button
                        className="button button-small button-quiet"
                        type="button"
                        onClick={() => void revealContext(context)}
                        disabled={reachable !== true}
                        aria-label={`Reveal ${context.label}`}
                      >
                        Reveal
                      </button>
                      <button
                        className="button button-small button-quiet"
                        type="button"
                        onClick={() => closeContext(context.id)}
                        disabled={isBusy}
                        aria-label={`Close ${context.label}`}
                      >
                        Close
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="button button-small"
                        type="button"
                        onClick={() => changeActive(context.id)}
                        disabled={isBusy}
                        aria-label={`Open ${context.label}`}
                      >
                        Open
                      </button>
                      <button
                        className="button button-small button-quiet"
                        type="button"
                        onClick={() => void revealContext(context)}
                        disabled={reachable !== true}
                        aria-label={`Reveal ${context.label}`}
                      >
                        Reveal
                      </button>
                      <button
                        className="button button-small button-quiet"
                        type="button"
                        onClick={() => void forgetContext(context.id)}
                        disabled={isBusy}
                        aria-label={`Forget ${context.label}`}
                      >
                        Forget
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

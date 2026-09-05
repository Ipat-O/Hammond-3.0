import { useEffect, useMemo, useState } from 'react';

import { DirectoryContextManager } from './directoryContextManager';
import type { DirectoryContextServices } from './contracts';
import { createDefaultLocalSettingsState, type LocalSettingsStateV2 } from './state';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Local settings could not be loaded.';
}

/**
 * Loads device-local directory-context state once and exposes the manager plus setter used
 * to persist further changes. A load failure still resolves to a usable default state
 * instead of blocking the app, per the module boundary for local settings.
 *
 * `state` mirrors the manager's own canonical state via `subscribe`, not a `.then(setState)` off
 * any individual mutating call: the manager notifies synchronously the moment it commits a
 * change, so `state` here is always driven by whichever mutation happened last, regardless of
 * how long any one of them takes to actually persist to disk. The exposed `setState` remains
 * available for a caller (e.g. `DirectoryContextPanel`'s own standalone tests) that manages its
 * own state independently of a manager subscription.
 */
export function useDirectoryContextState(services: DirectoryContextServices) {
  const manager = useMemo(() => new DirectoryContextManager(services), [services]);
  const [state, setState] = useState<LocalSettingsStateV2 | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const unsubscribe = manager.subscribe((next) => {
      if (mounted) setState(next);
    });
    manager.loadState().catch((loadError: unknown) => {
      if (!mounted) return;
      setError(errorMessage(loadError));
      setState(createDefaultLocalSettingsState());
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [manager]);

  return { manager, state, setState, error };
}

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
 */
export function useDirectoryContextState(services: DirectoryContextServices) {
  const manager = useMemo(() => new DirectoryContextManager(services), [services]);
  const [state, setState] = useState<LocalSettingsStateV2 | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    manager
      .loadState()
      .then((loaded) => {
        if (mounted) setState(loaded);
      })
      .catch((loadError: unknown) => {
        if (!mounted) return;
        setError(errorMessage(loadError));
        setState(createDefaultLocalSettingsState());
      });
    return () => {
      mounted = false;
    };
  }, [manager]);

  return { manager, state, setState, error };
}

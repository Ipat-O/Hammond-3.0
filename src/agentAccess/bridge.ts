import { useEffect, useRef } from 'react';

import { createAgentAccessDeps } from './deps';
import { toAgentAccessError } from './errors';
import { operationRegistry } from './registry';
import type { TrackerServices } from '../tracker/contracts';

const REQUEST_EVENT = 'agent-access://request';

type BridgeRequest =
  | { id: string; kind: 'listOperations' }
  | { id: string; kind: 'invoke'; name: string; input: unknown };

interface BridgeErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

interface BridgeResponsePayload {
  result?: unknown;
  error?: BridgeErrorPayload;
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Mounts the webview half of the local API/MCP bridge (HAM3-015): listens for
 * `agent-access://request` events emitted by the Rust HTTP layer, dispatches them into the one
 * operation registry, and answers via the `agent_access_respond` command — the only way an
 * answer reaches back to Rust, and only callable from this application's own webview.
 *
 * Mounted unconditionally at the top of `App`, independent of which screen is showing, so a
 * minimized window or a not-yet-navigated screen never blocks agent access. `ownerId` is the only
 * thing gating actual execution: every request is re-checked against the *current* value of
 * `ownerId` at the moment it is about to run (not just at listener-registration time), so a
 * sign-out that lands between a request arriving and its handler actually executing still stops
 * it — "authorization valid at execution time" per HAM3-015 section 4. Rust's own
 * `Readiness` (set via `agent_access_set_signed_in`) is a second, transport-level gate: it can
 * reject a request before it is even forwarded here, but this check is never removed just because
 * that one usually catches it first.
 */
export function useAgentAccessBridge(services: TrackerServices, ownerId: string | null): void {
  const ownerIdRef = useRef(ownerId);
  ownerIdRef.current = ownerId;

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    async function setup() {
      const { invoke } = await import('@tauri-apps/api/core');
      const { listen } = await import('@tauri-apps/api/event');
      if (cancelled) return;

      const deps = createAgentAccessDeps(services);

      const stop = await listen<BridgeRequest>(REQUEST_EVENT, (event) => {
        void handle(event.payload);
      });
      if (cancelled) {
        stop();
        return;
      }
      unlisten = stop;

      async function handle(request: BridgeRequest): Promise<void> {
        const response = await answer(request);
        try {
          await invoke('agent_access_respond', { id: request.id, response });
        } catch {
          // The workspace window may already be tearing down; there is nothing further to do —
          // the HTTP caller either already got disconnected or will time out on its own.
        }
      }

      async function answer(request: BridgeRequest): Promise<BridgeResponsePayload> {
        if (ownerIdRef.current === null) {
          return {
            error: {
              code: 'unauthenticated',
              message: 'No owner is currently signed in to Hammond.',
            },
          };
        }
        if (request.kind === 'listOperations') {
          return { result: { operations: operationRegistry.listSummaries() } };
        }
        try {
          const result = await operationRegistry.invoke(deps, request.name, request.input);
          // Re-checked after every await inside the handler completes: a sign-out that landed
          // while this operation's own async work was in flight must not let its result be
          // reported as a completed, authorized mutation.
          if (ownerIdRef.current === null) {
            return {
              error: {
                code: 'unauthenticated',
                message: 'Hammond signed out while this request was executing.',
              },
            };
          }
          return { result: result ?? null };
        } catch (error) {
          const agentAccessError = toAgentAccessError(error);
          return {
            error: {
              code: agentAccessError.code,
              message: agentAccessError.message,
              details: agentAccessError.details,
            },
          };
        }
      }
    }

    void setup();

    return () => {
      cancelled = true;
      unlisten?.();
      void import('@tauri-apps/api/core')
        .then(({ invoke }) =>
          invoke('agent_access_disconnect', {
            reason: 'The Hammond workspace window unmounted before this request completed.',
          }),
        )
        .catch(() => {});
    };
  }, [services]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('agent_access_set_signed_in', { signedIn: ownerId !== null }))
      .catch(() => {});
  }, [ownerId]);
}

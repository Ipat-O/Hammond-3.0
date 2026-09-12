import { useEffect, useRef, useState } from 'react';

import { createAgentAccessDeps, type AgentAccessDeps } from './deps';
import { toAgentAccessError } from './errors';
import { operationRegistry } from './registry';
import type { TrackerServices } from '../tracker/contracts';

const REQUEST_EVENT = 'agent-access://request';

export type BridgeRequest =
  | { id: string; kind: 'listOperations' }
  | { id: string; kind: 'invoke'; name: string; input: unknown };

interface BridgeErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export interface BridgeResponsePayload {
  result?: unknown;
  error?: BridgeErrorPayload;
}

/**
 * Error codes that mean "the operation was rejected before it could touch the backend"
 * (validation, unknown name, a not-found lookup that never got as far as a write). A sign-out
 * racing one of these changes nothing — the outcome is still a clean, definite "did not run".
 * Every other failure code can mean a mutation committed partway, so a concurrent sign-out makes
 * it genuinely ambiguous.
 */
const DEFINITELY_DID_NOT_MUTATE = new Set(['validation_error', 'unknown_operation', 'not_found']);

/**
 * Runs one bridged request against the operation registry and shapes its response. Pure and
 * transport-agnostic (no Tauri, no React) so the sign-out-timing behavior can be tested directly.
 *
 * `currentOwnerId()` is read twice on purpose:
 *
 * - **Before dispatch.** `null` here means the request never started — an ordinary
 *   `unauthenticated`, safe for the caller to treat as "did not run".
 * - **After a failure.** A sign-out that landed while the handler's async work was in flight
 *   makes a non-clean failure ambiguous: a mutation may have committed partway. That is reported
 *   as `unknown_outcome` (with the request id), never as `unauthenticated`, and never as
 *   something to auto-retry.
 *
 * A handler that *completed* is always reported as success — a sign-out cannot un-commit it, and
 * telling a caller a committed mutation "did not execute" is the specific failure this guards
 * against (HAM3-015 audit Finding 3). New work is still blocked: by the pre-dispatch check here
 * on the next request, and by Rust readiness.
 */
export async function answerAgentAccessRequest(
  deps: AgentAccessDeps,
  request: BridgeRequest,
  currentOwnerId: () => string | null,
): Promise<BridgeResponsePayload> {
  if (currentOwnerId() === null) {
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
    return { result: result ?? null };
  } catch (error) {
    const agentAccessError = toAgentAccessError(error);
    if (currentOwnerId() === null && !DEFINITELY_DID_NOT_MUTATE.has(agentAccessError.code)) {
      return {
        error: {
          code: 'unknown_outcome',
          message:
            `Hammond signed out while "${request.name}" (request ${request.id}) was executing; ` +
            `it may or may not have committed. Do not retry automatically — re-read the affected ` +
            `record to reconcile. (${agentAccessError.message})`,
        },
      };
    }
    return {
      error: {
        code: agentAccessError.code,
        message: agentAccessError.message,
        details: agentAccessError.details,
      },
    };
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Mounts the webview half of the local API/MCP bridge (HAM3-015): listens for
 * `agent-access://request` events emitted by the Rust HTTP layer, dispatches them through
 * `answerAgentAccessRequest`, and answers via the `agent_access_respond` command — the only way
 * an answer reaches back to Rust, and only callable from this application's own webview.
 *
 * Mounted unconditionally at the top of `App`, independent of which screen is showing, so a
 * minimized window or a not-yet-navigated screen never blocks agent access.
 *
 * Two facts gate execution, both owned here and reported to Rust:
 *
 * - **Listener attached** (`agent_access_set_listener_attached`): flipped `true` only *after*
 *   `listen()` resolves and `false` the instant this effect tears down. Rust refuses to forward
 *   a request while it is `false`, so a request arriving in the startup gap (readiness published
 *   a beat before the listener registered) or the teardown gap never dispatches into nothing
 *   (HAM3-015 audit Finding 5).
 * - **Signed in** (`agent_access_set_signed_in`): published only once a listener is attached, so
 *   readiness is never advertised ahead of the transport that serves it.
 */
export function useAgentAccessBridge(services: TrackerServices, ownerId: string | null): void {
  const ownerIdRef = useRef(ownerId);
  ownerIdRef.current = ownerId;
  const [listenerAttached, setListenerAttached] = useState(false);

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
      // The listener exists now — and only now may Rust forward a request to it.
      await invoke('agent_access_set_listener_attached', { attached: true }).catch(() => {});
      if (!cancelled) setListenerAttached(true);

      async function handle(request: BridgeRequest): Promise<void> {
        const response = await answerAgentAccessRequest(deps, request, () => ownerIdRef.current);
        try {
          await invoke('agent_access_respond', { id: request.id, response });
        } catch {
          // The workspace window may already be tearing down; there is nothing further to do —
          // the HTTP caller either already got disconnected or will time out on its own.
        }
      }
    }

    void setup();

    return () => {
      cancelled = true;
      setListenerAttached(false);
      unlisten?.();
      void import('@tauri-apps/api/core')
        .then(({ invoke }) =>
          // Rolls the listener flag back (so Rust stops forwarding) and drains anything already
          // dispatched as an unknown outcome — a stale readiness can never outlive the listener.
          invoke('agent_access_set_listener_attached', { attached: false }),
        )
        .catch(() => {});
    };
  }, [services]);

  // Keeps Rust's sign-in readiness in step with `ownerId` — but only once a listener is
  // attached. When the listener attaches, this re-runs and publishes the current state.
  useEffect(() => {
    if (!isTauriRuntime() || !listenerAttached) return;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('agent_access_set_signed_in', { signedIn: ownerId !== null }))
      .catch(() => {});
  }, [ownerId, listenerAttached]);
}

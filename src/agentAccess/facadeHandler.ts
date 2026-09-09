import type { TrackerServices } from '../tracker/contracts';
import { callFacadeTool } from './facade';
import {
  nativeAgentAccess,
  type FacadeRequestPayload,
  type FacadeResponsePayload,
} from './nativeBridge';
import { FacadeToolError, type FacadeContext } from './types';
import { publishAgentWriteNotification, type AgentWriteNotification } from './writeNotifications';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Extracts the identity a UI refresh needs from one write tool's own result shape — never from
 * the request's args, so a caller-supplied taskId can't be substituted for what was actually
 * written. `null` for anything that doesn't look like a successful write result (defensive only:
 * `callFacadeTool` already throws well before returning a malformed result). */
function writeNotificationFor(
  tool: string,
  result: unknown,
): Pick<AgentWriteNotification, 'tool' | 'taskId' | 'parentTaskId'> | null {
  if (!isRecord(result)) return null;
  if (tool === 'create_task' || tool === 'update_task') {
    const task = result.task;
    if (!isRecord(task) || typeof task.id !== 'string') return null;
    const parentTaskId =
      typeof task.parentTaskId === 'string' || task.parentTaskId === null
        ? task.parentTaskId
        : undefined;
    return { tool, taskId: task.id, parentTaskId };
  }
  if (tool === 'add_comment') {
    const comment = result.comment;
    if (!isRecord(comment) || typeof comment.taskId !== 'string') return null;
    return { tool, taskId: comment.taskId };
  }
  return null;
}

/**
 * Registers the app's ONE facade handler: independent of which page/route is currently mounted
 * (call this once, from the app root — never from `TrackerPage` or any other screen component),
 * so an agent connection keeps working across navigation, and a relayed request while the owner
 * is on the auth screen fails with a clear `signed_out` error rather than having nowhere to land.
 *
 * Native code (the Rust pipe server) only transports the validated request description; this
 * function is where it actually executes, against the SAME `TrackerServices` (and therefore the
 * same live Supabase session/RLS) the UI itself uses — never a second, parallel data path.
 *
 * Returns a cleanup function. Safe to call in a non-Tauri environment (tests, a plain browser
 * dev server): `listen()` rejects there, which this catches and logs once rather than crashing.
 */
export function registerAgentAccessFacadeHandler(services: TrackerServices): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;

  nativeAgentAccess
    .onFacadeRequest((payload) => {
      void handleRequest(services, payload);
    })
    .then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    })
    .catch((error: unknown) => {
      console.debug('agent access facade handler not registered (no native runtime):', error);
    });

  return () => {
    disposed = true;
    unlisten?.();
  };
}

async function handleRequest(
  services: TrackerServices,
  payload: FacadeRequestPayload,
): Promise<void> {
  const { correlationId, generation, projectId, permission, tool, args } = payload;
  try {
    // Independently re-checked here, not just trusted from the relayed payload: a revoke/
    // reconnect/app-restart between the pipe server's own validation and this handler actually
    // running must never let a stale generation's request execute.
    const status = await nativeAgentAccess.status();
    if (!status || status.generation !== generation) {
      await respond(correlationId, generation, {
        ok: false,
        error: { code: 'invalidated', message: 'This connection is no longer current.' },
      });
      return;
    }

    const { data, error } = await services.auth.getPersistedSession();
    const ownerId = error ? undefined : data.session?.user.id;
    if (!ownerId) {
      await respond(correlationId, generation, {
        ok: false,
        error: { code: 'signed_out', message: 'Hammond is not signed in.' },
      });
      return;
    }

    const ctx: FacadeContext = { ownerId, projectId, permission };
    const result = await callFacadeTool(services, ctx, tool, args);
    // Published only for a write that actually succeeded (never speculatively, never for a
    // request that threw below) — a listener (the tracker UI) refreshes visible reads for
    // exactly the identity this request targeted, not whatever it has selected right now.
    const notification = writeNotificationFor(tool, result);
    if (notification) publishAgentWriteNotification({ ownerId, projectId, ...notification });
    await respond(correlationId, generation, { ok: true, result });
  } catch (error) {
    const facadeError =
      error instanceof FacadeToolError
        ? error
        : new FacadeToolError(
            'internal_error',
            error instanceof Error ? error.message : String(error),
          );
    await respond(correlationId, generation, {
      ok: false,
      error: { code: facadeError.code, message: facadeError.message },
    });
  }
}

async function respond(
  correlationId: string,
  generation: number,
  outcome: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } },
): Promise<void> {
  const payload: FacadeResponsePayload = { correlationId, generation, ...outcome };
  try {
    await nativeAgentAccess.respond(payload);
  } catch (error) {
    console.debug('failed to deliver agent-access facade response:', error);
  }
}

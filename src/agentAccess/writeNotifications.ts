import type { AgentToolName } from './types';

/**
 * A completed, durable agent write (HAM3-014 correction F2) — published by `facadeHandler` AFTER
 * the underlying `create_task`/`update_task`/`add_comment` RPC has actually succeeded, never
 * speculatively and never for a failed write. Carries the identity the AGENT submitted the
 * request against (owner/project/task), not whatever the UI happens to have selected when the
 * write resolves — a subscriber compares this against its OWN current selection to decide what,
 * if anything, to refresh.
 *
 * This is a plain in-process event bus, not a realtime/polling subsystem: the facade handler and
 * `TrackerPage` already run in the same JS runtime (the frontend is the one and only place writes
 * are executed — see `facadeHandler`'s own module doc), so there is nothing to poll and nothing to
 * subscribe to on a server.
 */
export interface AgentWriteNotification {
  ownerId: string;
  projectId: string;
  tool: AgentToolName & ('create_task' | 'update_task' | 'add_comment');
  /** The created/updated task's id, or the task a comment was added to. */
  taskId: string;
  /** `create_task` only: the new task's parent, if any — lets a subscriber refresh an expanded
   * parent's child list even when it is not itself the newly created row. */
  parentTaskId?: string | null;
}

type Listener = (notification: AgentWriteNotification) => void;

const listeners = new Set<Listener>();

/** Registers `listener` for every future notification; call the returned function to unsubscribe
 * (e.g. from a `useEffect` cleanup on unmount, so a component never reacts after it is gone). */
export function subscribeAgentWriteNotifications(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishAgentWriteNotification(notification: AgentWriteNotification): void {
  for (const listener of listeners) listener(notification);
}

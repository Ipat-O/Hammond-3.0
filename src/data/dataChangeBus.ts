export type DataChangeResource = 'project' | 'task' | 'comment';
export type DataChangeOp = 'create' | 'update' | 'archive' | 'delete';

/**
 * `row` always carries at least `id` — the full mutated row for `create`/`update`/`archive` (every
 * repository method that publishes one already fetched it via `.select().single()`/`.select()` to
 * return to its own caller), or just `{ id }` for `delete` (`.select('id').single()`, matching what
 * `ProjectRepository.remove`/`TaskRepository.remove` actually select). A subscriber that needs more
 * than `.id` for a `delete` event has nothing else here to read.
 */
export interface DataChangeEvent {
  resource: DataChangeResource;
  op: DataChangeOp;
  row: { id: string } & Record<string, unknown>;
}

type Listener = (event: DataChangeEvent) => void;

/**
 * Process-wide notification bus for successful project/task/comment mutations — HAM3-015
 * Correction 2. Published by every repository method in `./repositories.ts` that performs one,
 * regardless of which caller triggered it (this app's own UI handlers, or an agent-access
 * HTTP/MCP write) and regardless of which repository *instance* did: `createAgentAccessDeps()`
 * (`src/agentAccess/deps.ts`) deliberately constructs its own `ProjectRepository`/
 * `TaskRepository`/`ProjectMemoryRepository` instances rather than reusing the UI's own (its own
 * comment explains why — they are otherwise-stateless wrappers over the one memoized Supabase
 * client), so a per-instance `subscribe()` — the pattern `DirectoryContextManager` already uses,
 * which really does hold its own in-memory state — cannot bridge that gap. This module-level bus
 * is the smallest thing that can, at the cost of being the one piece of shared mutable state in
 * this otherwise-stateless file.
 *
 * Confirmed live (HAM3-015 smoke test): a project created through the agent-access API did not
 * appear in the running UI's sidebar even after in-app navigation — only a full sign-out/sign-in
 * (which happens to force a remount-driven refetch) picked it up.
 *
 * Deliberately data-carrying, not just an invalidation signal: a subscriber merges the event's
 * own `row` directly into local state instead of re-querying on receipt — no extra round trip,
 * and no "a slow refetch's response lands after the owner has since navigated/edited further"
 * race for a naive refetch-on-invalidation to reintroduce.
 */
const listeners = new Set<Listener>();

export function publishDataChange(event: DataChangeEvent): void {
  for (const listener of listeners) listener(event);
}

/** Registers `listener` for every future event; returns an unsubscribe function. */
export function subscribeToDataChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

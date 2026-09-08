/**
 * HAM3-008 Correction 8 — one coherent per-task save coordinator.
 *
 * Earlier corrections repaired same-task save-response ordering after the fact: a per-task
 * "highest issued revision" watermark (`taskSaveRevisionRef`) decided which of several already
 * in-flight, concurrently-dispatched requests was allowed to update the confirmed collection. That
 * repeatedly needed new exception cases (Correction 7's Finding A, the round-6 residual: a
 * REJECTED newer revision left the watermark on a value no successful response could ever satisfy
 * again, so an older-but-successful write was permanently excluded from confirmation).
 *
 * This coordinator removes the class of bug instead of patching it further: at most one
 * persistence request per logical task (`key` — a real durable task id, or the stable local
 * `draft-task-...` id a not-yet-created task keeps until its first successful create) is ever
 * dispatched at a time. A second request for the same task queues FIFO and is not even sent to the
 * repository until the first settles. "Highest issued" and "highest successful" collapse into the
 * same thing by construction, because there is only ever one outstanding request to be either of
 * them. Different task keys queue and dispatch fully independently (Invariant 2: different tasks
 * save independently).
 *
 * The coordinator also owns the one authoritative "confirmed" store: the latest DURABLE row known
 * for each task, advanced by every successful dispatch here (regardless of which UI editor
 * happens to be open, and regardless of navigation) and by explicit `setConfirmed`/
 * `upsertConfirmed` calls (a full list load, or another confirmed-affecting response the caller
 * chooses to route through it). A rejection never advances it and never poisons the queue — the
 * next queued entry (if any) still dispatches once the rejected one settles.
 *
 * HAM3-008 Correction 9 — canonical queue identity and scoped cancellation.
 *
 * Correction 8's `durableIds` map (draft key -> real id, learned from a create's own response) was
 * one-way and consulted ONLY when building a dispatch's `durableId` context and by
 * `getConfirmedForKey` — never by `submit`, `hasPending`, or `cancelQueued`. That let a caller who
 * only ever learns of a just-created task's REAL id (the outliner, once `saveTask`'s continuation
 * rewrites the row's `id`) open a SECOND, entirely independent queue under that real id while the
 * first queue — still holding a genuinely queued update issued against the original draft id before
 * the create resolved — was still draining. Two persistence requests for one logical task could
 * then be in flight/queued at once, exactly the invariant this coordinator exists to rule out.
 *
 * Fix: every operation that touches `queues`/`inFlight` (`submit`, `hasPending`, `cancelQueued`,
 * and `dispatchNext` itself) first resolves its `key` through `resolveStorageKey`, which follows
 * the SAME draft-id/real-id association `durableIds` already records — so a submission naming
 * either alias always lands in the one physical queue entry for that logical task. The queue itself
 * is never physically moved between map keys (it stays filed under whichever key was used FIRST,
 * ordinarily the draft id); only the alias lookup changes, kept in `storageKeyFor`, the exact
 * reverse of `durableIds`, updated at the same moment and before any queued dispatch or
 * waiter-driven UI continuation can run — so no window exists where a second queue could open.
 *
 * Correction 9 also introduces minimal cancellation ownership (`TaskQueueOwner`): each queued entry
 * is tagged with who submitted it (`'editor'` — a form Save, Retry, or guard Save-all; `'outliner'`
 * — a status move or archive). `cancelQueued(key, owner)` — used by the editor's own explicit
 * Cancel/Discard — drops only entries tagged with that SAME owner, so an independently queued
 * outliner action waiting behind a just-discarded form draft is never silently lost (Finding 2). A
 * bare `cancelQueued(key)` keeps its previous unscoped meaning — every queued entry regardless of
 * owner — which `cancelAllQueued` (an owner change) still relies on: ALL old-owner work must go,
 * not just one kind of it.
 */

export interface TaskSaveDispatchContext {
  /**
   * The durable id already known for this key, from an earlier successful dispatch for the SAME
   * key — `null` when this key has no durable row yet (a brand-new, not-yet-created task) or
   * already IS a durable id (an existing task's own id is passed as `key` directly).
   */
  durableId: string | null;
}

export type TaskCoordinatorOp<Row> = (context: TaskSaveDispatchContext) => Promise<Row | Row[]>;

export type TaskCoordinatorOutcome<Row> =
  | { status: 'success'; result: Row | Row[] }
  | { status: 'error'; error: unknown }
  | { status: 'cancelled' };

/** Who submitted a queued entry — `'editor'` for a form Save/Retry/guard Save-all, `'outliner'`
 * for a status move or archive — so an explicit editor Cancel/Discard can scope its cancellation
 * to its own kind of work (HAM3-008 Correction 9, Finding 2) instead of dropping everything queued
 * for the task regardless of who asked for it. */
export type TaskQueueOwner = 'editor' | 'outliner';

interface QueueEntry<Row> {
  /** Non-null for requests whose exact snapshot can be deduplicated (task saves keyed by their
   * serialized field values); `null` opts a request (a status move, an archive) out of dedup —
   * every submission for it is a distinct, always-enqueued request. */
  dedupeToken: string | null;
  run: TaskCoordinatorOp<Row>;
  waiters: Array<(outcome: TaskCoordinatorOutcome<Row>) => void>;
  owner: TaskQueueOwner;
}

export class TaskSaveCoordinator<Row extends { id: string }> {
  private readonly queues = new Map<string, QueueEntry<Row>[]>();
  private readonly inFlight = new Set<string>();
  private readonly confirmedRows = new Map<string, Row>();
  private readonly durableIds = new Map<string, string>();
  /** The exact reverse of `durableIds` (real id -> the storage key its queue still lives under),
   * so a submission naming the real id resolves to the very same physical queue entry a submission
   * naming the original draft id would (HAM3-008 Correction 9). Populated at the same moment as
   * `durableIds`, never independently. */
  private readonly storageKeyFor = new Map<string, string>();

  /** The key under which `key`'s queue/in-flight state actually lives — itself, unless `key` is a
   * real id learned from an earlier create dispatched under a different (draft) key, in which case
   * this returns that original draft key. Every operation that touches `queues`/`inFlight` resolves
   * through this FIRST, so a caller may name either alias for a logical task and always reach the
   * one queue for it (HAM3-008 Correction 9, Finding 1). */
  private resolveStorageKey(key: string): string {
    return this.storageKeyFor.get(key) ?? key;
  }

  getConfirmed(id: string): Row | undefined {
    return this.confirmedRows.get(id);
  }

  /** Resolves confirmed data for `key` — a real task id, or a not-yet-created task's stable local
   * draft id (via whatever durable id its first successful create produced, if any yet). */
  getConfirmedForKey(key: string): Row | undefined {
    return this.confirmedRows.get(this.durableIds.get(key) ?? key);
  }

  setConfirmed(row: Row): void {
    this.confirmedRows.set(row.id, row);
  }

  /** Upserts every row from an authoritative read (a full task-list load) into confirmed — never
   * a wholesale replace, so a confirmed row set moments ago by a still-in-flight write for a task
   * this particular read didn't happen to include (a different project, a race with an archive)
   * is never wiped out from under it. */
  upsertConfirmed(rows: Row[]): void {
    for (const row of rows) this.confirmedRows.set(row.id, row);
  }

  /** Resolved the same way `submit`/`hasPending`/`cancelQueued` are (HAM3-008 Correction 9) — a
   * caller may ask with either the draft id or the real id once one is known and gets the same
   * answer either way. */
  getDurableId(key: string): string | undefined {
    return this.durableIds.get(this.resolveStorageKey(key));
  }

  /** True while `key` still has a request in flight or waiting behind it. A caller uses this to
   * decide whether ITS OWN just-settled outcome is still the last word for this task — e.g. a
   * rejection should surface its error only when nothing newer is already on its way to
   * superseding it (never flash a stale error for an attempt the owner has already moved past by
   * explicitly requesting a further save). Resolves `key` through its current alias first (HAM3-008
   * Correction 9), so this reflects the one true queue for the task regardless of which alias the
   * caller has in hand. */
  hasPending(key: string): boolean {
    const storageKey = this.resolveStorageKey(key);
    return this.inFlight.has(storageKey) || Boolean(this.queues.get(storageKey)?.length);
  }

  /**
   * Enqueues `run` for `key`, dispatching immediately if nothing else for this key is currently
   * queued or in flight; otherwise it waits behind whatever is already there. `key` is resolved
   * through its current alias first (HAM3-008 Correction 9) — a submission naming a just-created
   * task's real id lands in the SAME queue as one still naming its original draft id, never a
   * second, independent one. `dedupeToken`, when it matches the still-pending TAIL entry for this
   * key (whether that entry is already in flight or merely queued), shares that entry's eventual
   * outcome instead of enqueuing a second request for what is, byte-for-byte, the same snapshot —
   * the coordinator's own defense against a duplicate create/update from a double-submit of
   * unchanged content. `owner` tags who this entry belongs to for `cancelQueued`'s scoping.
   */
  submit(
    key: string,
    run: TaskCoordinatorOp<Row>,
    dedupeToken: string | null = null,
    owner: TaskQueueOwner = 'outliner',
  ): Promise<TaskCoordinatorOutcome<Row>> {
    return new Promise((resolve) => {
      const storageKey = this.resolveStorageKey(key);
      const queue = this.queues.get(storageKey) ?? [];
      const tail = queue[queue.length - 1];
      if (dedupeToken !== null && tail && tail.dedupeToken === dedupeToken) {
        tail.waiters.push(resolve);
        return;
      }
      const entry: QueueEntry<Row> = { dedupeToken, run, waiters: [resolve], owner };
      queue.push(entry);
      this.queues.set(storageKey, queue);
      if (!this.inFlight.has(storageKey)) void this.dispatchNext(storageKey);
    });
  }

  private async dispatchNext(key: string): Promise<void> {
    const queue = this.queues.get(key);
    const entry = queue?.[0];
    if (!queue || !entry) return;
    // `key` here is always already a storage key — the only callers are `submit` (which resolves
    // it first) and this method's own recursion below (which passes the very same value onward).
    const storageKey = key;
    this.inFlight.add(storageKey);
    let outcome: TaskCoordinatorOutcome<Row>;
    try {
      const result = await entry.run({ durableId: this.durableIds.get(storageKey) ?? null });
      for (const row of Array.isArray(result) ? result : [result]) {
        this.confirmedRows.set(row.id, row);
      }
      // A single-row result whose id differs from the key it was dispatched under is exactly a
      // not-yet-durable task's first successful create — remember its real id, in BOTH directions,
      // so every queued entry behind this one, and every future submission for EITHER this local
      // draft key or the newly durable real id (`saveTask`'s own continuation, or a `moveTask`/
      // `archiveTask` dispatched against the outliner row it just rewrote to that real id), resolves
      // to this exact same physical queue instead of opening a second, independent one (HAM3-008
      // Correction 9, Finding 1). The queue itself is never moved — it stays filed under
      // `storageKey` forever; only the alias lookup changes. Never applied to an array result
      // (archive's whole-subtree response): `storageKey` there is already a durable task id, and
      // remapping it onto a descendant's id would be a defect, not a durability fix.
      if (!Array.isArray(result) && result.id !== storageKey) {
        this.durableIds.set(storageKey, result.id);
        this.storageKeyFor.set(result.id, storageKey);
      }
      outcome = { status: 'success', result };
    } catch (error) {
      outcome = { status: 'error', error };
    }
    queue.shift();
    this.inFlight.delete(storageKey);
    for (const waiter of entry.waiters) waiter(outcome);
    if (queue.length > 0) void this.dispatchNext(storageKey);
    else this.queues.delete(storageKey);
  }

  /**
   * Drops every NOT-yet-dispatched entry for `key` — resolved through its current alias first
   * (HAM3-008 Correction 9), so this reaches the one true queue for the task regardless of whether
   * the caller has the draft id or the real id in hand — settling each dropped entry's waiters as
   * `cancelled`, never `success`, never silently. An in-flight (already dispatched) head, if any,
   * is left completely alone: it was already sent, so it may still finish durably and update
   * `confirmed` (Invariant 5 — local cancellation never pretends to roll back a request the
   * repository has already received).
   *
   * When `owner` is given, only queued entries submitted under that SAME owner are dropped; an
   * independently queued entry for the OTHER owner (an outliner move/archive still waiting behind a
   * just-discarded editor draft, or vice versa) is left exactly where it is, to dispatch normally in
   * its own turn (HAM3-008 Correction 9, Finding 2) — surviving `cancelQueued` entries keep their
   * original relative order. Omit `owner` for the previous, unscoped behavior: every queued entry
   * regardless of who submitted it. Use the scoped form for an explicit editor Cancel/Discard (only
   * ITS OWN unsent drafts must go); use the unscoped form when the owner truly abandons everything
   * queued for a task, whatever kind of work it is.
   */
  cancelQueued(key: string, owner?: TaskQueueOwner): void {
    const storageKey = this.resolveStorageKey(key);
    const queue = this.queues.get(storageKey);
    if (!queue || queue.length === 0) return;
    const startIndex = this.inFlight.has(storageKey) ? 1 : 0;
    const kept = queue.slice(0, startIndex);
    for (let i = startIndex; i < queue.length; i += 1) {
      const entry = queue[i];
      if (owner !== undefined && entry.owner !== owner) {
        kept.push(entry);
        continue;
      }
      for (const waiter of entry.waiters) waiter({ status: 'cancelled' });
    }
    queue.length = 0;
    queue.push(...kept);
    if (queue.length === 0 && !this.inFlight.has(storageKey)) this.queues.delete(storageKey);
  }

  /** Cancels every not-yet-dispatched entry, of every owner, across every key. Used on a mounted
   * owner change, alongside swapping in a fresh coordinator instance for the new owner: settles
   * every old-owner queued waiter as `cancelled` (rather than leaving it dangling forever) while
   * guaranteeing none of them ever reaches the repository under the new owner's session — ALL
   * queued work must go here, not just one kind of it, so this always uses the unscoped form of
   * `cancelQueued`. */
  cancelAllQueued(): void {
    for (const key of Array.from(this.queues.keys())) this.cancelQueued(key);
  }
}

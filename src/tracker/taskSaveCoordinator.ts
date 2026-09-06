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

interface QueueEntry<Row> {
  /** Non-null for requests whose exact snapshot can be deduplicated (task saves keyed by their
   * serialized field values); `null` opts a request (a status move, an archive) out of dedup —
   * every submission for it is a distinct, always-enqueued request. */
  dedupeToken: string | null;
  run: TaskCoordinatorOp<Row>;
  waiters: Array<(outcome: TaskCoordinatorOutcome<Row>) => void>;
}

export class TaskSaveCoordinator<Row extends { id: string }> {
  private readonly queues = new Map<string, QueueEntry<Row>[]>();
  private readonly inFlight = new Set<string>();
  private readonly confirmedRows = new Map<string, Row>();
  private readonly durableIds = new Map<string, string>();

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

  getDurableId(key: string): string | undefined {
    return this.durableIds.get(key);
  }

  /** True while `key` still has a request in flight or waiting behind it. A caller uses this to
   * decide whether ITS OWN just-settled outcome is still the last word for this task — e.g. a
   * rejection should surface its error only when nothing newer is already on its way to
   * superseding it (never flash a stale error for an attempt the owner has already moved past by
   * explicitly requesting a further save). */
  hasPending(key: string): boolean {
    return this.inFlight.has(key) || Boolean(this.queues.get(key)?.length);
  }

  /**
   * Enqueues `run` for `key`, dispatching immediately if nothing else for this key is currently
   * queued or in flight; otherwise it waits behind whatever is already there. `dedupeToken`, when
   * it matches the still-pending TAIL entry for this key (whether that entry is already in flight
   * or merely queued), shares that entry's eventual outcome instead of enqueuing a second request
   * for what is, byte-for-byte, the same snapshot — the coordinator's own defense against a
   * duplicate create/update from a double-submit of unchanged content.
   */
  submit(
    key: string,
    run: TaskCoordinatorOp<Row>,
    dedupeToken: string | null = null,
  ): Promise<TaskCoordinatorOutcome<Row>> {
    return new Promise((resolve) => {
      const queue = this.queues.get(key) ?? [];
      const tail = queue[queue.length - 1];
      if (dedupeToken !== null && tail && tail.dedupeToken === dedupeToken) {
        tail.waiters.push(resolve);
        return;
      }
      const entry: QueueEntry<Row> = { dedupeToken, run, waiters: [resolve] };
      queue.push(entry);
      this.queues.set(key, queue);
      if (!this.inFlight.has(key)) void this.dispatchNext(key);
    });
  }

  private async dispatchNext(key: string): Promise<void> {
    const queue = this.queues.get(key);
    const entry = queue?.[0];
    if (!queue || !entry) return;
    this.inFlight.add(key);
    let outcome: TaskCoordinatorOutcome<Row>;
    try {
      const result = await entry.run({ durableId: this.durableIds.get(key) ?? null });
      for (const row of Array.isArray(result) ? result : [result]) {
        this.confirmedRows.set(row.id, row);
      }
      // A single-row result whose id differs from the key it was dispatched under is exactly a
      // not-yet-durable task's first successful create — remember its real id so every queued
      // entry behind this one (and every future submission for this same local key) becomes an
      // update against that id instead of issuing a second, duplicate create. Never applied to an
      // array result (archive's whole-subtree response): `key` there is already a durable task
      // id, and remapping it onto a descendant's id would be a defect, not a durability fix.
      if (!Array.isArray(result) && result.id !== key) {
        this.durableIds.set(key, result.id);
      }
      outcome = { status: 'success', result };
    } catch (error) {
      outcome = { status: 'error', error };
    }
    queue.shift();
    this.inFlight.delete(key);
    for (const waiter of entry.waiters) waiter(outcome);
    if (queue.length > 0) void this.dispatchNext(key);
    else this.queues.delete(key);
  }

  /**
   * Drops every NOT-yet-dispatched entry for `key`, settling each dropped entry's waiters as
   * `cancelled` — never `success`, never silently. An in-flight (already dispatched) head, if any,
   * is left completely alone: it was already sent, so it may still finish durably and update
   * `confirmed` (Invariant 5 — local cancellation never pretends to roll back a request the
   * repository has already received). Use this when the owner explicitly abandons a task's
   * pending work (Cancel, Discard) — a queued-but-unsent save for a draft they just discarded must
   * never fire later and resurrect it.
   */
  cancelQueued(key: string): void {
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return;
    const startIndex = this.inFlight.has(key) ? 1 : 0;
    const dropped = queue.splice(startIndex);
    for (const entry of dropped) {
      for (const waiter of entry.waiters) waiter({ status: 'cancelled' });
    }
    if (queue.length === 0 && !this.inFlight.has(key)) this.queues.delete(key);
  }

  /** Cancels every not-yet-dispatched entry across every key. Used on a mounted owner change,
   * alongside swapping in a fresh coordinator instance for the new owner: settles every old-owner
   * queued waiter as `cancelled` (rather than leaving it dangling forever) while guaranteeing none
   * of them ever reaches the repository under the new owner's session. */
  cancelAllQueued(): void {
    for (const key of Array.from(this.queues.keys())) this.cancelQueued(key);
  }
}

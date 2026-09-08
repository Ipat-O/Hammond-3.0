import { TaskSaveCoordinator } from './taskSaveCoordinator';

interface Row {
  id: string;
  title: string;
  status: string;
}

/** A deferred promise plus the resolve/reject controls a test needs to settle it independently of
 * when it was created — lets a test assert "not yet called" before deliberately advancing time. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A tiny inspectable backend: `rows` is the actual persisted state a test can assert against
 * directly, never inferred from mock call order alone. */
function backend() {
  const rows = new Map<string, Row>();
  let nextId = 1;
  return {
    rows,
    create(fields: { title: string; status: string }) {
      const id = `real-${nextId++}`;
      const row: Row = { id, ...fields };
      rows.set(id, row);
      return row;
    },
    update(id: string, fields: Partial<{ title: string; status: string }>) {
      const current = rows.get(id);
      if (!current) throw new Error(`no such row ${id}`);
      const updated = { ...current, ...fields };
      rows.set(id, updated);
      return updated;
    },
  };
}

describe('TaskSaveCoordinator — per-task FIFO serialization', () => {
  it('a second submit for the SAME key does not dispatch until the first settles; different keys are independent', async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    const runCalls: string[] = [];
    const v1 = deferred<Row>();
    const v2 = deferred<Row>();
    const other = deferred<Row>();

    const p1 = coordinator.submit('task-1', () => {
      runCalls.push('v1');
      return v1.promise;
    });
    const p2 = coordinator.submit('task-1', () => {
      runCalls.push('v2');
      return v2.promise;
    });
    // A submit for a DIFFERENT key dispatches immediately regardless of task-1's own queue depth
    // (Invariant 2: different tasks save independently).
    const pOther = coordinator.submit('task-2', () => {
      runCalls.push('other');
      return other.promise;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(runCalls).toEqual(['v1', 'other']);

    v1.resolve({ id: 'task-1', title: 'v1', status: 'backlog' });
    await p1;
    expect(runCalls).toEqual(['v1', 'other', 'v2']);

    v2.resolve({ id: 'task-1', title: 'v2', status: 'backlog' });
    other.resolve({ id: 'task-2', title: 'other', status: 'backlog' });
    await Promise.all([p2, pOther]);
  });

  it('v1 succeeds, v2 succeeds: confirmed advances v1 then v2, ending on v2', async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    const v1 = deferred<Row>();
    const p1 = coordinator.submit('task-1', () => v1.promise);
    const p2 = coordinator.submit('task-1', () =>
      Promise.resolve<Row>({ id: 'task-1', title: 'v2', status: 'backlog' }),
    );

    v1.resolve({ id: 'task-1', title: 'v1', status: 'backlog' });
    const outcome1 = await p1;
    expect(outcome1).toEqual({ status: 'success', result: { id: 'task-1', title: 'v1', status: 'backlog' } });
    expect(coordinator.getConfirmed('task-1')?.title).toBe('v1');

    const outcome2 = await p2;
    expect(outcome2).toEqual({ status: 'success', result: { id: 'task-1', title: 'v2', status: 'backlog' } });
    expect(coordinator.getConfirmed('task-1')?.title).toBe('v2');
  });

  it('v1 succeeds, v2 fails: v1 remains confirmed, v2 settles as its own error, the queue is not poisoned', async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    const p1 = coordinator.submit('task-1', () =>
      Promise.resolve<Row>({ id: 'task-1', title: 'v1', status: 'backlog' }),
    );
    const p2 = coordinator.submit('task-1', () => Promise.reject(new Error('v2 rejected')));
    const p3 = coordinator.submit('task-1', () =>
      Promise.resolve<Row>({ id: 'task-1', title: 'v3', status: 'backlog' }),
    );

    await p1;
    const outcome2 = await p2;
    expect(outcome2.status).toBe('error');
    expect(coordinator.getConfirmed('task-1')?.title).toBe('v1');

    // A THIRD request queued behind the failed one must still dispatch — a rejection never
    // poisons the queue for requests behind it.
    const outcome3 = await p3;
    expect(outcome3).toEqual({ status: 'success', result: { id: 'task-1', title: 'v3', status: 'backlog' } });
    expect(coordinator.getConfirmed('task-1')?.title).toBe('v3');
  });

  it('v1 fails, v2 succeeds: the failure does not block v2, and confirmed ends on v2', async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    const p1 = coordinator.submit('task-1', () => Promise.reject(new Error('v1 rejected')));
    const p2 = coordinator.submit('task-1', () =>
      Promise.resolve<Row>({ id: 'task-1', title: 'v2', status: 'backlog' }),
    );

    const outcome1 = await p1;
    expect(outcome1.status).toBe('error');
    expect(coordinator.getConfirmed('task-1')).toBeUndefined();

    const outcome2 = await p2;
    expect(outcome2.status).toBe('success');
    expect(coordinator.getConfirmed('task-1')?.title).toBe('v2');
  });

  it('both fail: confirmed stays exactly as it was before either attempt (never set)', async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    const p1 = coordinator.submit('task-1', () => Promise.reject(new Error('one')));
    const p2 = coordinator.submit('task-1', () => Promise.reject(new Error('two')));

    expect((await p1).status).toBe('error');
    expect((await p2).status).toBe('error');
    expect(coordinator.getConfirmed('task-1')).toBeUndefined();
  });

  it('an identical resubmit (same dedupe token) while the first is still pending shares its outcome instead of dispatching twice', async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    let runCount = 0;
    const held = deferred<Row>();
    const token = JSON.stringify({ title: 'same', status: 'backlog' });
    const p1 = coordinator.submit(
      'task-1',
      () => {
        runCount += 1;
        return held.promise;
      },
      token,
    );
    const p2 = coordinator.submit(
      'task-1',
      () => {
        runCount += 1;
        return held.promise;
      },
      token,
    );

    expect(runCount).toBe(1);
    held.resolve({ id: 'task-1', title: 'same', status: 'backlog' });
    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o1).toEqual(o2);
    expect(runCount).toBe(1);
  });

  it('a different dedupe token still enqueues a genuinely distinct request even while the first is pending', async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    const runFields: string[] = [];
    const held = deferred<Row>();
    coordinator.submit(
      'task-1',
      () => {
        runFields.push('v1');
        return held.promise;
      },
      'token-v1',
    );
    coordinator.submit(
      'task-1',
      () => Promise.resolve<Row>({ id: 'task-1', title: 'v2', status: 'backlog' }),
      'token-v2',
    );

    expect(runFields).toEqual(['v1']);
    held.resolve({ id: 'task-1', title: 'v1', status: 'backlog' });
    await Promise.resolve();
    await Promise.resolve();
    expect(coordinator.getConfirmed('task-1')?.title).toBe('v2');
  });

  it('a not-yet-created task: overlapping saves issue exactly one create, and the queued second save becomes an update against the real id', async () => {
    const store = backend();
    const coordinator = new TaskSaveCoordinator<Row>();
    const createCalls: unknown[] = [];
    const updateCalls: Array<{ id: string; fields: unknown }> = [];
    const heldCreate = deferred<Row>();

    const p1 = coordinator.submit('draft-task-1', ({ durableId }) => {
      expect(durableId).toBeNull();
      createCalls.push({ title: 'v1' });
      return heldCreate.promise;
    });
    const p2 = coordinator.submit('draft-task-1', ({ durableId }) => {
      // Dispatched only after p1 settles — by then the coordinator must already know the real id.
      expect(durableId).not.toBeNull();
      updateCalls.push({ id: durableId as string, fields: { title: 'v2' } });
      return Promise.resolve(store.update(durableId as string, { title: 'v2' }));
    });

    heldCreate.resolve(store.create({ title: 'v1', status: 'backlog' }));
    await p1;
    expect(coordinator.getDurableId('draft-task-1')).toBe('real-1');
    await p2;

    expect(createCalls).toHaveLength(1);
    expect(updateCalls).toHaveLength(1);
    expect(store.rows.get('real-1')?.title).toBe('v2');
    expect(coordinator.getConfirmedForKey('draft-task-1')?.title).toBe('v2');
  });

  it('a failed create leaves no durable id, so a queued retry issues a fresh create rather than an update — no orphaned or duplicated draft', async () => {
    const store = backend();
    const coordinator = new TaskSaveCoordinator<Row>();
    const p1 = coordinator.submit('draft-task-1', () => Promise.reject(new Error('create blew up')));
    const p2 = coordinator.submit('draft-task-1', ({ durableId }) => {
      expect(durableId).toBeNull();
      return Promise.resolve(store.create({ title: 'retried', status: 'backlog' }));
    });

    expect((await p1).status).toBe('error');
    const outcome2 = await p2;
    expect(outcome2.status).toBe('success');
    expect(store.rows.size).toBe(1);
    expect(coordinator.getConfirmedForKey('draft-task-1')?.title).toBe('retried');
  });

  it("an archive's multi-row result never remaps the archived task's own key onto a descendant's id", async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    const parent: Row = { id: 'task-parent', title: 'Parent', status: 'backlog' };
    const child: Row = { id: 'task-child', title: 'Child', status: 'backlog' };
    const outcome = await coordinator.submit('task-parent', () => Promise.resolve([parent, child]));

    expect(outcome).toEqual({ status: 'success', result: [parent, child] });
    expect(coordinator.getDurableId('task-parent')).toBeUndefined();
    expect(coordinator.getConfirmedForKey('task-parent')?.id).toBe('task-parent');
    expect(coordinator.getConfirmed('task-child')?.id).toBe('task-child');
  });

  it('cancelQueued drops a not-yet-dispatched entry as cancelled, without disturbing the in-flight head — which still settles durably afterward', async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    const held = deferred<Row>();
    let queuedRan = false;
    const p1 = coordinator.submit('task-1', () => held.promise);
    const p2 = coordinator.submit('task-1', () => {
      queuedRan = true;
      return Promise.resolve<Row>({ id: 'task-1', title: 'never sent', status: 'backlog' });
    });

    coordinator.cancelQueued('task-1');
    expect(await p2).toEqual({ status: 'cancelled' });
    expect(queuedRan).toBe(false);

    // The in-flight head was left alone — it still settles, still durably, into confirmed.
    held.resolve({ id: 'task-1', title: 'already sent', status: 'backlog' });
    expect(await p1).toEqual({
      status: 'success',
      result: { id: 'task-1', title: 'already sent', status: 'backlog' },
    });
    expect(coordinator.getConfirmed('task-1')?.title).toBe('already sent');
  });

  it('cancelQueued with nothing in flight cancels every queued entry for that key', async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    // Populate a queue without letting it auto-dispatch by holding the head with a promise that
    // never resolves in this test, then cancel while entry 2 is still queued behind it.
    const held = deferred<Row>();
    coordinator.submit('task-1', () => held.promise);
    const p2 = coordinator.submit('task-1', () => Promise.resolve<Row>({ id: 'task-1', title: 'x', status: 'backlog' }));

    coordinator.cancelQueued('task-1');
    expect(await p2).toEqual({ status: 'cancelled' });
  });

  it('cancelAllQueued cancels queued (not in-flight) entries across every key at once', async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    const heldA = deferred<Row>();
    const heldB = deferred<Row>();
    coordinator.submit('task-a', () => heldA.promise);
    const pA2 = coordinator.submit('task-a', () => Promise.resolve<Row>({ id: 'task-a', title: 'a2', status: 'backlog' }));
    coordinator.submit('task-b', () => heldB.promise);
    const pB2 = coordinator.submit('task-b', () => Promise.resolve<Row>({ id: 'task-b', title: 'b2', status: 'backlog' }));

    coordinator.cancelAllQueued();
    expect(await pA2).toEqual({ status: 'cancelled' });
    expect(await pB2).toEqual({ status: 'cancelled' });

    // In-flight heads for both keys are untouched by the sweep.
    heldA.resolve({ id: 'task-a', title: 'a1', status: 'backlog' });
    heldB.resolve({ id: 'task-b', title: 'b1', status: 'backlog' });
    await Promise.resolve();
    expect(coordinator.getConfirmed('task-a')?.title).toBe('a1');
    expect(coordinator.getConfirmed('task-b')?.title).toBe('b1');
  });

  it('hasPending reflects whether ANY request (queued or in flight) still remains for a key, going false again only once every one of them has settled', async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    expect(coordinator.hasPending('task-1')).toBe(false);

    const held1 = deferred<Row>();
    const p1 = coordinator.submit('task-1', () => held1.promise);
    expect(coordinator.hasPending('task-1')).toBe(true);

    const held2 = deferred<Row>();
    const p2 = coordinator.submit('task-1', () => held2.promise);
    expect(coordinator.hasPending('task-1')).toBe(true);

    held1.resolve({ id: 'task-1', title: 'v1', status: 'backlog' });
    await p1;
    // v2 is now the one in flight — still pending overall.
    expect(coordinator.hasPending('task-1')).toBe(true);

    held2.resolve({ id: 'task-1', title: 'v2', status: 'backlog' });
    await p2;
    expect(coordinator.hasPending('task-1')).toBe(false);
  });

  it('upsertConfirmed (a full list load) never wipes a confirmed row it does not itself include', async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    coordinator.setConfirmed({ id: 'task-1', title: 'from a save', status: 'backlog' });
    coordinator.upsertConfirmed([{ id: 'task-2', title: 'from list load', status: 'backlog' }]);

    expect(coordinator.getConfirmed('task-1')?.title).toBe('from a save');
    expect(coordinator.getConfirmed('task-2')?.title).toBe('from list load');
  });
});

describe('TaskSaveCoordinator — HAM3-008 Correction 9: canonical queue identity across draft/real aliases (Finding 1)', () => {
  it('a submission naming the REAL id, made after a create resolved under the ORIGINAL draft key, lands in the SAME queue — it does not dispatch until an already-queued draft-keyed entry settles first', async () => {
    const store = backend();
    const coordinator = new TaskSaveCoordinator<Row>();
    const heldCreate = deferred<Row>();
    const heldUpdate = deferred<Row>();
    let archiveRan = false;

    // v1: the create itself, dispatched immediately under the draft key, held.
    const p1 = coordinator.submit('draft-task-1', () => heldCreate.promise, null, 'editor');
    // v2: a second explicit save, still under the SAME draft key (the UI reuses it until a real id
    // is known) — queues behind v1.
    const p2 = coordinator.submit(
      'draft-task-1',
      ({ durableId }) => {
        expect(durableId).toBe('real-1');
        return heldUpdate.promise;
      },
      null,
      'editor',
    );

    heldCreate.resolve(store.create({ title: 'v1', status: 'backlog' }));
    await p1;
    expect(coordinator.getDurableId('draft-task-1')).toBe('real-1');

    // An outliner action submitted under the REAL id — exactly what `archiveTask` does once the
    // outliner row has been rewritten to the real id — must resolve to the SAME physical queue as
    // the still-queued v2, not open an independent one that dispatches immediately.
    const p3 = coordinator.submit(
      'real-1',
      () => {
        archiveRan = true;
        return Promise.resolve<Row>({ id: 'real-1', title: 'v2', status: 'archived' });
      },
      null,
      'outliner',
    );

    await Promise.resolve();
    await Promise.resolve();
    // v2 is dispatched (it was already queued when the create settled); the real-id submission is
    // NOT — it must wait behind v2, proving both aliases share the one canonical queue.
    expect(archiveRan).toBe(false);
    expect(coordinator.hasPending('draft-task-1')).toBe(true);
    expect(coordinator.hasPending('real-1')).toBe(true);

    heldUpdate.resolve(store.update('real-1', { title: 'v2' }));
    await p2;
    await p3;
    expect(archiveRan).toBe(true);
    expect(coordinator.hasPending('draft-task-1')).toBe(false);
    expect(coordinator.hasPending('real-1')).toBe(false);
  });

  it('cancelQueued reaches an entry queued under the DRAFT key when called with the REAL id (and vice versa) — scoped cancellation works through either alias', async () => {
    const store = backend();
    const coordinator = new TaskSaveCoordinator<Row>();
    const heldCreate = deferred<Row>();
    const heldHead = deferred<Row>();
    const p1 = coordinator.submit('draft-task-1', () => heldCreate.promise, null, 'editor');
    heldCreate.resolve(store.create({ title: 'v1', status: 'backlog' }));
    await p1;
    expect(coordinator.getDurableId('real-1')).toBe('real-1');

    // A new head, in flight, so the next submission genuinely queues rather than dispatching.
    const pHead = coordinator.submit('draft-task-1', () => heldHead.promise, null, 'editor');
    let queuedRan = false;
    const pQueued = coordinator.submit(
      'draft-task-1',
      () => {
        queuedRan = true;
        return Promise.resolve<Row>({ id: 'real-1', title: 'never sent', status: 'backlog' });
      },
      null,
      'outliner',
    );

    // Cancel by the REAL id — an entry physically queued under the ORIGINAL draft key must still
    // be reachable and dropped (HAM3-008 Correction 9: scoped cancellation through both aliases).
    coordinator.cancelQueued('real-1', 'outliner');
    expect(await pQueued).toEqual({ status: 'cancelled' });
    expect(queuedRan).toBe(false);

    heldHead.resolve(store.update('real-1', { title: 'v-head' }));
    await pHead;
    expect(coordinator.hasPending('draft-task-1')).toBe(false);
  });
});

describe('TaskSaveCoordinator — HAM3-008 Correction 9: owner-scoped cancellation (Finding 2)', () => {
  it("cancelQueued(key, 'editor') drops only 'editor'-owned queued entries, leaving an independently queued 'outliner' entry to dispatch normally in its turn", async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    const held = deferred<Row>();
    let outlinerRan = false;
    const pHead = coordinator.submit('task-1', () => held.promise, null, 'editor');
    const pEditorQueued = coordinator.submit(
      'task-1',
      () => Promise.resolve<Row>({ id: 'task-1', title: 'never sent', status: 'backlog' }),
      null,
      'editor',
    );
    const pOutlinerQueued = coordinator.submit(
      'task-1',
      () => {
        outlinerRan = true;
        return Promise.resolve<Row>({ id: 'task-1', title: 'archived', status: 'done' });
      },
      null,
      'outliner',
    );

    coordinator.cancelQueued('task-1', 'editor');
    expect(await pEditorQueued).toEqual({ status: 'cancelled' });
    expect(outlinerRan).toBe(false);

    // The in-flight head (owner 'editor') is left alone regardless of the filter — Invariant 5.
    held.resolve({ id: 'task-1', title: 'already sent', status: 'backlog' });
    await pHead;

    // The surviving 'outliner' entry dispatches in its own turn once the head settles.
    expect(await pOutlinerQueued).toEqual({
      status: 'success',
      result: { id: 'task-1', title: 'archived', status: 'done' },
    });
    expect(outlinerRan).toBe(true);
    expect(coordinator.getConfirmed('task-1')?.title).toBe('archived');
  });

  it('an unscoped cancelQueued(key) (no owner argument) keeps dropping every queued entry regardless of owner — the previous, owner-change behavior', async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    const held = deferred<Row>();
    coordinator.submit('task-1', () => held.promise, null, 'editor');
    const pEditorQueued = coordinator.submit('task-1', () => Promise.resolve<Row>({ id: 'task-1', title: 'e', status: 'backlog' }), null, 'editor');
    const pOutlinerQueued = coordinator.submit('task-1', () => Promise.resolve<Row>({ id: 'task-1', title: 'o', status: 'backlog' }), null, 'outliner');

    coordinator.cancelQueued('task-1');
    expect(await pEditorQueued).toEqual({ status: 'cancelled' });
    expect(await pOutlinerQueued).toEqual({ status: 'cancelled' });
  });

  it('cancelAllQueued drops every queued entry of every owner across every key — an owner change abandons ALL old-owner work, not just form drafts', async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    const heldA = deferred<Row>();
    coordinator.submit('task-a', () => heldA.promise, null, 'editor');
    const pEditor = coordinator.submit('task-a', () => Promise.resolve<Row>({ id: 'task-a', title: 'e', status: 'backlog' }), null, 'editor');
    const pOutliner = coordinator.submit('task-a', () => Promise.resolve<Row>({ id: 'task-a', title: 'o', status: 'backlog' }), null, 'outliner');

    coordinator.cancelAllQueued();
    expect(await pEditor).toEqual({ status: 'cancelled' });
    expect(await pOutliner).toEqual({ status: 'cancelled' });
  });

  it('preserves the pre-Correction-9 default: submit/cancelQueued used exactly as before (no owner argument) still cancels every queued entry, in-flight head untouched', async () => {
    const coordinator = new TaskSaveCoordinator<Row>();
    const held = deferred<Row>();
    let queuedRan = false;
    const p1 = coordinator.submit('task-1', () => held.promise);
    const p2 = coordinator.submit('task-1', () => {
      queuedRan = true;
      return Promise.resolve<Row>({ id: 'task-1', title: 'never sent', status: 'backlog' });
    });

    coordinator.cancelQueued('task-1');
    expect(await p2).toEqual({ status: 'cancelled' });
    expect(queuedRan).toBe(false);

    held.resolve({ id: 'task-1', title: 'already sent', status: 'backlog' });
    expect(await p1).toEqual({
      status: 'success',
      result: { id: 'task-1', title: 'already sent', status: 'backlog' },
    });
  });
});

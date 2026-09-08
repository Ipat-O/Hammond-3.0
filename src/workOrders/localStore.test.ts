import { describe, expect, it } from 'vitest';

import { createFakeLocalSettings } from '../settings/testFakes';
import { WorkOrderDomainError } from './errors';
import { WorkOrderLocalStore } from './localStore';
import { createControlledLocalSettings } from './testFakes';
import {
  emptyWorkerFields,
  type WorkOrderDispatchSnapshot,
  type WorkOrderReportRecord,
} from './types';

function makeSnapshot(
  overrides: Partial<WorkOrderDispatchSnapshot> = {},
): WorkOrderDispatchSnapshot {
  const fields = emptyWorkerFields();
  fields.taskId = 'HAM3-009';
  return {
    id: 'dispatch-1',
    ownerId: 'owner-1',
    projectId: 'project-1',
    taskId: 'task-1',
    stage: 'worker',
    content: 'generated packet text',
    packet: { stage: 'worker', fields },
    createdAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

function makeReport(overrides: Partial<WorkOrderReportRecord> = {}): WorkOrderReportRecord {
  return {
    id: 'report-1',
    ownerId: 'owner-1',
    projectId: 'project-1',
    taskId: 'task-1',
    dispatchId: 'dispatch-1',
    rawText: 'raw report text',
    url: null,
    returnedIdentity: null,
    headSha: null,
    verificationNotes: '',
    limitations: '',
    provenance: 'owner-pasted',
    recordedAt: '2026-09-08T01:00:00.000Z',
    ...overrides,
  };
}

describe('WorkOrderLocalStore drafts', () => {
  it('round-trips a draft and clears it explicitly', async () => {
    const store = new WorkOrderLocalStore(createFakeLocalSettings());
    const key = {
      ownerId: 'owner-1',
      projectId: 'project-1',
      taskId: 'task-1',
      stage: 'worker' as const,
    };
    expect(await store.readDraft(key)).toBeNull();

    const value = { stage: 'worker', fields: emptyWorkerFields() };
    await store.writeDraft({ ...key, value });
    expect(await store.readDraft(key)).toEqual(value);

    await store.clearDraft(key);
    expect(await store.readDraft(key)).toBeNull();
  });

  it('keeps drafts for different stages of the same task independent', async () => {
    const store = new WorkOrderLocalStore(createFakeLocalSettings());
    const base = { ownerId: 'owner-1', projectId: 'project-1', taskId: 'task-1' };
    await store.writeDraft({ ...base, stage: 'worker', value: { marker: 'worker-draft' } });
    await store.writeDraft({ ...base, stage: 'audit', value: { marker: 'audit-draft' } });
    expect(await store.readDraft({ ...base, stage: 'worker' })).toEqual({ marker: 'worker-draft' });
    expect(await store.readDraft({ ...base, stage: 'audit' })).toEqual({ marker: 'audit-draft' });
  });
});

describe('WorkOrderLocalStore dispatch immutability', () => {
  it('appends a dispatch and lists it in the index and by task', async () => {
    const store = new WorkOrderLocalStore(createFakeLocalSettings());
    const snapshot = makeSnapshot();
    await store.appendDispatch(snapshot);

    expect(await store.getDispatch('owner-1', 'dispatch-1')).toEqual(snapshot);
    const index = await store.listDispatchIndex('owner-1');
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ id: 'dispatch-1', taskId: 'task-1', stage: 'worker' });
    expect(await store.listDispatchesForTask('owner-1', 'task-1')).toEqual([snapshot]);
  });

  it('MUTATION PROOF: refuses to overwrite an existing dispatch id with different content, and the stored content is unchanged after the attempt', async () => {
    const store = new WorkOrderLocalStore(createFakeLocalSettings());
    const original = makeSnapshot({ content: 'original content' });
    await store.appendDispatch(original);

    const mutated = makeSnapshot({ content: 'MUTATED — this must never be stored' });
    await expect(store.appendDispatch(mutated)).rejects.toThrow(WorkOrderDomainError);
    await expect(store.appendDispatch(mutated)).rejects.toThrow(/already recorded/);

    // The whole point of the guarantee: read the record back and prove it is still the original.
    const stored = await store.getDispatch('owner-1', 'dispatch-1');
    expect(stored?.content).toBe('original content');
    const index = await store.listDispatchIndex('owner-1');
    expect(index).toHaveLength(1);
  });

  it('is idempotent for a retry with the same id and same generated content, even with a different capture timestamp — no duplicate index entry', async () => {
    const store = new WorkOrderLocalStore(createFakeLocalSettings());
    const first = makeSnapshot({ createdAt: '2026-09-08T00:00:00.000Z' });
    const retry = makeSnapshot({ createdAt: '2026-09-08T00:00:05.000Z' });

    const firstResult = await store.appendDispatch(first);
    const retryResult = await store.appendDispatch(retry);

    expect(retryResult).toEqual(firstResult);
    expect(retryResult.createdAt).toBe('2026-09-08T00:00:00.000Z');
    const index = await store.listDispatchIndex('owner-1');
    expect(index).toHaveLength(1);
  });

  it('keeps different owners fully isolated', async () => {
    const store = new WorkOrderLocalStore(createFakeLocalSettings());
    await store.appendDispatch(makeSnapshot({ id: 'd-owner-1', ownerId: 'owner-1' }));
    await store.appendDispatch(makeSnapshot({ id: 'd-owner-2', ownerId: 'owner-2' }));

    expect(await store.listDispatchIndex('owner-1')).toHaveLength(1);
    expect(await store.listDispatchIndex('owner-2')).toHaveLength(1);
    expect(await store.getDispatch('owner-1', 'd-owner-2')).toBeNull();
  });

  it('serializes concurrent appends for the same owner without losing an index entry', async () => {
    const store = new WorkOrderLocalStore(createFakeLocalSettings());
    await Promise.all([
      store.appendDispatch(makeSnapshot({ id: 'concurrent-1' })),
      store.appendDispatch(makeSnapshot({ id: 'concurrent-2' })),
      store.appendDispatch(makeSnapshot({ id: 'concurrent-3' })),
    ]);
    const index = await store.listDispatchIndex('owner-1');
    expect(index.map((entry) => entry.id).sort()).toEqual([
      'concurrent-1',
      'concurrent-2',
      'concurrent-3',
    ]);
  });

  it('sorts listDispatchesForTask newest first', async () => {
    const store = new WorkOrderLocalStore(createFakeLocalSettings());
    await store.appendDispatch(
      makeSnapshot({ id: 'older', createdAt: '2026-09-01T00:00:00.000Z' }),
    );
    await store.appendDispatch(
      makeSnapshot({ id: 'newer', createdAt: '2026-09-05T00:00:00.000Z' }),
    );
    const list = await store.listDispatchesForTask('owner-1', 'task-1');
    expect(list.map((snapshot) => snapshot.id)).toEqual(['newer', 'older']);
  });
});

describe('WorkOrderLocalStore report immutability', () => {
  it('appends a report and lists it by dispatch and by task', async () => {
    const store = new WorkOrderLocalStore(createFakeLocalSettings());
    const report = makeReport();
    await store.appendReport(report);

    expect(await store.getReport('owner-1', 'report-1')).toEqual(report);
    expect(await store.listReportsForDispatch('owner-1', 'dispatch-1')).toEqual([report]);
    expect(await store.listReportsForTask('owner-1', 'task-1')).toEqual([report]);
  });

  it('MUTATION PROOF: refuses to overwrite an existing report id with different content', async () => {
    const store = new WorkOrderLocalStore(createFakeLocalSettings());
    await store.appendReport(makeReport({ rawText: 'original report' }));
    await expect(store.appendReport(makeReport({ rawText: 'MUTATED report' }))).rejects.toThrow(
      WorkOrderDomainError,
    );
    const stored = await store.getReport('owner-1', 'report-1');
    expect(stored?.rawText).toBe('original report');
  });

  it('is idempotent for a retry with the same id and same content, ignoring recordedAt', async () => {
    const store = new WorkOrderLocalStore(createFakeLocalSettings());
    const first = await store.appendReport(makeReport({ recordedAt: '2026-09-08T01:00:00.000Z' }));
    const retry = await store.appendReport(makeReport({ recordedAt: '2026-09-08T01:00:09.000Z' }));
    expect(retry).toEqual(first);
    expect(await store.listReportIndex('owner-1')).toHaveLength(1);
  });

  it('supports multiple reports attached to the same dispatch (a correction attaches a new report, never overwriting the prior one)', async () => {
    const store = new WorkOrderLocalStore(createFakeLocalSettings());
    await store.appendReport(makeReport({ id: 'report-1', rawText: 'first report' }));
    await store.appendReport(makeReport({ id: 'report-2', rawText: 'second report' }));
    const reports = await store.listReportsForDispatch('owner-1', 'dispatch-1');
    expect(reports).toHaveLength(2);
    expect(reports.map((report) => report.rawText).sort()).toEqual([
      'first report',
      'second report',
    ]);
  });
});

describe('WorkOrderLocalStore partial-write recovery (HAM3-009 Correction 1)', () => {
  const DISPATCH_INDEX_KEY = 'hammond.workOrders.index.owner-1';
  const REPORT_INDEX_KEY = 'hammond.workOrders.reportIndex.owner-1';

  it('dispatch: document write succeeds, index write fails, then an identical retry repairs the index without duplicating or losing the original', async () => {
    const settings = createControlledLocalSettings();
    settings.failWritesMatching((key) => key === DISPATCH_INDEX_KEY, { count: 1 });
    const store = new WorkOrderLocalStore(settings);
    const snapshot = makeSnapshot();

    await expect(store.appendDispatch(snapshot)).rejects.toThrow();
    // The document itself is durably saved even though the attempt as a whole failed.
    expect(await store.getDispatch('owner-1', 'dispatch-1')).toEqual(snapshot);
    // But it is not yet discoverable through history — the whole point of the bug.
    expect(await store.listDispatchIndex('owner-1')).toEqual([]);
    expect(await store.listDispatchesForTask('owner-1', 'task-1')).toEqual([]);

    const retryResult = await store.appendDispatch(snapshot);
    expect(retryResult).toEqual(snapshot);
    const index = await store.listDispatchIndex('owner-1');
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ id: 'dispatch-1', taskId: 'task-1', stage: 'worker' });
    expect(await store.listDispatchesForTask('owner-1', 'task-1')).toEqual([snapshot]);
    // The original createdAt/content survive untouched — this is a repair, not a re-write.
    const recovered = await store.getDispatch('owner-1', 'dispatch-1');
    expect(recovered).toEqual(snapshot);
  });

  it('report: document write succeeds, index write fails, then an identical retry repairs the index and the report appears once under its dispatch', async () => {
    const settings = createControlledLocalSettings();
    settings.failWritesMatching((key) => key === REPORT_INDEX_KEY, { count: 1 });
    const store = new WorkOrderLocalStore(settings);
    const report = makeReport();

    await expect(store.appendReport(report)).rejects.toThrow();
    expect(await store.getReport('owner-1', 'report-1')).toEqual(report);
    expect(await store.listReportIndex('owner-1')).toEqual([]);
    expect(await store.listReportsForDispatch('owner-1', 'dispatch-1')).toEqual([]);

    const retryResult = await store.appendReport(report);
    expect(retryResult).toEqual(report);
    expect(await store.listReportIndex('owner-1')).toHaveLength(1);
    const reports = await store.listReportsForDispatch('owner-1', 'dispatch-1');
    expect(reports).toEqual([report]);
    expect(reports[0].rawText).toBe(report.rawText);
    expect(reports[0].provenance).toBe(report.provenance);
  });

  it('MUTATION PROOF (recovery path): a repeated index failure never fabricates success and never duplicates the index entry, recovering only once the underlying write actually succeeds — proved across fresh store instances so recovery cannot be relying on in-memory cache', async () => {
    const settings = createControlledLocalSettings();
    settings.failWritesMatching((key) => key === DISPATCH_INDEX_KEY, { count: 2 });
    const snapshot = makeSnapshot();

    // Attempt 1: document write succeeds, index write fails (1st failure). A brand-new store
    // instance each time, wrapping the same underlying settings — recovery must come from the
    // persisted state, not from anything cached on the store object.
    await expect(new WorkOrderLocalStore(settings).appendDispatch(snapshot)).rejects.toThrow(
      WorkOrderDomainError,
    );
    expect(await new WorkOrderLocalStore(settings).listDispatchIndex('owner-1')).toEqual([]);

    // Attempt 2: document already exists (unchanged), index write fails again (2nd failure) — a
    // truthful error again, not a false success.
    await expect(new WorkOrderLocalStore(settings).appendDispatch(snapshot)).rejects.toThrow(
      WorkOrderDomainError,
    );
    expect(await new WorkOrderLocalStore(settings).listDispatchIndex('owner-1')).toEqual([]);

    // Attempt 3: the index write is allowed through — recovers cleanly, exactly one entry.
    const recovered = await new WorkOrderLocalStore(settings).appendDispatch(snapshot);
    expect(recovered).toEqual(snapshot);
    const index = await new WorkOrderLocalStore(settings).listDispatchIndex('owner-1');
    expect(index).toHaveLength(1);

    // A further identical retry after recovery is a true no-op: no extra index write is issued.
    const writeCallsBefore = (settings.write as unknown as { mock: { calls: unknown[] } }).mock
      .calls.length;
    await new WorkOrderLocalStore(settings).appendDispatch(snapshot);
    const writeCallsAfter = (settings.write as unknown as { mock: { calls: unknown[] } }).mock.calls
      .length;
    expect(writeCallsAfter).toBe(writeCallsBefore);
  });

  it('an already-correct index is left alone (no redundant write) and conflicting content under the same id is still rejected without touching the index or other entries', async () => {
    const settings = createControlledLocalSettings();
    const store = new WorkOrderLocalStore(settings);
    await store.appendDispatch(makeSnapshot({ id: 'other-owner-2-dispatch', ownerId: 'owner-2' }));
    await store.appendDispatch(makeSnapshot({ id: 'sibling-dispatch', taskId: 'task-2' }));
    const original = makeSnapshot({ content: 'original content' });
    await store.appendDispatch(original);

    const writeCallsBefore = (settings.write as unknown as { mock: { calls: unknown[] } }).mock
      .calls.length;
    await store.appendDispatch(original);
    const writeCallsAfter = (settings.write as unknown as { mock: { calls: unknown[] } }).mock.calls
      .length;
    expect(writeCallsAfter).toBe(writeCallsBefore);

    const mutated = makeSnapshot({ content: 'MUTATED — this must never be stored' });
    await expect(store.appendDispatch(mutated)).rejects.toThrow(WorkOrderDomainError);
    expect((await store.getDispatch('owner-1', 'dispatch-1'))?.content).toBe('original content');

    // Sibling entries for the same owner and the isolated other owner both survive untouched.
    expect(await store.listDispatchIndex('owner-1')).toHaveLength(2);
    expect(await store.listDispatchIndex('owner-2')).toHaveLength(1);
  });

  it('a document write failure (before the index is ever touched) leaves no phantom document, index entry, or history record', async () => {
    const settings = createControlledLocalSettings();
    const key = 'hammond.workOrders.dispatch.owner-1.dispatch-1';
    settings.failWritesMatching((k) => k === key, { count: 1 });
    const store = new WorkOrderLocalStore(settings);
    const snapshot = makeSnapshot();

    await expect(store.appendDispatch(snapshot)).rejects.toThrow();
    expect(await store.getDispatch('owner-1', 'dispatch-1')).toBeNull();
    expect(await store.listDispatchIndex('owner-1')).toEqual([]);
    expect(await store.listDispatchesForTask('owner-1', 'task-1')).toEqual([]);

    const recovered = await store.appendDispatch(snapshot);
    expect(recovered).toEqual(snapshot);
    expect(await store.listDispatchIndex('owner-1')).toHaveLength(1);
  });
});

describe('WorkOrderLocalStore durable pending-attempt recovery (HAM3-009 Correction 2)', () => {
  const OWNER = 'owner-1';
  const PROJECT = 'project-1';
  const TASK = 'task-1';

  function dispatchParams(overrides: Partial<{ content: string; createdAt: string }> = {}) {
    const fields = emptyWorkerFields();
    fields.taskId = TASK;
    return {
      ownerId: OWNER,
      projectId: PROJECT,
      taskId: TASK,
      stage: 'worker' as const,
      packet: { stage: 'worker' as const, fields },
      content: overrides.content ?? 'generated packet text A',
      createdAt: overrides.createdAt ?? '2026-09-08T00:00:00.000Z',
    };
  }

  it('metadata failure BEFORE any document exists: fails truthfully, writes no document and no pending record — a retry then succeeds cleanly', async () => {
    const settings = createControlledLocalSettings();
    settings.failWritesMatching((key) => key.startsWith('hammond.workOrders.pendingDispatch.'), {
      count: 1,
    });
    const store = new WorkOrderLocalStore(settings);

    await expect(
      store.appendDispatchDurable({ ...dispatchParams(), newId: () => 'fresh-id-1' }),
    ).rejects.toThrow(WorkOrderDomainError);
    expect(await store.getDispatch(OWNER, 'fresh-id-1')).toBeNull();
    expect(await store.getPendingDispatchAttempt(OWNER, PROJECT, TASK, 'worker')).toBeNull();
    expect(await store.listDispatchIndex(OWNER)).toEqual([]);

    const { snapshot, recoveredOriginal } = await store.appendDispatchDurable({
      ...dispatchParams(),
      newId: () => 'fresh-id-1',
    });
    expect(snapshot.id).toBe('fresh-id-1');
    expect(recoveredOriginal).toBeNull();
    expect(await store.listDispatchIndex(OWNER)).toHaveLength(1);
    expect(await store.getPendingDispatchAttempt(OWNER, PROJECT, TASK, 'worker')).toBeNull();
  });

  it('document-write failure (pending metadata already durable): the pending record survives the failure, and a retry recovers with a fresh document write', async () => {
    const settings = createControlledLocalSettings();
    const store = new WorkOrderLocalStore(settings);
    settings.failWritesMatching((key) => key === 'hammond.workOrders.dispatch.owner-1.fresh-id-1', {
      count: 1,
    });

    await expect(
      store.appendDispatchDurable({ ...dispatchParams(), newId: () => 'fresh-id-1' }),
    ).rejects.toThrow(WorkOrderDomainError);
    expect(await store.getDispatch(OWNER, 'fresh-id-1')).toBeNull();
    const pendingAfterFailure = await store.getPendingDispatchAttempt(
      OWNER,
      PROJECT,
      TASK,
      'worker',
    );
    expect(pendingAfterFailure).toMatchObject({
      id: 'fresh-id-1',
      content: 'generated packet text A',
    });

    const { snapshot } = await store.appendDispatchDurable({
      ...dispatchParams(),
      newId: () => 'fresh-id-1',
    });
    expect(snapshot.id).toBe('fresh-id-1');
    expect(await store.listDispatchIndex(OWNER)).toHaveLength(1);
    expect(await store.getPendingDispatchAttempt(OWNER, PROJECT, TASK, 'worker')).toBeNull();
  });

  it('MUTATION PROOF (navigation/restart): index write fails, then an identical resubmission from a brand-new store instance (simulated remount/restart) repairs the index — one document, one history entry, byte-identical original', async () => {
    const settings = createControlledLocalSettings();
    settings.failWritesMatching((key) => key === `hammond.workOrders.index.${OWNER}`, {
      count: 1,
    });

    await expect(
      new WorkOrderLocalStore(settings).appendDispatchDurable({
        ...dispatchParams(),
        newId: () => 'fresh-id-1',
      }),
    ).rejects.toThrow(WorkOrderDomainError);
    expect(await new WorkOrderLocalStore(settings).listDispatchIndex(OWNER)).toEqual([]);

    // A brand-new store instance — nothing cached in memory — recovers purely from durable state,
    // scoped only by owner/project/task/stage. No id is supplied by the caller here.
    const restarted = new WorkOrderLocalStore(settings);
    const { snapshot, recoveredOriginal } = await restarted.appendDispatchDurable({
      ...dispatchParams(),
      newId: () => 'should-not-be-used',
    });
    expect(snapshot.id).toBe('fresh-id-1');
    expect(recoveredOriginal).toBeNull();
    expect(snapshot.createdAt).toBe('2026-09-08T00:00:00.000Z');
    const index = await restarted.listDispatchIndex(OWNER);
    expect(index).toHaveLength(1);
    expect(await restarted.getPendingDispatchAttempt(OWNER, PROJECT, TASK, 'worker')).toBeNull();
  });

  it('repeated index failures across fresh store instances (simulated repeated restarts) never fabricate success and never duplicate — recovery lands exactly once the write finally succeeds', async () => {
    const settings = createControlledLocalSettings();
    settings.failWritesMatching((key) => key === `hammond.workOrders.index.${OWNER}`, {
      count: 2,
    });
    const params = () => ({ ...dispatchParams(), newId: () => 'fresh-id-1' });

    await expect(new WorkOrderLocalStore(settings).appendDispatchDurable(params())).rejects.toThrow(
      WorkOrderDomainError,
    );
    await expect(new WorkOrderLocalStore(settings).appendDispatchDurable(params())).rejects.toThrow(
      WorkOrderDomainError,
    );
    expect(await new WorkOrderLocalStore(settings).listDispatchIndex(OWNER)).toEqual([]);

    const recovered = await new WorkOrderLocalStore(settings).appendDispatchDurable(params());
    expect(recovered.snapshot.id).toBe('fresh-id-1');
    expect(await new WorkOrderLocalStore(settings).listDispatchIndex(OWNER)).toHaveLength(1);
  });

  it('MUTATION PROOF (edited-content recovery): editing the content after a partial failure — from a fresh store instance — first recovers the original as its own history entry, then records the edit as a second, distinct entry; original bytes/timestamp untouched', async () => {
    const settings = createControlledLocalSettings();
    settings.failWritesMatching((key) => key === `hammond.workOrders.index.${OWNER}`, {
      count: 1,
    });

    await expect(
      new WorkOrderLocalStore(settings).appendDispatchDurable({
        ...dispatchParams({ content: 'original content' }),
        newId: () => 'original-id',
      }),
    ).rejects.toThrow(WorkOrderDomainError);

    // Restart, then submit *edited* content instead of resubmitting the original.
    const restarted = new WorkOrderLocalStore(settings);
    const { snapshot, recoveredOriginal } = await restarted.appendDispatchDurable({
      ...dispatchParams({
        content: 'edited content after failure',
        createdAt: '2026-09-08T00:05:00.000Z',
      }),
      newId: () => 'edited-id',
    });

    expect(recoveredOriginal).toMatchObject({
      id: 'original-id',
      content: 'original content',
      createdAt: '2026-09-08T00:00:00.000Z',
    });
    expect(snapshot).toMatchObject({ id: 'edited-id', content: 'edited content after failure' });

    const history = await restarted.listDispatchesForTask(OWNER, TASK);
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.content).sort()).toEqual([
      'edited content after failure',
      'original content',
    ]);
    expect(await restarted.getPendingDispatchAttempt(OWNER, PROJECT, TASK, 'worker')).toBeNull();
  });

  it('if recovering the original fails again during an edited-content submission, the edit is never attempted — no orphan for the edit, the original pending record survives untouched for a later retry', async () => {
    const settings = createControlledLocalSettings();
    settings.failWritesMatching((key) => key === `hammond.workOrders.index.${OWNER}`, {
      count: 2,
    });

    await expect(
      new WorkOrderLocalStore(settings).appendDispatchDurable({
        ...dispatchParams({ content: 'original content' }),
        newId: () => 'original-id',
      }),
    ).rejects.toThrow(WorkOrderDomainError);

    // Edited content submitted while the original is still unrecovered — recovering the original
    // hits the second scripted index failure, so the edit must never be attempted.
    await expect(
      new WorkOrderLocalStore(settings).appendDispatchDurable({
        ...dispatchParams({ content: 'edited content', createdAt: '2026-09-08T00:05:00.000Z' }),
        newId: () => 'edited-id',
      }),
    ).rejects.toThrow(WorkOrderDomainError);

    // No orphan for the edit was ever created, and the original pending record is untouched.
    expect(await new WorkOrderLocalStore(settings).getDispatch(OWNER, 'edited-id')).toBeNull();
    expect(await new WorkOrderLocalStore(settings).listDispatchIndex(OWNER)).toEqual([]);
    const pending = await new WorkOrderLocalStore(settings).getPendingDispatchAttempt(
      OWNER,
      PROJECT,
      TASK,
      'worker',
    );
    expect(pending).toMatchObject({ id: 'original-id', content: 'original content' });

    // A later retry (index writes now succeed) recovers the original, then records the edit.
    const { snapshot, recoveredOriginal } = await new WorkOrderLocalStore(
      settings,
    ).appendDispatchDurable({
      ...dispatchParams({ content: 'edited content', createdAt: '2026-09-08T00:05:00.000Z' }),
      newId: () => 'edited-id',
    });
    expect(recoveredOriginal).toMatchObject({ id: 'original-id', content: 'original content' });
    expect(snapshot).toMatchObject({ id: 'edited-id', content: 'edited content' });
    expect(await new WorkOrderLocalStore(settings).listDispatchIndex(OWNER)).toHaveLength(2);
  });

  it('a cleanup (pending-record-clear) failure after the document and index are already consistent surfaces an error, but a retry is fully idempotent — no duplicate, pending eventually cleared', async () => {
    const settings = createControlledLocalSettings();
    settings.failRemovesMatching(
      (key) => key === `hammond.workOrders.pendingDispatch.${OWNER}.${PROJECT}.${TASK}.worker`,
      { count: 1 },
    );
    const store = new WorkOrderLocalStore(settings);

    await expect(
      store.appendDispatchDurable({ ...dispatchParams(), newId: () => 'fresh-id-1' }),
    ).rejects.toThrow();
    // The underlying data is already fully consistent even though the call itself reported an
    // error — the failure is scoped to "could not confirm cleanup," not to the record itself.
    expect(await store.listDispatchIndex(OWNER)).toHaveLength(1);
    expect((await store.getDispatch(OWNER, 'fresh-id-1'))?.content).toBe('generated packet text A');

    const writeCallsBefore = (settings.write as unknown as { mock: { calls: unknown[] } }).mock
      .calls.length;
    const { snapshot } = await store.appendDispatchDurable({
      ...dispatchParams(),
      newId: () => 'fresh-id-1',
    });
    const writeCallsAfter = (settings.write as unknown as { mock: { calls: unknown[] } }).mock.calls
      .length;
    expect(snapshot.id).toBe('fresh-id-1');
    expect(await store.listDispatchIndex(OWNER)).toHaveLength(1); // still exactly one — no duplicate
    expect(writeCallsAfter).toBe(writeCallsBefore); // the retry was a pure repair, no redundant write
    expect(await store.getPendingDispatchAttempt(OWNER, PROJECT, TASK, 'worker')).toBeNull();
  });

  it('scope isolation: two distinct tasks, two stages of the same task, and two owners each keep independent pending attempts — none interferes with another', async () => {
    const settings = createControlledLocalSettings();
    settings.failWritesMatching((key) => key === `hammond.workOrders.index.${OWNER}`, {
      count: 1,
    });
    settings.failWritesMatching((key) => key === 'hammond.workOrders.index.owner-2', { count: 1 });

    // Task 1 / worker stage: partial failure leaves a pending attempt.
    await expect(
      new WorkOrderLocalStore(settings).appendDispatchDurable({
        ...dispatchParams({ content: 'task-1 worker content' }),
        newId: () => 'task-1-worker-id',
      }),
    ).rejects.toThrow();

    // Task 2 (different task, same owner/stage) is unaffected — no pending record there, and a
    // fresh attempt succeeds outright without touching task 1's pending attempt.
    const task2Store = new WorkOrderLocalStore(settings);
    const task2Result = await task2Store.appendDispatchDurable({
      ...dispatchParams({ content: 'task-2 worker content' }),
      taskId: 'task-2',
      newId: () => 'task-2-worker-id',
    });
    expect(task2Result.recoveredOriginal).toBeNull();
    expect(
      await task2Store.getPendingDispatchAttempt(OWNER, PROJECT, TASK, 'worker'),
    ).toMatchObject({ id: 'task-1-worker-id' });

    // Correction stage of task 1 (different stage, same task) is also unaffected.
    const correctionFields = emptyWorkerFields();
    correctionFields.taskId = TASK;
    const correctionResult = await task2Store.appendDispatchDurable({
      ownerId: OWNER,
      projectId: PROJECT,
      taskId: TASK,
      stage: 'correction',
      packet: { stage: 'worker', fields: correctionFields },
      content: 'task-1 correction content',
      createdAt: '2026-09-08T01:00:00.000Z',
      newId: () => 'task-1-correction-id',
    });
    expect(correctionResult.recoveredOriginal).toBeNull();
    expect(
      await task2Store.getPendingDispatchAttempt(OWNER, PROJECT, TASK, 'worker'),
    ).toMatchObject({ id: 'task-1-worker-id' });

    // A different owner entirely, hitting its own scripted failure, never touches owner-1's state.
    await expect(
      new WorkOrderLocalStore(settings).appendDispatchDurable({
        ...dispatchParams({ content: 'owner-2 content' }),
        ownerId: 'owner-2',
        newId: () => 'owner-2-id',
      }),
    ).rejects.toThrow();
    expect(
      await task2Store.getPendingDispatchAttempt(OWNER, PROJECT, TASK, 'worker'),
    ).toMatchObject({ id: 'task-1-worker-id' });
    expect(await task2Store.listDispatchIndex(OWNER)).toHaveLength(2); // task-2 + task-1 correction
    expect(await task2Store.listDispatchIndex('owner-2')).toEqual([]);
  });

  it('a fresh dispatch submitted with identical content AFTER the previous identical-content attempt already fully completed is recorded as a genuinely new, distinct attempt — not silently merged with the completed one', async () => {
    const store = new WorkOrderLocalStore(createFakeLocalSettings());
    const first = await store.appendDispatchDurable({
      ...dispatchParams(),
      newId: () => 'first-id',
    });
    expect(first.snapshot.id).toBe('first-id');
    expect(await store.getPendingDispatchAttempt(OWNER, PROJECT, TASK, 'worker')).toBeNull();

    // Nothing is "pending" any more — this is a deliberate new attempt, not a retry, even though
    // the content happens to be identical.
    const second = await store.appendDispatchDurable({
      ...dispatchParams(),
      newId: () => 'second-id',
    });
    expect(second.snapshot.id).toBe('second-id');
    expect(second.recoveredOriginal).toBeNull();
    expect(await store.listDispatchIndex(OWNER)).toHaveLength(2);
  });

  it('report: MUTATION PROOF (navigation/restart) — index write fails, then an identical resubmission from a fresh store instance repairs it under its original dispatch, no hidden duplicate', async () => {
    const settings = createControlledLocalSettings();
    const store = new WorkOrderLocalStore(settings);
    await store.appendDispatch(makeSnapshot());
    settings.failWritesMatching((key) => key === `hammond.workOrders.reportIndex.${OWNER}`, {
      count: 1,
    });

    const reportParams = () => ({
      ownerId: OWNER,
      projectId: PROJECT,
      taskId: TASK,
      dispatchId: 'dispatch-1',
      rawText: 'raw report text',
      url: null,
      returnedIdentity: null,
      headSha: null,
      verificationNotes: '',
      limitations: '',
      provenance: 'owner-pasted',
      recordedAt: '2026-09-08T01:00:00.000Z',
      newId: () => 'report-fresh-id',
    });

    await expect(
      new WorkOrderLocalStore(settings).appendReportDurable(reportParams()),
    ).rejects.toThrow(WorkOrderDomainError);
    const restarted = new WorkOrderLocalStore(settings);
    const { report, recoveredOriginal } = await restarted.appendReportDurable(reportParams());
    expect(report.id).toBe('report-fresh-id');
    expect(recoveredOriginal).toBeNull();
    expect(await restarted.listReportsForDispatch(OWNER, 'dispatch-1')).toHaveLength(1);
    expect(await restarted.getPendingReportAttempt(OWNER, 'dispatch-1')).toBeNull();
  });

  it('report: editing the returned text after a partial failure recovers the original report, then attaches the edit as a second, distinct report under the same dispatch', async () => {
    const settings = createControlledLocalSettings();
    const store = new WorkOrderLocalStore(settings);
    await store.appendDispatch(makeSnapshot());
    settings.failWritesMatching((key) => key === `hammond.workOrders.reportIndex.${OWNER}`, {
      count: 1,
    });

    await expect(
      store.appendReportDurable({
        ownerId: OWNER,
        projectId: PROJECT,
        taskId: TASK,
        dispatchId: 'dispatch-1',
        rawText: 'first attempt text',
        url: null,
        returnedIdentity: null,
        headSha: null,
        verificationNotes: '',
        limitations: '',
        provenance: 'owner-pasted',
        recordedAt: '2026-09-08T01:00:00.000Z',
        newId: () => 'report-original-id',
      }),
    ).rejects.toThrow(WorkOrderDomainError);

    const { report, recoveredOriginal } = await store.appendReportDurable({
      ownerId: OWNER,
      projectId: PROJECT,
      taskId: TASK,
      dispatchId: 'dispatch-1',
      rawText: 'edited text after failure',
      url: null,
      returnedIdentity: null,
      headSha: null,
      verificationNotes: '',
      limitations: '',
      provenance: 'owner-pasted',
      recordedAt: '2026-09-08T01:05:00.000Z',
      newId: () => 'report-edited-id',
    });

    expect(recoveredOriginal).toMatchObject({
      id: 'report-original-id',
      rawText: 'first attempt text',
    });
    expect(report).toMatchObject({ id: 'report-edited-id', rawText: 'edited text after failure' });
    const reports = await store.listReportsForDispatch(OWNER, 'dispatch-1');
    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.rawText).sort()).toEqual([
      'edited text after failure',
      'first attempt text',
    ]);
  });

  it('report: two different dispatches under the same task keep independent pending report attempts — a report attempt for one dispatch never attaches to the other', async () => {
    const settings = createControlledLocalSettings();
    const store = new WorkOrderLocalStore(settings);
    await store.appendDispatch(makeSnapshot({ id: 'dispatch-a' }));
    await store.appendDispatch(makeSnapshot({ id: 'dispatch-b' }));
    settings.failWritesMatching((key) => key === `hammond.workOrders.reportIndex.${OWNER}`, {
      count: 1,
    });

    await expect(
      store.appendReportDurable({
        ownerId: OWNER,
        projectId: PROJECT,
        taskId: TASK,
        dispatchId: 'dispatch-a',
        rawText: 'report for dispatch A',
        url: null,
        returnedIdentity: null,
        headSha: null,
        verificationNotes: '',
        limitations: '',
        provenance: 'owner-pasted',
        recordedAt: '2026-09-08T01:00:00.000Z',
        newId: () => 'report-a-id',
      }),
    ).rejects.toThrow(WorkOrderDomainError);

    // A fresh report attempt for the OTHER dispatch succeeds outright and never touches dispatch
    // A's still-pending attempt.
    const resultB = await store.appendReportDurable({
      ownerId: OWNER,
      projectId: PROJECT,
      taskId: TASK,
      dispatchId: 'dispatch-b',
      rawText: 'report for dispatch B',
      url: null,
      returnedIdentity: null,
      headSha: null,
      verificationNotes: '',
      limitations: '',
      provenance: 'owner-pasted',
      recordedAt: '2026-09-08T01:00:00.000Z',
      newId: () => 'report-b-id',
    });
    expect(resultB.recoveredOriginal).toBeNull();
    expect(await store.getPendingReportAttempt(OWNER, 'dispatch-a')).toMatchObject({
      id: 'report-a-id',
    });
    expect(await store.listReportsForDispatch(OWNER, 'dispatch-a')).toEqual([]);
    expect(await store.listReportsForDispatch(OWNER, 'dispatch-b')).toHaveLength(1);
  });
});

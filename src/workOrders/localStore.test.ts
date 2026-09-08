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

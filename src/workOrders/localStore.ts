import type { LocalSettingsStore } from '../api/contracts';
import { WorkOrderDomainError } from './errors';
import type {
  WorkOrderDispatchSnapshot,
  WorkOrderIndexEntry,
  WorkOrderReportIndexEntry,
  WorkOrderReportRecord,
  WorkOrderStage,
} from './types';

function indexKey(ownerId: string): string {
  return `hammond.workOrders.index.${ownerId}`;
}

function reportIndexKey(ownerId: string): string {
  return `hammond.workOrders.reportIndex.${ownerId}`;
}

function dispatchKey(ownerId: string, id: string): string {
  return `hammond.workOrders.dispatch.${ownerId}.${id}`;
}

function reportKey(ownerId: string, id: string): string {
  return `hammond.workOrders.report.${ownerId}.${id}`;
}

function draftKey(
  ownerId: string,
  projectId: string,
  taskId: string,
  stage: WorkOrderStage,
): string {
  return `hammond.workOrders.draft.${ownerId}.${projectId}.${taskId}.${stage}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Compares two dispatch snapshots ignoring `createdAt`, so a retry that reuses the same id and
 * content is recognized as the same attempt even though its timestamp was captured independently
 * on each attempt. */
function dispatchContentEqual(a: WorkOrderDispatchSnapshot, b: WorkOrderDispatchSnapshot): boolean {
  return deepEqual({ ...a, createdAt: null }, { ...b, createdAt: null });
}

function reportContentEqual(a: WorkOrderReportRecord, b: WorkOrderReportRecord): boolean {
  return deepEqual({ ...a, recordedAt: null }, { ...b, recordedAt: null });
}

/**
 * Device-local, verbatim persistence for work-order drafts, dispatch snapshots, and report
 * records. Never touches Supabase — this is the durable owner-scoped local store that keeps the
 * exact packet/report text, which may contain absolute local paths, entirely off the cloud.
 * Dispatches and reports are append-only: `appendDispatch`/`appendReport` refuse to overwrite an
 * existing id with different content (idempotent when the retried content is identical, so a
 * double click or a retry after a partial failure never creates a duplicate or silently mutates
 * history). Writes for one owner are serialized so a concurrent index read-modify-write can never
 * race and drop an entry.
 */
export class WorkOrderLocalStore {
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(private readonly settings: LocalSettingsStore) {}

  private enqueue<T>(ownerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.writeChains.get(ownerId) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.writeChains.set(
      ownerId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** Runs a document/index write for `appendDispatch`/`appendReport`, converting a raw storage
   * failure into a typed `persistence_failed` domain error so callers (and the UI's pending-id
   * recovery, which keys off `WorkOrderDomainError.code`) can tell a truthful storage failure
   * apart from an `immutable_conflict`, instead of a bare driver/adapter error leaking through. */
  private async persist<T>(action: () => Promise<T>, message: string): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof WorkOrderDomainError) throw error;
      throw new WorkOrderDomainError('persistence_failed', message, { cause: error });
    }
  }

  async readDraft<T>(params: {
    ownerId: string;
    projectId: string;
    taskId: string;
    stage: WorkOrderStage;
  }): Promise<T | null> {
    return this.settings.read<T>(
      draftKey(params.ownerId, params.projectId, params.taskId, params.stage),
    );
  }

  async writeDraft<T>(params: {
    ownerId: string;
    projectId: string;
    taskId: string;
    stage: WorkOrderStage;
    value: T;
  }): Promise<void> {
    return this.settings.write(
      draftKey(params.ownerId, params.projectId, params.taskId, params.stage),
      params.value,
    );
  }

  async clearDraft(params: {
    ownerId: string;
    projectId: string;
    taskId: string;
    stage: WorkOrderStage;
  }): Promise<void> {
    return this.settings.remove(
      draftKey(params.ownerId, params.projectId, params.taskId, params.stage),
    );
  }

  async listDispatchIndex(ownerId: string): Promise<WorkOrderIndexEntry[]> {
    return (await this.settings.read<WorkOrderIndexEntry[]>(indexKey(ownerId))) ?? [];
  }

  async getDispatch(ownerId: string, id: string): Promise<WorkOrderDispatchSnapshot | null> {
    return this.settings.read<WorkOrderDispatchSnapshot>(dispatchKey(ownerId, id));
  }

  async listDispatchesForTask(
    ownerId: string,
    taskId: string,
  ): Promise<WorkOrderDispatchSnapshot[]> {
    const index = await this.listDispatchIndex(ownerId);
    const matching = index
      .filter((entry) => entry.taskId === taskId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const snapshots = await Promise.all(
      matching.map((entry) => this.getDispatch(ownerId, entry.id)),
    );
    return snapshots.filter((snapshot): snapshot is WorkOrderDispatchSnapshot => snapshot !== null);
  }

  /** Writes the dispatch index entry for `snapshot` if one is not already present — repairs a
   * prior attempt that saved the document but failed the index write, without ever duplicating an
   * entry. Never called for a rejected (different-content) write, so a genuine conflict never
   * touches the index. */
  private async ensureDispatchIndexEntry(snapshot: WorkOrderDispatchSnapshot): Promise<void> {
    const index = await this.listDispatchIndex(snapshot.ownerId);
    if (index.some((entry) => entry.id === snapshot.id)) return;
    const entry: WorkOrderIndexEntry = {
      id: snapshot.id,
      projectId: snapshot.projectId,
      taskId: snapshot.taskId,
      stage: snapshot.stage,
      createdAt: snapshot.createdAt,
    };
    await this.persist(
      () => this.settings.write(indexKey(snapshot.ownerId), [...index, entry]),
      `Dispatch ${snapshot.id} was saved but could not be recorded in the history index. Retry to repair it.`,
    );
  }

  /**
   * Appends an immutable dispatch snapshot. Idempotent for an exact retry of the same id+content;
   * throws `immutable_conflict` if the same id is ever submitted with different content.
   *
   * The document write and the index write are two separate `settings.write` calls, so a failure
   * between them (document saved, index not) is possible. Rather than leaving that a permanent
   * orphan — discoverable by `getDispatch` but invisible to history/originalWorker lookups — every
   * call (including the idempotent same-content retry) ensures the index entry exists before
   * reporting success. A retry that fails only the index write again still throws, so the caller
   * never sees a false success; a retry that reaches the index write cleanly repairs it in place.
   */
  async appendDispatch(snapshot: WorkOrderDispatchSnapshot): Promise<WorkOrderDispatchSnapshot> {
    return this.enqueue(snapshot.ownerId, async () => {
      const existing = await this.getDispatch(snapshot.ownerId, snapshot.id);
      if (existing) {
        if (!dispatchContentEqual(existing, snapshot)) {
          throw new WorkOrderDomainError(
            'immutable_conflict',
            `Dispatch ${snapshot.id} is already recorded with different content and cannot be overwritten.`,
          );
        }
        await this.ensureDispatchIndexEntry(existing);
        return existing;
      }
      await this.persist(
        () => this.settings.write(dispatchKey(snapshot.ownerId, snapshot.id), snapshot),
        `Failed to save dispatch ${snapshot.id}.`,
      );
      await this.ensureDispatchIndexEntry(snapshot);
      return snapshot;
    });
  }

  async listReportIndex(ownerId: string): Promise<WorkOrderReportIndexEntry[]> {
    return (await this.settings.read<WorkOrderReportIndexEntry[]>(reportIndexKey(ownerId))) ?? [];
  }

  async getReport(ownerId: string, id: string): Promise<WorkOrderReportRecord | null> {
    return this.settings.read<WorkOrderReportRecord>(reportKey(ownerId, id));
  }

  async listReportsForDispatch(
    ownerId: string,
    dispatchId: string,
  ): Promise<WorkOrderReportRecord[]> {
    const index = await this.listReportIndex(ownerId);
    const matching = index
      .filter((entry) => entry.dispatchId === dispatchId)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    const reports = await Promise.all(matching.map((entry) => this.getReport(ownerId, entry.id)));
    return reports.filter((report): report is WorkOrderReportRecord => report !== null);
  }

  async listReportsForTask(ownerId: string, taskId: string): Promise<WorkOrderReportRecord[]> {
    const index = await this.listReportIndex(ownerId);
    const matching = index
      .filter((entry) => entry.taskId === taskId)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    const reports = await Promise.all(matching.map((entry) => this.getReport(ownerId, entry.id)));
    return reports.filter((report): report is WorkOrderReportRecord => report !== null);
  }

  /** Writes the report index entry for `report` if one is not already present — repairs a prior
   * attempt that saved the record but failed the index write, without ever duplicating an entry. */
  private async ensureReportIndexEntry(report: WorkOrderReportRecord): Promise<void> {
    const index = await this.listReportIndex(report.ownerId);
    if (index.some((entry) => entry.id === report.id)) return;
    const entry: WorkOrderReportIndexEntry = {
      id: report.id,
      dispatchId: report.dispatchId,
      projectId: report.projectId,
      taskId: report.taskId,
      recordedAt: report.recordedAt,
    };
    await this.persist(
      () => this.settings.write(reportIndexKey(report.ownerId), [...index, entry]),
      `Report ${report.id} was saved but could not be recorded in the report index. Retry to repair it.`,
    );
  }

  /**
   * Appends an immutable report record. Idempotent for an exact retry of the same id+content;
   * throws `immutable_conflict` if the same id is ever submitted with different content. Same
   * document-then-index repair as `appendDispatch` — see there for why.
   */
  async appendReport(report: WorkOrderReportRecord): Promise<WorkOrderReportRecord> {
    return this.enqueue(report.ownerId, async () => {
      const existing = await this.getReport(report.ownerId, report.id);
      if (existing) {
        if (!reportContentEqual(existing, report)) {
          throw new WorkOrderDomainError(
            'immutable_conflict',
            `Report ${report.id} is already recorded with different content and cannot be overwritten.`,
          );
        }
        await this.ensureReportIndexEntry(existing);
        return existing;
      }
      await this.persist(
        () => this.settings.write(reportKey(report.ownerId, report.id), report),
        `Failed to save report ${report.id}.`,
      );
      await this.ensureReportIndexEntry(report);
      return report;
    });
  }
}

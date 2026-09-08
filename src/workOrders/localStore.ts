import type { LocalSettingsStore } from '../api/contracts';
import { WorkOrderDomainError } from './errors';
import type {
  WorkOrderDispatchSnapshot,
  WorkOrderIndexEntry,
  WorkOrderPendingDispatchAttempt,
  WorkOrderPendingReportAttempt,
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

/** Scoped by owner/project/task/stage — the same tuple the draft uses — because a dispatch attempt
 * is a property of "what the owner is currently preparing for this stage of this task", not of any
 * single generated id. At most one pending dispatch attempt exists per scope at a time. */
function pendingDispatchKey(
  ownerId: string,
  projectId: string,
  taskId: string,
  stage: WorkOrderStage,
): string {
  return `hammond.workOrders.pendingDispatch.${ownerId}.${projectId}.${taskId}.${stage}`;
}

/** Scoped by the report's fixed `dispatchId` target — never by whichever dispatch the UI currently
 * has selected — so a report recovery always reattaches to the same dispatch it was originally
 * being attached to. */
function pendingReportKey(ownerId: string, dispatchId: string): string {
  return `hammond.workOrders.pendingReport.${ownerId}.${dispatchId}`;
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

/** Whether a pending dispatch attempt was submitted with the exact same packet+content that is
 * being submitted now — an unedited retry (double click, or a resubmission after navigation/
 * restart with nothing changed) rather than an edit of an earlier partial attempt. */
function pendingDispatchMatches(
  pending: WorkOrderPendingDispatchAttempt,
  submission: { packet: WorkOrderDispatchSnapshot['packet']; content: string },
): boolean {
  return pending.content === submission.content && deepEqual(pending.packet, submission.packet);
}

function pendingReportMatches(
  pending: WorkOrderPendingReportAttempt,
  submission: {
    rawText: string;
    url: string | null;
    returnedIdentity: WorkOrderReportRecord['returnedIdentity'];
    headSha: string | null;
    verificationNotes: string;
    limitations: string;
    provenance: string;
  },
): boolean {
  return (
    pending.rawText === submission.rawText &&
    pending.url === submission.url &&
    deepEqual(pending.returnedIdentity, submission.returnedIdentity) &&
    pending.headSha === submission.headSha &&
    pending.verificationNotes === submission.verificationNotes &&
    pending.limitations === submission.limitations &&
    pending.provenance === submission.provenance
  );
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
 *
 * `appendDispatchDurable`/`appendReportDurable` (HAM3-009 Correction 2) additionally persist a
 * *pending attempt* record — the stable id plus the exact submitted packet/content — before ever
 * writing the document, so an attempt survives navigation, remount, or a process restart and is
 * recoverable from scope alone (no id held only in memory). This is prospective only: it covers
 * every attempt made from this version forward. `LocalSettingsStore` exposes no key-enumeration
 * primitive (`read`/`write`/`remove` by exact key only — see `../api/contracts.ts`), so there is no
 * way to scan for a dispatch/report document that was already orphaned by a version of this code
 * that predates the pending-attempt record (i.e. saved-but-unindexed under the original Correction
 * 1 fix, with no pending record ever written because the concept did not exist yet). Any such
 * pre-existing orphan's id was never retained anywhere durable once its originating in-memory ref
 * was dropped, so it is not migrated or reconciled here — there is nothing to migrate from. This
 * gap is disclosed, not silently promised away.
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
    return this.enqueue(snapshot.ownerId, () => this.appendDispatchLocked(snapshot));
  }

  /** The body of `appendDispatch`, without its own `enqueue` — callers that are already running
   * inside this owner's write chain (namely `appendDispatchDurable`) call this directly, since
   * nesting `enqueue` calls for the same owner would deadlock (the inner call would wait on the
   * very outer task that is calling it). */
  private async appendDispatchLocked(
    snapshot: WorkOrderDispatchSnapshot,
  ): Promise<WorkOrderDispatchSnapshot> {
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
  }

  async getPendingDispatchAttempt(
    ownerId: string,
    projectId: string,
    taskId: string,
    stage: WorkOrderStage,
  ): Promise<WorkOrderPendingDispatchAttempt | null> {
    return this.settings.read<WorkOrderPendingDispatchAttempt>(
      pendingDispatchKey(ownerId, projectId, taskId, stage),
    );
  }

  private async setPendingDispatchAttempt(attempt: WorkOrderPendingDispatchAttempt): Promise<void> {
    await this.persist(
      () =>
        this.settings.write(
          pendingDispatchKey(attempt.ownerId, attempt.projectId, attempt.taskId, attempt.stage),
          attempt,
        ),
      `Could not durably record attempt ${attempt.id} before saving it — nothing was written. Retry.`,
    );
  }

  private async clearPendingDispatchAttempt(
    ownerId: string,
    projectId: string,
    taskId: string,
    stage: WorkOrderStage,
  ): Promise<void> {
    await this.settings.remove(pendingDispatchKey(ownerId, projectId, taskId, stage));
  }

  /**
   * The durable-recovery entry point for recording a dispatch: unlike `appendDispatch` (which
   * requires the caller to already hold a stable id), this derives and durably persists the
   * attempt's own identity, so a UI/service recreated after a stage switch, task switch, remount,
   * or process restart discovers the same in-flight attempt from `ownerId`/`projectId`/`taskId`/
   * `stage` alone — no id supplied by the caller, no hidden UUID an owner would ever need to know.
   *
   * Recovery model — at most one pending attempt is tracked per (owner, project, task, stage):
   *  - No pending attempt on record → a new attempt. A fresh id is minted and the attempt (id +
   *    exact packet + exact content) is durably recorded as pending *before* the document is ever
   *    written; if that write fails, this call fails truthfully and no untracked document is ever
   *    created. Once the document and its index entry are consistent, the pending record is
   *    cleared.
   *  - A pending attempt exists with identical packet+content → an unedited retry (double click,
   *    or resubmission after navigation/restart with nothing changed). The same id is reused,
   *    which lets `appendDispatch`'s own idempotent repair recover a document that was saved but
   *    never indexed.
   *  - A pending attempt exists with *different* content → the packet was edited since an earlier
   *    partial failure. The original attempt is recovered first, under its own id and exact
   *    original bytes/timestamp (never deleted, never reused for the new content, never
   *    re-validated — it was already accepted); its pending record is cleared only once that
   *    fully succeeds. Only then is the edited content recorded as a new, distinct attempt under a
   *    fresh id. If recovering the original fails again, the edited content is never attempted —
   *    the caller sees a truthful error, the original pending record is untouched for a later
   *    retry, and the edited draft (persisted separately by the caller) is not lost.
   */
  async appendDispatchDurable(params: {
    ownerId: string;
    projectId: string;
    taskId: string;
    stage: WorkOrderStage;
    packet: WorkOrderDispatchSnapshot['packet'];
    content: string;
    createdAt: string;
    newId: () => string;
  }): Promise<{
    snapshot: WorkOrderDispatchSnapshot;
    recoveredOriginal: WorkOrderDispatchSnapshot | null;
  }> {
    return this.enqueue(params.ownerId, async () => {
      const pending = await this.getPendingDispatchAttempt(
        params.ownerId,
        params.projectId,
        params.taskId,
        params.stage,
      );
      let recoveredOriginal: WorkOrderDispatchSnapshot | null = null;

      if (pending && !pendingDispatchMatches(pending, params)) {
        const original: WorkOrderDispatchSnapshot = {
          id: pending.id,
          ownerId: pending.ownerId,
          projectId: pending.projectId,
          taskId: pending.taskId,
          stage: pending.stage,
          content: pending.content,
          packet: pending.packet,
          createdAt: pending.createdAt,
        };
        recoveredOriginal = await this.appendDispatchLocked(original);
        await this.clearPendingDispatchAttempt(
          params.ownerId,
          params.projectId,
          params.taskId,
          params.stage,
        );
      }

      const reuse = pending !== null && pendingDispatchMatches(pending, params);
      const id = reuse ? pending!.id : params.newId();
      const createdAt = reuse ? pending!.createdAt : params.createdAt;
      const snapshot: WorkOrderDispatchSnapshot = {
        id,
        ownerId: params.ownerId,
        projectId: params.projectId,
        taskId: params.taskId,
        stage: params.stage,
        content: params.content,
        packet: params.packet,
        createdAt,
      };
      if (!reuse) {
        await this.setPendingDispatchAttempt({
          id,
          ownerId: params.ownerId,
          projectId: params.projectId,
          taskId: params.taskId,
          stage: params.stage,
          packet: params.packet,
          content: params.content,
          createdAt,
        });
      }
      const recorded = await this.appendDispatchLocked(snapshot);
      await this.clearPendingDispatchAttempt(
        params.ownerId,
        params.projectId,
        params.taskId,
        params.stage,
      );
      return { snapshot: recorded, recoveredOriginal };
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
    return this.enqueue(report.ownerId, () => this.appendReportLocked(report));
  }

  /** The body of `appendReport`, without its own `enqueue` — see `appendDispatchLocked` for why
   * this split exists (avoids a nested-enqueue deadlock from `appendReportDurable`). */
  private async appendReportLocked(report: WorkOrderReportRecord): Promise<WorkOrderReportRecord> {
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
  }

  async getPendingReportAttempt(
    ownerId: string,
    dispatchId: string,
  ): Promise<WorkOrderPendingReportAttempt | null> {
    return this.settings.read<WorkOrderPendingReportAttempt>(pendingReportKey(ownerId, dispatchId));
  }

  private async setPendingReportAttempt(attempt: WorkOrderPendingReportAttempt): Promise<void> {
    await this.persist(
      () => this.settings.write(pendingReportKey(attempt.ownerId, attempt.dispatchId), attempt),
      `Could not durably record report attempt ${attempt.id} before saving it — nothing was written. Retry.`,
    );
  }

  private async clearPendingReportAttempt(ownerId: string, dispatchId: string): Promise<void> {
    await this.settings.remove(pendingReportKey(ownerId, dispatchId));
  }

  /**
   * The report equivalent of `appendDispatchDurable` — see there for the full recovery model.
   * Scoped by the report's fixed `dispatchId`, so a stage change, task switch, or a *different*
   * dispatch's report attempt never interferes with recovering this one.
   */
  async appendReportDurable(params: {
    ownerId: string;
    projectId: string;
    taskId: string;
    dispatchId: string;
    rawText: string;
    url: string | null;
    returnedIdentity: WorkOrderReportRecord['returnedIdentity'];
    headSha: string | null;
    verificationNotes: string;
    limitations: string;
    provenance: string;
    recordedAt: string;
    newId: () => string;
  }): Promise<{ report: WorkOrderReportRecord; recoveredOriginal: WorkOrderReportRecord | null }> {
    return this.enqueue(params.ownerId, async () => {
      const pending = await this.getPendingReportAttempt(params.ownerId, params.dispatchId);
      let recoveredOriginal: WorkOrderReportRecord | null = null;

      if (pending && !pendingReportMatches(pending, params)) {
        const original: WorkOrderReportRecord = {
          id: pending.id,
          ownerId: pending.ownerId,
          projectId: pending.projectId,
          taskId: pending.taskId,
          dispatchId: pending.dispatchId,
          rawText: pending.rawText,
          url: pending.url,
          returnedIdentity: pending.returnedIdentity,
          headSha: pending.headSha,
          verificationNotes: pending.verificationNotes,
          limitations: pending.limitations,
          provenance: pending.provenance,
          recordedAt: pending.recordedAt,
        };
        recoveredOriginal = await this.appendReportLocked(original);
        await this.clearPendingReportAttempt(params.ownerId, params.dispatchId);
      }

      const reuse = pending !== null && pendingReportMatches(pending, params);
      const id = reuse ? pending!.id : params.newId();
      const recordedAt = reuse ? pending!.recordedAt : params.recordedAt;
      const report: WorkOrderReportRecord = {
        id,
        ownerId: params.ownerId,
        projectId: params.projectId,
        taskId: params.taskId,
        dispatchId: params.dispatchId,
        rawText: params.rawText,
        url: params.url,
        returnedIdentity: params.returnedIdentity,
        headSha: params.headSha,
        verificationNotes: params.verificationNotes,
        limitations: params.limitations,
        provenance: params.provenance,
        recordedAt,
      };
      if (!reuse) {
        await this.setPendingReportAttempt({
          id,
          ownerId: params.ownerId,
          projectId: params.projectId,
          taskId: params.taskId,
          dispatchId: params.dispatchId,
          rawText: params.rawText,
          url: params.url,
          returnedIdentity: params.returnedIdentity,
          headSha: params.headSha,
          verificationNotes: params.verificationNotes,
          limitations: params.limitations,
          provenance: params.provenance,
          recordedAt,
        });
      }
      const recorded = await this.appendReportLocked(report);
      await this.clearPendingReportAttempt(params.ownerId, params.dispatchId);
      return { report: recorded, recoveredOriginal };
    });
  }
}

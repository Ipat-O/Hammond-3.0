import type { AssignmentsService } from '../assignments/service';
import type { InstructionsService } from '../instructions/service';
import type { InstructionRole, ProviderFamily } from '../instructions/types';
import { WorkOrderDomainError } from './errors';
import { seedIdentityFromProviderFamily } from './identity';
import type {
  WorkOrderInjectionService,
  WorkOrderInjectOutcome,
  WorkOrderRemoveOutcome,
} from './injection';
import { WorkOrderLocalStore } from './localStore';
import { generateAuditPacket, generateCorrectionPacket, generateWorkerPacket } from './generation';
import type {
  AuditPacketFields,
  CorrectionPacketFields,
  ParticipantIdentity,
  ReturnedIdentity,
  WorkerPacketFields,
  WorkOrderDispatchSnapshot,
  WorkOrderFields,
  WorkOrderReportRecord,
  WorkOrderStage,
} from './types';
import {
  emptyAuditFields,
  emptyCorrectionFields,
  emptyEvidenceReference,
  emptyWorkerFields,
} from './types';
import {
  isExactFullSha,
  validateAuditFields,
  validateCorrectionFields,
  validateWorkerFields,
  type ValidationResult,
} from './validation';

let idCounter = 0;

/** A fresh idempotency key: generated once per user attempt (Record click, report attach), then
 * reused across retries so a retried write is recognized as the same attempt rather than a new
 * one. Prefers `crypto.randomUUID()`; falls back to a counter for environments without it. */
export function createWorkOrderId(): string {
  const cryptoObj = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  idCounter += 1;
  return `wo-${Date.now()}-${idCounter}`;
}

export interface WorkOrdersServiceDeps {
  localStore: WorkOrderLocalStore;
  injection: WorkOrderInjectionService;
  assignments: AssignmentsService;
  instructions: InstructionsService;
  /** Injectable for tests; defaults to `new Date().toISOString()`. */
  now?: () => string;
}

/**
 * Orchestrates the work-orders domain: prefilling packet fields from the project's current
 * role/provider assignments and active instruction versions, validating and generating packet
 * text, recording immutable dispatch snapshots and append-only report records through
 * `WorkOrderLocalStore`, and offering optional local-directory injection through
 * `WorkOrderInjectionService`. Every fallible mutation here is a plain async orchestration over
 * injected ports, so it is exercisable with in-memory fakes — no Supabase, filesystem, or React
 * involved.
 */
export class WorkOrdersService {
  private readonly localStore: WorkOrderLocalStore;
  private readonly injection: WorkOrderInjectionService;
  private readonly assignments: AssignmentsService;
  private readonly instructions: InstructionsService;
  private readonly now: () => string;

  constructor(deps: WorkOrdersServiceDeps) {
    this.localStore = deps.localStore;
    this.injection = deps.injection;
    this.assignments = deps.assignments;
    this.instructions = deps.instructions;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  // ---- Drafts (mutable scratch state, auto-persisted so navigation/errors never lose typing) ----

  async readDraft(params: {
    ownerId: string;
    projectId: string;
    taskId: string;
    stage: WorkOrderStage;
  }): Promise<WorkOrderFields | null> {
    return this.localStore.readDraft<WorkOrderFields>(params);
  }

  async writeDraft(params: {
    ownerId: string;
    projectId: string;
    taskId: string;
    stage: WorkOrderStage;
    packet: WorkOrderFields;
  }): Promise<void> {
    return this.localStore.writeDraft({ ...params, value: params.packet });
  }

  async clearDraft(params: {
    ownerId: string;
    projectId: string;
    taskId: string;
    stage: WorkOrderStage;
  }): Promise<void> {
    return this.localStore.clearDraft(params);
  }

  // ---- History lookups ----

  async listHistory(ownerId: string, taskId: string): Promise<WorkOrderDispatchSnapshot[]> {
    return this.localStore.listDispatchesForTask(ownerId, taskId);
  }

  async getReportsForDispatch(
    ownerId: string,
    dispatchId: string,
  ): Promise<WorkOrderReportRecord[]> {
    return this.localStore.listReportsForDispatch(ownerId, dispatchId);
  }

  async getReportsForTask(ownerId: string, taskId: string): Promise<WorkOrderReportRecord[]> {
    return this.localStore.listReportsForTask(ownerId, taskId);
  }

  /** The identity of the earliest recorded Worker-stage dispatch for a task — the "original worker" a correction must return to. `null` when no Worker dispatch is on record. */
  async getOriginalWorkerIdentity(
    ownerId: string,
    taskId: string,
  ): Promise<ParticipantIdentity | null> {
    const dispatches = await this.localStore.listDispatchesForTask(ownerId, taskId);
    const workerDispatches = dispatches.filter(
      (
        dispatch,
      ): dispatch is WorkOrderDispatchSnapshot & {
        packet: { stage: 'worker'; fields: WorkerPacketFields };
      } => dispatch.stage === 'worker' && dispatch.packet.stage === 'worker',
    );
    const earliest = workerDispatches[workerDispatches.length - 1];
    return earliest ? earliest.packet.fields.assignedWorker : null;
  }

  private async latestReportForStages(
    ownerId: string,
    taskId: string,
    stages: WorkOrderStage[],
  ): Promise<WorkOrderReportRecord | null> {
    const reports = await this.localStore.listReportsForTask(ownerId, taskId);
    for (const report of reports) {
      const dispatch = await this.localStore.getDispatch(ownerId, report.dispatchId);
      if (dispatch && stages.includes(dispatch.stage)) return report;
    }
    return null;
  }

  // ---- Prefill ----

  async defaultWorkerFields(params: {
    projectId: string;
    taskId: string;
    humanOwner: string;
    repositoryPath?: string;
  }): Promise<WorkerPacketFields> {
    const fields = emptyWorkerFields();
    fields.taskId = params.taskId;
    fields.humanOwner = params.humanOwner;
    fields.coordinates.repositoryPath = params.repositoryPath ?? '';

    const [orchestratorAssignment, workerAssignment, auditorAssignment] = await Promise.all([
      this.assignments.getAssignment({ projectId: params.projectId, role: 'orchestrator' }),
      this.assignments.getAssignment({ projectId: params.projectId, role: 'worker' }),
      this.assignments.getAssignment({ projectId: params.projectId, role: 'auditor' }),
    ]);
    if (orchestratorAssignment) {
      fields.activeOrchestrator = seedIdentityFromProviderFamily(orchestratorAssignment.provider);
    }
    if (workerAssignment) {
      fields.assignedWorker = seedIdentityFromProviderFamily(workerAssignment.provider);
      fields.instructionProvenance = await this.tryResolveProvenance({
        projectId: params.projectId,
        role: 'worker',
        provider: workerAssignment.provider,
      });
    }
    if (auditorAssignment) {
      fields.assignedAuditor = seedIdentityFromProviderFamily(auditorAssignment.provider);
    }
    return fields;
  }

  async defaultCorrectionFields(params: {
    ownerId: string;
    projectId: string;
    taskId: string;
    humanOwner: string;
    repositoryPath?: string;
  }): Promise<CorrectionPacketFields> {
    const fields = emptyCorrectionFields();
    fields.taskId = params.taskId;
    fields.humanOwner = params.humanOwner;
    fields.coordinates.repositoryPath = params.repositoryPath ?? '';

    const [
      dispatches,
      orchestratorAssignment,
      workerAssignment,
      auditorAssignment,
      originalWorker,
    ] = await Promise.all([
      this.localStore.listDispatchesForTask(params.ownerId, params.taskId),
      this.assignments.getAssignment({ projectId: params.projectId, role: 'orchestrator' }),
      this.assignments.getAssignment({ projectId: params.projectId, role: 'worker' }),
      this.assignments.getAssignment({ projectId: params.projectId, role: 'auditor' }),
      this.getOriginalWorkerIdentity(params.ownerId, params.taskId),
    ]);

    fields.correctionNumber =
      dispatches.filter((dispatch) => dispatch.stage === 'correction').length + 1;
    if (orchestratorAssignment) {
      fields.activeOrchestrator = seedIdentityFromProviderFamily(orchestratorAssignment.provider);
    }
    fields.assignedWorker =
      originalWorker ??
      (workerAssignment
        ? seedIdentityFromProviderFamily(workerAssignment.provider)
        : fields.assignedWorker);
    if (auditorAssignment) {
      fields.assignedReauditor = seedIdentityFromProviderFamily(auditorAssignment.provider);
    }
    if (workerAssignment) {
      fields.instructionProvenance = await this.tryResolveProvenance({
        projectId: params.projectId,
        role: 'worker',
        provider: workerAssignment.provider,
      });
    }

    const priorAuditReport = await this.latestReportForStages(params.ownerId, params.taskId, [
      'audit',
    ]);
    if (priorAuditReport) {
      fields.auditReportReference = priorAuditReport.url
        ? { kind: 'url', url: priorAuditReport.url, provenance: priorAuditReport.provenance }
        : {
            kind: 'pasted_text',
            text: priorAuditReport.rawText,
            provenance: priorAuditReport.provenance,
          };
    }
    const priorWorkerReport = await this.latestReportForStages(params.ownerId, params.taskId, [
      'worker',
      'correction',
    ]);
    fields.previousHeadSha = priorWorkerReport?.headSha ?? '';

    return fields;
  }

  async defaultAuditFields(params: {
    ownerId: string;
    projectId: string;
    taskId: string;
    humanOwner: string;
    repositoryPath?: string;
  }): Promise<AuditPacketFields> {
    const fields = emptyAuditFields();
    fields.taskId = params.taskId;
    fields.humanOwner = params.humanOwner;
    fields.repositoryPath = params.repositoryPath ?? '';

    const [orchestratorAssignment, auditorAssignment, originalWorker] = await Promise.all([
      this.assignments.getAssignment({ projectId: params.projectId, role: 'orchestrator' }),
      this.assignments.getAssignment({ projectId: params.projectId, role: 'auditor' }),
      this.getOriginalWorkerIdentity(params.ownerId, params.taskId),
    ]);
    if (orchestratorAssignment) {
      fields.activeOrchestrator = seedIdentityFromProviderFamily(orchestratorAssignment.provider);
    }
    if (originalWorker) fields.authorWorker = originalWorker;
    if (auditorAssignment) {
      fields.assignedAuditor = seedIdentityFromProviderFamily(auditorAssignment.provider);
      fields.instructionProvenance = await this.tryResolveProvenance({
        projectId: params.projectId,
        role: 'auditor',
        provider: auditorAssignment.provider,
      });
    }

    const priorWorkerReport = await this.latestReportForStages(params.ownerId, params.taskId, [
      'worker',
      'correction',
    ]);
    fields.reviewedHeadSha = priorWorkerReport?.headSha ?? '';
    if (priorWorkerReport) {
      fields.workerReportReference = priorWorkerReport.url
        ? { kind: 'url', url: priorWorkerReport.url, provenance: priorWorkerReport.provenance }
        : {
            kind: 'pasted_text',
            text: priorWorkerReport.rawText,
            provenance: priorWorkerReport.provenance,
          };
    } else {
      fields.workerReportReference = emptyEvidenceReference();
    }

    return fields;
  }

  private async tryResolveProvenance(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
  }) {
    try {
      return await this.instructions.resolveActiveVersionIds(params);
    } catch {
      return null;
    }
  }

  // ---- Validation and generation ----

  validatePacket(
    packet: WorkOrderFields,
    context: { expectedWorker?: ParticipantIdentity | null } = {},
  ): ValidationResult {
    if (packet.stage === 'worker') return validateWorkerFields(packet.fields);
    if (packet.stage === 'correction') {
      return validateCorrectionFields(packet.fields, {
        expectedWorker: context.expectedWorker ?? null,
      });
    }
    return validateAuditFields(packet.fields);
  }

  generateContent(packet: WorkOrderFields): string {
    if (packet.stage === 'worker') return generateWorkerPacket(packet.fields);
    if (packet.stage === 'correction') return generateCorrectionPacket(packet.fields);
    return generateAuditPacket(packet.fields);
  }

  // ---- Recording (immutable) ----

  /**
   * Records an immutable dispatch snapshot. `id` must be generated once per user attempt
   * (`createWorkOrderId()`) and reused across retries: a retry with the same id and same
   * generated content is idempotent (returns the original snapshot, no duplicate); a different
   * id already on record with different content is rejected rather than overwritten.
   */
  async recordDispatch(params: {
    id: string;
    ownerId: string;
    projectId: string;
    taskId: string;
    packet: WorkOrderFields;
    createdAt?: string;
    expectedWorker?: ParticipantIdentity | null;
  }): Promise<WorkOrderDispatchSnapshot> {
    const validation = this.validatePacket(params.packet, {
      expectedWorker: params.expectedWorker,
    });
    if (!validation.isValid) {
      throw new WorkOrderDomainError(
        'invalid_fields',
        `Cannot record dispatch: ${validation.errors.map((issue) => issue.message).join(' ')}`,
      );
    }
    const snapshot: WorkOrderDispatchSnapshot = {
      id: params.id,
      ownerId: params.ownerId,
      projectId: params.projectId,
      taskId: params.taskId,
      stage: params.packet.stage,
      content: this.generateContent(params.packet),
      packet: params.packet,
      createdAt: params.createdAt ?? this.now(),
    };
    return this.localStore.appendDispatch(snapshot);
  }

  /** Attaches an append-only report record to an existing dispatch. Never mutates the dispatch or any prior report; a correction's returned report is simply a new record. */
  async attachReport(params: {
    id: string;
    ownerId: string;
    projectId: string;
    taskId: string;
    dispatchId: string;
    rawText: string;
    url: string | null;
    returnedIdentity: ReturnedIdentity | null;
    headSha: string | null;
    verificationNotes: string;
    limitations: string;
    provenance: string;
    recordedAt?: string;
  }): Promise<WorkOrderReportRecord> {
    const dispatch = await this.localStore.getDispatch(params.ownerId, params.dispatchId);
    if (!dispatch) {
      throw new WorkOrderDomainError(
        'not_found',
        `Cannot attach report: dispatch ${params.dispatchId} was not found.`,
      );
    }
    if (params.rawText.trim() === '' && (params.url ?? '').trim() === '') {
      throw new WorkOrderDomainError(
        'invalid_fields',
        'A report needs the raw returned text or a URL.',
      );
    }
    if (params.headSha && !isExactFullSha(params.headSha)) {
      throw new WorkOrderDomainError(
        'invalid_fields',
        'A supplied head SHA must be the exact full 40-character SHA.',
      );
    }
    const report: WorkOrderReportRecord = {
      id: params.id,
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
      recordedAt: params.recordedAt ?? this.now(),
    };
    return this.localStore.appendReport(report);
  }

  // ---- Optional local injection ----

  async previewInjection(params: { root: string; dispatch: WorkOrderDispatchSnapshot }) {
    return this.injection.preview({
      root: params.root,
      projectId: params.dispatch.projectId,
      taskId: params.dispatch.taskId,
      dispatchId: params.dispatch.id,
      stage: params.dispatch.stage,
      content: params.dispatch.content,
    });
  }

  async injectDispatch(params: {
    root: string;
    dispatch: WorkOrderDispatchSnapshot;
    forceReplace?: boolean;
  }): Promise<WorkOrderInjectOutcome> {
    return this.injection.inject({
      root: params.root,
      projectId: params.dispatch.projectId,
      taskId: params.dispatch.taskId,
      dispatchId: params.dispatch.id,
      stage: params.dispatch.stage,
      content: params.dispatch.content,
      forceReplace: params.forceReplace,
    });
  }

  async removeInjection(params: {
    root: string;
    projectId: string;
    taskId: string;
  }): Promise<WorkOrderRemoveOutcome> {
    return this.injection.remove(params);
  }
}

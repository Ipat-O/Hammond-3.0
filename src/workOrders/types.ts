export const WORK_ORDER_STAGES = ['worker', 'correction', 'audit'] as const;
export type WorkOrderStage = (typeof WORK_ORDER_STAGES)[number];

/**
 * Free-text, owner-editable participant identity. Deliberately not the narrow
 * `codex | claude_code | kilo_code` execution-provider enum used elsewhere: `provider` here is
 * the independence-bearing organization/family (e.g. "Anthropic", "DeepSeek"), `tool` is the
 * harness/app (e.g. "Claude Code", "Kilo Code"), and `model` is the exact model. A harness like
 * Kilo Code can host different providers, so family independence is validated from this explicit
 * data, never inferred from tool-name inequality (see `identity.ts`).
 */
export interface ParticipantIdentity {
  provider: string;
  tool: string;
  model: string;
}

export function emptyIdentity(): ParticipantIdentity {
  return { provider: '', tool: '', model: '' };
}

/** An owner-supplied link, or an explicit not-available marker with a reason — never a blank/invented URL. */
export type LinkOrUnavailable =
  { kind: 'url'; url: string } | { kind: 'not_available'; reason: string };

export function unavailableLink(reason = ''): LinkOrUnavailable {
  return { kind: 'not_available', reason };
}

/** A reference to a report/evidence document the recipient needs: a URL, pasted raw text, or explicitly unavailable. */
export type EvidenceReference =
  | { kind: 'url'; url: string; provenance: string }
  | { kind: 'pasted_text'; text: string; provenance: string }
  | { kind: 'not_available'; reason: string };

export function emptyEvidenceReference(): EvidenceReference {
  return { kind: 'not_available', reason: '' };
}

export interface DeliveryCoordinates {
  repositoryPath: string;
  remoteUrl: LinkOrUnavailable;
  issueUrl: LinkOrUnavailable;
  pullRequestUrl: LinkOrUnavailable;
  baseBranch: string;
  workBranch: string;
  startSha: string;
}

export function emptyCoordinates(): DeliveryCoordinates {
  return {
    repositoryPath: '',
    remoteUrl: unavailableLink(),
    issueUrl: unavailableLink(),
    pullRequestUrl: unavailableLink(),
    baseBranch: 'dev',
    workBranch: '',
    startSha: '',
  };
}

/** The exact instruction-version ids composed for a role at prefill time — traceable provenance, not a live pointer. */
export interface InstructionProvenance {
  sharedRoleVersionId: string;
  providerVersionId: string;
  overrideVersionId: string | null;
}

export interface WorkerPacketFields {
  taskId: string;
  humanOwner: string;
  activeOrchestrator: ParticipantIdentity;
  assignedWorker: ParticipantIdentity;
  assignedAuditor: ParticipantIdentity;
  coordinates: DeliveryCoordinates;
  scope: string;
  nonScope: string;
  acceptance: string;
  verification: string;
  requiredEvidence: string;
  stopRules: string;
  instructionProvenance: InstructionProvenance | null;
}

export function emptyWorkerFields(): WorkerPacketFields {
  return {
    taskId: '',
    humanOwner: '',
    activeOrchestrator: emptyIdentity(),
    assignedWorker: emptyIdentity(),
    assignedAuditor: emptyIdentity(),
    coordinates: emptyCoordinates(),
    scope: '',
    nonScope: '',
    acceptance: '',
    verification: '',
    requiredEvidence: '',
    stopRules: '',
    instructionProvenance: null,
  };
}

export interface CorrectionPacketFields {
  taskId: string;
  correctionNumber: number;
  humanOwner: string;
  activeOrchestrator: ParticipantIdentity;
  assignedWorker: ParticipantIdentity;
  assignedReauditor: ParticipantIdentity;
  coordinates: DeliveryCoordinates;
  previousHeadSha: string;
  auditReportReference: EvidenceReference;
  requiredCorrections: string;
  expectedReturnEvidence: string;
  instructionProvenance: InstructionProvenance | null;
}

export function emptyCorrectionFields(): CorrectionPacketFields {
  return {
    taskId: '',
    correctionNumber: 1,
    humanOwner: '',
    activeOrchestrator: emptyIdentity(),
    assignedWorker: emptyIdentity(),
    assignedReauditor: emptyIdentity(),
    coordinates: emptyCoordinates(),
    previousHeadSha: '',
    auditReportReference: emptyEvidenceReference(),
    requiredCorrections: '',
    expectedReturnEvidence: '',
    instructionProvenance: null,
  };
}

export interface AuditPacketFields {
  taskId: string;
  humanOwner: string;
  activeOrchestrator: ParticipantIdentity;
  authorWorker: ParticipantIdentity;
  assignedAuditor: ParticipantIdentity;
  repositoryPath: string;
  remoteUrl: LinkOrUnavailable;
  baseBranch: string;
  baseSha: string;
  pullRequestUrl: string;
  reviewedHeadSha: string;
  workerReportReference: EvidenceReference;
  acceptance: string;
  verification: string;
  instructionProvenance: InstructionProvenance | null;
}

export function emptyAuditFields(): AuditPacketFields {
  return {
    taskId: '',
    humanOwner: '',
    activeOrchestrator: emptyIdentity(),
    authorWorker: emptyIdentity(),
    assignedAuditor: emptyIdentity(),
    repositoryPath: '',
    remoteUrl: unavailableLink(),
    baseBranch: 'dev',
    baseSha: '',
    pullRequestUrl: '',
    reviewedHeadSha: '',
    workerReportReference: emptyEvidenceReference(),
    acceptance: '',
    verification: '',
    instructionProvenance: null,
  };
}

export type WorkOrderFields =
  | { stage: 'worker'; fields: WorkerPacketFields }
  | { stage: 'correction'; fields: CorrectionPacketFields }
  | { stage: 'audit'; fields: AuditPacketFields };

/** A frozen, immutable dispatch snapshot: the exact generated text plus the structured fields that produced it. */
export interface WorkOrderDispatchSnapshot {
  id: string;
  ownerId: string;
  projectId: string;
  taskId: string;
  stage: WorkOrderStage;
  content: string;
  packet: WorkOrderFields;
  createdAt: string;
}

/** The actual identity a recipient reported back, which may be partial or mismatched from what was dispatched — never silently overwritten. */
export interface ReturnedIdentity {
  provider: string;
  tool: string;
  model: string;
}

export interface WorkOrderReportRecord {
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
  recordedAt: string;
}

export interface WorkOrderIndexEntry {
  id: string;
  projectId: string;
  taskId: string;
  stage: WorkOrderStage;
  createdAt: string;
}

export interface WorkOrderReportIndexEntry {
  id: string;
  dispatchId: string;
  projectId: string;
  taskId: string;
  recordedAt: string;
}

import { identitiesEqual, identityIsComplete, isIndependentFamily } from './identity';
import type {
  AuditPacketFields,
  CorrectionPacketFields,
  DeliveryCoordinates,
  EvidenceReference,
  LinkOrUnavailable,
  ParticipantIdentity,
  WorkerPacketFields,
} from './types';

export interface FieldIssue {
  field: string;
  message: string;
}

export interface ValidationResult {
  errors: FieldIssue[];
  isValid: boolean;
}

function result(errors: FieldIssue[]): ValidationResult {
  return { errors, isValid: errors.length === 0 };
}

const FULL_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;

export function isExactFullSha(value: string): boolean {
  return FULL_SHA_PATTERN.test(value.trim());
}

export function isSyntacticallyValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host !== '';
  } catch {
    return false;
  }
}

function requireNonBlank(field: string, value: string, errors: FieldIssue[], label = field) {
  if (value.trim() === '') errors.push({ field, message: `${label} is required.` });
}

function checkIdentity(field: string, identity: ParticipantIdentity, errors: FieldIssue[]) {
  if (identity.provider.trim() === '')
    errors.push({ field: `${field}.provider`, message: `${field} provider is required.` });
  if (identity.tool.trim() === '')
    errors.push({ field: `${field}.tool`, message: `${field} tool is required.` });
  if (identity.model.trim() === '')
    errors.push({ field: `${field}.model`, message: `${field} model is required.` });
}

function checkFullSha(field: string, value: string, errors: FieldIssue[], label = field) {
  if (value.trim() === '') {
    errors.push({ field, message: `${label} is required.` });
  } else if (!isExactFullSha(value)) {
    errors.push({
      field,
      message: `${label} must be the exact full 40-character SHA, not abbreviated.`,
    });
  }
}

function checkLink(field: string, link: LinkOrUnavailable, errors: FieldIssue[], label = field) {
  if (link.kind === 'not_available') {
    if (link.reason.trim() === '') {
      errors.push({ field, message: `${label} must give a reason when marked not available.` });
    }
    return;
  }
  if (!isSyntacticallyValidUrl(link.url)) {
    errors.push({ field, message: `${label} must be a syntactically valid URL.` });
  }
}

/** A link that MUST be a real URL — `not_available` is not accepted (audit PR link, for example). */
function checkRequiredUrl(field: string, value: string, errors: FieldIssue[], label = field) {
  if (value.trim() === '') {
    errors.push({ field, message: `${label} is required and cannot be not_available.` });
  } else if (!isSyntacticallyValidUrl(value)) {
    errors.push({ field, message: `${label} must be a syntactically valid URL.` });
  }
}

function checkRequiredEvidenceReference(
  field: string,
  reference: EvidenceReference,
  errors: FieldIssue[],
  label = field,
) {
  if (reference.kind === 'not_available') {
    errors.push({
      field,
      message: `${label} is required — provide a URL or pasted text, not not_available.`,
    });
    return;
  }
  if (reference.kind === 'url' && !isSyntacticallyValidUrl(reference.url)) {
    errors.push({ field, message: `${label} URL must be syntactically valid.` });
    return;
  }
  if (reference.kind === 'pasted_text' && reference.text.trim() === '') {
    errors.push({ field, message: `${label} pasted text cannot be empty.` });
    return;
  }
  if (reference.provenance.trim() === '') {
    errors.push({
      field: `${field}.provenance`,
      message: `${label} needs an honest provenance note.`,
    });
  }
}

function checkCoordinates(field: string, coordinates: DeliveryCoordinates, errors: FieldIssue[]) {
  requireNonBlank(`${field}.repositoryPath`, coordinates.repositoryPath, errors, 'Repository path');
  requireNonBlank(`${field}.baseBranch`, coordinates.baseBranch, errors, 'Base branch');
  requireNonBlank(`${field}.workBranch`, coordinates.workBranch, errors, 'Work branch');
  checkFullSha(`${field}.startSha`, coordinates.startSha, errors, 'Start SHA');
  checkLink(`${field}.remoteUrl`, coordinates.remoteUrl, errors, 'Remote URL');
  checkLink(`${field}.issueUrl`, coordinates.issueUrl, errors, 'Issue URL');
  checkLink(`${field}.pullRequestUrl`, coordinates.pullRequestUrl, errors, 'Pull request URL');
}

export function validateWorkerFields(fields: WorkerPacketFields): ValidationResult {
  const errors: FieldIssue[] = [];
  requireNonBlank('taskId', fields.taskId, errors, 'Task ID');
  requireNonBlank('humanOwner', fields.humanOwner, errors, 'Human owner');
  checkIdentity('activeOrchestrator', fields.activeOrchestrator, errors);
  checkIdentity('assignedWorker', fields.assignedWorker, errors);
  checkIdentity('assignedAuditor', fields.assignedAuditor, errors);
  checkCoordinates('coordinates', fields.coordinates, errors);
  requireNonBlank('scope', fields.scope, errors, 'Scope');
  requireNonBlank('nonScope', fields.nonScope, errors, 'Non-scope');
  requireNonBlank('acceptance', fields.acceptance, errors, 'Acceptance criteria');
  requireNonBlank('verification', fields.verification, errors, 'Verification');
  requireNonBlank('requiredEvidence', fields.requiredEvidence, errors, 'Required return evidence');
  requireNonBlank('stopRules', fields.stopRules, errors, 'Stop rules');

  if (
    identityIsComplete(fields.assignedWorker) &&
    identityIsComplete(fields.assignedAuditor) &&
    !isIndependentFamily(fields.assignedWorker, fields.assignedAuditor)
  ) {
    errors.push({
      field: 'assignedAuditor.provider',
      message:
        'The assigned auditor must belong to a different provider family than the assigned worker — no family audits its own work.',
    });
  }

  return result(errors);
}

export interface CorrectionValidationContext {
  /** The original worker identity this task was dispatched to, if a prior Worker dispatch was found. `null` means no prior dispatch is on record, so identity-match cannot be enforced. */
  expectedWorker: ParticipantIdentity | null;
}

export function validateCorrectionFields(
  fields: CorrectionPacketFields,
  context: CorrectionValidationContext,
): ValidationResult {
  const errors: FieldIssue[] = [];
  requireNonBlank('taskId', fields.taskId, errors, 'Task ID');
  if (!Number.isInteger(fields.correctionNumber) || fields.correctionNumber < 1) {
    errors.push({
      field: 'correctionNumber',
      message: 'Correction number must be a positive integer.',
    });
  }
  requireNonBlank('humanOwner', fields.humanOwner, errors, 'Human owner');
  checkIdentity('activeOrchestrator', fields.activeOrchestrator, errors);
  checkIdentity('assignedWorker', fields.assignedWorker, errors);
  checkIdentity('assignedReauditor', fields.assignedReauditor, errors);
  checkCoordinates('coordinates', fields.coordinates, errors);
  checkFullSha('previousHeadSha', fields.previousHeadSha, errors, 'Previous head SHA');
  checkRequiredEvidenceReference(
    'auditReportReference',
    fields.auditReportReference,
    errors,
    'Audit report reference',
  );
  requireNonBlank(
    'requiredCorrections',
    fields.requiredCorrections,
    errors,
    'Required corrections',
  );
  requireNonBlank(
    'expectedReturnEvidence',
    fields.expectedReturnEvidence,
    errors,
    'Expected return evidence',
  );

  if (
    context.expectedWorker &&
    identityIsComplete(fields.assignedWorker) &&
    !identitiesEqual(fields.assignedWorker, context.expectedWorker)
  ) {
    errors.push({
      field: 'assignedWorker',
      message:
        'A correction must return to the original worker — this identity does not match the prior dispatch.',
    });
  }

  if (
    identityIsComplete(fields.assignedWorker) &&
    identityIsComplete(fields.assignedReauditor) &&
    !isIndependentFamily(fields.assignedWorker, fields.assignedReauditor)
  ) {
    errors.push({
      field: 'assignedReauditor.provider',
      message: 'The re-auditor must belong to a different provider family than the worker.',
    });
  }

  return result(errors);
}

export function validateAuditFields(fields: AuditPacketFields): ValidationResult {
  const errors: FieldIssue[] = [];
  requireNonBlank('taskId', fields.taskId, errors, 'Task ID');
  requireNonBlank('humanOwner', fields.humanOwner, errors, 'Human owner');
  checkIdentity('activeOrchestrator', fields.activeOrchestrator, errors);
  checkIdentity('authorWorker', fields.authorWorker, errors);
  checkIdentity('assignedAuditor', fields.assignedAuditor, errors);
  requireNonBlank('repositoryPath', fields.repositoryPath, errors, 'Repository path');
  checkLink('remoteUrl', fields.remoteUrl, errors, 'Remote URL');
  requireNonBlank('baseBranch', fields.baseBranch, errors, 'Base branch');
  checkFullSha('baseSha', fields.baseSha, errors, 'Base SHA');
  checkRequiredUrl('pullRequestUrl', fields.pullRequestUrl, errors, 'Pull request URL');
  checkFullSha('reviewedHeadSha', fields.reviewedHeadSha, errors, 'Reviewed head SHA');
  checkRequiredEvidenceReference(
    'workerReportReference',
    fields.workerReportReference,
    errors,
    'Worker report reference',
  );
  requireNonBlank('acceptance', fields.acceptance, errors, 'Acceptance criteria');
  requireNonBlank('verification', fields.verification, errors, 'Verification');

  if (
    identityIsComplete(fields.authorWorker) &&
    identityIsComplete(fields.assignedAuditor) &&
    !isIndependentFamily(fields.authorWorker, fields.assignedAuditor)
  ) {
    errors.push({
      field: 'assignedAuditor.provider',
      message:
        'The assigned auditor must belong to a different provider family than the author worker — no family audits its own work.',
    });
  }

  return result(errors);
}

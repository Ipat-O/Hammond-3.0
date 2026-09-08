import type {
  AuditPacketFields,
  CorrectionPacketFields,
  DeliveryCoordinates,
  EvidenceReference,
  InstructionProvenance,
  LinkOrUnavailable,
  ParticipantIdentity,
  WorkerPacketFields,
} from './types';

const MISSING = 'MISSING — required';

function orMissing(value: string): string {
  const trimmed = value.trim();
  return trimmed === '' ? MISSING : trimmed;
}

function renderLink(link: LinkOrUnavailable): string {
  if (link.kind === 'url') return orMissing(link.url);
  const reason = link.reason.trim();
  return reason === '' ? 'not_available (no reason given)' : `not_available (${reason})`;
}

function renderIdentityBlock(indent: string, identity: ParticipantIdentity): string {
  return (
    `${indent}provider: ${orMissing(identity.provider)}\n` +
    `${indent}tool: ${orMissing(identity.tool)}\n` +
    `${indent}model: ${orMissing(identity.model)}`
  );
}

function renderEvidenceReference(reference: EvidenceReference): string {
  if (reference.kind === 'url') {
    return `URL: ${orMissing(reference.url)}\nProvenance: ${orMissing(reference.provenance)}`;
  }
  if (reference.kind === 'pasted_text') {
    return `Provenance: ${orMissing(reference.provenance)}\n\n${orMissing(reference.text)}`;
  }
  const reason = reference.reason.trim();
  return `not_available (${reason === '' ? 'no reason given' : reason})`;
}

function renderInstructionProvenance(provenance: InstructionProvenance | null): string {
  if (!provenance)
    return 'not_available (no active instruction selection recorded at dispatch time)';
  return (
    `shared_role_version_id: ${provenance.sharedRoleVersionId}\n` +
    `provider_version_id: ${provenance.providerVersionId}\n` +
    `override_version_id: ${provenance.overrideVersionId ?? 'null'}`
  );
}

function renderCoordinatesBlock(coordinates: DeliveryCoordinates): string {
  return (
    `\`\`\`yaml\n` +
    `repository_path: ${orMissing(coordinates.repositoryPath)}\n` +
    `remote_url: ${renderLink(coordinates.remoteUrl)}\n` +
    `issue_url: ${renderLink(coordinates.issueUrl)}\n` +
    `pull_request_url: ${renderLink(coordinates.pullRequestUrl)}\n` +
    `base_branch: ${orMissing(coordinates.baseBranch)}\n` +
    `work_branch: ${orMissing(coordinates.workBranch)}\n` +
    `start_sha: ${orMissing(coordinates.startSha)}\n` +
    `\`\`\``
  );
}

export function generateWorkerPacket(fields: WorkerPacketFields): string {
  return `# Hammond Work Order — Worker

## Identity and stage

\`\`\`yaml
task_id: ${orMissing(fields.taskId)}
stage: implementation
human_owner: ${orMissing(fields.humanOwner)}
active_orchestrator:
${renderIdentityBlock('  ', fields.activeOrchestrator)}
assigned_worker:
${renderIdentityBlock('  ', fields.assignedWorker)}
assigned_auditor_after_delivery:
${renderIdentityBlock('  ', fields.assignedAuditor)}
\`\`\`

You are the assigned implementation worker. The orchestrator routes the workflow and does not
write the feature. The named auditor does not participate in implementation and will review your
exact pushed head after delivery.

If your provider, tool, model, role, repository, branch, task, or orchestrator differs from this
packet, stop and report the mismatch.

## Authority boundary

The human owner and the orchestrator control planning state. Do not read or edit planning-tracker
files, change task state, broaden scope, mark the PR ready, merge, or create follow-up tasks. This
packet is your complete context.

## Delivery coordinates

${renderCoordinatesBlock(fields.coordinates)}

## Selected instruction version provenance

\`\`\`yaml
${renderInstructionProvenance(fields.instructionProvenance)}
\`\`\`

## Scope

${orMissing(fields.scope)}

## Non-scope

${orMissing(fields.nonScope)}

## Acceptance criteria

${orMissing(fields.acceptance)}

## Verification

${orMissing(fields.verification)}

## Required return evidence

${orMissing(fields.requiredEvidence)}

## Stop rules

${orMissing(fields.stopRules)}

## Delivery

Commit, push, open a draft PR targeting \`${orMissing(fields.coordinates.baseBranch)}\`, include the
literal task ID, and post a structured top-level worker report. Do not mark ready or merge.
`;
}

export function generateCorrectionPacket(fields: CorrectionPacketFields): string {
  return `# Hammond Work Order — Correction ${fields.correctionNumber}

Correction returns to the original worker. The previous auditor remains the auditor for the
resulting new head unless the human owner records an explicit routing override.

\`\`\`yaml
task_id: ${orMissing(fields.taskId)}
stage: correction
correction: ${fields.correctionNumber}
human_owner: ${orMissing(fields.humanOwner)}
active_orchestrator:
${renderIdentityBlock('  ', fields.activeOrchestrator)}
assigned_worker:
${renderIdentityBlock('  ', fields.assignedWorker)}
assigned_reauditor:
${renderIdentityBlock('  ', fields.assignedReauditor)}
\`\`\`

## Delivery coordinates

${renderCoordinatesBlock(fields.coordinates)}

## Selected instruction version provenance

\`\`\`yaml
${renderInstructionProvenance(fields.instructionProvenance)}
\`\`\`

## Previous reviewed head

\`\`\`yaml
previous_head_sha: ${orMissing(fields.previousHeadSha)}
\`\`\`

## Audit report reference

${renderEvidenceReference(fields.auditReportReference)}

## Required corrections

${orMissing(fields.requiredCorrections)}

## Expected return evidence

${orMissing(fields.expectedReturnEvidence)}

Implement only confirmed findings within the task's acceptance boundary. Do not add scope beyond
what is required above. New commits invalidate every prior approval. Re-run affected focused
verification, update the same draft PR, post a top-level correction report, and return the new
exact head. Do not invent or predict the resulting head SHA — report it only once it exists.
`;
}

export function generateAuditPacket(fields: AuditPacketFields): string {
  return `# Hammond Work Order — Independent Audit

## Identity and stage

\`\`\`yaml
task_id: ${orMissing(fields.taskId)}
stage: independent_audit
human_owner: ${orMissing(fields.humanOwner)}
active_orchestrator:
${renderIdentityBlock('  ', fields.activeOrchestrator)}
author_worker:
${renderIdentityBlock('  ', fields.authorWorker)}
assigned_auditor:
${renderIdentityBlock('  ', fields.assignedAuditor)}
reviewed_head_sha: ${orMissing(fields.reviewedHeadSha)}
\`\`\`

You are the independent auditor. You did not write this implementation. The orchestrator routes
the workflow but does not dictate your verdict.

## Authority boundary

Do not change feature code, tracker state, PR readiness, or merge state. Preserve owner files.
Restore every audit mutation. If a safe audit cannot proceed, report the exact blocker rather than
manufacturing evidence.

## Review coordinates

\`\`\`yaml
repository_path: ${orMissing(fields.repositoryPath)}
remote_url: ${renderLink(fields.remoteUrl)}
base_branch: ${orMissing(fields.baseBranch)}
base_sha: ${orMissing(fields.baseSha)}
pull_request_url: ${orMissing(fields.pullRequestUrl)}
reviewed_head_sha: ${orMissing(fields.reviewedHeadSha)}
\`\`\`

## Selected instruction version provenance

\`\`\`yaml
${renderInstructionProvenance(fields.instructionProvenance)}
\`\`\`

## Worker report reference

${renderEvidenceReference(fields.workerReportReference)}

## Acceptance criteria

${orMissing(fields.acceptance)}

## Verification

${orMissing(fields.verification)}

Prioritize correctness and the visible single-owner workflow. Distinguish product failures from
test-infrastructure failures.

Post a structured top-level PR audit report and return exactly one SHA-bound verdict, restoring
every mutation and probe you made before returning it:

\`\`\`text
AUDIT-VERDICT: APPROVE ${orMissing(fields.reviewedHeadSha)}
AUDIT-VERDICT: CHANGES ${orMissing(fields.reviewedHeadSha)}
\`\`\`
`;
}

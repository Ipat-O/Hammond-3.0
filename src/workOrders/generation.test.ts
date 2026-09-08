import { describe, expect, it } from 'vitest';

import { generateAuditPacket, generateCorrectionPacket, generateWorkerPacket } from './generation';
import {
  emptyAuditFields,
  emptyCorrectionFields,
  emptyWorkerFields,
  type AuditPacketFields,
  type CorrectionPacketFields,
  type WorkerPacketFields,
} from './types';

const FULL_SHA = 'c'.repeat(40);

function baseWorkerFields(): WorkerPacketFields {
  const fields = emptyWorkerFields();
  fields.taskId = 'HAM3-009';
  fields.humanOwner = 'Ipat-O';
  fields.activeOrchestrator = { provider: 'OpenAI', tool: 'Codex Desktop', model: 'GPT-5.6 Sol' };
  fields.assignedWorker = { provider: 'Anthropic', tool: 'Claude Code', model: 'claude-sonnet-5' };
  fields.assignedAuditor = { provider: 'DeepSeek', tool: 'Kilo Code', model: 'deepseek-v4-pro' };
  fields.coordinates = {
    repositoryPath: '/home/user/Hammond-3.0',
    remoteUrl: { kind: 'url', url: 'https://github.com/Ipat-O/Hammond-3.0' },
    issueUrl: { kind: 'not_available', reason: 'no matching issue found' },
    pullRequestUrl: { kind: 'not_available', reason: 'not created yet' },
    baseBranch: 'dev',
    workBranch: 'claude/ham3-009-work-orders',
    startSha: FULL_SHA,
  };
  fields.scope = 'Build the work-orders feature.';
  fields.nonScope = 'No provider launching.';
  fields.acceptance = 'A recipient can execute from the prompt alone.';
  fields.verification = 'Run the focused suite.';
  fields.requiredEvidence = 'Exit codes and totals.';
  fields.stopRules = 'Stop on identity mismatch.';
  fields.instructionProvenance = {
    sharedRoleVersionId: 'shared-1',
    providerVersionId: 'provider-1',
    overrideVersionId: null,
  };
  return fields;
}

describe('generateWorkerPacket', () => {
  it('includes every identity, coordinate, and content field verbatim', () => {
    const text = generateWorkerPacket(baseWorkerFields());
    expect(text).toContain('task_id: HAM3-009');
    expect(text).toContain('human_owner: Ipat-O');
    expect(text).toContain('provider: OpenAI');
    expect(text).toContain('tool: Codex Desktop');
    expect(text).toContain('model: GPT-5.6 Sol');
    expect(text).toContain('provider: Anthropic');
    expect(text).toContain('tool: Claude Code');
    expect(text).toContain('model: claude-sonnet-5');
    expect(text).toContain('provider: DeepSeek');
    expect(text).toContain(`start_sha: ${FULL_SHA}`);
    expect(text).toContain('repository_path: /home/user/Hammond-3.0');
    expect(text).toContain('remote_url: https://github.com/Ipat-O/Hammond-3.0');
    expect(text).toContain('issue_url: not_available (no matching issue found)');
    expect(text).toContain('pull_request_url: not_available (not created yet)');
    expect(text).toContain('Build the work-orders feature.');
    expect(text).toContain('No provider launching.');
    expect(text).toContain('A recipient can execute from the prompt alone.');
    expect(text).toContain('Run the focused suite.');
    expect(text).toContain('Exit codes and totals.');
    expect(text).toContain('Stop on identity mismatch.');
    expect(text).toContain('shared_role_version_id: shared-1');
    expect(text).toContain('override_version_id: null');
  });

  it('never fabricates a value for a missing field — renders an explicit MISSING marker', () => {
    const text = generateWorkerPacket(emptyWorkerFields());
    expect(text).toContain('task_id: MISSING');
    expect(text).toContain('human_owner: MISSING');
    expect(text).not.toMatch(/task_id:\s*$/m);
  });

  it('never invents a URL — an empty not_available reason still renders honestly, never as a link', () => {
    const fields = baseWorkerFields();
    fields.coordinates.remoteUrl = { kind: 'not_available', reason: '' };
    const text = generateWorkerPacket(fields);
    expect(text).toContain('remote_url: not_available (no reason given)');
    expect(text).not.toContain('remote_url: https');
  });

  it('renders "not_available" provenance when no instruction selection is on record', () => {
    const fields = baseWorkerFields();
    fields.instructionProvenance = null;
    const text = generateWorkerPacket(fields);
    expect(text).toContain(
      'not_available (no active instruction selection recorded at dispatch time)',
    );
  });

  it('is a pure function of its fields — identical fields render byte-identical text', () => {
    const fields = baseWorkerFields();
    expect(generateWorkerPacket(fields)).toBe(generateWorkerPacket(baseWorkerFields()));
  });
});

function baseCorrectionFields(): CorrectionPacketFields {
  const fields = emptyCorrectionFields();
  fields.taskId = 'HAM3-009';
  fields.correctionNumber = 3;
  fields.humanOwner = 'Ipat-O';
  fields.activeOrchestrator = { provider: 'OpenAI', tool: 'Codex Desktop', model: 'GPT-5.6 Sol' };
  fields.assignedWorker = { provider: 'Anthropic', tool: 'Claude Code', model: 'claude-sonnet-5' };
  fields.assignedReauditor = { provider: 'DeepSeek', tool: 'Kilo Code', model: 'deepseek-v4-pro' };
  fields.coordinates.repositoryPath = '/home/user/Hammond-3.0';
  fields.coordinates.baseBranch = 'dev';
  fields.coordinates.workBranch = 'claude/ham3-009-work-orders';
  fields.coordinates.startSha = FULL_SHA;
  fields.previousHeadSha = FULL_SHA;
  fields.auditReportReference = {
    kind: 'url',
    url: 'https://github.com/Ipat-O/Hammond-3.0/pull/10#issuecomment-1',
    provenance: 'Verified PR comment',
  };
  fields.requiredCorrections = 'Fix F1.';
  fields.expectedReturnEvidence = 'New head once pushed.';
  return fields;
}

describe('generateCorrectionPacket', () => {
  it('includes the correction number, previous head, and audit report reference', () => {
    const text = generateCorrectionPacket(baseCorrectionFields());
    expect(text).toContain('# Hammond Work Order — Correction 3');
    expect(text).toContain('correction: 3');
    expect(text).toContain(`previous_head_sha: ${FULL_SHA}`);
    expect(text).toContain('https://github.com/Ipat-O/Hammond-3.0/pull/10#issuecomment-1');
    expect(text).toContain('Verified PR comment');
    expect(text).toContain('Fix F1.');
    expect(text).toContain('New head once pushed.');
  });

  it('never predicts or invents the resulting new head SHA', () => {
    const text = generateCorrectionPacket(baseCorrectionFields());
    expect(text.toLowerCase()).not.toContain('new_head_sha:');
    expect(text).toContain('Do not invent or predict the resulting head SHA');
  });

  it('renders pasted-text audit report evidence with its provenance, not as a fabricated link', () => {
    const fields = baseCorrectionFields();
    fields.auditReportReference = {
      kind: 'pasted_text',
      text: 'AUDIT-VERDICT: CHANGES abc',
      provenance: 'Owner-pasted, not independently verified',
    };
    const text = generateCorrectionPacket(fields);
    expect(text).toContain('Owner-pasted, not independently verified');
    expect(text).toContain('AUDIT-VERDICT: CHANGES abc');
  });
});

function baseAuditFields(): AuditPacketFields {
  const fields = emptyAuditFields();
  fields.taskId = 'HAM3-009';
  fields.humanOwner = 'Ipat-O';
  fields.activeOrchestrator = { provider: 'OpenAI', tool: 'Codex Desktop', model: 'GPT-5.6 Sol' };
  fields.authorWorker = { provider: 'Anthropic', tool: 'Claude Code', model: 'claude-sonnet-5' };
  fields.assignedAuditor = { provider: 'DeepSeek', tool: 'Kilo Code', model: 'deepseek-v4-pro' };
  fields.repositoryPath = '/home/user/Hammond-3.0';
  fields.baseBranch = 'dev';
  fields.baseSha = FULL_SHA;
  fields.pullRequestUrl = 'https://github.com/Ipat-O/Hammond-3.0/pull/11';
  fields.reviewedHeadSha = FULL_SHA;
  fields.workerReportReference = {
    kind: 'url',
    url: 'https://github.com/Ipat-O/Hammond-3.0/pull/11#issuecomment-2',
    provenance: 'Verified PR comment',
  };
  fields.acceptance = 'It works.';
  fields.verification = 'Run tests.';
  return fields;
}

describe('generateAuditPacket', () => {
  it('embeds the exact reviewed head SHA into both verdict lines', () => {
    const text = generateAuditPacket(baseAuditFields());
    expect(text).toContain(`AUDIT-VERDICT: APPROVE ${FULL_SHA}`);
    expect(text).toContain(`AUDIT-VERDICT: CHANGES ${FULL_SHA}`);
    expect(text).toContain(`reviewed_head_sha: ${FULL_SHA}`);
    expect(text).toContain('pull_request_url: https://github.com/Ipat-O/Hammond-3.0/pull/11');
  });

  it('renders MISSING for the PR URL and SHA verdict lines when absent, never a fabricated value', () => {
    const fields = baseAuditFields();
    fields.pullRequestUrl = '';
    fields.reviewedHeadSha = '';
    const text = generateAuditPacket(fields);
    expect(text).toContain('pull_request_url: MISSING');
    expect(text).toContain('AUDIT-VERDICT: APPROVE MISSING');
  });
});

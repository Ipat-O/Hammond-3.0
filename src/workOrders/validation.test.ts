import { describe, expect, it } from 'vitest';

import {
  isExactFullSha,
  isSyntacticallyValidUrl,
  validateAuditFields,
  validateCorrectionFields,
  validateWorkerFields,
} from './validation';
import {
  emptyAuditFields,
  emptyCorrectionFields,
  emptyWorkerFields,
  type AuditPacketFields,
  type CorrectionPacketFields,
  type ParticipantIdentity,
  type WorkerPacketFields,
} from './types';

const FULL_SHA_A = 'a'.repeat(40);
const FULL_SHA_B = 'b'.repeat(40);

function identity(provider: string, tool: string, model: string): ParticipantIdentity {
  return { provider, tool, model };
}

function validWorkerFields(): WorkerPacketFields {
  const fields = emptyWorkerFields();
  fields.taskId = 'HAM3-009';
  fields.humanOwner = 'Owner';
  fields.activeOrchestrator = identity('OpenAI', 'Codex', 'gpt-5.6');
  fields.assignedWorker = identity('Anthropic', 'Claude Code', 'claude-sonnet-5');
  fields.assignedAuditor = identity('DeepSeek', 'Kilo Code', 'deepseek-v4-pro');
  fields.coordinates = {
    repositoryPath: '/repo',
    remoteUrl: { kind: 'url', url: 'https://github.com/org/repo' },
    issueUrl: { kind: 'not_available', reason: 'no matching issue' },
    pullRequestUrl: { kind: 'not_available', reason: 'not created yet' },
    baseBranch: 'dev',
    workBranch: 'claude/task',
    startSha: FULL_SHA_A,
  };
  fields.scope = 'Do the thing.';
  fields.nonScope = 'Not the other thing.';
  fields.acceptance = 'It works.';
  fields.verification = 'Run tests.';
  fields.requiredEvidence = 'Test output.';
  fields.stopRules = 'Stop if X.';
  return fields;
}

describe('isExactFullSha', () => {
  it('accepts exactly 40 hex characters', () => {
    expect(isExactFullSha(FULL_SHA_A)).toBe(true);
    expect(isExactFullSha(FULL_SHA_A.toUpperCase())).toBe(true);
  });

  it('rejects abbreviated or malformed SHAs', () => {
    expect(isExactFullSha('a391b81')).toBe(false);
    expect(isExactFullSha(`${FULL_SHA_A}f`)).toBe(false);
    expect(isExactFullSha('not-a-sha')).toBe(false);
    expect(isExactFullSha('')).toBe(false);
  });
});

describe('isSyntacticallyValidUrl', () => {
  it('accepts absolute http(s) URLs', () => {
    expect(isSyntacticallyValidUrl('https://github.com/org/repo/pull/1')).toBe(true);
    expect(isSyntacticallyValidUrl('http://example.com')).toBe(true);
  });

  it('rejects non-URLs and non-http(s) schemes', () => {
    expect(isSyntacticallyValidUrl('not a url')).toBe(false);
    expect(isSyntacticallyValidUrl('ftp://example.com/file')).toBe(false);
    expect(isSyntacticallyValidUrl('')).toBe(false);
  });
});

describe('validateWorkerFields', () => {
  it('passes for a fully completed packet', () => {
    const result = validateWorkerFields(validWorkerFields());
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reports every missing required field, not just the first', () => {
    const result = validateWorkerFields(emptyWorkerFields());
    expect(result.isValid).toBe(false);
    const fieldNames = result.errors.map((issue) => issue.field);
    expect(fieldNames).toEqual(
      expect.arrayContaining([
        'taskId',
        'humanOwner',
        'activeOrchestrator.provider',
        'assignedWorker.provider',
        'assignedAuditor.provider',
        'coordinates.repositoryPath',
        'coordinates.workBranch',
        'coordinates.startSha',
        'scope',
        'nonScope',
        'acceptance',
        'verification',
        'requiredEvidence',
        'stopRules',
      ]),
    );
  });

  it('rejects an abbreviated start SHA', () => {
    const fields = validWorkerFields();
    fields.coordinates.startSha = 'b391b81';
    const result = validateWorkerFields(fields);
    expect(result.isValid).toBe(false);
    expect(result.errors.some((issue) => issue.field === 'coordinates.startSha')).toBe(true);
  });

  it('requires a reason when a link is marked not_available', () => {
    const fields = validWorkerFields();
    fields.coordinates.issueUrl = { kind: 'not_available', reason: '' };
    const result = validateWorkerFields(fields);
    expect(result.errors.some((issue) => issue.field === 'coordinates.issueUrl')).toBe(true);
  });

  it('rejects a same-family assigned worker and auditor', () => {
    const fields = validWorkerFields();
    fields.assignedAuditor = identity('Anthropic', 'Some Other Tool', 'claude-opus-5');
    const result = validateWorkerFields(fields);
    expect(result.isValid).toBe(false);
    expect(result.errors.some((issue) => issue.field === 'assignedAuditor.provider')).toBe(true);
  });

  it('does not double-flag family independence before both identities are complete', () => {
    const fields = validWorkerFields();
    fields.assignedAuditor = identity('', '', '');
    const result = validateWorkerFields(fields);
    // Missing-field errors are reported, but the independence check itself is not reachable
    // (and must not throw) while an identity is incomplete.
    expect(
      result.errors.filter((issue) => issue.message.includes('no family audits')),
    ).toHaveLength(0);
  });
});

function validCorrectionFields(): CorrectionPacketFields {
  const fields = emptyCorrectionFields();
  fields.taskId = 'HAM3-009';
  fields.correctionNumber = 1;
  fields.humanOwner = 'Owner';
  fields.activeOrchestrator = identity('OpenAI', 'Codex', 'gpt-5.6');
  fields.assignedWorker = identity('Anthropic', 'Claude Code', 'claude-sonnet-5');
  fields.assignedReauditor = identity('DeepSeek', 'Kilo Code', 'deepseek-v4-pro');
  fields.coordinates = {
    repositoryPath: '/repo',
    remoteUrl: { kind: 'url', url: 'https://github.com/org/repo' },
    issueUrl: { kind: 'not_available', reason: 'n/a' },
    pullRequestUrl: { kind: 'url', url: 'https://github.com/org/repo/pull/10' },
    baseBranch: 'dev',
    workBranch: 'claude/task',
    startSha: FULL_SHA_A,
  };
  fields.previousHeadSha = FULL_SHA_B;
  fields.auditReportReference = {
    kind: 'url',
    url: 'https://github.com/org/repo/pull/10#issuecomment-1',
    provenance: 'Verified PR comment',
  };
  fields.requiredCorrections = 'Fix the thing.';
  fields.expectedReturnEvidence = 'New head SHA once pushed.';
  return fields;
}

describe('validateCorrectionFields', () => {
  it('passes for a fully completed packet with no expected-worker context', () => {
    const result = validateCorrectionFields(validCorrectionFields(), { expectedWorker: null });
    expect(result.isValid).toBe(true);
  });

  it('requires the previous head SHA to be exact and full', () => {
    const fields = validCorrectionFields();
    fields.previousHeadSha = 'b391b81';
    const result = validateCorrectionFields(fields, { expectedWorker: null });
    expect(result.errors.some((issue) => issue.field === 'previousHeadSha')).toBe(true);
  });

  it('rejects an audit report reference marked not_available', () => {
    const fields = validCorrectionFields();
    fields.auditReportReference = { kind: 'not_available', reason: 'lost the link' };
    const result = validateCorrectionFields(fields, { expectedWorker: null });
    expect(result.errors.some((issue) => issue.field === 'auditReportReference')).toBe(true);
  });

  it('rejects an assigned worker that does not match the original worker on record', () => {
    const fields = validCorrectionFields();
    const original = identity('Anthropic', 'Claude Code', 'claude-sonnet-5');
    fields.assignedWorker = identity('OpenAI', 'Codex', 'gpt-5.6');
    const result = validateCorrectionFields(fields, { expectedWorker: original });
    expect(result.isValid).toBe(false);
    expect(result.errors.some((issue) => issue.field === 'assignedWorker')).toBe(true);
  });

  it('accepts an assigned worker that matches the original worker on record', () => {
    const fields = validCorrectionFields();
    const original = identity('Anthropic', 'Claude Code', 'claude-sonnet-5');
    const result = validateCorrectionFields(fields, { expectedWorker: original });
    expect(result.isValid).toBe(true);
  });
});

function validAuditFields(): AuditPacketFields {
  const fields = emptyAuditFields();
  fields.taskId = 'HAM3-009';
  fields.humanOwner = 'Owner';
  fields.activeOrchestrator = identity('OpenAI', 'Codex', 'gpt-5.6');
  fields.authorWorker = identity('Anthropic', 'Claude Code', 'claude-sonnet-5');
  fields.assignedAuditor = identity('DeepSeek', 'Kilo Code', 'deepseek-v4-pro');
  fields.repositoryPath = '/repo';
  fields.remoteUrl = { kind: 'url', url: 'https://github.com/org/repo' };
  fields.baseBranch = 'dev';
  fields.baseSha = FULL_SHA_A;
  fields.pullRequestUrl = 'https://github.com/org/repo/pull/10';
  fields.reviewedHeadSha = FULL_SHA_B;
  fields.workerReportReference = {
    kind: 'url',
    url: 'https://github.com/org/repo/pull/10#issuecomment-1',
    provenance: 'Verified PR comment',
  };
  fields.acceptance = 'It works.';
  fields.verification = 'Run tests.';
  return fields;
}

describe('validateAuditFields', () => {
  it('passes for a fully completed packet', () => {
    const result = validateAuditFields(validAuditFields());
    expect(result.isValid).toBe(true);
  });

  it('requires a real PR URL — not_available is rejected', () => {
    const fields = validAuditFields();
    fields.pullRequestUrl = '';
    const result = validateAuditFields(fields);
    expect(result.errors.some((issue) => issue.field === 'pullRequestUrl')).toBe(true);
  });

  it('rejects a syntactically invalid PR URL', () => {
    const fields = validAuditFields();
    fields.pullRequestUrl = 'not-a-url';
    const result = validateAuditFields(fields);
    expect(result.errors.some((issue) => issue.field === 'pullRequestUrl')).toBe(true);
  });

  it('rejects an abbreviated reviewed head SHA', () => {
    const fields = validAuditFields();
    fields.reviewedHeadSha = 'b391b81';
    const result = validateAuditFields(fields);
    expect(result.errors.some((issue) => issue.field === 'reviewedHeadSha')).toBe(true);
  });

  it('rejects a same-family author and auditor', () => {
    const fields = validAuditFields();
    fields.assignedAuditor = identity('Anthropic', 'A Different Tool', 'claude-opus-5');
    const result = validateAuditFields(fields);
    expect(result.isValid).toBe(false);
    expect(result.errors.some((issue) => issue.field === 'assignedAuditor.provider')).toBe(true);
  });

  it('rejects a worker report reference marked not_available', () => {
    const fields = validAuditFields();
    fields.workerReportReference = { kind: 'not_available', reason: 'lost it' };
    const result = validateAuditFields(fields);
    expect(result.errors.some((issue) => issue.field === 'workerReportReference')).toBe(true);
  });
});

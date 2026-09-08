import { beforeEach, describe, expect, it } from 'vitest';

import { WorkOrderDomainError } from './errors';
import { createWorkOrderId } from './service';
import {
  createControlledLocalSettings,
  createWorkOrdersTestHarness,
  type WorkOrdersTestHarness,
} from './testFakes';
import type { CorrectionPacketFields, WorkerPacketFields, WorkOrderFields } from './types';

const PROJECT_ID = 'project-1';
const TASK_ID = 'task-1';
const FULL_SHA_A = 'a'.repeat(40);
const FULL_SHA_B = 'b'.repeat(40);

function validWorkerPacket(
  harness: WorkOrdersTestHarness,
  fields: WorkerPacketFields,
): Extract<WorkOrderFields, { stage: 'worker' }> {
  fields.assignedAuditor = { provider: 'DeepSeek', tool: 'Kilo Code', model: 'deepseek-v4-pro' };
  fields.scope = 'Scope.';
  fields.nonScope = 'Non-scope.';
  fields.acceptance = 'Acceptance.';
  fields.verification = 'Verification.';
  fields.requiredEvidence = 'Evidence.';
  fields.stopRules = 'Stop rules.';
  fields.coordinates.workBranch = 'claude/task-1';
  fields.coordinates.startSha = FULL_SHA_A;
  fields.coordinates.remoteUrl = { kind: 'not_available', reason: 'not tracked by Hammond' };
  fields.coordinates.issueUrl = { kind: 'not_available', reason: 'no matching issue' };
  fields.coordinates.pullRequestUrl = { kind: 'not_available', reason: 'not created yet' };
  void harness;
  return { stage: 'worker', fields };
}

async function buildRecordableWorkerPacket(
  harness: WorkOrdersTestHarness,
): Promise<Extract<WorkOrderFields, { stage: 'worker' }>> {
  const fields = await harness.service.defaultWorkerFields({
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    humanOwner: 'Owner',
  });
  fields.activeOrchestrator = { provider: 'OpenAI', tool: 'Codex', model: 'gpt-5.6' };
  fields.assignedWorker = { provider: 'Anthropic', tool: 'Claude Code', model: 'claude-sonnet-5' };
  const packet = validWorkerPacket(harness, fields);
  packet.fields.coordinates.repositoryPath = '/scratch';
  return packet;
}

describe('WorkOrdersService prefill', () => {
  let harness: WorkOrdersTestHarness;

  beforeEach(() => {
    harness = createWorkOrdersTestHarness();
    harness.seedProject(PROJECT_ID);
  });

  it('defaultWorkerFields seeds identities from the project role assignments (D-014 defaults)', async () => {
    const fields = await harness.service.defaultWorkerFields({
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      humanOwner: 'Owner',
      repositoryPath: '/scratch/project',
    });
    expect(fields.taskId).toBe(TASK_ID);
    expect(fields.humanOwner).toBe('Owner');
    expect(fields.coordinates.repositoryPath).toBe('/scratch/project');
    // D-014 defaults: orchestrator=codex, worker=claude_code, auditor=kilo_code.
    expect(fields.activeOrchestrator).toEqual({ provider: 'OpenAI', tool: 'Codex', model: '' });
    expect(fields.assignedWorker).toEqual({
      provider: 'Anthropic',
      tool: 'Claude Code',
      model: '',
    });
    expect(fields.assignedAuditor.tool).toBe('Kilo Code');
    expect(fields.instructionProvenance).not.toBeNull();
  });

  it('defaultCorrectionFields prefills the correction number from prior corrections and the original worker identity', async () => {
    const workerPacket = validWorkerPacket(
      harness,
      await harness.service.defaultWorkerFields({
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        humanOwner: 'Owner',
      }),
    );
    (workerPacket.fields as WorkerPacketFields).coordinates.remoteUrl = {
      kind: 'not_available',
      reason: 'n/a',
    };
    (workerPacket.fields as WorkerPacketFields).coordinates.issueUrl = {
      kind: 'not_available',
      reason: 'n/a',
    };
    (workerPacket.fields as WorkerPacketFields).coordinates.pullRequestUrl = {
      kind: 'not_available',
      reason: 'n/a',
    };
    (workerPacket.fields as WorkerPacketFields).activeOrchestrator = {
      provider: 'OpenAI',
      tool: 'Codex',
      model: 'gpt-5.6',
    };
    (workerPacket.fields as WorkerPacketFields).assignedWorker = {
      provider: 'Anthropic',
      tool: 'Claude Code',
      model: 'claude-sonnet-5',
    };
    (workerPacket.fields as WorkerPacketFields).coordinates.repositoryPath = '/scratch/project';

    await harness.service.recordDispatch({
      id: createWorkOrderId(),
      ownerId: harness.ownerId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      packet: workerPacket,
    });

    const correctionFields = await harness.service.defaultCorrectionFields({
      ownerId: harness.ownerId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      humanOwner: 'Owner',
    });
    expect(correctionFields.correctionNumber).toBe(1);
    expect(correctionFields.assignedWorker).toEqual({
      provider: 'Anthropic',
      tool: 'Claude Code',
      model: 'claude-sonnet-5',
    });
  });
});

describe('WorkOrdersService.recordDispatch', () => {
  let harness: WorkOrdersTestHarness;

  beforeEach(() => {
    harness = createWorkOrdersTestHarness();
    harness.seedProject(PROJECT_ID);
  });

  async function recordedWorkerPacket() {
    const fields = await harness.service.defaultWorkerFields({
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      humanOwner: 'Owner',
    });
    fields.activeOrchestrator = { provider: 'OpenAI', tool: 'Codex', model: 'gpt-5.6' };
    fields.assignedWorker = {
      provider: 'Anthropic',
      tool: 'Claude Code',
      model: 'claude-sonnet-5',
    };
    const packet = validWorkerPacket(harness, fields);
    (packet.fields as WorkerPacketFields).coordinates.repositoryPath = '/scratch/project';
    return packet;
  }

  it('rejects recording an invalid packet — nothing is persisted', async () => {
    const emptyPacket: WorkOrderFields = {
      stage: 'worker',
      fields: await harness.service.defaultWorkerFields({
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        humanOwner: '',
      }),
    };
    await expect(
      harness.service.recordDispatch({
        id: createWorkOrderId(),
        ownerId: harness.ownerId,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        packet: emptyPacket,
      }),
    ).rejects.toThrow(WorkOrderDomainError);
    expect(await harness.service.listHistory(harness.ownerId, TASK_ID)).toEqual([]);
  });

  it('records a valid packet as an immutable snapshot with generated content', async () => {
    const packet = await recordedWorkerPacket();
    const snapshot = await harness.service.recordDispatch({
      id: createWorkOrderId(),
      ownerId: harness.ownerId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      packet,
    });
    expect(snapshot.content).toContain('# Hammond Work Order — Worker');
    expect(snapshot.content).toContain('claude-sonnet-5');
    const history = await harness.service.listHistory(harness.ownerId, TASK_ID);
    expect(history).toHaveLength(1);
  });

  it('IMMUTABILITY MUTATION PROOF: editing the assignment/instructions after recording never changes the stored snapshot on re-read', async () => {
    const packet = await recordedWorkerPacket();
    const snapshot = await harness.service.recordDispatch({
      id: createWorkOrderId(),
      ownerId: harness.ownerId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      packet,
    });
    const originalContent = snapshot.content;

    // Change the project's role assignment after the dispatch was recorded.
    await harness.assignments.updateAssignment({
      projectId: PROJECT_ID,
      role: 'worker',
      provider: 'codex',
    });

    const [reread] = await harness.service.listHistory(harness.ownerId, TASK_ID);
    expect(reread.content).toBe(originalContent);
    expect(reread.content).toContain('claude-sonnet-5');
  });

  it('is idempotent for a retry with the same id (double-click / retry-after-partial-failure never duplicates)', async () => {
    const packet = await recordedWorkerPacket();
    const id = createWorkOrderId();
    const first = await harness.service.recordDispatch({
      id,
      ownerId: harness.ownerId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      packet,
    });
    const retry = await harness.service.recordDispatch({
      id,
      ownerId: harness.ownerId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      packet,
      createdAt: first.createdAt,
    });
    expect(retry).toEqual(first);
    expect(await harness.service.listHistory(harness.ownerId, TASK_ID)).toHaveLength(1);
  });
});

describe('WorkOrdersService correction identity gating', () => {
  let harness: WorkOrdersTestHarness;

  beforeEach(() => {
    harness = createWorkOrdersTestHarness();
    harness.seedProject(PROJECT_ID);
  });

  it('blocks recording a correction whose assigned worker does not match the original worker', async () => {
    const workerFields = await harness.service.defaultWorkerFields({
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      humanOwner: 'Owner',
    });
    workerFields.activeOrchestrator = { provider: 'OpenAI', tool: 'Codex', model: 'gpt-5.6' };
    workerFields.assignedWorker = {
      provider: 'Anthropic',
      tool: 'Claude Code',
      model: 'claude-sonnet-5',
    };
    const workerPacket = validWorkerPacket(harness, workerFields);
    workerPacket.fields.coordinates.repositoryPath = '/scratch';
    await harness.service.recordDispatch({
      id: createWorkOrderId(),
      ownerId: harness.ownerId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      packet: workerPacket,
    });

    const correctionFields = await harness.service.defaultCorrectionFields({
      ownerId: harness.ownerId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      humanOwner: 'Owner',
    });
    correctionFields.assignedWorker = { provider: 'OpenAI', tool: 'Codex', model: 'gpt-5.6' }; // wrong recipient
    correctionFields.assignedReauditor = {
      provider: 'DeepSeek',
      tool: 'Kilo Code',
      model: 'deepseek-v4-pro',
    };
    correctionFields.previousHeadSha = FULL_SHA_B;
    correctionFields.auditReportReference = {
      kind: 'url',
      url: 'https://github.com/org/repo/pull/1#issuecomment-1',
      provenance: 'verified',
    };
    correctionFields.requiredCorrections = 'Fix it.';
    correctionFields.expectedReturnEvidence = 'New head.';
    correctionFields.coordinates.workBranch = 'claude/task-1';
    correctionFields.coordinates.startSha = FULL_SHA_A;

    const originalWorker = await harness.service.getOriginalWorkerIdentity(
      harness.ownerId,
      TASK_ID,
    );
    const packet: WorkOrderFields = {
      stage: 'correction',
      fields: correctionFields as CorrectionPacketFields,
    };
    await expect(
      harness.service.recordDispatch({
        id: createWorkOrderId(),
        ownerId: harness.ownerId,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        packet,
        expectedWorker: originalWorker,
      }),
    ).rejects.toThrow(WorkOrderDomainError);
  });
});

describe('WorkOrdersService.attachReport', () => {
  let harness: WorkOrdersTestHarness;

  beforeEach(() => {
    harness = createWorkOrdersTestHarness();
    harness.seedProject(PROJECT_ID);
  });

  it('rejects attaching a report to a dispatch that does not exist', async () => {
    await expect(
      harness.service.attachReport({
        id: createWorkOrderId(),
        ownerId: harness.ownerId,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        dispatchId: 'no-such-dispatch',
        rawText: 'report text',
        url: null,
        returnedIdentity: null,
        headSha: null,
        verificationNotes: '',
        limitations: '',
        provenance: 'owner-pasted',
      }),
    ).rejects.toThrow(WorkOrderDomainError);
  });

  it('attaches a report, never mutating the dispatch it responds to', async () => {
    const fields = await harness.service.defaultWorkerFields({
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      humanOwner: 'Owner',
    });
    fields.activeOrchestrator = { provider: 'OpenAI', tool: 'Codex', model: 'gpt-5.6' };
    fields.assignedWorker = {
      provider: 'Anthropic',
      tool: 'Claude Code',
      model: 'claude-sonnet-5',
    };
    const packet = validWorkerPacket(harness, fields);
    packet.fields.coordinates.repositoryPath = '/scratch';
    const dispatch = await harness.service.recordDispatch({
      id: createWorkOrderId(),
      ownerId: harness.ownerId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      packet,
    });

    const report = await harness.service.attachReport({
      id: createWorkOrderId(),
      ownerId: harness.ownerId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      dispatchId: dispatch.id,
      rawText: 'Worker report text',
      url: 'https://github.com/org/repo/pull/1#issuecomment-1',
      returnedIdentity: { provider: 'Anthropic', tool: 'Claude Code', model: 'claude-sonnet-5' },
      headSha: FULL_SHA_A,
      verificationNotes: 'All green.',
      limitations: 'None disclosed.',
      provenance: 'Pasted from PR comment',
    });
    expect(report.dispatchId).toBe(dispatch.id);

    const [rereadDispatch] = await harness.service.listHistory(harness.ownerId, TASK_ID);
    expect(rereadDispatch).toEqual(dispatch);
    const reports = await harness.service.getReportsForDispatch(harness.ownerId, dispatch.id);
    expect(reports).toEqual([report]);
  });

  it('rejects a supplied head SHA that is not exact/full', async () => {
    const fields = await harness.service.defaultWorkerFields({
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      humanOwner: 'Owner',
    });
    fields.activeOrchestrator = { provider: 'OpenAI', tool: 'Codex', model: 'gpt-5.6' };
    fields.assignedWorker = {
      provider: 'Anthropic',
      tool: 'Claude Code',
      model: 'claude-sonnet-5',
    };
    const packet = validWorkerPacket(harness, fields);
    packet.fields.coordinates.repositoryPath = '/scratch';
    const dispatch = await harness.service.recordDispatch({
      id: createWorkOrderId(),
      ownerId: harness.ownerId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      packet,
    });

    await expect(
      harness.service.attachReport({
        id: createWorkOrderId(),
        ownerId: harness.ownerId,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        dispatchId: dispatch.id,
        rawText: 'text',
        url: null,
        returnedIdentity: null,
        headSha: 'abc123',
        verificationNotes: '',
        limitations: '',
        provenance: 'owner-pasted',
      }),
    ).rejects.toThrow(WorkOrderDomainError);
  });
});

describe('WorkOrdersService injection passthrough', () => {
  it('injects the exact recorded dispatch content into the selected directory', async () => {
    const harness = createWorkOrdersTestHarness();
    harness.seedProject(PROJECT_ID);
    const fields = await harness.service.defaultWorkerFields({
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      humanOwner: 'Owner',
    });
    fields.activeOrchestrator = { provider: 'OpenAI', tool: 'Codex', model: 'gpt-5.6' };
    fields.assignedWorker = {
      provider: 'Anthropic',
      tool: 'Claude Code',
      model: 'claude-sonnet-5',
    };
    const packet = validWorkerPacket(harness, fields);
    packet.fields.coordinates.repositoryPath = '/scratch';
    const dispatch = await harness.service.recordDispatch({
      id: createWorkOrderId(),
      ownerId: harness.ownerId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      packet,
    });

    const outcome = await harness.service.injectDispatch({ root: '/scratch', dispatch });
    expect(outcome.kind).toBe('Written');
    const written = Array.from(harness.filesystem.files.values())[0];
    expect(written).toContain(dispatch.content);
  });
});

describe('WorkOrdersService partial-write recovery (HAM3-009 Correction 1)', () => {
  const OWNER_ID = 'owner-1';

  it('recordDispatch: index write fails then an identical retry recovers — original-worker identity is discoverable and the correction identity gate still enforces it against the recovered history', async () => {
    const settings = createControlledLocalSettings();
    settings.failWritesMatching((key) => key === `hammond.workOrders.index.${OWNER_ID}`, {
      count: 1,
    });
    const harness = createWorkOrdersTestHarness(OWNER_ID, { localSettings: settings });
    harness.seedProject(PROJECT_ID);
    const packet = await buildRecordableWorkerPacket(harness);
    const id = createWorkOrderId();

    await expect(
      harness.service.recordDispatch({
        id,
        ownerId: harness.ownerId,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        packet,
      }),
    ).rejects.toThrow(WorkOrderDomainError);
    // Before recovery: the document is saved but genuinely undiscoverable — not a false success.
    expect(await harness.service.listHistory(harness.ownerId, TASK_ID)).toEqual([]);
    expect(await harness.service.getOriginalWorkerIdentity(harness.ownerId, TASK_ID)).toBeNull();

    const recovered = await harness.service.recordDispatch({
      id,
      ownerId: harness.ownerId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      packet,
    });
    const history = await harness.service.listHistory(harness.ownerId, TASK_ID);
    expect(history).toEqual([recovered]);

    const originalWorker = await harness.service.getOriginalWorkerIdentity(
      harness.ownerId,
      TASK_ID,
    );
    expect(originalWorker).toEqual({
      provider: 'Anthropic',
      tool: 'Claude Code',
      model: 'claude-sonnet-5',
    });

    // The correction identity gate must still block a mismatched recipient now that the recovered
    // dispatch is on record — recovery must never bypass this gate.
    const correctionFields = await harness.service.defaultCorrectionFields({
      ownerId: harness.ownerId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      humanOwner: 'Owner',
    });
    expect(correctionFields.assignedWorker).toEqual(originalWorker);
    correctionFields.assignedWorker = { provider: 'OpenAI', tool: 'Codex', model: 'gpt-5.6' };
    correctionFields.assignedReauditor = {
      provider: 'DeepSeek',
      tool: 'Kilo Code',
      model: 'deepseek-v4-pro',
    };
    correctionFields.previousHeadSha = FULL_SHA_B;
    correctionFields.auditReportReference = {
      kind: 'url',
      url: 'https://github.com/org/repo/pull/1#issuecomment-1',
      provenance: 'verified',
    };
    correctionFields.requiredCorrections = 'Fix it.';
    correctionFields.expectedReturnEvidence = 'New head.';
    correctionFields.coordinates.workBranch = 'claude/task-1';
    correctionFields.coordinates.startSha = FULL_SHA_A;

    await expect(
      harness.service.recordDispatch({
        id: createWorkOrderId(),
        ownerId: harness.ownerId,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        packet: { stage: 'correction', fields: correctionFields as CorrectionPacketFields },
        expectedWorker: originalWorker,
      }),
    ).rejects.toThrow(WorkOrderDomainError);
  });

  it('attachReport: index write fails then an identical retry recovers — the report shows up exactly once under its dispatch with exact raw text/identity/provenance', async () => {
    const settings = createControlledLocalSettings();
    settings.failWritesMatching((key) => key === `hammond.workOrders.reportIndex.${OWNER_ID}`, {
      count: 1,
    });
    const harness = createWorkOrdersTestHarness(OWNER_ID, { localSettings: settings });
    harness.seedProject(PROJECT_ID);
    const packet = await buildRecordableWorkerPacket(harness);
    const dispatch = await harness.service.recordDispatch({
      id: createWorkOrderId(),
      ownerId: harness.ownerId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      packet,
    });

    const reportParams = {
      id: createWorkOrderId(),
      ownerId: harness.ownerId,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      dispatchId: dispatch.id,
      rawText: 'Worker report text',
      url: 'https://github.com/org/repo/pull/1#issuecomment-1',
      returnedIdentity: { provider: 'Anthropic', tool: 'Claude Code', model: 'claude-sonnet-5' },
      headSha: FULL_SHA_A,
      verificationNotes: 'All green.',
      limitations: 'None disclosed.',
      provenance: 'Pasted from PR comment',
    };

    await expect(harness.service.attachReport(reportParams)).rejects.toThrow(WorkOrderDomainError);
    expect(await harness.service.getReportsForDispatch(harness.ownerId, dispatch.id)).toEqual([]);

    const recovered = await harness.service.attachReport(reportParams);
    const reports = await harness.service.getReportsForDispatch(harness.ownerId, dispatch.id);
    expect(reports).toEqual([recovered]);
    expect(reports[0].rawText).toBe('Worker report text');
    expect(reports[0].provenance).toBe('Pasted from PR comment');
    expect(reports[0].returnedIdentity).toEqual({
      provider: 'Anthropic',
      tool: 'Claude Code',
      model: 'claude-sonnet-5',
    });

    const taskReports = await harness.service.getReportsForTask(harness.ownerId, TASK_ID);
    expect(taskReports).toEqual([recovered]);
  });
});

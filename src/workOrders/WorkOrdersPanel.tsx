import { useCallback, useEffect, useRef, useState } from 'react';

import { formatIdentity, identitiesEqual, isIndependentFamily } from './identity';
import { WorkOrderDomainError } from './errors';
import type { WorkOrderInjectOutcome } from './injection';
import type { WorkOrdersService } from './service';
import type {
  AuditPacketFields,
  CorrectionPacketFields,
  DeliveryCoordinates,
  EvidenceReference,
  LinkOrUnavailable,
  ParticipantIdentity,
  ReturnedIdentity,
  WorkerPacketFields,
  WorkOrderDispatchSnapshot,
  WorkOrderFields,
  WorkOrderPendingReportAttempt,
  WorkOrderReportRecord,
  WorkOrderStage,
} from './types';
import type { FieldIssue } from './validation';

export interface WorkOrdersPanelProps {
  service: WorkOrdersService;
  ownerId: string;
  ownerEmail?: string;
  projectId: string;
  taskId: string;
  taskTitle: string;
  /** The currently open local directory root, or `null` when none is linked. Copy/history stay
   * available either way; only injection requires a directory. */
  directoryRoot: string | null;
}

const STAGE_LABEL: Record<WorkOrderStage, string> = {
  worker: 'Worker',
  correction: 'Correction',
  audit: 'Audit',
};

function errorMessage(error: unknown): string {
  if (error instanceof WorkOrderDomainError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

function dispatchIdentityFor(dispatch: WorkOrderDispatchSnapshot): ParticipantIdentity | null {
  if (dispatch.packet.stage === 'worker') return dispatch.packet.fields.assignedWorker;
  if (dispatch.packet.stage === 'correction') return dispatch.packet.fields.assignedWorker;
  return dispatch.packet.fields.assignedAuditor;
}

// ---- Small field primitives ----

function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="form-row">
      {props.label}
      <input
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function TextAreaField(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="form-row">
      {props.label}
      <textarea
        rows={3}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function IdentityFields(props: {
  legend: string;
  identity: ParticipantIdentity;
  onChange: (identity: ParticipantIdentity) => void;
}) {
  const { identity, onChange } = props;
  return (
    <fieldset className="work-order-identity">
      <legend>{props.legend}</legend>
      <TextField
        label="Provider"
        value={identity.provider}
        onChange={(provider) => onChange({ ...identity, provider })}
      />
      <TextField
        label="Tool"
        value={identity.tool}
        onChange={(tool) => onChange({ ...identity, tool })}
      />
      <TextField
        label="Model"
        value={identity.model}
        onChange={(model) => onChange({ ...identity, model })}
      />
    </fieldset>
  );
}

function LinkField(props: {
  label: string;
  link: LinkOrUnavailable;
  onChange: (link: LinkOrUnavailable) => void;
}) {
  const { link, onChange } = props;
  return (
    <div className="form-row work-order-link-field">
      <span>{props.label}</span>
      <select
        value={link.kind}
        onChange={(event) =>
          onChange(
            event.target.value === 'url'
              ? { kind: 'url', url: link.kind === 'url' ? link.url : '' }
              : { kind: 'not_available', reason: link.kind === 'not_available' ? link.reason : '' },
          )
        }
      >
        <option value="url">URL</option>
        <option value="not_available">Not available</option>
      </select>
      {link.kind === 'url' ? (
        <input
          type="text"
          placeholder="https://…"
          value={link.url}
          onChange={(event) => onChange({ kind: 'url', url: event.target.value })}
        />
      ) : (
        <input
          type="text"
          placeholder="Reason it is not available"
          value={link.reason}
          onChange={(event) => onChange({ kind: 'not_available', reason: event.target.value })}
        />
      )}
    </div>
  );
}

function EvidenceReferenceField(props: {
  label: string;
  reference: EvidenceReference;
  onChange: (reference: EvidenceReference) => void;
  allowNotAvailable?: boolean;
}) {
  const { reference, onChange } = props;
  return (
    <div className="work-order-evidence-field">
      <span>{props.label}</span>
      <select
        value={reference.kind}
        onChange={(event) => {
          const kind = event.target.value;
          if (kind === 'url') onChange({ kind: 'url', url: '', provenance: '' });
          else if (kind === 'pasted_text')
            onChange({ kind: 'pasted_text', text: '', provenance: '' });
          else onChange({ kind: 'not_available', reason: '' });
        }}
      >
        <option value="url">URL</option>
        <option value="pasted_text">Pasted text</option>
        {props.allowNotAvailable !== false && <option value="not_available">Not available</option>}
      </select>
      {reference.kind === 'url' && (
        <>
          <input
            type="text"
            placeholder="https://…"
            value={reference.url}
            onChange={(event) => onChange({ ...reference, url: event.target.value })}
          />
          <input
            type="text"
            placeholder="Provenance (e.g. verified PR comment)"
            value={reference.provenance}
            onChange={(event) => onChange({ ...reference, provenance: event.target.value })}
          />
        </>
      )}
      {reference.kind === 'pasted_text' && (
        <>
          <textarea
            rows={3}
            placeholder="Paste the exact returned text"
            value={reference.text}
            onChange={(event) => onChange({ ...reference, text: event.target.value })}
          />
          <input
            type="text"
            placeholder="Provenance (e.g. owner-pasted, not independently verified)"
            value={reference.provenance}
            onChange={(event) => onChange({ ...reference, provenance: event.target.value })}
          />
        </>
      )}
      {reference.kind === 'not_available' && (
        <input
          type="text"
          placeholder="Reason it is not available"
          value={reference.reason}
          onChange={(event) => onChange({ kind: 'not_available', reason: event.target.value })}
        />
      )}
    </div>
  );
}

function CoordinatesFields(props: {
  coordinates: DeliveryCoordinates;
  onChange: (coordinates: DeliveryCoordinates) => void;
}) {
  const { coordinates, onChange } = props;
  return (
    <fieldset className="work-order-coordinates">
      <legend>Delivery coordinates</legend>
      <TextField
        label="Repository path"
        value={coordinates.repositoryPath}
        onChange={(repositoryPath) => onChange({ ...coordinates, repositoryPath })}
      />
      <LinkField
        label="Remote URL"
        link={coordinates.remoteUrl}
        onChange={(remoteUrl) => onChange({ ...coordinates, remoteUrl })}
      />
      <LinkField
        label="Issue URL"
        link={coordinates.issueUrl}
        onChange={(issueUrl) => onChange({ ...coordinates, issueUrl })}
      />
      <LinkField
        label="Pull request URL"
        link={coordinates.pullRequestUrl}
        onChange={(pullRequestUrl) => onChange({ ...coordinates, pullRequestUrl })}
      />
      <TextField
        label="Base branch"
        value={coordinates.baseBranch}
        onChange={(baseBranch) => onChange({ ...coordinates, baseBranch })}
      />
      <TextField
        label="Work branch"
        value={coordinates.workBranch}
        onChange={(workBranch) => onChange({ ...coordinates, workBranch })}
      />
      <TextField
        label="Start SHA (exact, full)"
        value={coordinates.startSha}
        onChange={(startSha) => onChange({ ...coordinates, startSha })}
      />
    </fieldset>
  );
}

function ValidationErrorsList(props: { errors: FieldIssue[] }) {
  if (props.errors.length === 0) return null;
  return (
    <div className="save-error" role="alert" aria-label="Missing requirements">
      <p>This packet is missing requirements:</p>
      <ul>
        {props.errors.map((issue) => (
          <li key={issue.field}>{issue.message}</li>
        ))}
      </ul>
    </div>
  );
}

interface ReportFormState {
  dispatchId: string;
  rawText: string;
  url: string;
  provider: string;
  tool: string;
  model: string;
  headSha: string;
  verificationNotes: string;
  limitations: string;
  provenance: string;
  /** True when this form's values came from a recovered pending report attempt (HAM3-009
   * Correction 3) rather than the owner opening a blank form — drives the "didn't finish" notice
   * and the Retry label; never affects what `submitReportForm` sends. */
  restored: boolean;
}

function emptyReportForm(dispatchId: string): ReportFormState {
  return {
    dispatchId,
    rawText: '',
    url: '',
    provider: '',
    tool: '',
    model: '',
    headSha: '',
    verificationNotes: '',
    limitations: '',
    provenance: '',
    restored: false,
  };
}

function reportFormFromPending(pending: WorkOrderPendingReportAttempt): ReportFormState {
  return {
    dispatchId: pending.dispatchId,
    rawText: pending.rawText,
    url: pending.url ?? '',
    provider: pending.returnedIdentity?.provider ?? '',
    tool: pending.returnedIdentity?.tool ?? '',
    model: pending.returnedIdentity?.model ?? '',
    headSha: pending.headSha ?? '',
    verificationNotes: pending.verificationNotes,
    limitations: pending.limitations,
    provenance: pending.provenance,
    restored: true,
  };
}

export function WorkOrdersPanel(props: WorkOrdersPanelProps) {
  const { service, ownerId, ownerEmail, projectId, taskId, taskTitle } = props;
  const directoryRootRef = useRef(props.directoryRoot);
  directoryRootRef.current = props.directoryRoot;

  const [stage, setStage] = useState<WorkOrderStage>('worker');
  const [packet, setPacket] = useState<WorkOrderFields | null>(null);
  const [loading, setLoading] = useState(true);
  const [expectedWorker, setExpectedWorker] = useState<ParticipantIdentity | null>(null);
  const [history, setHistory] = useState<WorkOrderDispatchSnapshot[]>([]);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [reportsByDispatch, setReportsByDispatch] = useState<
    Record<string, WorkOrderReportRecord[]>
  >({});
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [lastRecordedId, setLastRecordedId] = useState<string | null>(null);
  const [recoveredDispatchNotice, setRecoveredDispatchNotice] = useState<string | null>(null);

  const [reportForm, setReportForm] = useState<ReportFormState | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [recoveredReportNotice, setRecoveredReportNotice] = useState<{
    dispatchId: string;
    message: string;
  } | null>(null);

  const [injectionBusy, setInjectionBusy] = useState(false);
  const [injectionError, setInjectionError] = useState<string | null>(null);
  const [injectionMessage, setInjectionMessage] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<WorkOrderDispatchSnapshot | null>(
    null,
  );

  const loadTokenRef = useRef(0);
  /** Guards the async pending-report lookup kicked off when a dispatch is opened (HAM3-009
   * Correction 3): bumped whenever the owner/project/task/stage context resets (the main load
   * effect below) or a different dispatch is opened, so a late-resolving lookup for a
   * since-abandoned context is recognized as stale and dropped rather than populating the wrong
   * dispatch's form. */
  const reportPendingTokenRef = useRef(0);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const computeDefaults = useCallback(
    async (nextStage: WorkOrderStage): Promise<WorkOrderFields> => {
      const humanOwner = ownerEmail ?? '';
      const repositoryPath = directoryRootRef.current ?? undefined;
      if (nextStage === 'worker') {
        return {
          stage: 'worker',
          fields: await service.defaultWorkerFields({
            projectId,
            taskId,
            humanOwner,
            repositoryPath,
          }),
        };
      }
      if (nextStage === 'correction') {
        return {
          stage: 'correction',
          fields: await service.defaultCorrectionFields({
            ownerId,
            projectId,
            taskId,
            humanOwner,
            repositoryPath,
          }),
        };
      }
      return {
        stage: 'audit',
        fields: await service.defaultAuditFields({
          ownerId,
          projectId,
          taskId,
          humanOwner,
          repositoryPath,
        }),
      };
    },
    [service, ownerId, ownerEmail, projectId, taskId],
  );

  const refreshHistory = useCallback(async () => {
    const list = await service.listHistory(ownerId, taskId);
    setHistory(list);
    return list;
  }, [service, ownerId, taskId]);

  useEffect(() => {
    let cancelled = false;
    const token = ++loadTokenRef.current;
    // Invalidates any in-flight pending-report lookup from the context this effect is leaving —
    // otherwise it could resolve after `reportForm` below is reset to null and repopulate it with
    // the previous owner/project/task/stage's recovered content.
    ++reportPendingTokenRef.current;
    setLoading(true);
    setPendingConfirmation(null);
    setInjectionMessage(null);
    setInjectionError(null);
    setExpandedHistoryId(null);
    setReportForm(null);
    setRecordError(null);
    setCopyStatus('idle');
    setRecoveredDispatchNotice(null);
    setRecoveredReportNotice(null);

    void (async () => {
      const draft = await service.readDraft({ ownerId, projectId, taskId, stage });
      const nextPacket = draft ?? (await computeDefaults(stage));
      const original = await service.getOriginalWorkerIdentity(ownerId, taskId);
      const list = await service.listHistory(ownerId, taskId);
      if (cancelled || loadTokenRef.current !== token) return;
      setPacket(nextPacket);
      setExpectedWorker(original);
      setHistory(list);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [service, ownerId, projectId, taskId, stage, computeDefaults]);

  function persistDraft(next: WorkOrderFields) {
    void service
      .writeDraft({ ownerId, projectId, taskId, stage: next.stage, packet: next })
      .catch(() => undefined);
  }

  function updateWorkerFields(mutate: (fields: WorkerPacketFields) => WorkerPacketFields) {
    setPacket((current) => {
      if (!current || current.stage !== 'worker') return current;
      const next: WorkOrderFields = { stage: 'worker', fields: mutate(current.fields) };
      persistDraft(next);
      return next;
    });
  }

  function updateCorrectionFields(
    mutate: (fields: CorrectionPacketFields) => CorrectionPacketFields,
  ) {
    setPacket((current) => {
      if (!current || current.stage !== 'correction') return current;
      const next: WorkOrderFields = { stage: 'correction', fields: mutate(current.fields) };
      persistDraft(next);
      return next;
    });
  }

  function updateAuditFields(mutate: (fields: AuditPacketFields) => AuditPacketFields) {
    setPacket((current) => {
      if (!current || current.stage !== 'audit') return current;
      const next: WorkOrderFields = { stage: 'audit', fields: mutate(current.fields) };
      persistDraft(next);
      return next;
    });
  }

  const validation = packet ? service.validatePacket(packet, { expectedWorker }) : null;
  const content = packet ? service.generateContent(packet) : '';

  async function handleCopy(text: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is not available.');
      await navigator.clipboard.writeText(text);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  }

  async function handleRecord() {
    if (!packet || !validation?.isValid) return;
    setRecording(true);
    setRecordError(null);
    setRecoveredDispatchNotice(null);

    try {
      // No id is generated or held here: `recordDispatchDurable` derives and durably persists the
      // attempt's own identity from owner/project/task/stage, so it discovers and repairs an
      // earlier partial attempt (an unindexed document from a prior click, a stage switch, a
      // remount, or a full app restart) on its own — nothing but this call is needed to recover it.
      const { snapshot, recoveredOriginal } = await service.recordDispatchDurable({
        ownerId,
        projectId,
        taskId,
        packet,
        expectedWorker,
      });
      await service.clearDraft({ ownerId, projectId, taskId, stage });
      setLastRecordedId(snapshot.id);
      setRecoveredDispatchNotice(
        recoveredOriginal
          ? `Also recovered an earlier partial attempt as dispatch ${recoveredOriginal.id} — it is preserved in history below, unedited.`
          : null,
      );
      await refreshHistory();
      const original = await service.getOriginalWorkerIdentity(ownerId, taskId);
      setExpectedWorker(original);
      setPacket(await computeDefaults(stage));
    } catch (error) {
      setRecordError(errorMessage(error));
    } finally {
      setRecording(false);
    }
  }

  async function toggleHistoryItem(dispatch: WorkOrderDispatchSnapshot) {
    if (expandedHistoryId === dispatch.id) {
      setExpandedHistoryId(null);
      return;
    }
    setExpandedHistoryId(dispatch.id);
    const dispatchId = dispatch.id;
    // Scopes this lookup to the exact dispatch/context being opened right now — a later switch to
    // a different dispatch, or a task/owner/stage reset, bumps this token and makes the check below
    // recognize this lookup as stale.
    const token = ++reportPendingTokenRef.current;
    if (!reportsByDispatch[dispatchId]) {
      const reports = await service.getReportsForDispatch(ownerId, dispatchId);
      setReportsByDispatch((current) => ({ ...current, [dispatchId]: reports }));
    }
    const pending = await service.getPendingReportAttempt(ownerId, dispatchId);
    if (!isMountedRef.current || reportPendingTokenRef.current !== token) return;
    if (!pending) return;
    let applied = false;
    setReportForm((current) => {
      // The owner already has a report form open (restored earlier, or opened by hand and possibly
      // typed into since this lookup began) — never clobber it with a late-arriving result.
      if (current !== null) return current;
      applied = true;
      return reportFormFromPending(pending);
    });
    if (applied) {
      setAttachError(null);
      setRecoveredReportNotice(null);
    }
  }

  async function runInject(dispatch: WorkOrderDispatchSnapshot, forceReplace: boolean) {
    const root = directoryRootRef.current;
    if (!root) {
      setInjectionError('No directory is open — link one to inject.');
      return;
    }
    setInjectionBusy(true);
    setInjectionError(null);
    setInjectionMessage(null);
    try {
      const outcome: WorkOrderInjectOutcome = await service.injectDispatch({
        root,
        dispatch,
        forceReplace,
      });
      if (outcome.kind === 'RequiresConfirmation') {
        setPendingConfirmation(dispatch);
      } else {
        setPendingConfirmation(null);
        setInjectionMessage(`Written to ${outcome.relativePath}.`);
      }
    } catch (error) {
      setInjectionError(errorMessage(error));
    } finally {
      setInjectionBusy(false);
    }
  }

  function beginReportForm(dispatchId: string) {
    setReportForm(emptyReportForm(dispatchId));
    setAttachError(null);
    setRecoveredReportNotice(null);
  }

  async function submitReportForm() {
    if (!reportForm) return;
    setAttaching(true);
    setAttachError(null);
    setRecoveredReportNotice(null);
    const returnedIdentity: ReturnedIdentity | null =
      reportForm.provider.trim() || reportForm.tool.trim() || reportForm.model.trim()
        ? { provider: reportForm.provider, tool: reportForm.tool, model: reportForm.model }
        : null;

    try {
      // No id is generated or held here — see `handleRecord`'s comment: `attachReportDurable`
      // recovers an earlier partial attempt on its own, scoped by this report's fixed dispatchId.
      const { report, recoveredOriginal } = await service.attachReportDurable({
        ownerId,
        projectId,
        taskId,
        dispatchId: reportForm.dispatchId,
        rawText: reportForm.rawText,
        url: reportForm.url.trim() ? reportForm.url.trim() : null,
        returnedIdentity,
        headSha: reportForm.headSha.trim() ? reportForm.headSha.trim() : null,
        verificationNotes: reportForm.verificationNotes,
        limitations: reportForm.limitations,
        provenance: reportForm.provenance,
      });
      setReportsByDispatch((current) => {
        const existing = current[report.dispatchId] ?? [];
        const withRecoveredOriginal = recoveredOriginal
          ? [recoveredOriginal, ...existing.filter((r) => r.id !== recoveredOriginal.id)]
          : existing;
        return {
          ...current,
          [report.dispatchId]: [report, ...withRecoveredOriginal.filter((r) => r.id !== report.id)],
        };
      });
      setRecoveredReportNotice(
        recoveredOriginal
          ? {
              dispatchId: report.dispatchId,
              message: `Also recovered an earlier partial attempt as report ${recoveredOriginal.id} — it is preserved above, unedited.`,
            }
          : null,
      );
      setReportForm(null);
    } catch (error) {
      setAttachError(errorMessage(error));
    } finally {
      setAttaching(false);
    }
  }

  if (loading || !packet) {
    return (
      <section className="work-order-panel" aria-label={`Work orders for ${taskTitle}`}>
        <p className="muted-copy">Loading work orders…</p>
      </section>
    );
  }

  return (
    <section className="work-order-panel" aria-label={`Work orders for ${taskTitle}`}>
      <p className="card-kicker">Work orders — {taskTitle}</p>
      <div className="work-order-stage-tabs" role="tablist" aria-label="Packet stage">
        {(['worker', 'correction', 'audit'] as const).map((tabStage) => (
          <button
            key={tabStage}
            type="button"
            role="tab"
            aria-selected={stage === tabStage}
            className={`button button-small ${stage === tabStage ? 'button-primary' : 'button-quiet'}`}
            onClick={() => setStage(tabStage)}
          >
            {STAGE_LABEL[tabStage]}
          </button>
        ))}
      </div>

      {stage === 'worker' && packet.stage === 'worker' && (
        <div className="stack-form work-order-form">
          <TextField
            label="Human owner"
            value={packet.fields.humanOwner}
            onChange={(humanOwner) => updateWorkerFields((f) => ({ ...f, humanOwner }))}
          />
          <IdentityFields
            legend="Active orchestrator"
            identity={packet.fields.activeOrchestrator}
            onChange={(activeOrchestrator) =>
              updateWorkerFields((f) => ({ ...f, activeOrchestrator }))
            }
          />
          <IdentityFields
            legend="Assigned worker"
            identity={packet.fields.assignedWorker}
            onChange={(assignedWorker) => updateWorkerFields((f) => ({ ...f, assignedWorker }))}
          />
          <IdentityFields
            legend="Assigned auditor (after delivery)"
            identity={packet.fields.assignedAuditor}
            onChange={(assignedAuditor) => updateWorkerFields((f) => ({ ...f, assignedAuditor }))}
          />
          {!isIndependentFamily(packet.fields.assignedWorker, packet.fields.assignedAuditor) &&
            packet.fields.assignedWorker.provider.trim() !== '' &&
            packet.fields.assignedAuditor.provider.trim() !== '' && (
              <p className="save-error" role="alert">
                The assigned auditor must be a different provider family than the assigned worker.
              </p>
            )}
          <CoordinatesFields
            coordinates={packet.fields.coordinates}
            onChange={(coordinates) => updateWorkerFields((f) => ({ ...f, coordinates }))}
          />
          <TextAreaField
            label="Scope"
            value={packet.fields.scope}
            onChange={(scope) => updateWorkerFields((f) => ({ ...f, scope }))}
          />
          <TextAreaField
            label="Non-scope"
            value={packet.fields.nonScope}
            onChange={(nonScope) => updateWorkerFields((f) => ({ ...f, nonScope }))}
          />
          <TextAreaField
            label="Acceptance criteria"
            value={packet.fields.acceptance}
            onChange={(acceptance) => updateWorkerFields((f) => ({ ...f, acceptance }))}
          />
          <TextAreaField
            label="Verification"
            value={packet.fields.verification}
            onChange={(verification) => updateWorkerFields((f) => ({ ...f, verification }))}
          />
          <TextAreaField
            label="Required return evidence"
            value={packet.fields.requiredEvidence}
            onChange={(requiredEvidence) => updateWorkerFields((f) => ({ ...f, requiredEvidence }))}
          />
          <TextAreaField
            label="Stop rules"
            value={packet.fields.stopRules}
            onChange={(stopRules) => updateWorkerFields((f) => ({ ...f, stopRules }))}
          />
        </div>
      )}

      {stage === 'correction' && packet.stage === 'correction' && (
        <div className="stack-form work-order-form">
          {expectedWorker ? (
            <p className="muted-copy">
              Original worker on record: {formatIdentity(expectedWorker)}
            </p>
          ) : (
            <p className="muted-copy">No prior Worker dispatch is on record for this task yet.</p>
          )}
          <TextField
            label="Correction number"
            value={String(packet.fields.correctionNumber)}
            onChange={(value) =>
              updateCorrectionFields((f) => ({ ...f, correctionNumber: Number(value) || 1 }))
            }
          />
          <TextField
            label="Human owner"
            value={packet.fields.humanOwner}
            onChange={(humanOwner) => updateCorrectionFields((f) => ({ ...f, humanOwner }))}
          />
          <IdentityFields
            legend="Active orchestrator"
            identity={packet.fields.activeOrchestrator}
            onChange={(activeOrchestrator) =>
              updateCorrectionFields((f) => ({ ...f, activeOrchestrator }))
            }
          />
          <IdentityFields
            legend="Assigned worker (must be the original worker)"
            identity={packet.fields.assignedWorker}
            onChange={(assignedWorker) => updateCorrectionFields((f) => ({ ...f, assignedWorker }))}
          />
          <IdentityFields
            legend="Assigned re-auditor"
            identity={packet.fields.assignedReauditor}
            onChange={(assignedReauditor) =>
              updateCorrectionFields((f) => ({ ...f, assignedReauditor }))
            }
          />
          <CoordinatesFields
            coordinates={packet.fields.coordinates}
            onChange={(coordinates) => updateCorrectionFields((f) => ({ ...f, coordinates }))}
          />
          <TextField
            label="Previous head SHA (exact, full)"
            value={packet.fields.previousHeadSha}
            onChange={(previousHeadSha) =>
              updateCorrectionFields((f) => ({ ...f, previousHeadSha }))
            }
          />
          <EvidenceReferenceField
            label="Audit report reference"
            reference={packet.fields.auditReportReference}
            onChange={(auditReportReference) =>
              updateCorrectionFields((f) => ({ ...f, auditReportReference }))
            }
            allowNotAvailable={false}
          />
          <TextAreaField
            label="Required corrections"
            value={packet.fields.requiredCorrections}
            onChange={(requiredCorrections) =>
              updateCorrectionFields((f) => ({ ...f, requiredCorrections }))
            }
          />
          <TextAreaField
            label="Expected return evidence"
            value={packet.fields.expectedReturnEvidence}
            onChange={(expectedReturnEvidence) =>
              updateCorrectionFields((f) => ({ ...f, expectedReturnEvidence }))
            }
          />
        </div>
      )}

      {stage === 'audit' && packet.stage === 'audit' && (
        <div className="stack-form work-order-form">
          <TextField
            label="Human owner"
            value={packet.fields.humanOwner}
            onChange={(humanOwner) => updateAuditFields((f) => ({ ...f, humanOwner }))}
          />
          <IdentityFields
            legend="Active orchestrator"
            identity={packet.fields.activeOrchestrator}
            onChange={(activeOrchestrator) =>
              updateAuditFields((f) => ({ ...f, activeOrchestrator }))
            }
          />
          <IdentityFields
            legend="Author worker"
            identity={packet.fields.authorWorker}
            onChange={(authorWorker) => updateAuditFields((f) => ({ ...f, authorWorker }))}
          />
          <IdentityFields
            legend="Assigned auditor (different family)"
            identity={packet.fields.assignedAuditor}
            onChange={(assignedAuditor) => updateAuditFields((f) => ({ ...f, assignedAuditor }))}
          />
          {!isIndependentFamily(packet.fields.authorWorker, packet.fields.assignedAuditor) &&
            packet.fields.authorWorker.provider.trim() !== '' &&
            packet.fields.assignedAuditor.provider.trim() !== '' && (
              <p className="save-error" role="alert">
                The assigned auditor must be a different provider family than the author worker.
              </p>
            )}
          <TextField
            label="Repository path"
            value={packet.fields.repositoryPath}
            onChange={(repositoryPath) => updateAuditFields((f) => ({ ...f, repositoryPath }))}
          />
          <LinkField
            label="Remote URL"
            link={packet.fields.remoteUrl}
            onChange={(remoteUrl) => updateAuditFields((f) => ({ ...f, remoteUrl }))}
          />
          <TextField
            label="Base branch"
            value={packet.fields.baseBranch}
            onChange={(baseBranch) => updateAuditFields((f) => ({ ...f, baseBranch }))}
          />
          <TextField
            label="Base SHA (exact, full)"
            value={packet.fields.baseSha}
            onChange={(baseSha) => updateAuditFields((f) => ({ ...f, baseSha }))}
          />
          <TextField
            label="Pull request URL (required, real link)"
            value={packet.fields.pullRequestUrl}
            onChange={(pullRequestUrl) => updateAuditFields((f) => ({ ...f, pullRequestUrl }))}
          />
          <TextField
            label="Reviewed head SHA (exact, full)"
            value={packet.fields.reviewedHeadSha}
            onChange={(reviewedHeadSha) => updateAuditFields((f) => ({ ...f, reviewedHeadSha }))}
          />
          <EvidenceReferenceField
            label="Worker report reference"
            reference={packet.fields.workerReportReference}
            onChange={(workerReportReference) =>
              updateAuditFields((f) => ({ ...f, workerReportReference }))
            }
            allowNotAvailable={false}
          />
          <TextAreaField
            label="Acceptance criteria"
            value={packet.fields.acceptance}
            onChange={(acceptance) => updateAuditFields((f) => ({ ...f, acceptance }))}
          />
          <TextAreaField
            label="Verification"
            value={packet.fields.verification}
            onChange={(verification) => updateAuditFields((f) => ({ ...f, verification }))}
          />
        </div>
      )}

      <ValidationErrorsList errors={validation?.errors ?? []} />

      <div className="work-order-preview">
        <p className="card-kicker">Exact candidate text</p>
        <pre className="instruction-preview-output" aria-label="Generated packet text">
          {content}
        </pre>
        <div className="form-actions">
          <button
            type="button"
            className="button button-quiet"
            onClick={() => void handleCopy(content)}
          >
            Copy
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={!validation?.isValid || recording}
            onClick={() => void handleRecord()}
          >
            {recording ? 'Recording…' : 'Record dispatch'}
          </button>
        </div>
        {copyStatus === 'copied' && <p className="muted-copy">Copied.</p>}
        {copyStatus === 'error' && (
          <p className="save-error" role="alert">
            Copy failed — select and copy the text above manually.
          </p>
        )}
        {recordError && (
          <p className="save-error" role="alert">
            {recordError}
          </p>
        )}
        {lastRecordedId && !recording && !recordError && (
          <p className="muted-copy">Recorded as dispatch {lastRecordedId}.</p>
        )}
        {recoveredDispatchNotice && !recording && !recordError && (
          <p className="muted-copy">{recoveredDispatchNotice}</p>
        )}
      </div>

      <div className="work-order-history">
        <p className="card-kicker">History ({history.length})</p>
        {history.length === 0 && (
          <p className="muted-copy">No dispatches recorded yet for this task.</p>
        )}
        <ul className="work-order-history-list">
          {history.map((dispatch) => {
            const identity = dispatchIdentityFor(dispatch);
            const reports = reportsByDispatch[dispatch.id] ?? [];
            return (
              <li key={dispatch.id} className="work-order-history-item">
                <button
                  type="button"
                  className="button button-small button-quiet"
                  onClick={() => void toggleHistoryItem(dispatch)}
                >
                  {STAGE_LABEL[dispatch.stage]} · {new Date(dispatch.createdAt).toLocaleString()}
                  {identity ? ` · ${formatIdentity(identity)}` : ''}
                </button>
                {expandedHistoryId === dispatch.id && (
                  <div className="work-order-history-detail">
                    <pre className="instruction-preview-output">{dispatch.content}</pre>
                    <div className="form-actions">
                      <button
                        type="button"
                        className="button button-small button-quiet"
                        onClick={() => void handleCopy(dispatch.content)}
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        className="button button-small"
                        disabled={injectionBusy}
                        onClick={() => void runInject(dispatch, false)}
                      >
                        Inject this packet
                      </button>
                      {reportForm?.dispatchId !== dispatch.id && (
                        <button
                          type="button"
                          className="button button-small button-quiet"
                          onClick={() => beginReportForm(dispatch.id)}
                        >
                          Attach returned report
                        </button>
                      )}
                    </div>

                    {pendingConfirmation?.id === dispatch.id && (
                      <div className="save-error" role="alert">
                        <p>
                          The target file already holds different content (unmanaged or a different
                          task&apos;s packet). Replacing it overwrites that content.
                        </p>
                        <div className="form-actions">
                          <button
                            type="button"
                            className="button button-danger button-small"
                            onClick={() => void runInject(dispatch, true)}
                          >
                            Replace
                          </button>
                          <button
                            type="button"
                            className="button button-quiet button-small"
                            onClick={() => setPendingConfirmation(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {injectionError && (
                      <p className="save-error" role="alert">
                        {injectionError}
                      </p>
                    )}
                    {injectionMessage && <p className="muted-copy">{injectionMessage}</p>}

                    <p className="card-kicker">Returned reports ({reports.length})</p>
                    {recoveredReportNotice?.dispatchId === dispatch.id && (
                      <p className="muted-copy">{recoveredReportNotice.message}</p>
                    )}
                    {reports.map((report) => {
                      const mismatched =
                        report.returnedIdentity !== null &&
                        identity !== null &&
                        !identitiesEqual(identity, {
                          provider: report.returnedIdentity.provider,
                          tool: report.returnedIdentity.tool,
                          model: report.returnedIdentity.model,
                        });
                      return (
                        <div key={report.id} className="work-order-report">
                          <p className="muted-copy">
                            Recorded {new Date(report.recordedAt).toLocaleString()} · provenance:{' '}
                            {report.provenance || 'not stated'}
                          </p>
                          {mismatched && (
                            <p className="save-error" role="alert">
                              Returned identity differs from the dispatched identity.
                            </p>
                          )}
                          {report.headSha && (
                            <p className="muted-copy">Head SHA: {report.headSha}</p>
                          )}
                          {report.url && <p className="muted-copy">URL: {report.url}</p>}
                          <pre className="instruction-preview-output">
                            {report.rawText || '(no raw text supplied)'}
                          </pre>
                        </div>
                      );
                    })}

                    {reportForm?.dispatchId === dispatch.id && (
                      <div className="stack-form work-order-report-form">
                        {reportForm.restored && (
                          <p className="muted-copy" role="status">
                            Previous report save didn&apos;t finish. Retry recording.
                          </p>
                        )}
                        <TextAreaField
                          label="Raw returned text"
                          value={reportForm.rawText}
                          onChange={(rawText) => setReportForm((f) => (f ? { ...f, rawText } : f))}
                        />
                        <TextField
                          label="URL (optional)"
                          value={reportForm.url}
                          onChange={(url) => setReportForm((f) => (f ? { ...f, url } : f))}
                        />
                        <TextField
                          label="Returned provider"
                          value={reportForm.provider}
                          onChange={(provider) =>
                            setReportForm((f) => (f ? { ...f, provider } : f))
                          }
                        />
                        <TextField
                          label="Returned tool"
                          value={reportForm.tool}
                          onChange={(tool) => setReportForm((f) => (f ? { ...f, tool } : f))}
                        />
                        <TextField
                          label="Returned model"
                          value={reportForm.model}
                          onChange={(model) => setReportForm((f) => (f ? { ...f, model } : f))}
                        />
                        <TextField
                          label="Head SHA (optional)"
                          value={reportForm.headSha}
                          onChange={(headSha) => setReportForm((f) => (f ? { ...f, headSha } : f))}
                        />
                        <TextAreaField
                          label="Verification notes"
                          value={reportForm.verificationNotes}
                          onChange={(verificationNotes) =>
                            setReportForm((f) => (f ? { ...f, verificationNotes } : f))
                          }
                        />
                        <TextAreaField
                          label="Limitations"
                          value={reportForm.limitations}
                          onChange={(limitations) =>
                            setReportForm((f) => (f ? { ...f, limitations } : f))
                          }
                        />
                        <TextField
                          label="Provenance"
                          value={reportForm.provenance}
                          onChange={(provenance) =>
                            setReportForm((f) => (f ? { ...f, provenance } : f))
                          }
                        />
                        {attachError && (
                          <p className="save-error" role="alert">
                            {attachError}
                          </p>
                        )}
                        <div className="form-actions">
                          <button
                            type="button"
                            className="button button-primary button-small"
                            disabled={attaching}
                            onClick={() => void submitReportForm()}
                          >
                            {attaching
                              ? 'Attaching…'
                              : reportForm.restored
                                ? 'Retry recording'
                                : 'Attach report'}
                          </button>
                          <button
                            type="button"
                            className="button button-quiet button-small"
                            onClick={() => setReportForm(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

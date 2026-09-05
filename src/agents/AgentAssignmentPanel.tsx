import { useCallback, useEffect, useRef, useState } from 'react';

import type { AssignmentsService } from '../assignments/service';
import type { AgentAssignment } from '../assignments/types';
import { INSTRUCTION_ROLES, PROVIDER_FAMILIES } from '../instructions/types';
import type { InstructionRole, ProviderFamily } from '../instructions/types';
import type { HarnessClassification } from '../harness/types';
import type { HarnessInjectionService } from '../harness/service';
import type { InjectionPreview } from '../harness/types';

export interface AgentAssignmentPanelProject {
  id: string;
  name: string;
}

export interface AgentAssignmentPanelProps {
  assignmentsService: AssignmentsService;
  harnessService: HarnessInjectionService;
  project: AgentAssignmentPanelProject;
  /** The linked local directory's absolute root path, or `null` if this project has no linked directory. */
  directoryRoot: string | null;
}

function roleLabel(role: InstructionRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function providerLabel(provider: ProviderFamily): string {
  return provider
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function classificationLabel(classification: HarnessClassification): string {
  switch (classification.kind) {
    case 'Missing':
      return 'Not created yet';
    case 'ManagedValid':
      return 'Hammond-managed';
    case 'ManagedForeign':
      return `Belongs to a different project or role (${roleLabel(classification.header.role)}, project ${classification.header.projectId})`;
    case 'ManagedMalformed':
      return 'Hammond-managed (malformed — will be repaired)';
    case 'Unmanaged':
      return 'Unmanaged — existing owner content present';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'That action failed. Nothing was changed.';
}

/**
 * The minimal HAM3-006 owner-operable surface: distinct "Execution provider" controls for each
 * role (Agent assignment), plus a role-scoped injection preview and Inject/Update/Remove/Retry
 * actions. Full Customize/Advanced editing and version history remain HAM3-007's Instruction
 * Studio; this panel never recreates HAM3-005's three-column layer editor.
 */
export function AgentAssignmentPanel({
  assignmentsService,
  harnessService,
  project,
  directoryRoot,
}: AgentAssignmentPanelProps) {
  const [assignments, setAssignments] = useState<AgentAssignment[] | null>(null);
  const [assignmentsLoading, setAssignmentsLoading] = useState(true);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [savingRole, setSavingRole] = useState<InstructionRole | null>(null);

  const [selectedRole, setSelectedRole] = useState<InstructionRole>('worker');
  const [preview, setPreview] = useState<InjectionPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const lastActionRef = useRef<(() => Promise<unknown>) | null>(null);

  const loadAssignments = useCallback(async () => {
    setAssignmentsLoading(true);
    setAssignmentError(null);
    try {
      setAssignments(await assignmentsService.listForProject(project.id));
    } catch (error) {
      setAssignmentError(errorMessage(error));
    } finally {
      setAssignmentsLoading(false);
    }
  }, [assignmentsService, project.id]);

  useEffect(() => {
    void loadAssignments();
  }, [loadAssignments]);

  const loadPreview = useCallback(async () => {
    if (!directoryRoot) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      setPreview(
        await harnessService.preview({
          root: directoryRoot,
          projectId: project.id,
          role: selectedRole,
        }),
      );
    } catch (error) {
      setPreviewError(errorMessage(error));
    } finally {
      setPreviewLoading(false);
    }
  }, [harnessService, directoryRoot, project.id, selectedRole]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview, refreshToken]);

  function refresh() {
    setRefreshToken((token) => token + 1);
  }

  async function changeProvider(role: InstructionRole, provider: ProviderFamily) {
    setSavingRole(role);
    setAssignmentError(null);
    try {
      if (directoryRoot) {
        await harnessService.switchProviderAndInject({
          root: directoryRoot,
          projectId: project.id,
          role,
          newProvider: provider,
        });
      } else {
        await assignmentsService.updateAssignment({ projectId: project.id, role, provider });
      }
      await loadAssignments();
      refresh();
    } catch (error) {
      setAssignmentError(errorMessage(error));
    } finally {
      setSavingRole(null);
    }
  }

  async function runAction(action: () => Promise<unknown>) {
    lastActionRef.current = action;
    setActionBusy(true);
    setActionError(null);
    try {
      await action();
      refresh();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setActionBusy(false);
    }
  }

  function runInject(forceReplace: boolean) {
    if (!directoryRoot) return;
    void runAction(() =>
      harnessService.inject({
        root: directoryRoot,
        projectId: project.id,
        role: selectedRole,
        forceReplace,
      }),
    );
  }

  function runImport() {
    if (!directoryRoot) return;
    void runAction(() =>
      harnessService.importThenReplace({
        root: directoryRoot,
        projectId: project.id,
        role: selectedRole,
      }),
    );
  }

  function runRemove() {
    if (!directoryRoot) return;
    void runAction(() =>
      harnessService.remove({ root: directoryRoot, projectId: project.id, role: selectedRole }),
    );
  }

  function retry() {
    if (!lastActionRef.current) return;
    void runAction(lastActionRef.current);
  }

  function cancelConflict() {
    setActionError(null);
    lastActionRef.current = null;
  }

  const injectLabel =
    preview?.action === 'create' ? 'Inject' : preview?.action === 'repair' ? 'Repair' : 'Update';

  return (
    <div className="agent-assignment-panel">
      <section aria-labelledby="agent-assignment-heading">
        <div className="section-heading compact-heading">
          <div>
            <p className="eyebrow">Agent assignment</p>
            <h2 id="agent-assignment-heading">Which AI performs each role?</h2>
          </div>
        </div>

        {assignmentError && (
          <div className="save-error" role="alert">
            <span>{assignmentError}</span>
            <button
              className="button button-small"
              type="button"
              onClick={() => void loadAssignments()}
            >
              Retry
            </button>
          </div>
        )}

        {assignmentsLoading ? (
          <p className="sidebar-empty">Loading assignments…</p>
        ) : (
          <ul className="agent-assignment-list">
            {INSTRUCTION_ROLES.map((role) => {
              const assignment = assignments?.find((a) => a.role === role) ?? null;
              return (
                <li key={role} className="agent-assignment-row">
                  <span className="agent-assignment-role">{roleLabel(role)}</span>
                  <label>
                    Execution provider
                    <select
                      value={assignment?.provider ?? ''}
                      disabled={savingRole === role || !assignment}
                      onChange={(event) =>
                        void changeProvider(role, event.target.value as ProviderFamily)
                      }
                      aria-label={`${roleLabel(role)} execution provider`}
                    >
                      {PROVIDER_FAMILIES.map((provider) => (
                        <option key={provider} value={provider}>
                          {providerLabel(provider)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {savingRole === role && <span className="agent-assignment-saving">Saving…</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="instruction-preview-section" aria-labelledby="injection-preview-heading">
        <div className="section-heading compact-heading">
          <div>
            <p className="eyebrow">Injection preview</p>
            <h2 id="injection-preview-heading">
              {preview
                ? `${roleLabel(preview.role)} instructions for ${providerLabel(preview.provider)}`
                : `${roleLabel(selectedRole)} instructions`}
            </h2>
          </div>
          <label>
            Role
            <select
              value={selectedRole}
              onChange={(event) => setSelectedRole(event.target.value as InstructionRole)}
            >
              {INSTRUCTION_ROLES.map((role) => (
                <option key={role} value={role}>
                  {roleLabel(role)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {!directoryRoot ? (
          <p className="sidebar-empty">
            Link a local directory for {project.name} to preview and inject instructions.
          </p>
        ) : previewLoading ? (
          <p className="sidebar-empty">Loading preview…</p>
        ) : previewError ? (
          <div className="save-error" role="alert">
            <span>Preview failed: {previewError}</span>
            <button className="button button-small" type="button" onClick={refresh}>
              Retry
            </button>
          </div>
        ) : preview ? (
          <>
            <dl className="agent-injection-meta">
              <div>
                <dt>Linked directory</dt>
                <dd>
                  <code>{directoryRoot}</code>
                </dd>
              </div>
              <div>
                <dt>Target path</dt>
                <dd>
                  <code>{preview.relativePath}</code>
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{classificationLabel(preview.classification)}</dd>
              </div>
            </dl>

            <h3>Composed preview</h3>
            <pre className="instruction-preview-output" aria-label="Composed preview">
              {preview.effectiveContent || '(nothing composed yet)'}
            </pre>

            {actionError && (
              <div className="save-error" role="alert">
                <span>{actionError}</span>
                <button
                  className="button button-small"
                  type="button"
                  onClick={retry}
                  disabled={actionBusy}
                >
                  Retry
                </button>
              </div>
            )}

            {preview.classification.kind === 'ManagedForeign' && (
              <p className="save-error" role="alert">
                This target already holds a Hammond-managed document for{' '}
                <strong>{roleLabel(preview.classification.header.role)}</strong> in project{' '}
                <code>{preview.classification.header.projectId}</code>, not this role/project.
                Import is not offered — that would fold someone else&apos;s instructions into this
                project. Choose Replace to overwrite it, or Cancel to leave it untouched.
              </p>
            )}

            <div className="form-actions">
              {preview.classification.kind === 'Unmanaged' ? (
                <>
                  <button
                    className="button button-primary"
                    type="button"
                    onClick={runImport}
                    disabled={actionBusy}
                  >
                    Import existing content
                  </button>
                  <button
                    className="button button-danger"
                    type="button"
                    onClick={() => runInject(true)}
                    disabled={actionBusy}
                  >
                    Replace
                  </button>
                  <button className="button button-quiet" type="button" onClick={cancelConflict}>
                    Cancel
                  </button>
                </>
              ) : preview.classification.kind === 'ManagedForeign' ? (
                <>
                  <button
                    className="button button-danger"
                    type="button"
                    onClick={() => runInject(true)}
                    disabled={actionBusy}
                  >
                    Replace
                  </button>
                  <button className="button button-quiet" type="button" onClick={cancelConflict}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="button button-primary"
                    type="button"
                    onClick={() => runInject(false)}
                    disabled={actionBusy}
                  >
                    {actionBusy ? 'Working…' : injectLabel}
                  </button>
                  {preview.classification.kind === 'ManagedValid' && (
                    <button
                      className="button button-quiet"
                      type="button"
                      onClick={runRemove}
                      disabled={actionBusy}
                    >
                      Remove
                    </button>
                  )}
                </>
              )}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}

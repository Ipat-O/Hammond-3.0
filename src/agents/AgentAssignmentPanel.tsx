import { useCallback, useEffect, useState } from 'react';

import type { AssignmentsService } from '../assignments/service';
import type { AgentAssignment } from '../assignments/types';
import { INSTRUCTION_ROLES } from '../instructions/types';
import type { InstructionRole, ProviderFamily } from '../instructions/types';
import { PROVIDER_FAMILIES } from '../instructions/types';
import type { HarnessInjectionService } from '../harness/service';

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
  /** Which role's row is highlighted as "currently shown below" in the Instruction Studio. */
  selectedRole?: InstructionRole;
  /** Called when the owner picks a different role row to view/edit effective instructions for. */
  onSelectRole?: (role: InstructionRole) => void;
  /** Called after a provider assignment change (direct update or a full safe provider switch) completes. */
  onAssignmentChanged?: () => void;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'That action failed. Nothing was changed.';
}

/**
 * The "Agent assignment" section of the Instruction Studio: distinct Execution provider controls
 * for orchestrator, worker, and auditor. Instruction-variant customization elsewhere in the
 * Studio never touches this data — the only way a role's execution provider changes is here,
 * through the safe provider-switch workflow (`switchProviderAndInject` when a directory is
 * linked, so the prior provider's managed target is cleaned up and the new one is injected in one
 * step; a plain assignment update when there is nothing local to migrate).
 */
export function AgentAssignmentPanel({
  assignmentsService,
  harnessService,
  project,
  directoryRoot,
  selectedRole,
  onSelectRole,
  onAssignmentChanged,
}: AgentAssignmentPanelProps) {
  const [assignments, setAssignments] = useState<AgentAssignment[] | null>(null);
  const [assignmentsLoading, setAssignmentsLoading] = useState(true);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [savingRole, setSavingRole] = useState<InstructionRole | null>(null);

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
      onAssignmentChanged?.();
    } catch (error) {
      setAssignmentError(errorMessage(error));
    } finally {
      setSavingRole(null);
    }
  }

  return (
    <section className="agent-assignment-panel" aria-labelledby="agent-assignment-heading">
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
            const isSelected = selectedRole === role;
            return (
              <li
                key={role}
                className={`agent-assignment-row ${isSelected ? 'agent-assignment-row-selected' : ''}`}
              >
                {onSelectRole ? (
                  <button
                    type="button"
                    className="agent-assignment-role agent-assignment-role-button"
                    aria-pressed={isSelected}
                    onClick={() => onSelectRole(role)}
                  >
                    {roleLabel(role)}
                  </button>
                ) : (
                  <span className="agent-assignment-role">{roleLabel(role)}</span>
                )}
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
  );
}

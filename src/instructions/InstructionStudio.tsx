import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { AgentAssignmentPanel } from '../agents/AgentAssignmentPanel';
import type { AssignmentsService } from '../assignments/service';
import type { AgentAssignment } from '../assignments/types';
import type { HarnessInjectionService } from '../harness/service';
import type { HarnessClassification, InjectionPreview } from '../harness/types';
import { composeInstructions } from './composition';
import { HistoryDrawer } from './HistoryDrawer';
import { MarkdownView } from './MarkdownView';
import type { InstructionsService } from './service';
import { PROVIDER_FAMILIES } from './types';
import type {
  ActiveVersionIds,
  InstructionRole,
  InstructionVersion,
  ProviderFamily,
} from './types';

export interface InstructionStudioProject {
  id: string;
  name: string;
}

export interface InstructionStudioProps {
  instructionsService: InstructionsService;
  assignmentsService: AssignmentsService;
  harnessService: HarnessInjectionService;
  project: InstructionStudioProject;
  /** The linked local directory's absolute root path, or `null` if this project has no linked directory. */
  directoryRoot: string | null;
}

/** Exposed so a host screen (TrackerPage) can guard project switches against unsaved edits here. */
export interface InstructionStudioHandle {
  isDirty(): boolean;
  /** Saves every dirty editor. Resolves `true` only if everything saved; a partial failure leaves drafts and the failed one's error in place. */
  save(): Promise<boolean>;
  discard(): void;
}

type HistorySlot = 'override' | 'shared' | 'variant';

interface EffectiveData {
  layers: { sharedRole: string; provider: string; projectOverride: string };
  active: ActiveVersionIds;
  overrideHistory: InstructionVersion[];
  sharedHistory: InstructionVersion[];
  providerHistory: InstructionVersion[];
}

interface VariantOverride {
  provider: ProviderFamily;
  content: string;
  history: InstructionVersion[];
  activeId: string | null;
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

export const InstructionStudio = forwardRef<InstructionStudioHandle, InstructionStudioProps>(
  function InstructionStudio(
    { instructionsService, assignmentsService, harnessService, project, directoryRoot },
    ref,
  ) {
    const [role, setRoleState] = useState<InstructionRole>('worker');
    const [assignments, setAssignments] = useState<AgentAssignment[] | null>(null);
    const assignment = assignments?.find((a) => a.role === role) ?? null;
    const assignedProvider = assignment?.provider ?? null;

    // Invalidates any in-flight async work whenever the (project, role) context changes, so a
    // stale completion can never overwrite state that belongs to a different context.
    const contextGenRef = useRef(0);
    useEffect(() => {
      contextGenRef.current += 1;
    }, [project.id, role]);

    const [effective, setEffective] = useState<EffectiveData | null>(null);
    const [effectiveLoading, setEffectiveLoading] = useState(true);
    const [effectiveError, setEffectiveError] = useState<string | null>(null);

    const [customizing, setCustomizing] = useState(false);
    const [overrideDraft, setOverrideDraft] = useState('');
    const [overrideSaving, setOverrideSaving] = useState(false);
    const [overrideSaveError, setOverrideSaveError] = useState<string | null>(null);

    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [sharedDraft, setSharedDraft] = useState('');
    const [sharedSaving, setSharedSaving] = useState(false);
    const [sharedSaveError, setSharedSaveError] = useState<string | null>(null);

    const [variantOverride, setVariantOverride] = useState<VariantOverride | null>(null);
    const [variantDraft, setVariantDraft] = useState('');
    const [variantLoading, setVariantLoading] = useState(false);
    const [variantLoadError, setVariantLoadError] = useState<string | null>(null);
    const [variantSaving, setVariantSaving] = useState(false);
    const [variantSaveError, setVariantSaveError] = useState<string | null>(null);

    const variantProvider = variantOverride?.provider ?? assignedProvider ?? 'claude_code';
    const variantContent = variantOverride
      ? variantOverride.content
      : (effective?.layers.provider ?? '');
    const variantHistory = variantOverride
      ? variantOverride.history
      : (effective?.providerHistory ?? []);
    const variantActiveId = variantOverride
      ? variantOverride.activeId
      : (effective?.active.providerVersionId ?? null);

    const [historyOpen, setHistoryOpen] = useState<HistorySlot | null>(null);
    const [historyBusy, setHistoryBusy] = useState(false);
    const [historyError, setHistoryError] = useState<string | null>(null);

    const [taskPreviewText, setTaskPreviewText] = useState('');
    const [taskPreviewComposed, setTaskPreviewComposed] = useState('');
    const [taskPreviewError, setTaskPreviewError] = useState<string | null>(null);

    const [harnessPreview, setHarnessPreview] = useState<InjectionPreview | null>(null);
    const [harnessPreviewLoading, setHarnessPreviewLoading] = useState(false);
    const [harnessPreviewError, setHarnessPreviewError] = useState<string | null>(null);
    const [actionBusy, setActionBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [refreshToken, setRefreshToken] = useState(0);
    const lastActionRef = useRef<(() => Promise<unknown>) | null>(null);

    const [pendingTransition, setPendingTransition] = useState<(() => void) | null>(null);
    const [transitionSaving, setTransitionSaving] = useState(false);
    const [transitionError, setTransitionError] = useState<string | null>(null);

    const overrideDirty =
      customizing && overrideDraft !== (effective?.layers.projectOverride ?? '');
    const sharedDirty = sharedDraft !== (effective?.layers.sharedRole ?? '');
    const variantDirty = variantDraft !== variantContent;
    const isDirty = overrideDirty || sharedDirty || variantDirty;

    // `loadEffective` below is memoized on (project, role, provider) only, so it can be called by
    // a background refresh (e.g. after Inject) without being recreated. Reading `customizing` or
    // the dirty flags directly from its closure would see whatever those were when the callback
    // was last (re)created — not their current value — silently clobbering an in-progress edit.
    // Refs kept fresh every render sidestep that staleness without adding these fast-changing UI
    // flags to loadEffective's own dependency array (which would refetch on every keystroke-free
    // mode toggle).
    const customizingRef = useRef(customizing);
    customizingRef.current = customizing;
    const variantOverrideRef = useRef(variantOverride);
    variantOverrideRef.current = variantOverride;
    const sharedDirtyRef = useRef(sharedDirty);
    sharedDirtyRef.current = sharedDirty;
    const variantDirtyRef = useRef(variantDirty);
    variantDirtyRef.current = variantDirty;

    function bumpRefresh() {
      setRefreshToken((token) => token + 1);
    }

    const loadAssignments = useCallback(async () => {
      try {
        setAssignments(await assignmentsService.listForProject(project.id));
      } catch (error) {
        setEffectiveError(errorMessage(error));
      }
    }, [assignmentsService, project.id]);

    useEffect(() => {
      void loadAssignments();
    }, [loadAssignments]);

    const loadEffective = useCallback(async () => {
      if (!assignedProvider) return;
      const gen = contextGenRef.current;
      setEffectiveLoading(true);
      setEffectiveError(null);
      try {
        const [layers, active, overrideHistory, sharedHistory, providerHistory] = await Promise.all(
          [
            instructionsService.getActiveLayerContents({
              projectId: project.id,
              role,
              provider: assignedProvider,
            }),
            instructionsService.resolveActiveVersionIds({
              projectId: project.id,
              role,
              provider: assignedProvider,
            }),
            instructionsService.listOwnerVersions({
              role,
              provider: assignedProvider,
              layer: 'project_override',
              projectId: project.id,
            }),
            instructionsService.listOwnerVersions({
              role,
              provider: null,
              layer: 'shared_role',
              projectId: null,
            }),
            instructionsService.listOwnerVersions({
              role,
              provider: assignedProvider,
              layer: 'provider',
              projectId: null,
            }),
          ],
        );
        if (contextGenRef.current !== gen) return;
        setEffective({ layers, active, overrideHistory, sharedHistory, providerHistory });
        if (!customizingRef.current) setOverrideDraft(layers.projectOverride);
        if (!sharedDirtyRef.current) setSharedDraft(layers.sharedRole);
        if (!variantOverrideRef.current && !variantDirtyRef.current) {
          setVariantDraft(layers.provider);
        }
      } catch (error) {
        if (contextGenRef.current !== gen) return;
        setEffectiveError(errorMessage(error));
      } finally {
        if (contextGenRef.current === gen) setEffectiveLoading(false);
      }
      // Deliberately excludes customizing/variantOverride/sharedDirty/variantDirty: those are
      // read through the refs above so this callback (and its background refreshes) always sees
      // their current value without needing to be recreated - and refetched - on every toggle.
    }, [instructionsService, project.id, role, assignedProvider]);

    useEffect(() => {
      void loadEffective();
    }, [loadEffective, refreshToken]);

    // Reset all per-context UI state (customize mode, advanced variant, actions) whenever the
    // role changes, so a retry or a stale draft can never silently act on the previous role.
    useEffect(() => {
      setCustomizing(false);
      setOverrideSaveError(null);
      setAdvancedOpen(false);
      setVariantOverride(null);
      setSharedSaveError(null);
      setVariantSaveError(null);
      setHistoryOpen(null);
      setTaskPreviewText('');
      setTaskPreviewComposed('');
      lastActionRef.current = null;
      setActionError(null);
      setHarnessPreview(null);
    }, [project.id, role]);

    const loadVariant = useCallback(
      async (provider: ProviderFamily) => {
        if (provider === assignedProvider) {
          setVariantOverride(null);
          setVariantDraft(effective?.layers.provider ?? '');
          return;
        }
        const gen = contextGenRef.current;
        setVariantLoading(true);
        setVariantLoadError(null);
        try {
          const [layers, active, history] = await Promise.all([
            instructionsService.getActiveLayerContents({ projectId: project.id, role, provider }),
            instructionsService.resolveActiveVersionIds({ projectId: project.id, role, provider }),
            instructionsService.listOwnerVersions({
              role,
              provider,
              layer: 'provider',
              projectId: null,
            }),
          ]);
          if (contextGenRef.current !== gen) return;
          setVariantOverride({
            provider,
            content: layers.provider,
            history,
            activeId: active.providerVersionId,
          });
          setVariantDraft(layers.provider);
        } catch (error) {
          if (contextGenRef.current !== gen) return;
          setVariantLoadError(errorMessage(error));
        } finally {
          if (contextGenRef.current === gen) setVariantLoading(false);
        }
      },
      [instructionsService, project.id, role, assignedProvider, effective],
    );

    useEffect(() => {
      if (!assignedProvider) return;
      let cancelled = false;
      instructionsService
        .composePreview({
          projectId: project.id,
          role,
          provider: assignedProvider,
          taskWorkOrder: taskPreviewText,
        })
        .then((composed) => {
          if (!cancelled) {
            setTaskPreviewComposed(composed);
            setTaskPreviewError(null);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) setTaskPreviewError(errorMessage(error));
        });
      return () => {
        cancelled = true;
      };
    }, [instructionsService, project.id, role, assignedProvider, taskPreviewText, refreshToken]);

    const loadHarnessPreview = useCallback(async () => {
      if (!directoryRoot) {
        setHarnessPreview(null);
        setHarnessPreviewError(null);
        return;
      }
      const gen = contextGenRef.current;
      setHarnessPreviewLoading(true);
      setHarnessPreviewError(null);
      try {
        const preview = await harnessService.preview({
          root: directoryRoot,
          projectId: project.id,
          role,
        });
        if (contextGenRef.current !== gen) return;
        setHarnessPreview(preview);
      } catch (error) {
        if (contextGenRef.current !== gen) return;
        setHarnessPreviewError(errorMessage(error));
      } finally {
        if (contextGenRef.current === gen) setHarnessPreviewLoading(false);
      }
    }, [harnessService, directoryRoot, project.id, role]);

    useEffect(() => {
      void loadHarnessPreview();
    }, [loadHarnessPreview, refreshToken]);

    function guardedTransition(action: () => void) {
      if (isDirty) {
        setTransitionError(null);
        setPendingTransition(() => action);
      } else {
        action();
      }
    }

    function selectRole(nextRole: InstructionRole) {
      guardedTransition(() => setRoleState(nextRole));
    }

    function toggleAdvanced() {
      setAdvancedOpen((open) => !open);
    }

    function openHistory(slot: HistorySlot) {
      guardedTransition(() => {
        setHistoryError(null);
        setHistoryOpen(slot);
      });
    }

    async function saveOverride(): Promise<boolean> {
      if (!assignedProvider) return false;
      setOverrideSaving(true);
      setOverrideSaveError(null);
      try {
        await instructionsService.saveAndActivate({
          projectId: project.id,
          role,
          provider: assignedProvider,
          layer: 'project_override',
          content: overrideDraft,
        });
        bumpRefresh();
        return true;
      } catch (error) {
        setOverrideSaveError(errorMessage(error));
        return false;
      } finally {
        setOverrideSaving(false);
      }
    }

    async function saveShared(): Promise<boolean> {
      if (!assignedProvider) return false;
      setSharedSaving(true);
      setSharedSaveError(null);
      try {
        await instructionsService.saveAndActivate({
          projectId: project.id,
          role,
          provider: assignedProvider,
          layer: 'shared_role',
          content: sharedDraft,
        });
        bumpRefresh();
        return true;
      } catch (error) {
        setSharedSaveError(errorMessage(error));
        return false;
      } finally {
        setSharedSaving(false);
      }
    }

    async function saveVariant(): Promise<boolean> {
      setVariantSaving(true);
      setVariantSaveError(null);
      try {
        await instructionsService.saveAndActivate({
          projectId: project.id,
          role,
          provider: variantProvider,
          layer: 'provider',
          content: variantDraft,
        });
        bumpRefresh();
        await loadVariant(variantProvider);
        return true;
      } catch (error) {
        setVariantSaveError(errorMessage(error));
        return false;
      } finally {
        setVariantSaving(false);
      }
    }

    async function saveAllDirty(): Promise<boolean> {
      let ok = true;
      if (overrideDirty) ok = (await saveOverride()) && ok;
      if (ok && sharedDirty) ok = (await saveShared()) && ok;
      if (ok && variantDirty) ok = (await saveVariant()) && ok;
      return ok;
    }

    function discardAllDirty() {
      setOverrideDraft(effective?.layers.projectOverride ?? '');
      setOverrideSaveError(null);
      setSharedDraft(effective?.layers.sharedRole ?? '');
      setSharedSaveError(null);
      setVariantDraft(variantContent);
      setVariantSaveError(null);
    }

    async function restoreVersion(slot: HistorySlot, versionId: string) {
      if (!assignedProvider) return;
      setHistoryBusy(true);
      setHistoryError(null);
      try {
        if (slot === 'override') {
          const { version } = await instructionsService.restoreAndActivate({
            projectId: project.id,
            role,
            provider: assignedProvider,
            layer: 'project_override',
            sourceVersionId: versionId,
          });
          // Restoring is an explicit, intentional content replacement — refresh the draft
          // regardless of `customizing`, so it can never look dirty against the version it now
          // matches, and never silently discard the restore by leaving a stale draft on screen.
          setOverrideDraft(version.content);
          setOverrideSaveError(null);
        } else if (slot === 'shared') {
          const { version } = await instructionsService.restoreAndActivate({
            projectId: project.id,
            role,
            provider: assignedProvider,
            layer: 'shared_role',
            sourceVersionId: versionId,
          });
          setSharedDraft(version.content);
          setSharedSaveError(null);
        } else {
          const { version } = await instructionsService.restoreAndActivate({
            projectId: project.id,
            role,
            provider: variantProvider,
            layer: 'provider',
            sourceVersionId: versionId,
          });
          setVariantDraft(version.content);
          setVariantSaveError(null);
        }
        bumpRefresh();
        if (variantOverride) await loadVariant(variantOverride.provider);
        setHistoryOpen(null);
      } catch (error) {
        setHistoryError(errorMessage(error));
      } finally {
        setHistoryBusy(false);
      }
    }

    function handleAssignmentChanged() {
      bumpRefresh();
    }

    async function runAction(action: () => Promise<unknown>) {
      lastActionRef.current = action;
      setActionBusy(true);
      setActionError(null);
      try {
        await action();
        bumpRefresh();
      } catch (error) {
        setActionError(errorMessage(error));
      } finally {
        setActionBusy(false);
      }
    }

    function runInject(forceReplace: boolean) {
      if (!directoryRoot) return;
      void runAction(() =>
        harnessService.inject({ root: directoryRoot, projectId: project.id, role, forceReplace }),
      );
    }

    function runImport() {
      if (!directoryRoot) return;
      const root = directoryRoot;
      void runAction(async () => {
        try {
          return await harnessService.importThenReplace({ root, projectId: project.id, role });
        } catch (error) {
          // The import's own save can succeed before a local write failure. A naive retry would
          // re-run the whole import — re-saving the already-imported content as a duplicate
          // version — so once import has been attempted, retry only the local write.
          lastActionRef.current = () =>
            harnessService.inject({ root, projectId: project.id, role, forceReplace: true });
          throw error;
        }
      });
    }

    function runRemove() {
      if (!directoryRoot) return;
      void runAction(() =>
        harnessService.remove({ root: directoryRoot, projectId: project.id, role }),
      );
    }

    function retryAction() {
      if (!lastActionRef.current) return;
      void runAction(lastActionRef.current);
    }

    function cancelConflict() {
      setActionError(null);
      lastActionRef.current = null;
    }

    useImperativeHandle(ref, () => ({
      isDirty: () => isDirty,
      save: saveAllDirty,
      discard: discardAllDirty,
    }));

    const effectiveComposed = effective
      ? composeInstructions({ ...effective.layers, taskWorkOrder: '' })
      : '';
    const inheritedOnly = effective
      ? composeInstructions({
          sharedRole: effective.layers.sharedRole,
          provider: effective.layers.provider,
          projectOverride: '',
          taskWorkOrder: '',
        })
      : '';
    const draftComposed = effective
      ? composeInstructions({
          sharedRole: effective.layers.sharedRole,
          provider: effective.layers.provider,
          projectOverride: overrideDraft,
          taskWorkOrder: '',
        })
      : '';
    const activeOverrideVersionNumber = effective?.active.overrideVersionId
      ? (effective.overrideHistory.find((v) => v.id === effective.active.overrideVersionId)
          ?.version ?? null)
      : null;

    const injectLabel =
      harnessPreview?.action === 'create'
        ? 'Inject'
        : harnessPreview?.action === 'repair'
          ? 'Repair'
          : 'Update';

    const historyDescriptor =
      historyOpen === 'override'
        ? {
            label: `${roleLabel(role)} — Project override`,
            history: effective?.overrideHistory ?? [],
            activeVersionId: effective?.active.overrideVersionId ?? null,
          }
        : historyOpen === 'shared'
          ? {
              label: `${roleLabel(role)} — Shared role`,
              history: effective?.sharedHistory ?? [],
              activeVersionId: effective?.active.sharedRoleVersionId ?? null,
            }
          : historyOpen === 'variant'
            ? {
                label: `${roleLabel(role)} — ${providerLabel(variantProvider)} variant`,
                history: variantHistory,
                activeVersionId: variantActiveId,
              }
            : null;

    return (
      <div className="instruction-studio">
        <AgentAssignmentPanel
          assignmentsService={assignmentsService}
          harnessService={harnessService}
          project={project}
          directoryRoot={directoryRoot}
          selectedRole={role}
          onSelectRole={selectRole}
          onAssignmentChanged={handleAssignmentChanged}
        />

        <section
          className="instruction-effective-section"
          aria-labelledby="instruction-effective-heading"
        >
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">Effective instructions</p>
              <h2 id="instruction-effective-heading">
                {assignedProvider
                  ? `${roleLabel(role)} instructions for ${providerLabel(assignedProvider)}`
                  : `${roleLabel(role)} instructions`}
              </h2>
            </div>
          </div>

          {effectiveError && (
            <div className="save-error" role="alert">
              <span>{effectiveError}</span>
              <button
                className="button button-small"
                type="button"
                onClick={() => void loadEffective()}
              >
                Retry
              </button>
            </div>
          )}

          {effectiveLoading ? (
            <p className="sidebar-empty">Loading instructions…</p>
          ) : !effective ? (
            <p className="sidebar-empty">Waiting for the agent assignment to resolve…</p>
          ) : !customizing ? (
            <>
              <p className="instruction-inherit-note">
                {activeOverrideVersionNumber !== null
                  ? `Customized for this project · v${activeOverrideVersionNumber}`
                  : `Using default — inherited from the Shared ${roleLabel(role)} and ${assignedProvider ? providerLabel(assignedProvider) : ''} variant.`}
              </p>
              <MarkdownView
                markdown={effectiveComposed}
                aria-label="Effective instructions preview"
              />
              <div className="form-actions">
                <button
                  className="button button-primary"
                  type="button"
                  onClick={() => guardedTransition(() => setCustomizing(true))}
                >
                  Customize
                </button>
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => openHistory('override')}
                >
                  History
                </button>
              </div>
            </>
          ) : (
            <div className="instruction-customize-grid">
              <div>
                <p className="instruction-inherit-note">
                  Inherited defaults (Shared {roleLabel(role)} +{' '}
                  {assignedProvider ? providerLabel(assignedProvider) : ''}) — shown for reference;
                  not editable here.
                </p>
                <MarkdownView markdown={inheritedOnly} aria-label="Inherited defaults preview" />
              </div>
              <div>
                <label htmlFor="project-override-editor">
                  Project override (Markdown)
                  <textarea
                    id="project-override-editor"
                    className="instruction-layer-textarea"
                    rows={8}
                    value={overrideDraft}
                    onChange={(event) => setOverrideDraft(event.target.value)}
                    aria-label="Project override content"
                  />
                </label>
                <p className="muted-copy">
                  Added after the inherited defaults above, for this project only. Leave empty to
                  use the defaults as-is.
                </p>
                <h3>Draft preview (unsaved)</h3>
                <MarkdownView markdown={draftComposed} aria-label="Draft preview" />
                {overrideSaveError && (
                  <div className="save-error" role="alert">
                    <span>{overrideSaveError}</span>
                  </div>
                )}
                {activeOverrideVersionNumber !== null && !overrideDirty && (
                  <p className="instruction-saved-status">Saved · v{activeOverrideVersionNumber}</p>
                )}
                <div className="form-actions">
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={overrideSaving}
                    onClick={() => void saveOverride()}
                  >
                    {overrideSaving ? 'Saving…' : 'Save changes'}
                  </button>
                  <button
                    className="button button-quiet"
                    type="button"
                    onClick={() => {
                      setOverrideDraft(effective.layers.projectOverride);
                      setOverrideSaveError(null);
                      setCustomizing(false);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="button button-quiet"
                    type="button"
                    onClick={() => openHistory('override')}
                  >
                    History
                  </button>
                </div>
              </div>
            </div>
          )}

          <details
            className="instruction-advanced"
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}
          >
            <summary
              onClick={(event) => {
                event.preventDefault();
                toggleAdvanced();
              }}
            >
              Advanced
            </summary>
            {advancedOpen && (
              <>
                <p className="muted-copy">
                  These edit the underlying templates shared across projects, not just this
                  project&apos;s override. Choosing a provider below only changes which variant you
                  are viewing — it never reassigns {roleLabel(role)}&apos;s execution provider (use
                  Agent assignment above for that).
                </p>

                <article className="instruction-layer-card" aria-label="Shared role layer">
                  <h3>Shared {roleLabel(role)} instructions</h3>
                  <p className="muted-copy">
                    Applies to every project using the {roleLabel(role)} role, for every execution
                    provider.
                  </p>
                  <textarea
                    className="instruction-layer-textarea"
                    rows={6}
                    value={sharedDraft}
                    onChange={(event) => setSharedDraft(event.target.value)}
                    aria-label="Shared role content"
                  />
                  {sharedSaveError && (
                    <div className="save-error" role="alert">
                      {sharedSaveError}
                    </div>
                  )}
                  <div className="form-actions">
                    <button
                      className="button button-primary"
                      type="button"
                      disabled={sharedSaving}
                      onClick={() => void saveShared()}
                    >
                      {sharedSaving ? 'Saving…' : 'Save new version'}
                    </button>
                    <button
                      className="button button-quiet"
                      type="button"
                      onClick={() => openHistory('shared')}
                    >
                      History
                    </button>
                  </div>
                </article>

                <article className="instruction-layer-card" aria-label="Provider variant layer">
                  <h3>Provider variant instructions</h3>
                  <label>
                    Variant
                    <select
                      value={variantProvider}
                      onChange={(event) => void loadVariant(event.target.value as ProviderFamily)}
                      aria-label="Provider variant"
                    >
                      {PROVIDER_FAMILIES.map((provider) => (
                        <option key={provider} value={provider}>
                          {providerLabel(provider)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="muted-copy">
                    Applies to every project that assigns {providerLabel(variantProvider)} to the{' '}
                    {roleLabel(role)} role.
                  </p>
                  {variantLoadError && (
                    <div className="save-error" role="alert">
                      {variantLoadError}
                    </div>
                  )}
                  {variantLoading ? (
                    <p className="sidebar-empty">Loading variant…</p>
                  ) : (
                    <>
                      <textarea
                        className="instruction-layer-textarea"
                        rows={6}
                        value={variantDraft}
                        onChange={(event) => setVariantDraft(event.target.value)}
                        aria-label="Provider variant content"
                      />
                      {variantSaveError && (
                        <div className="save-error" role="alert">
                          {variantSaveError}
                        </div>
                      )}
                      <div className="form-actions">
                        <button
                          className="button button-primary"
                          type="button"
                          disabled={variantSaving}
                          onClick={() => void saveVariant()}
                        >
                          {variantSaving ? 'Saving…' : 'Save new version'}
                        </button>
                        <button
                          className="button button-quiet"
                          type="button"
                          onClick={() => openHistory('variant')}
                        >
                          History
                        </button>
                      </div>
                    </>
                  )}
                </article>
              </>
            )}
          </details>

          <section className="task-preview-section" aria-labelledby="task-preview-heading">
            <h3 id="task-preview-heading">Test a task-specific instruction</h3>
            <p className="muted-copy">
              Preview only — this text won&apos;t be saved, and is never injected or added to
              history.
            </p>
            <label>
              Task-specific text
              <textarea
                className="instruction-layer-textarea"
                rows={3}
                value={taskPreviewText}
                onChange={(event) => setTaskPreviewText(event.target.value)}
                aria-label="Task-specific test text"
              />
            </label>
            {taskPreviewError && (
              <div className="save-error" role="alert">
                {taskPreviewError}
              </div>
            )}
            <MarkdownView markdown={taskPreviewComposed} aria-label="Task preview" />
          </section>

          <section
            className="generated-document-section"
            aria-labelledby="generated-document-heading"
          >
            <h3 id="generated-document-heading">Generated document &amp; local file</h3>
            {!directoryRoot ? (
              <p className="sidebar-empty">
                Link a local directory for {project.name} to preview the exact target file and
                inject instructions.
              </p>
            ) : harnessPreviewLoading ? (
              <p className="sidebar-empty">Loading preview…</p>
            ) : harnessPreviewError ? (
              <div className="save-error" role="alert">
                <span>Preview failed: {harnessPreviewError}</span>
                <button className="button button-small" type="button" onClick={bumpRefresh}>
                  Retry
                </button>
              </div>
            ) : harnessPreview ? (
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
                      <code>{harnessPreview.relativePath}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{classificationLabel(harnessPreview.classification)}</dd>
                  </div>
                </dl>
                <p className="muted-copy">
                  Preview generated at {harnessPreview.generatedHeader.generatedAt}; a real
                  Inject/Update stamps its own generation time, which may differ from this preview.
                </p>
                <h4>Complete generated document</h4>
                <pre className="instruction-preview-output" aria-label="Generated document">
                  {harnessPreview.generatedDocument}
                </pre>

                {actionError && (
                  <div className="save-error" role="alert">
                    <span>{actionError}</span>
                    <button
                      className="button button-small"
                      type="button"
                      onClick={retryAction}
                      disabled={actionBusy}
                    >
                      Retry
                    </button>
                  </div>
                )}

                {harnessPreview.classification.kind === 'ManagedForeign' && (
                  <p className="save-error" role="alert">
                    This target already holds a Hammond-managed document for{' '}
                    <strong>{roleLabel(harnessPreview.classification.header.role)}</strong> in
                    project <code>{harnessPreview.classification.header.projectId}</code>, not this
                    role/project. Import is not offered — that would fold someone else&apos;s
                    instructions into this project. Choose Replace to overwrite it, or Cancel to
                    leave it untouched.
                  </p>
                )}

                <div className="form-actions">
                  {harnessPreview.classification.kind === 'Unmanaged' ? (
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
                      <button
                        className="button button-quiet"
                        type="button"
                        onClick={cancelConflict}
                      >
                        Cancel
                      </button>
                    </>
                  ) : harnessPreview.classification.kind === 'ManagedForeign' ? (
                    <>
                      <button
                        className="button button-danger"
                        type="button"
                        onClick={() => runInject(true)}
                        disabled={actionBusy}
                      >
                        Replace
                      </button>
                      <button
                        className="button button-quiet"
                        type="button"
                        onClick={cancelConflict}
                      >
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
                      {harnessPreview.classification.kind === 'ManagedValid' && (
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
        </section>

        {historyOpen && historyDescriptor && (
          <HistoryDrawer
            label={historyDescriptor.label}
            history={historyDescriptor.history}
            activeVersionId={historyDescriptor.activeVersionId}
            busy={historyBusy}
            error={historyError}
            onRestore={(versionId) => void restoreVersion(historyOpen, versionId)}
            onClose={() => setHistoryOpen(null)}
          />
        )}

        {pendingTransition && (
          <div className="modal-backdrop">
            <div
              className="modal-card"
              role="dialog"
              aria-modal="true"
              aria-label="Unsaved changes"
            >
              <h2>Unsaved changes</h2>
              <p className="muted-copy">
                You have unsaved instruction edits. Save them, discard them, or stay here.
              </p>
              {transitionError && (
                <div className="save-error" role="alert">
                  {transitionError}
                </div>
              )}
              <div className="form-actions">
                <button
                  className="button button-primary"
                  type="button"
                  disabled={transitionSaving}
                  onClick={() => {
                    setTransitionSaving(true);
                    setTransitionError(null);
                    void saveAllDirty()
                      .then((ok) => {
                        if (ok) {
                          const run = pendingTransition;
                          setPendingTransition(null);
                          run?.();
                        } else {
                          setTransitionError('Save failed — see the error above for details.');
                        }
                      })
                      .catch((error: unknown) => setTransitionError(errorMessage(error)))
                      .finally(() => setTransitionSaving(false));
                  }}
                >
                  {transitionSaving ? 'Saving…' : 'Save changes'}
                </button>
                <button
                  className="button button-danger"
                  type="button"
                  onClick={() => {
                    discardAllDirty();
                    const run = pendingTransition;
                    setPendingTransition(null);
                    run?.();
                  }}
                >
                  Discard changes
                </button>
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => setPendingTransition(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  },
);

import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { INSTRUCTION_ROLES, PROVIDER_FAMILIES } from './types';
import type {
  InstructionLayer,
  InstructionRole,
  InstructionVersion,
  ProviderFamily,
} from './types';
import type { InstructionsService } from './service';

export interface InstructionsPanelProject {
  id: string;
  name: string;
}

export interface InstructionsPanelProps {
  service: InstructionsService;
  projects: InstructionsPanelProject[];
}

interface LayerState {
  history: InstructionVersion[];
  draft: string;
  activeVersionId: string | null;
}

const LAYER_LABEL: Record<InstructionLayer, string> = {
  shared_role: 'Shared role',
  provider: 'Provider',
  project_override: 'Project override',
};

function providerLabel(provider: ProviderFamily): string {
  return provider
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function emptyLayerState(): LayerState {
  return { history: [], draft: '', activeVersionId: null };
}

export function InstructionsPanel({ service, projects }: InstructionsPanelProps) {
  const [projectId, setProjectId] = useState<string | null>(projects[0]?.id ?? null);
  const [role, setRole] = useState<InstructionRole>('worker');
  const [provider, setProvider] = useState<ProviderFamily>('claude_code');

  const [sharedRole, setSharedRole] = useState<LayerState>(emptyLayerState());
  const [providerLayer, setProviderLayer] = useState<LayerState>(emptyLayerState());
  const [override, setOverride] = useState<LayerState>(emptyLayerState());

  const [taskWorkOrder, setTaskWorkOrder] = useState('');
  const [preview, setPreview] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingLayer, setSavingLayer] = useState<InstructionLayer | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const load = useCallback(async () => {
    if (!projectId) {
      setSharedRole(emptyLayerState());
      setProviderLayer(emptyLayerState());
      setOverride(emptyLayerState());
      setPreview('');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [sharedHistory, providerHistory, overrideHistory, active, layerContents] =
        await Promise.all([
          service.listOwnerVersions({
            role,
            provider: null,
            layer: 'shared_role',
            projectId: null,
          }),
          service.listOwnerVersions({ role, provider, layer: 'provider', projectId: null }),
          service.listOwnerVersions({ role, provider, layer: 'project_override', projectId }),
          service.resolveActiveVersionIds({ projectId, role, provider }),
          service.getActiveLayerContents({ projectId, role, provider }),
        ]);
      setSharedRole({
        history: sharedHistory,
        draft: layerContents.sharedRole,
        activeVersionId: active.sharedRoleVersionId,
      });
      setProviderLayer({
        history: providerHistory,
        draft: layerContents.provider,
        activeVersionId: active.providerVersionId,
      });
      setOverride({
        history: overrideHistory,
        draft: layerContents.projectOverride,
        activeVersionId: active.overrideVersionId,
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load instructions');
    } finally {
      setLoading(false);
    }
  }, [service, projectId, role, provider]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  useEffect(() => {
    if (!projectId) {
      setPreview('');
      return;
    }
    let cancelled = false;
    void service
      .composePreview({ projectId, role, provider, taskWorkOrder })
      .then((composed) => {
        if (!cancelled) setPreview(composed);
      })
      .catch(() => {
        if (!cancelled) setPreview('');
      });
    return () => {
      cancelled = true;
    };
  }, [service, projectId, role, provider, taskWorkOrder, refreshToken]);

  function refresh() {
    setRefreshToken((token) => token + 1);
  }

  async function saveLayer(layer: InstructionLayer, content: string) {
    if (!projectId) return;
    setSavingLayer(layer);
    setError(null);
    try {
      await service.saveAndActivate({ projectId, role, provider, layer, content });
      refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save this version');
    } finally {
      setSavingLayer(null);
    }
  }

  async function restoreVersion(layer: InstructionLayer, sourceVersionId: string) {
    if (!projectId) return;
    setSavingLayer(layer);
    setError(null);
    try {
      await service.restoreAndActivate({ projectId, role, provider, layer, sourceVersionId });
      refresh();
    } catch (restoreError) {
      setError(
        restoreError instanceof Error ? restoreError.message : 'Failed to restore this version',
      );
    } finally {
      setSavingLayer(null);
    }
  }

  async function selectVersion(layer: InstructionLayer, versionId: string) {
    if (!projectId) return;
    setError(null);
    try {
      await service.activateExistingVersion({ projectId, role, provider, layer, versionId });
      refresh();
    } catch (selectError) {
      setError(
        selectError instanceof Error ? selectError.message : 'Failed to select this version',
      );
    }
  }

  function renderLayerCard(
    layer: InstructionLayer,
    state: LayerState,
    setState: Dispatch<SetStateAction<LayerState>>,
    disabled: boolean,
  ) {
    return (
      <article className="instruction-layer-card" aria-label={`${LAYER_LABEL[layer]} layer`}>
        <div className="instruction-layer-heading">
          <h3>{LAYER_LABEL[layer]}</h3>
          {state.activeVersionId && (
            <span className="version-pill">
              v{state.history.find((v) => v.id === state.activeVersionId)?.version ?? '·'}
            </span>
          )}
        </div>
        <textarea
          className="instruction-layer-textarea"
          value={state.draft}
          disabled={disabled}
          onChange={(event) => setState((current) => ({ ...current, draft: event.target.value }))}
          rows={6}
          aria-label={`${LAYER_LABEL[layer]} content`}
        />
        <div className="form-actions">
          <button
            className="button button-primary"
            type="button"
            disabled={disabled || savingLayer === layer}
            onClick={() => void saveLayer(layer, state.draft)}
          >
            {savingLayer === layer ? 'Saving…' : 'Save new version'}
          </button>
        </div>
        <ul className="instruction-history-list" aria-label={`${LAYER_LABEL[layer]} history`}>
          {state.history.map((version) => (
            <li key={version.id} className="instruction-history-item">
              <span>
                v{version.version}
                {version.restoredFromVersionId && (
                  <span className="instruction-restore-badge">
                    {' '}
                    · restored from an earlier version
                  </span>
                )}
                {version.id === state.activeVersionId && (
                  <span className="instruction-active-badge"> · active</span>
                )}
              </span>
              <span className="instruction-history-actions">
                {version.id !== state.activeVersionId && (
                  <button
                    className="button button-small"
                    type="button"
                    disabled={disabled}
                    onClick={() => void selectVersion(layer, version.id)}
                  >
                    Select
                  </button>
                )}
                <button
                  className="button button-small"
                  type="button"
                  disabled={disabled}
                  onClick={() => void restoreVersion(layer, version.id)}
                >
                  Restore
                </button>
              </span>
            </li>
          ))}
          {state.history.length === 0 && (
            <li className="instruction-history-empty">
              No owner versions yet — using base content.
            </li>
          )}
        </ul>
      </article>
    );
  }

  return (
    <div className="instructions-panel">
      <div className="instructions-picker-row">
        <label>
          Project
          <select
            value={projectId ?? ''}
            onChange={(event) => setProjectId(event.target.value || null)}
          >
            {projects.length === 0 && <option value="">No projects yet</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Role
          <select value={role} onChange={(event) => setRole(event.target.value as InstructionRole)}>
            {INSTRUCTION_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label>
          Provider
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value as ProviderFamily)}
          >
            {PROVIDER_FAMILIES.map((p) => (
              <option key={p} value={p}>
                {providerLabel(p)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="save-error" role="alert">
          {error}
        </div>
      )}
      {!projectId ? (
        <p className="sidebar-empty">Create a project first to compose its instructions.</p>
      ) : loading ? (
        <p className="sidebar-empty">Loading instructions…</p>
      ) : (
        <>
          <div className="instruction-layer-grid">
            {renderLayerCard('shared_role', sharedRole, setSharedRole, false)}
            {renderLayerCard('provider', providerLayer, setProviderLayer, false)}
            {renderLayerCard('project_override', override, setOverride, false)}
          </div>

          <section className="instruction-preview-section">
            <label>
              Task work order (optional, preview only — never saved as a durable record)
              <textarea
                className="instruction-layer-textarea"
                rows={3}
                value={taskWorkOrder}
                onChange={(event) => setTaskWorkOrder(event.target.value)}
                aria-label="Task work order"
              />
            </label>
            <h3>Composed preview</h3>
            <pre className="instruction-preview-output" aria-label="Composed preview">
              {preview || '(nothing composed yet)'}
            </pre>
          </section>
        </>
      )}
    </div>
  );
}

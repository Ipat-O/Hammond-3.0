import { useRef, useState } from 'react';

import type { InstructionVersion } from './types';
import { useFocusTrap } from './useFocusTrap';

export interface HistoryDrawerProps {
  /** Names exactly which slot this history belongs to, e.g. "Worker — Project override". */
  label: string;
  history: InstructionVersion[];
  activeVersionId: string | null;
  busy: boolean;
  error: string | null;
  onRestore: (versionId: string) => void;
  onClose: () => void;
}

/**
 * A single scoped history view: one "Restore this version" action per entry (never the ordinary
 * Select-versus-Restore choice), active/provenance labeling, and an optional raw-content inspector
 * per version. Modal focus is trapped, Escape closes, and focus returns to whatever triggered it.
 */
export function HistoryDrawer({
  label,
  history,
  activeVersionId,
  busy,
  error,
  onRestore,
  onClose,
}: HistoryDrawerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  useFocusTrap(containerRef, true, onClose);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal-card history-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${label} history`}
        ref={containerRef}
        tabIndex={-1}
      >
        <div className="editor-heading">
          <div>
            <p className="card-kicker">Version history</p>
            <h2>{label}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close history"
          >
            ×
          </button>
        </div>
        <p className="muted-copy">
          Restoring creates a new version and keeps this history — nothing is deleted or reordered.
        </p>
        {error && (
          <div className="save-error" role="alert">
            {error}
          </div>
        )}
        <ul
          className="instruction-history-list history-drawer-list"
          aria-label={`${label} versions`}
        >
          {history.map((version) => {
            const isActive = version.id === activeVersionId;
            const isInspecting = inspecting === version.id;
            return (
              <li key={version.id} className="instruction-history-item history-drawer-item">
                <div className="history-drawer-item-row">
                  <span>
                    v{version.version}
                    {version.restoredFromVersionId && (
                      <span className="instruction-restore-badge">
                        {' '}
                        · restored from an earlier version
                      </span>
                    )}
                    {isActive && <span className="instruction-active-badge"> · active</span>}
                  </span>
                  <span className="instruction-history-actions">
                    <button
                      className="button button-small button-quiet"
                      type="button"
                      aria-expanded={isInspecting}
                      onClick={() => setInspecting(isInspecting ? null : version.id)}
                    >
                      {isInspecting ? 'Hide content' : 'View content'}
                    </button>
                    <button
                      className="button button-small"
                      type="button"
                      disabled={isActive || busy}
                      onClick={() => onRestore(version.id)}
                    >
                      {busy ? 'Restoring…' : 'Restore this version'}
                    </button>
                  </span>
                </div>
                {isInspecting && (
                  <pre className="instruction-preview-output history-drawer-source">
                    {version.content || '(empty)'}
                  </pre>
                )}
              </li>
            );
          })}
          {history.length === 0 && (
            <li className="instruction-history-empty">No versions yet — using base content.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';

interface AgentAccessStatus {
  enabled: boolean;
  port: number;
  startedAt: string;
  tokenFingerprint: string;
}

interface RevealedToken {
  token: string;
  port: number;
}

async function callTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/**
 * The owner-facing setup/rotation/revocation surface for the local API's bearer token (HAM3-015
 * section 4). A credential here grants the same supported owner-level operations a signed-in
 * owner already has through the UI — this is not a separate authorization system, just a way to
 * let a local MCP client act as the signed-in owner without a second login.
 */
export function AgentAccessPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<AgentAccessStatus | null>(null);
  const [revealed, setRevealed] = useState<RevealedToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refreshStatus() {
    try {
      const next = await callTauri<AgentAccessStatus>('agent_access_get_status');
      setStatus(next);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load local API status.');
    }
  }

  useEffect(() => {
    void refreshStatus();
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      const token = await callTauri<RevealedToken>('agent_access_reveal_token');
      setRevealed(token);
    } catch (revealError) {
      setError(revealError instanceof Error ? revealError.message : 'Could not reveal the token.');
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    setBusy(true);
    setError(null);
    try {
      await callTauri('agent_access_rotate_token');
      setRevealed(null);
      await refreshStatus();
    } catch (rotateError) {
      setError(rotateError instanceof Error ? rotateError.message : 'Could not rotate the token.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await callTauri('agent_access_revoke_token');
      setRevealed(null);
      await refreshStatus();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : 'Could not revoke the token.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-access-heading"
      >
        <div className="editor-heading">
          <div>
            <p className="card-kicker">Settings</p>
            <h2 id="agent-access-heading">Local API &amp; MCP access</h2>
          </div>
          <button type="button" className="text-button" onClick={onClose}>
            Close
          </button>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {status ? (
          <div className="stack-form">
            <p>
              Status: <strong>{status.enabled ? 'Enabled' : 'Revoked'}</strong>
            </p>
            <p>Local port: {status.port}</p>
            <p>Token: ends in {status.tokenFingerprint}</p>
            <p className="auth-copy">
              Started: {status.startedAt}. A running, signed-in Hammond exposes an HTTP API on
              127.0.0.1:{status.port} and a bundled MCP entry point that reads this same token.
              Anyone holding this token can perform any operation the signed-in owner can — treat it
              like a password, not a read-only key.
            </p>

            {revealed && (
              <div className="form-success" role="status">
                <p>Bearer token (shown once per reveal — copy it now):</p>
                <code style={{ wordBreak: 'break-all' }}>{revealed.token}</code>
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void reveal()}
                disabled={busy}
              >
                Reveal token
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void rotate()}
                disabled={busy}
              >
                Rotate token
              </button>
              <button
                type="button"
                className="button button-danger"
                onClick={() => void revoke()}
                disabled={busy}
              >
                Revoke access
              </button>
            </div>
          </div>
        ) : (
          !error && <p>Loading local API status…</p>
        )}
      </div>
    </div>
  );
}

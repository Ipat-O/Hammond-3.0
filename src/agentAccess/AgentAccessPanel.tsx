import { useEffect, useState } from 'react';

import { nativeAgentAccess, type ConnectionInfo } from './nativeBridge';
import type { AgentAccessPermission } from './types';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'That action failed. Nothing was changed.';
}

interface AgentAccessPanelProps {
  projectId: string;
  projectName: string;
}

/**
 * Owner-facing settings for HAM3-014 agent access (D-022): enable/disable for this project,
 * choose read-only or task-write, copy the launch configuration for an MCP host, and revoke the
 * current connection. Talks to the native layer directly (`nativeAgentAccess`) — it is not part of
 * `TrackerServices`, since agent-access state lives in Hammond's own local/native store, not
 * Supabase. Safe to mount without a Tauri runtime (tests, a browser dev server): every native call
 * is caught and surfaced as an inert status message rather than thrown.
 */
export function AgentAccessPanel({ projectId, projectName }: AgentAccessPanelProps) {
  const [status, setStatus] = useState<ConnectionInfo | null | 'unavailable'>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [permission, setPermission] = useState<AgentAccessPermission>('read_only');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    nativeAgentAccess
      .status()
      .then((result) => {
        if (mounted) setStatus(result);
      })
      .catch(() => {
        if (mounted) setStatus('unavailable');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const boundToThisProject =
    status !== null && status !== 'unavailable' && status.projectId === projectId;

  async function enable() {
    setActionError(null);
    setBusy(true);
    try {
      const next = await nativeAgentAccess.enable(projectId, projectName, permission);
      setStatus(next);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setActionError(null);
    setBusy(true);
    try {
      await nativeAgentAccess.disable();
      setStatus(null);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setActionError(null);
    setBusy(true);
    try {
      const next = await nativeAgentAccess.revoke();
      setStatus(next);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function copyLaunchConfig() {
    if (status === null || status === 'unavailable') return;
    setActionError(null);
    try {
      await navigator.clipboard.writeText(JSON.stringify(status.launchConfig, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  if (loading) {
    return (
      <section className="agent-access-section" aria-labelledby="agent-access-heading">
        <p className="eyebrow">Agent access</p>
        <h2 id="agent-access-heading">Agent access</h2>
        <p className="muted-copy">Checking status…</p>
      </section>
    );
  }

  if (status === 'unavailable') {
    return (
      <section className="agent-access-section" aria-labelledby="agent-access-heading">
        <p className="eyebrow">Agent access</p>
        <h2 id="agent-access-heading">Agent access</h2>
        <p className="muted-copy">
          Agent access requires the installed Hammond desktop app; it is not available in this
          environment.
        </p>
      </section>
    );
  }

  return (
    <section className="agent-access-section" aria-labelledby="agent-access-heading">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">Local agent connections</p>
          <h2 id="agent-access-heading">Agent access</h2>
        </div>
      </div>

      {actionError && (
        <div className="save-error" role="alert">
          <span>{actionError}</span>
        </div>
      )}

      {!boundToThisProject ? (
        <>
          <p className="muted-copy">
            {status === null
              ? 'Not enabled. Enabling lets a local MCP host (an agent you run) read this project — and, if you allow it, create tasks and comments — while Hammond is running and signed in.'
              : `Currently enabled for a different project ("${status.projectName}"). Enabling here switches the connection to this project and invalidates the old one.`}
          </p>
          <fieldset className="agent-access-permission" disabled={busy}>
            <legend>Access level</legend>
            <label>
              <input
                type="radio"
                name="agent-access-permission"
                value="read_only"
                checked={permission === 'read_only'}
                onChange={() => setPermission('read_only')}
              />
              Read-only (project context, tasks, instructions)
            </label>
            <label>
              <input
                type="radio"
                name="agent-access-permission"
                value="task_write"
                checked={permission === 'task_write'}
                onChange={() => setPermission('task_write')}
              />
              Read + task write (also create tasks, update ordinary statuses, add comments)
            </label>
          </fieldset>
          <button
            className="button button-primary"
            type="button"
            onClick={() => void enable()}
            disabled={busy}
          >
            {busy ? 'Enabling…' : 'Enable agent access for this project'}
          </button>
        </>
      ) : (
        <>
          <p className="agent-access-status">
            Enabled for <strong>{status.projectName}</strong> —{' '}
            {status.permission === 'task_write' ? 'read + task write' : 'read-only'}.
          </p>
          <div className="agent-access-actions">
            <button
              className="button button-secondary"
              type="button"
              onClick={() => void copyLaunchConfig()}
            >
              {copied ? 'Copied!' : 'Copy launch configuration'}
            </button>
            <button
              className="button button-quiet"
              type="button"
              onClick={() => void revoke()}
              disabled={busy}
            >
              Revoke connection
            </button>
            <button
              className="button button-danger"
              type="button"
              onClick={() => void disable()}
              disabled={busy}
            >
              {busy ? 'Working…' : 'Disable'}
            </button>
          </div>
          <p className="muted-copy">
            Paste the launch configuration into your MCP host's server config. Revoking invalidates
            every current connection without changing the project/permission you picked; Disable
            turns agent access off entirely.
          </p>
        </>
      )}
    </section>
  );
}

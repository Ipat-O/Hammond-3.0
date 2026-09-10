import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Must match `src-tauri/tauri.conf.json`'s `identifier`. Not read from that file at build time
 * (this package is deployed independently of the repository checkout) — if that identifier ever
 * changes, this constant needs a matching update.
 */
const BUNDLE_IDENTIFIER = 'com.ipat-o.hammond';
const CREDENTIALS_FILE_NAME = 'agent-access-credentials.json';

export interface AgentAccessCredentials {
  version: number;
  enabled: boolean;
  token: string;
  port: number;
  pid: number;
  startedAt: string;
}

export class HammondNotRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HammondNotRunningError';
  }
}

/**
 * Mirrors Tauri v2's `app_local_data_dir()` resolution for this bundle identifier on each
 * platform. An env var override is supported for tests and for a non-standard install.
 */
export function resolveAppLocalDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HAMMOND_APP_LOCAL_DATA_DIR) return env.HAMMOND_APP_LOCAL_DATA_DIR;

  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, BUNDLE_IDENTIFIER);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', BUNDLE_IDENTIFIER);
  }
  const base = env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return path.join(base, BUNDLE_IDENTIFIER);
}

export function credentialsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HAMMOND_AGENT_ACCESS_CREDENTIALS_PATH) return env.HAMMOND_AGENT_ACCESS_CREDENTIALS_PATH;
  return path.join(resolveAppLocalDataDir(env), CREDENTIALS_FILE_NAME);
}

function isPlausibleCredentials(value: unknown): value is AgentAccessCredentials {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.token === 'string' &&
    record.token.length > 0 &&
    typeof record.port === 'number' &&
    typeof record.enabled === 'boolean'
  );
}

/**
 * Reads the current local API credentials Hammond wrote at startup. Never caches across calls —
 * callers decide their own caching/refresh policy (see `client.ts`, which refreshes exactly once
 * after a connection-level failure to recover from a Hammond restart on a new port).
 */
export async function readCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentAccessCredentials> {
  const filePath = credentialsFilePath(env);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HammondNotRunningError(
        `No local API credentials file at ${filePath}. Start Hammond and sign in first — the file is created the moment the desktop app launches.`,
      );
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Local API credentials file at ${filePath} is not valid JSON.`);
  }
  if (!isPlausibleCredentials(parsed)) {
    throw new Error(`Local API credentials file at ${filePath} is malformed.`);
  }
  return parsed;
}

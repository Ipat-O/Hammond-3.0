import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  credentialsFilePath,
  HammondNotRunningError,
  readCredentials,
  resolveAppLocalDataDir,
} from './credentials.js';

test('resolveAppLocalDataDir respects an explicit override', () => {
  const dir = resolveAppLocalDataDir({
    HAMMOND_APP_LOCAL_DATA_DIR: '/custom/dir',
  } as NodeJS.ProcessEnv);
  assert.equal(dir, '/custom/dir');
});

test('resolveAppLocalDataDir resolves a platform-appropriate path when no override is set', () => {
  const dir = resolveAppLocalDataDir({} as NodeJS.ProcessEnv);
  assert.ok(dir.includes('com.ipat-o.hammond'));
});

test('readCredentials throws HammondNotRunningError when the credentials file does not exist', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hammond-mcp-test-'));
  const missingPath = path.join(dir, 'does-not-exist.json');
  try {
    await assert.rejects(
      () =>
        readCredentials({
          HAMMOND_AGENT_ACCESS_CREDENTIALS_PATH: missingPath,
        } as NodeJS.ProcessEnv),
      HammondNotRunningError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCredentials rejects malformed JSON with a clear error, not a crash', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hammond-mcp-test-'));
  const filePath = path.join(dir, 'agent-access-credentials.json');
  await writeFile(filePath, 'not json');
  try {
    await assert.rejects(
      () =>
        readCredentials({ HAMMOND_AGENT_ACCESS_CREDENTIALS_PATH: filePath } as NodeJS.ProcessEnv),
      /not valid JSON/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCredentials rejects a well-formed JSON file missing required fields', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hammond-mcp-test-'));
  const filePath = path.join(dir, 'agent-access-credentials.json');
  await writeFile(filePath, JSON.stringify({ version: 1 }));
  try {
    await assert.rejects(
      () =>
        readCredentials({ HAMMOND_AGENT_ACCESS_CREDENTIALS_PATH: filePath } as NodeJS.ProcessEnv),
      /malformed/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCredentials returns the parsed credentials for a well-formed file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hammond-mcp-test-'));
  const filePath = path.join(dir, 'agent-access-credentials.json');
  const credentials = {
    version: 1,
    enabled: true,
    token: 'a'.repeat(64),
    port: 54321,
    pid: 1234,
    startedAt: '2026-01-01T00:00:00Z',
  };
  await writeFile(filePath, JSON.stringify(credentials));
  try {
    const result = await readCredentials({
      HAMMOND_AGENT_ACCESS_CREDENTIALS_PATH: filePath,
    } as NodeJS.ProcessEnv);
    assert.deepEqual(result, credentials);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('credentialsFilePath honors the credentials-path override directly', () => {
  const result = credentialsFilePath({
    HAMMOND_AGENT_ACCESS_CREDENTIALS_PATH: '/explicit/path.json',
  } as NodeJS.ProcessEnv);
  assert.equal(result, '/explicit/path.json');
});

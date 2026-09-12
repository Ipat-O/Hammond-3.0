import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { HammondClient, HammondOperationError } from './client.js';

let tempDir: string | undefined;
const originalFetch = globalThis.fetch;
const originalEnvOverride = process.env.HAMMOND_AGENT_ACCESS_CREDENTIALS_PATH;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalEnvOverride === undefined) delete process.env.HAMMOND_AGENT_ACCESS_CREDENTIALS_PATH;
  else process.env.HAMMOND_AGENT_ACCESS_CREDENTIALS_PATH = originalEnvOverride;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function seedCredentials(overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'hammond-mcp-client-test-'));
  const filePath = path.join(tempDir, 'agent-access-credentials.json');
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      enabled: true,
      token: 'test-token',
      port: 4123,
      pid: 1,
      startedAt: '2026-01-01T00:00:00Z',
      ...overrides,
    }),
  );
  process.env.HAMMOND_AGENT_ACCESS_CREDENTIALS_PATH = filePath;
  return filePath;
}

test('listOperations sends the bearer token and returns the operations array', async () => {
  await seedCredentials();
  let capturedUrl: string | undefined;
  let capturedAuth: string | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
    return new Response(
      JSON.stringify({
        result: { operations: [{ name: 'projects.list', description: 'd', inputSchema: {} }] },
      }),
      {
        status: 200,
      },
    );
  }) as typeof fetch;

  const client = new HammondClient();
  const operations = await client.listOperations();

  assert.equal(capturedUrl, 'http://127.0.0.1:4123/v1/operations');
  assert.equal(capturedAuth, 'Bearer test-token');
  assert.equal(operations.length, 1);
  assert.equal(operations[0].name, 'projects.list');
});

test('invokeOperation throws a typed HammondOperationError on a non-200 response', async () => {
  await seedCredentials();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), {
      status: 404,
    })) as typeof fetch;

  const client = new HammondClient();
  await assert.rejects(
    () => client.invokeOperation('projects.get', { projectId: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof HammondOperationError);
      assert.equal(error.code, 'not_found');
      assert.equal(error.httpStatus, 404);
      return true;
    },
  );
});

test('retries once after a connection-level failure, re-reading credentials (recovers from a Hammond restart on a new port)', async () => {
  const filePath = await seedCredentials({ port: 1111 });
  const urlsUsed: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urlsUsed.push(String(url));
    if (urlsUsed.length === 1) {
      // Simulate Hammond having restarted on a new port between the two attempts: the
      // credentials file is rewritten synchronously, before this rejection is even observed by
      // the client, so the retry's re-read is guaranteed to see the new port.
      writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          enabled: true,
          token: 'test-token',
          port: 2222,
          pid: 2,
          startedAt: 'x',
        }),
      );
      throw new Error('ECONNREFUSED');
    }
    return new Response(JSON.stringify({ result: { operations: [] } }), { status: 200 });
  }) as typeof fetch;

  const client = new HammondClient();
  const operations = await client.listOperations();

  assert.deepEqual(urlsUsed, [
    'http://127.0.0.1:1111/v1/operations',
    'http://127.0.0.1:2222/v1/operations',
  ]);
  assert.deepEqual(operations, []);
});

test('never retries after a gateway-timeout (unknown-outcome) response — the operation may already have run', async () => {
  await seedCredentials();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ error: { code: 'unknown_outcome', message: 'timed out' } }),
      { status: 504 },
    );
  }) as typeof fetch;

  const client = new HammondClient();
  await assert.rejects(() => client.invokeOperation('tasks.create', {}), HammondOperationError);
  assert.equal(calls, 1);
});

test('retries once on a 401 (token may have been rotated) but not twice', async () => {
  await seedCredentials();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ error: { code: 'invalid_token', message: 'bad token' } }),
      { status: 401 },
    );
  }) as typeof fetch;

  const client = new HammondClient();
  await assert.rejects(() => client.listOperations(), HammondOperationError);
  assert.equal(calls, 2);
});

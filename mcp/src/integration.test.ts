import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Real MCP SDK protocol evidence (HAM3-015 acceptance criterion 7: "fake-only service tests are
 * insufficient transport evidence"): this spawns the actual built bundle
 * (`dist/hammond-mcp.mjs`) as a child process, speaks real MCP JSON-RPC to it over real stdio
 * pipes via the official SDK's own `Client`/`StdioClientTransport`, and has the adapter talk to a
 * genuine (if minimal) HTTP server standing in for Hammond's `/v1/operations` contract — no
 * function is called directly in-process. Run `npm run build` before this test if `dist/` is
 * stale (the `pretest` step below is not wired up on purpose: this test's own `before` hook fails
 * loudly with instructions instead of silently rebuilding).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(HERE, '..', 'dist', 'hammond-mcp.mjs');
const TOKEN = 'integration-test-token';

let mockHammond: HttpServer;
let mockPort: number;
let tempDir: string;
let credentialsPath: string;
let client: Client;
let transport: StdioClientTransport;
let rejectAll = false;

const ECHO_SCHEMA = {
  $schema: 'https://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false,
};

before(async () => {
  const { existsSync } = await import('node:fs');
  assert.ok(
    existsSync(BUNDLE_PATH),
    `Bundle not found at ${BUNDLE_PATH}. Run "npm run build" in mcp/ before this test.`,
  );

  mockHammond = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (rejectAll || auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'invalid_token', message: 'bad token' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/operations') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          result: {
            operations: [
              {
                name: 'test.echo',
                description: 'Echoes the given message.',
                inputSchema: ECHO_SCHEMA,
              },
            ],
          },
        }),
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/operations/test.echo') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const input = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { echoed: input.message } }));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'no such route in mock' } }));
  });
  await new Promise<void>((resolve) => mockHammond.listen(0, '127.0.0.1', resolve));
  mockPort = (mockHammond.address() as { port: number }).port;

  tempDir = await mkdtemp(path.join(os.tmpdir(), 'hammond-mcp-integration-'));
  credentialsPath = path.join(tempDir, 'agent-access-credentials.json');
  await writeFile(
    credentialsPath,
    JSON.stringify({
      version: 1,
      enabled: true,
      token: TOKEN,
      port: mockPort,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }),
  );

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE_PATH],
    env: {
      ...(process.env as Record<string, string>),
      HAMMOND_AGENT_ACCESS_CREDENTIALS_PATH: credentialsPath,
    },
  });
  client = new Client({ name: 'hammond-mcp-integration-test', version: '0.0.0' });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await new Promise<void>((resolve) => mockHammond?.close(() => resolve()));
  await rm(tempDir, { recursive: true, force: true });
});

test("a real MCP client discovers the tool Hammond's mock backend advertises", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'test.echo');
  assert.deepEqual(tools[0].inputSchema, ECHO_SCHEMA);
});

test("a real MCP client calls the tool and gets back the mock backend's real HTTP response", async () => {
  const result = await client.callTool({
    name: 'test.echo',
    arguments: { message: 'hello from a real MCP client' },
  });
  assert.equal(result.isError, undefined);
  const content = result.content as { type: string; text: string }[];
  assert.equal(content.length, 1);
  const parsed = JSON.parse(content[0].text);
  assert.equal(parsed.echoed, 'hello from a real MCP client');
});

test('a backend rejecting every request (revoked token) surfaces as a tool error over the real protocol, not a crash', async () => {
  // The adapter already has a valid cached token from the earlier calls in this file; making the
  // *mock server* reject unconditionally (rather than editing the credentials file, which the
  // adapter would not necessarily re-read) is what actually exercises the 401 path end to end —
  // including the adapter's one retry, which re-reads the same still-correct token and still
  // gets refused, then surfaces the failure as an ordinary tool-call error rather than throwing
  // out of the MCP request or killing the connection.
  rejectAll = true;
  try {
    const result = await client.callTool({ name: 'test.echo', arguments: { message: 'x' } });
    assert.equal(result.isError, true);
    const content = result.content as { type: string; text: string }[];
    const parsed = JSON.parse(content[0].text);
    assert.equal(parsed.code, 'invalid_token');
  } finally {
    rejectAll = false;
  }

  // The connection must still be usable afterward — one failed call never tears it down.
  const followUp = await client.callTool({
    name: 'test.echo',
    arguments: { message: 'still alive' },
  });
  assert.equal(followUp.isError, undefined);
});

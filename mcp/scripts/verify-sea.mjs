// One-off manual verification script (not part of the test suite) proving the packaged
// single-executable binary speaks real MCP protocol end to end. Not committed as a permanent
// test because it depends on a locally-built platform-specific binary at dist/hammond-mcp.
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TOKEN = 'sea-verify-token';
const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'invalid_token', message: 'bad' } }));
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
              description: 'echo',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      }),
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/operations/test.echo') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: { echoed: JSON.parse(body || '{}').message } }));
    });
    return;
  }
  res.writeHead(404);
  res.end('{}');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const dir = mkdtempSync(path.join(os.tmpdir(), 'sea-verify-'));
const credPath = path.join(dir, 'agent-access-credentials.json');
writeFileSync(
  credPath,
  JSON.stringify({
    version: 1,
    enabled: true,
    token: TOKEN,
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }),
);

const transport = new StdioClientTransport({
  command: path.resolve('dist/hammond-mcp'),
  args: [],
  env: { ...process.env, HAMMOND_AGENT_ACCESS_CREDENTIALS_PATH: credPath },
});
const client = new Client({ name: 'sea-verify', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('SEA BINARY listTools ->', JSON.stringify(tools));
if (tools.length !== 1 || tools[0].name !== 'test.echo')
  throw new Error('unexpected tools list from SEA binary');

const result = await client.callTool({
  name: 'test.echo',
  arguments: { message: 'hello from SEA binary' },
});
console.log('SEA BINARY callTool ->', JSON.stringify(result));
const parsed = JSON.parse(result.content[0].text);
if (parsed.echoed !== 'hello from SEA binary')
  throw new Error('unexpected callTool result from SEA binary');

await client.close();
server.close();
rmSync(dir, { recursive: true, force: true });
console.log('SEA BINARY VERIFICATION: PASSED');

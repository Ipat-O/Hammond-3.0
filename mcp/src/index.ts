#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createHammondMcpServer } from './server.js';

/**
 * Entry point for the Hammond local MCP adapter. Stdout is reserved entirely for MCP protocol
 * traffic (the SDK's `StdioServerTransport` owns it); every diagnostic goes to stderr instead —
 * never `console.log`, which would corrupt the JSON-RPC stream a harness is trying to parse.
 */
async function main(): Promise<void> {
  const server = createHammondMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('hammond-mcp: connected over stdio, ready.\n');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `hammond-mcp: fatal startup error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});

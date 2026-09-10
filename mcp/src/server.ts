import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { HammondClient, HammondOperationError } from './client.js';
import { HammondNotRunningError } from './credentials.js';

/**
 * Operations that only *prepare* instruction content — they never write a harness file, and the
 * owner's explicit interaction contract (HAM3-015 section 3) requires the calling agent to ask
 * "Inject now, or leave ready for later?" before ever calling `harness.inject`. This reminder is
 * layered on here, in the thin adapter, rather than in the registry itself: it is a
 * conversational nudge for whatever harness/model is on the other end of stdio, not a change to
 * the HTTP contract direct callers (tests, `curl`) see.
 */
const PREPARE_OPERATIONS = new Set([
  'instructions.prepare',
  'instructions.restore',
  'instructions.activateExisting',
]);

const NEXT_ACTION_REMINDER =
  'This only saved/activated instructions inside Hammond — no AGENTS.md/CLAUDE.md/.kilocode file was touched. ' +
  'Ask the user now: "Inject now, or leave ready for later?" Only call harness.inject after they explicitly say ' +
  'to inject. Never treat silence, elapsed time, or permission to prepare as permission to inject.';

export function createHammondMcpServer(client: HammondClient = new HammondClient()): Server {
  const server = new Server(
    { name: 'hammond-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const operations = await client.listOperations();
    return {
      tools: operations.map((operation) => ({
        name: operation.name,
        description: operation.description,
        inputSchema: operation.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await client.invokeOperation(name, args ?? {});
      const payload = PREPARE_OPERATIONS.has(name)
        ? { ...(result as Record<string, unknown>), nextAction: NEXT_ACTION_REMINDER }
        : result;
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(describeError(error), null, 2) }],
      };
    }
  });

  return server;
}

function describeError(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof HammondOperationError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof HammondNotRunningError) {
    return { code: 'hammond_not_running', message: error.message };
  }
  if (error instanceof Error) {
    return { code: 'adapter_error', message: error.message };
  }
  return { code: 'adapter_error', message: String(error) };
}

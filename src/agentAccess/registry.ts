import { z } from 'zod';

import type { AgentAccessDeps } from './deps';
import { AgentAccessError, toAgentAccessError } from './errors';
import { assignmentOperations } from './operations/assignments';
import { commentOperations } from './operations/comments';
import { contextOperations } from './operations/context';
import { harnessOperations } from './operations/harness';
import { instructionOperations } from './operations/instructions';
import { localContextOperations } from './operations/localContexts';
import { projectOperations } from './operations/projects';
import { taskOperations } from './operations/tasks';
import type { AnyOperationDefinition, OperationSummary } from './types';

const ALL_OPERATIONS: AnyOperationDefinition[] = [
  ...projectOperations,
  ...taskOperations,
  ...commentOperations,
  ...contextOperations,
  ...instructionOperations,
  ...assignmentOperations,
  ...localContextOperations,
  ...harnessOperations,
];

/**
 * The one typed, allowlisted operation registry both the HTTP surface and the MCP adapter are
 * built from — see HAM3-015. Neither transport implements Hammond domain behavior a second time:
 * both only reach a Hammond operation by name through `invokeOperation` below.
 */
export class OperationRegistry {
  private readonly byName = new Map<string, AnyOperationDefinition>();

  constructor(operations: AnyOperationDefinition[] = ALL_OPERATIONS) {
    for (const operation of operations) {
      if (this.byName.has(operation.name)) {
        throw new Error(`Duplicate agent-access operation name: ${operation.name}`);
      }
      this.byName.set(operation.name, operation);
    }
  }

  listSummaries(): OperationSummary[] {
    return Array.from(this.byName.values()).map((operation) => ({
      name: operation.name,
      description: operation.description,
      inputSchema: z.toJSONSchema(operation.inputSchema as z.ZodType, { target: 'draft-7' }),
    }));
  }

  async invoke(deps: AgentAccessDeps, name: string, rawInput: unknown): Promise<unknown> {
    const operation = this.byName.get(name);
    if (!operation) {
      throw new AgentAccessError('unknown_operation', `No such operation: ${name}`);
    }
    const parsed = operation.inputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new AgentAccessError('validation_error', 'Input failed validation.', {
        issues: parsed.error.issues,
      });
    }
    try {
      return await operation.handler(deps, parsed.data);
    } catch (error) {
      throw toAgentAccessError(error);
    }
  }
}

export const operationRegistry = new OperationRegistry();

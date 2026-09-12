import type { z } from 'zod';

import type { AgentAccessDeps } from './deps';

export interface OperationDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  handler: (deps: AgentAccessDeps, input: Input) => Promise<Output>;
}

/** Type-erases an `OperationDefinition<Input, Output>` for storage in one map of mixed operations. */
export type AnyOperationDefinition = OperationDefinition<unknown, unknown>;

export function defineOperation<Input>(
  name: string,
  description: string,
  inputSchema: z.ZodType<Input>,
  handler: (deps: AgentAccessDeps, input: Input) => Promise<unknown>,
): AnyOperationDefinition {
  return { name, description, inputSchema, handler } as AnyOperationDefinition;
}

export interface OperationSummary {
  name: string;
  description: string;
  inputSchema: unknown;
}

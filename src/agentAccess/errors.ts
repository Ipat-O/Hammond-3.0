/**
 * Transport-agnostic error codes for the agent-access operation registry. The Rust HTTP layer
 * (`src-tauri/src/agent_access/server.rs`) maps these to HTTP status codes; the MCP adapter
 * (`mcp/src/index.ts`) surfaces `code`/`message` directly in a tool error result. Neither
 * transport invents its own error vocabulary — this is the one place operation failures are
 * classified.
 */
export type AgentAccessErrorCode =
  | 'validation_error'
  | 'unknown_operation'
  | 'not_found'
  | 'conflict'
  | 'stale_preview'
  | 'requires_confirmation'
  | 'forbidden'
  | 'unauthenticated'
  | 'persistence_failed';

export class AgentAccessError extends Error {
  readonly code: AgentAccessErrorCode;
  readonly details?: unknown;

  constructor(code: AgentAccessErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AgentAccessError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Normalizes any thrown value (a domain error from `InstructionDomainError`/
 * `AssignmentDomainError`, a raw Supabase/PostgREST error, or an unrelated exception) into an
 * `AgentAccessError` so every operation handler's failure reaches a transport in the same shape,
 * without every handler re-implementing this mapping.
 */
export function toAgentAccessError(error: unknown): AgentAccessError {
  if (error instanceof AgentAccessError) return error;

  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    // `.single()` finding zero (or more than one) row is Supabase/PostgREST's signal for "not
    // visible to this owner" — RLS filters a cross-owner or nonexistent id the same way, so a
    // foreign id is never distinguishable from a missing one.
    if (code === 'PGRST116') {
      return new AgentAccessError('not_found', 'No matching record was found.');
    }
    if (
      error.name === 'InstructionDomainError' ||
      error.name === 'AssignmentDomainError' ||
      error.name === 'ImportPostSaveFailure'
    ) {
      return new AgentAccessError('conflict', error.message);
    }
    // A malformed continuation cursor (`src/data/pagination.ts`) is caller input, not a backend
    // fault — classify it as a stable validation error, never a generic persistence failure.
    if (error.name === 'PaginationCursorError' || error.name === 'TargetConsistencyError') {
      return new AgentAccessError('validation_error', error.message);
    }
    return new AgentAccessError('persistence_failed', error.message);
  }
  return new AgentAccessError('persistence_failed', String(error));
}

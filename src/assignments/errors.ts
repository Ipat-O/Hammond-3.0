export type AssignmentErrorCode =
  'missing_assignment' | 'stale_reference' | 'permission_denied' | 'persistence_failed';

/**
 * A repository/service failure for the agent-assignment domain, typed so
 * callers can distinguish "the project or assignment row is stale/missing"
 * from "the write was denied or otherwise failed to persist" rather than
 * treating every failure the same way. Never thrown in place of a real
 * result: nothing in this domain fabricates a saved assignment on failure.
 */
export class AssignmentDomainError extends Error {
  readonly code: AssignmentErrorCode;

  constructor(code: AssignmentErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AssignmentDomainError';
    this.code = code;
  }
}

/**
 * Maps a raw Postgres/PostgREST error into a typed, actionable domain
 * error. Postgres/PostgREST codes: PGRST116 = `.single()` found zero (or
 * more than one) row, meaning the targeted (project, role) assignment does
 * not exist or is no longer visible to this owner (RLS silently filters a
 * cross-owner/stale project rather than raising a distinct error, so this
 * is the correct signal for "missing"); 23503 = foreign key violation (the
 * project itself no longer exists); 42501 = insufficient privilege (RLS
 * rejected the write).
 */
export function toAssignmentDomainError(error: unknown): AssignmentDomainError {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);

  if (code === 'PGRST116') {
    return new AssignmentDomainError('missing_assignment', message, { cause: error });
  }
  if (code === '23503') {
    return new AssignmentDomainError('stale_reference', message, { cause: error });
  }
  if (code === '42501') {
    return new AssignmentDomainError('permission_denied', message, { cause: error });
  }
  return new AssignmentDomainError('persistence_failed', message, { cause: error });
}

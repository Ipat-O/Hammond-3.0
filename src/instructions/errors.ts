export type InstructionErrorCode =
  'missing_selection' | 'wrong_category_version' | 'stale_reference' | 'persistence_failed';

export class InstructionDomainError extends Error {
  readonly code: InstructionErrorCode;

  constructor(code: InstructionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InstructionDomainError';
    this.code = code;
  }
}

/**
 * Maps a raw Postgres/PostgREST error surfaced by the repository into a
 * typed, actionable domain error instead of letting a bare driver error
 * reach callers. Postgres error codes: 23514 = check constraint violation
 * (the project_instruction_selections_validate trigger rejects a reference
 * that belongs to the wrong layer/role/provider/project/owner), 23503 =
 * foreign key violation (a referenced version id no longer exists), 42501 =
 * insufficient privilege (RLS rejected the write, or the caller tried an
 * append-only/immutable mutation).
 */
export function toInstructionDomainError(error: unknown): InstructionDomainError {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);

  if (code === '23514') {
    return new InstructionDomainError('wrong_category_version', message, { cause: error });
  }
  if (code === '23503') {
    return new InstructionDomainError('stale_reference', message, { cause: error });
  }
  return new InstructionDomainError('persistence_failed', message, { cause: error });
}

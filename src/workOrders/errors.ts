export type WorkOrderErrorCode =
  | 'invalid_fields'
  | 'duplicate_dispatch'
  | 'immutable_conflict'
  | 'not_found'
  | 'persistence_failed';

/**
 * A failure in the work-orders domain, typed so callers can distinguish "the packet fields
 * failed validation" from "an already-recorded dispatch was asked to change" from an ordinary
 * storage failure. Never thrown in place of a real result: nothing in this domain fabricates a
 * recorded dispatch or report on failure.
 */
export class WorkOrderDomainError extends Error {
  readonly code: WorkOrderErrorCode;

  constructor(code: WorkOrderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkOrderDomainError';
    this.code = code;
  }
}

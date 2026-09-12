/**
 * Deterministic keyset pagination shared by every repository list method exposed to the
 * agent-access registry. Offset-based pagination (`.range()`) shifts underneath a caller when
 * rows are inserted between pages; keyset pagination on `(created_at, id)` does not, and the
 * `id` tiebreaker keeps ordering total (and therefore free of omissions/duplicates) even across
 * rows sharing the exact same `created_at` timestamp.
 */

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export interface PageParams {
  limit?: number;
  /** An opaque continuation token from a previous page's `nextCursor`. `null`/omitted starts from the first page. */
  cursor?: string | null;
}

export interface Page<T> {
  items: T[];
  /** Present iff more rows exist beyond this page; pass back as `cursor` to continue. */
  nextCursor: string | null;
}

export interface KeysetRow {
  created_at: string;
  id: string;
}

/**
 * A malformed / unparseable continuation cursor. Carries `name === 'PaginationCursorError'` so
 * `toAgentAccessError` (`src/agentAccess/errors.ts`) can classify it as `validation_error`
 * (HTTP 400) rather than letting it fall through to a generic `persistence_failed` (500) — a bad
 * cursor is caller input, not a backend fault.
 */
export class PaginationCursorError extends Error {
  constructor(message = 'Invalid pagination cursor.') {
    super(message);
    this.name = 'PaginationCursorError';
  }
}

/**
 * The two cursor fields are interpolated into a PostgREST `.or()` filter string
 * (`keysetPredicate` below), so each must be validated to a shape that carries no PostgREST
 * filter syntax (`,` splits OR terms; `.` separates column/operator/value; `(` `)` form
 * `and(...)` groups) before it is ever embedded. These patterns are deliberately strict: the
 * only values `encodeCursor` ever produces are a Postgres `timestamptz` (as ISO-8601) and a
 * `uuid` primary key.
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CURSOR_SEPARATOR = '::';
const MAX_CURSOR_LENGTH = 128;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.trunc(limit)));
}

/** Cursors are plain (not secret) continuation markers, not credentials — no need to obscure them. */
export function encodeCursor(row: KeysetRow): string {
  return `${row.created_at}${CURSOR_SEPARATOR}${row.id}`;
}

function isValidTimestamp(value: string): boolean {
  return ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

export function decodeCursor(cursor: string | null | undefined): KeysetRow | null {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH) {
    throw new PaginationCursorError();
  }
  const separatorIndex = cursor.indexOf(CURSOR_SEPARATOR);
  if (separatorIndex < 0) {
    throw new PaginationCursorError();
  }
  const createdAt = cursor.slice(0, separatorIndex);
  const id = cursor.slice(separatorIndex + CURSOR_SEPARATOR.length);
  // Both halves must round-trip to exactly the format `encodeCursor` emits — anything else
  // (an extra separator, a `.or()` metacharacter, a non-timestamp, a non-uuid) is rejected
  // before it can reach `keysetPredicate`.
  if (!isValidTimestamp(createdAt) || !UUID.test(id)) {
    throw new PaginationCursorError();
  }
  return { created_at: createdAt, id };
}

/**
 * The `.or()` keyset predicate for "strictly after `after` in `(created_at, id)` order"
 * (ascending) or "strictly before" (descending). Combined with ordering by the same two columns
 * in the same direction, this is what makes a page boundary landing mid-timestamp resume without
 * skipping or repeating a row. `after` is only ever a value returned by `decodeCursor`, whose
 * strict validation is what keeps this string free of injected filter syntax.
 */
export function keysetPredicate(after: KeysetRow, ascending: boolean): string {
  const op = ascending ? 'gt' : 'lt';
  return `created_at.${op}.${after.created_at},and(created_at.eq.${after.created_at},id.${op}.${after.id})`;
}

/** Splits a `limit + 1`-row fetch into the page to return plus the next cursor, if any. */
export function toPage<Row extends KeysetRow>(rows: Row[], limit: number): Page<Row> {
  if (rows.length <= limit) {
    return { items: rows, nextCursor: null };
  }
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: encodeCursor(last) };
}

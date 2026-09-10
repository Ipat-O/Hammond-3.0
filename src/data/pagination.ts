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

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.trunc(limit)));
}

/** Cursors are plain (not secret) continuation markers, not credentials — no need to obscure them. */
export function encodeCursor(row: KeysetRow): string {
  return `${row.created_at}::${row.id}`;
}

export function decodeCursor(cursor: string | null | undefined): KeysetRow | null {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  const separatorIndex = cursor.indexOf('::');
  if (separatorIndex < 0) {
    throw new Error('Invalid pagination cursor');
  }
  const createdAt = cursor.slice(0, separatorIndex);
  const id = cursor.slice(separatorIndex + 2);
  if (!createdAt || !id) {
    throw new Error('Invalid pagination cursor');
  }
  return { created_at: createdAt, id };
}

/**
 * The `.or()` keyset predicate for "strictly after `after` in `(created_at, id)` order"
 * (ascending) or "strictly before" (descending). Combined with ordering by the same two columns
 * in the same direction, this is what makes a page boundary landing mid-timestamp resume without
 * skipping or repeating a row.
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

/** Opaque offset cursors for the facade's bounded list tools. Not meant to be stable across a
 * changing underlying collection (an insert/delete between pages can shift results) — good enough
 * for a first version's "no silent truncation" contract, where every response reports whether
 * more results exist and how to continue. */

interface CursorPayload {
  offset: number;
}

export function encodeCursor(offset: number): string {
  return btoa(JSON.stringify({ offset } satisfies CursorPayload));
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(atob(cursor)) as Partial<CursorPayload>;
    return typeof parsed.offset === 'number' && parsed.offset >= 0 ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

export function paginate<T>(
  items: T[],
  cursor: string | undefined,
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const offset = decodeCursor(cursor);
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return { items: page, nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null };
}

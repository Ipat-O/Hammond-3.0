import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  keysetPredicate,
  PaginationCursorError,
  toPage,
} from './pagination';

const TS = '2026-09-10T17:00:50.123456+00:00';
const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('decodeCursor validation (HAM3-015 Correction 1, F4)', () => {
  it('round-trips a real (timestamp, uuid) cursor', () => {
    const cursor = encodeCursor({ created_at: TS, id: ID });
    expect(decodeCursor(cursor)).toEqual({ created_at: TS, id: ID });
  });

  it('accepts the ISO-8601 shapes Postgres timestamptz serializes to', () => {
    for (const ts of [
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00.000Z',
      '2026-09-10T17:00:50+00:00',
      '2026-09-10T17:00:50.123456+02:00',
    ]) {
      expect(decodeCursor(`${ts}::${ID}`)).toEqual({ created_at: ts, id: ID });
    }
  });

  it('returns null for an absent cursor', () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it.each([
    ['no separator', `${TS}${ID}`],
    ['empty half', `${TS}::`],
    ['non-timestamp created_at', `not-a-timestamp::${ID}`],
    ['non-uuid id', `${TS}::comments-3`],
    ['PostgREST OR injection in created_at', `2020-01-01T00:00:00Z,id.gt.zzz::${ID}`],
    ['PostgREST filter syntax in id', `${TS}::id.gt.zzz`],
    ['and() group injection', `${TS}::${ID},and(created_at.gt.2000-01-01T00:00:00Z`],
    ['parenthesis in id', `${TS}::${ID})`],
    ['whitespace', `${TS}:: ${ID}`],
    ['over length', `${TS}::${ID}${'x'.repeat(200)}`],
  ])('rejects %s with a PaginationCursorError', (_label, bad) => {
    expect(() => decodeCursor(bad)).toThrow(PaginationCursorError);
  });

  it('a rejected cursor is name-tagged so the API maps it to validation_error, not a 500', () => {
    try {
      decodeCursor('garbage');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).name).toBe('PaginationCursorError');
    }
  });
});

describe('keyset pagination mechanics are unchanged', () => {
  it('clampLimit stays within [1, 200] and defaults to 50', () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(5000)).toBe(200);
    expect(clampLimit(17)).toBe(17);
  });

  it('keysetPredicate is only ever fed decodeCursor output and keeps its ascending/descending shape', () => {
    const after = decodeCursor(`${TS}::${ID}`)!;
    expect(keysetPredicate(after, true)).toBe(
      `created_at.gt.${TS},and(created_at.eq.${TS},id.gt.${ID})`,
    );
    expect(keysetPredicate(after, false)).toBe(
      `created_at.lt.${TS},and(created_at.eq.${TS},id.lt.${ID})`,
    );
  });

  it('toPage splits an over-fetch and emits a resumable cursor that decodes cleanly', () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
      id: `3f2504e0-4f89-41d3-9a0c-0305e82c330${i}`,
    }));
    const page = toPage(rows, 3);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor)).toEqual({
      created_at: rows[2].created_at,
      id: rows[2].id,
    });

    const lastPage = toPage(rows.slice(3), 3);
    expect(lastPage.nextCursor).toBeNull();
  });
});

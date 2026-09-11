import { dataOrThrow, normalizeSupabaseError } from './supabaseError';

describe('normalizeSupabaseError', () => {
  it('wraps a plain PostgREST error body (not an Error instance) into a real Error', () => {
    // The exact shape @supabase/postgrest-js hands back on its normal (non-`.throwOnError()`)
    // path for `.single()` finding zero rows: `JSON.parse`d response body, never a class
    // instance. Reproduces the live HAM3-015 Correction 2 finding.
    const raw = {
      code: 'PGRST116',
      message: 'JSON object requested, multiple (or no) rows returned',
      details: 'Results contain 0 rows, application/vnd.pgrst.object+json requires 1 row',
      hint: null,
    };

    const normalized = normalizeSupabaseError(raw as unknown as { message?: string });

    expect(normalized).toBeInstanceOf(Error);
    expect(normalized.code).toBe('PGRST116');
    expect(normalized.message).toBe('JSON object requested, multiple (or no) rows returned');
  });

  it('passes an already-real Error through unchanged rather than re-wrapping it', () => {
    const original = Object.assign(new Error('already real'), { code: 'PGRST116' });
    expect(normalizeSupabaseError(original)).toBe(original);
  });

  it('falls back to a generic message when the plain error body has none', () => {
    const normalized = normalizeSupabaseError({ code: 'unknown' });
    expect(normalized).toBeInstanceOf(Error);
    expect(normalized.message).toBe('Supabase request failed');
    expect(normalized.code).toBe('unknown');
  });
});

describe('dataOrThrow', () => {
  it('throws a normalized (instanceof Error, .code preserved) error for a plain PostgREST error body', () => {
    let caught: unknown;
    try {
      dataOrThrow({
        data: null,
        error: { code: 'PGRST116', message: 'no matching row' } as unknown as Error,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe('PGRST116');
  });

  it('returns data when there is no error', () => {
    expect(dataOrThrow({ data: { id: '1' }, error: null })).toEqual({ id: '1' });
  });

  it('throws a plain Error when there is neither data nor an error', () => {
    expect(() => dataOrThrow({ data: null, error: null })).toThrow('Supabase returned no data');
  });
});

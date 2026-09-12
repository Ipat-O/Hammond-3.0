/**
 * Normalizes a Supabase/PostgREST `{ data, error }` result's `error` into a genuine `Error`
 * instance carrying its original `code`/`details`/`hint`, and throws it.
 *
 * `@supabase/postgrest-js` only constructs its own `PostgrestError` class (which extends `Error`)
 * on the `.throwOnError()` path — nothing in this app calls that. On the normal `{ data, error }`
 * path every repository here uses, a failed request's `error` is just the response body parsed
 * with `JSON.parse`: a plain object (`{ code, message, details, hint }`), never `instanceof
 * Error`. Every downstream consumer branches on `instanceof Error` to read `.message`/`.code` —
 * `toAgentAccessError` (HAM3-015's `not_found` -> HTTP 404 mapping) and every screen's own
 * `errorMessage()` UI helper alike — so throwing that raw plain object instead of a real `Error`
 * silently misclassifies every ordinary Supabase failure (an expected `PGRST116` "no matching
 * row" included) as an opaque, generic one. Confirmed live: `projects.get` on a just-deleted
 * project returned HTTP 500 `persistence_failed`/`"[object Object]"` instead of the documented
 * 404 `not_found` (HAM3-015 Correction 2).
 *
 * Idempotent: an `error` that already is an `Error` (a real `PostgrestError`, a future
 * postgrest-js version, or a test fake) passes through unchanged rather than being re-wrapped.
 */
export function normalizeSupabaseError(
  error: { message?: string; code?: string; details?: string; hint?: string } | Error,
): Error & { code?: string; details?: string; hint?: string } {
  if (error instanceof Error) return error;
  const { message, ...rest } = error;
  return Object.assign(new Error(message ?? 'Supabase request failed'), {
    name: 'PostgrestError',
    ...rest,
  });
}

/**
 * Unwraps a Supabase `{ data, error }` result, throwing `error` (normalized — see
 * {@link normalizeSupabaseError}) if present, else returning `data`. `data === null` with no
 * `error` is a distinct, genuinely unexpected case (not the ordinary "zero rows" shape any
 * caller here produces) and is reported as its own plain `Error`, never silently passed through.
 */
export function dataOrThrow<T>(result: {
  data: T;
  error: { message?: string; code?: string; details?: string; hint?: string } | Error | null;
}): NonNullable<T> {
  if (result.error) throw normalizeSupabaseError(result.error);
  if (result.data === null) throw new Error('Supabase returned no data');
  return result.data as NonNullable<T>;
}

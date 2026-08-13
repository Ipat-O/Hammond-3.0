const WINDOWS_ABSOLUTE_PATH = /(^|[\s"'(])(?:[a-zA-Z]:[\\/]|\\\\)[^\s"')]+/;
const POSIX_ABSOLUTE_PATH = /(^|[\s"'(])\/(?!\/)[^\s"')]+/;

export function assertNoAbsoluteLocalPaths(value: unknown): void {
  if (typeof value === 'string') {
    if (WINDOWS_ABSOLUTE_PATH.test(value) || POSIX_ABSOLUTE_PATH.test(value)) {
      throw new Error('Supabase payloads must not contain absolute local paths');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoAbsoluteLocalPaths);
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(assertNoAbsoluteLocalPaths);
  }
}

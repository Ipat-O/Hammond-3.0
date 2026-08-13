import { assertNoAbsoluteLocalPaths } from './pathGuard';

describe('assertNoAbsoluteLocalPaths', () => {
  it.each([
    'C:\\Users\\owner\\repo',
    'D:/work/repo',
    '\\\\server\\share\\repo',
    '/home/owner/repo',
  ])('rejects %s', (path) =>
    expect(() => assertNoAbsoluteLocalPaths({ nested: path })).toThrow(/absolute local paths/),
  );

  it('allows identifiers, prose, and web URLs', () => {
    expect(() =>
      assertNoAbsoluteLocalPaths({
        projectId: 'abc',
        note: 'owner/project',
        url: 'https://example.test/x',
      }),
    ).not.toThrow();
  });
});

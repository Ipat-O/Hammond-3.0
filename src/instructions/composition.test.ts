import { composeInstructions } from './composition';
import type { ComposedLayers } from './types';

function layers(overrides: Partial<ComposedLayers> = {}): ComposedLayers {
  return { sharedRole: '', provider: '', projectOverride: '', taskWorkOrder: '', ...overrides };
}

describe('composeInstructions', () => {
  it('joins all four layers in order with exactly two newlines between them', () => {
    const input = layers({
      sharedRole: 'shared',
      provider: 'provider',
      projectOverride: 'override',
      taskWorkOrder: 'work order',
    });
    expect(composeInstructions(input)).toBe('shared\n\nprovider\n\noverride\n\nwork order');
  });

  it('omits an empty layer entirely, without introducing an extra separator', () => {
    expect(composeInstructions(layers({ sharedRole: 'shared', provider: 'provider' }))).toBe(
      'shared\n\nprovider',
    );
  });

  it('keeps whitespace-only content as content rather than trimming it away', () => {
    const input = layers({ sharedRole: '   ', provider: 'provider' });
    expect(composeInstructions(input)).toBe('   \n\nprovider');
  });

  it('returns the empty string when every layer is omitted', () => {
    expect(composeInstructions(layers())).toBe('');
  });

  it('returns a single layer unmodified when it is the only one present', () => {
    expect(composeInstructions(layers({ projectOverride: 'only this' }))).toBe('only this');
  });

  it('produces identical output on repeated calls with the same input (deterministic, no hidden state)', () => {
    const input = layers({ sharedRole: 'a', provider: 'b', taskWorkOrder: 'd' });
    const first = composeInstructions(input);
    const second = composeInstructions(input);
    expect(first).toBe(second);
    expect(first).toBe('a\n\nb\n\nd');
  });

  it('does not mutate its input', () => {
    const input = layers({
      sharedRole: 'a',
      provider: 'b',
      projectOverride: 'c',
      taskWorkOrder: 'd',
    });
    const snapshot = { ...input };
    composeInstructions(input);
    expect(input).toEqual(snapshot);
  });

  it('preserves content byte-for-byte, including internal newlines, without reinterpreting it', () => {
    const input = layers({ sharedRole: 'line one\nline two', provider: 'p' });
    expect(composeInstructions(input)).toBe('line one\nline two\n\np');
  });

  // Every one of the 2^4 combinations of omitted (empty-string) vs. present layers,
  // proving the exact join order and separator hold for each permutation.
  const layerKeys: (keyof ComposedLayers)[] = [
    'sharedRole',
    'provider',
    'projectOverride',
    'taskWorkOrder',
  ];
  const labels: Record<keyof ComposedLayers, string> = {
    sharedRole: 'SHARED',
    provider: 'PROVIDER',
    projectOverride: 'OVERRIDE',
    taskWorkOrder: 'WORKORDER',
  };

  for (let mask = 0; mask < 16; mask++) {
    const present = layerKeys.filter((_, index) => (mask & (1 << index)) !== 0);
    const description =
      present.length === 0 ? 'no layers present' : `present: ${present.join(', ')}`;

    it(`permutation (${description}) composes only the included layers in fixed order`, () => {
      const input = layers();
      for (const key of present) input[key] = labels[key];

      const expected = present.map((key) => labels[key]).join('\n\n');
      expect(composeInstructions(input)).toBe(expected);
    });
  }
});

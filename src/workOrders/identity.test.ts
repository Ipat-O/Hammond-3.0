import { describe, expect, it } from 'vitest';

import {
  formatIdentity,
  identitiesEqual,
  identityIsComplete,
  isIndependentFamily,
  seedIdentityFromProviderFamily,
} from './identity';
import type { ParticipantIdentity } from './types';

function identity(provider: string, tool: string, model: string): ParticipantIdentity {
  return { provider, tool, model };
}

describe('identityIsComplete', () => {
  it('is true only when every field is non-blank', () => {
    expect(identityIsComplete(identity('Anthropic', 'Claude Code', 'claude-sonnet-5'))).toBe(true);
    expect(identityIsComplete(identity('Anthropic', 'Claude Code', ''))).toBe(false);
    expect(identityIsComplete(identity('', '', ''))).toBe(false);
    expect(identityIsComplete(identity('  ', 'Claude Code', 'x'))).toBe(false);
  });
});

describe('identitiesEqual', () => {
  it('compares case- and whitespace-insensitively per field', () => {
    const a = identity('Anthropic', 'Claude Code', 'claude-sonnet-5');
    const b = identity(' anthropic ', 'CLAUDE CODE', 'Claude-Sonnet-5');
    expect(identitiesEqual(a, b)).toBe(true);
  });

  it('is false when any field differs', () => {
    const a = identity('Anthropic', 'Claude Code', 'claude-sonnet-5');
    const b = identity('Anthropic', 'Claude Code', 'claude-opus-5');
    expect(identitiesEqual(a, b)).toBe(false);
  });
});

describe('isIndependentFamily', () => {
  it('is true for different, non-blank provider families regardless of tool', () => {
    const worker = identity('Anthropic', 'Claude Code', 'claude-sonnet-5');
    const auditor = identity('DeepSeek', 'Kilo Code', 'deepseek-v4-pro');
    expect(isIndependentFamily(worker, auditor)).toBe(true);
  });

  it('is false for the same provider family even with different tools', () => {
    // Regression guard: tool-name inequality alone must never establish independence, since
    // Kilo Code can host different providers and the same provider can be reached through
    // different tools.
    const worker = identity('Anthropic', 'Claude Code', 'claude-sonnet-5');
    const auditor = identity('Anthropic', 'Some Other Harness', 'claude-opus-5');
    expect(isIndependentFamily(worker, auditor)).toBe(false);
  });

  it('is false when either provider is blank — independence cannot be established from missing data', () => {
    const worker = identity('', 'Kilo Code', 'unknown-model');
    const auditor = identity('DeepSeek', 'Kilo Code', 'deepseek-v4-pro');
    expect(isIndependentFamily(worker, auditor)).toBe(false);
    expect(isIndependentFamily(auditor, worker)).toBe(false);
  });

  it('is case/whitespace-insensitive', () => {
    const a = identity('OpenAI', 'Codex', 'gpt-5.6');
    const b = identity(' openai ', 'Codex Desktop', 'gpt-5.6-sol');
    expect(isIndependentFamily(a, b)).toBe(false);
  });
});

describe('seedIdentityFromProviderFamily', () => {
  it('seeds provider and tool for codex and claude_code, leaving model blank', () => {
    expect(seedIdentityFromProviderFamily('codex')).toEqual({
      provider: 'OpenAI',
      tool: 'Codex',
      model: '',
    });
    expect(seedIdentityFromProviderFamily('claude_code')).toEqual({
      provider: 'Anthropic',
      tool: 'Claude Code',
      model: '',
    });
  });

  it('leaves provider blank for kilo_code since the hosted family is ambiguous', () => {
    const seeded = seedIdentityFromProviderFamily('kilo_code');
    expect(seeded.provider).toBe('');
    expect(seeded.tool).toBe('Kilo Code');
  });
});

describe('formatIdentity', () => {
  it('joins provider / tool / model exactly', () => {
    expect(formatIdentity(identity('Anthropic', 'Claude Code', 'claude-sonnet-5'))).toBe(
      'Anthropic / Claude Code / claude-sonnet-5',
    );
  });

  it('marks blank fields as MISSING rather than rendering an empty segment', () => {
    expect(formatIdentity(identity('', 'Claude Code', ''))).toBe('MISSING / Claude Code / MISSING');
  });
});

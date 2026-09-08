import type { ProviderFamily } from '../instructions/types';
import type { ParticipantIdentity } from './types';

/** Seed values for a work-order identity when a role/provider assignment is known. `provider` is
 * left blank for `kilo_code` because Kilo Code is a harness that can host different provider
 * families (the owner must state which one explicitly) — never guessed. */
export const IDENTITY_SEED_BY_PROVIDER_FAMILY: Readonly<
  Record<ProviderFamily, { provider: string; tool: string }>
> = {
  codex: { provider: 'OpenAI', tool: 'Codex' },
  claude_code: { provider: 'Anthropic', tool: 'Claude Code' },
  kilo_code: { provider: '', tool: 'Kilo Code' },
};

export function seedIdentityFromProviderFamily(family: ProviderFamily): ParticipantIdentity {
  const seed = IDENTITY_SEED_BY_PROVIDER_FAMILY[family];
  return { provider: seed.provider, tool: seed.tool, model: '' };
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function identityIsComplete(identity: ParticipantIdentity): boolean {
  return (
    identity.provider.trim() !== '' && identity.tool.trim() !== '' && identity.model.trim() !== ''
  );
}

export function identitiesEqual(a: ParticipantIdentity, b: ParticipantIdentity): boolean {
  return (
    normalize(a.provider) === normalize(b.provider) &&
    normalize(a.tool) === normalize(b.tool) &&
    normalize(a.model) === normalize(b.model)
  );
}

/**
 * Whether two identities belong to independently-controlled provider families. Compares only the
 * normalized `provider` field — never `tool`, since the same tool (e.g. Kilo Code) can host
 * different families, so tool-name inequality alone never establishes independence. An empty
 * provider on either side means independence cannot be established at all.
 */
export function isIndependentFamily(a: ParticipantIdentity, b: ParticipantIdentity): boolean {
  const pa = normalize(a.provider);
  const pb = normalize(b.provider);
  if (pa === '' || pb === '') return false;
  return pa !== pb;
}

export function formatIdentity(identity: ParticipantIdentity): string {
  const provider = identity.provider.trim() || 'MISSING';
  const tool = identity.tool.trim() || 'MISSING';
  const model = identity.model.trim() || 'MISSING';
  return `${provider} / ${tool} / ${model}`;
}

import type {
  HarnessClassification,
  HarnessClassifyResult,
  HarnessInjectOutcome,
  HarnessRemoveOutcome,
  ManagedHeaderFields,
} from '../api/contracts';
import type { ProviderFamily } from '../instructions/types';
import type { HarnessAdapter } from './contracts';
import { MANAGED_HEADER_FORMAT_VERSION } from './types';

const TARGET_PATHS: Record<ProviderFamily, string> = {
  codex: 'AGENTS.md',
  claude_code: 'CLAUDE.md',
  kilo_code: '.kilocode/rules/hammond.md',
};

export interface FakeHarnessTarget {
  content: string | null;
  classification: HarnessClassification;
}

export interface FakeHarnessFilesystem {
  targets: Map<string, FakeHarnessTarget>;
}

function key(root: string, provider: ProviderFamily): string {
  return `${root}|${provider}`;
}

export function createFakeHarnessFilesystem(): FakeHarnessFilesystem {
  return { targets: new Map() };
}

/** Seeds an existing unmanaged file at a provider's target, as if an owner already had one. */
export function seedUnmanaged(
  fs: FakeHarnessFilesystem,
  root: string,
  provider: ProviderFamily,
  content: string,
) {
  fs.targets.set(key(root, provider), { content, classification: { kind: 'Unmanaged' } });
}

/**
 * In-memory `HarnessAdapter` fake mirroring the load-bearing native invariants: Inject refuses
 * (`RequiresConfirmation`) an Unmanaged target unless `forceReplace` is set, a `ManagedMalformed`
 * target is always safely repaired, and Remove only ever deletes a target whose *current*
 * on-disk content is `ManagedValid`.
 */
export function createFakeHarnessAdapter(
  fs: FakeHarnessFilesystem,
  root: string,
  provider: ProviderFamily,
): HarnessAdapter {
  const relativePath = TARGET_PATHS[provider];

  function classifyNow(): HarnessClassification {
    const existing = fs.targets.get(key(root, provider));
    return existing ? existing.classification : { kind: 'Missing' };
  }

  return {
    async targetPath() {
      return relativePath;
    },

    async classify(): Promise<HarnessClassifyResult> {
      return { relativePath, classification: classifyNow() };
    },

    async inject(_root, fields, composedContent, forceReplace): Promise<HarnessInjectOutcome> {
      const classification = classifyNow();
      if (classification.kind === 'Unmanaged' && !forceReplace) {
        return { kind: 'RequiresConfirmation', relativePath };
      }
      const header: ManagedHeaderFields = {
        ...fields,
        provider,
        formatVersion: MANAGED_HEADER_FORMAT_VERSION,
      };
      fs.targets.set(key(root, provider), {
        content: composedContent,
        classification: { kind: 'ManagedValid', header },
      });
      return { kind: 'Written', relativePath };
    },

    async remove(): Promise<HarnessRemoveOutcome> {
      const classification = classifyNow();
      if (classification.kind === 'Missing') return { kind: 'NotFound', relativePath };
      if (classification.kind !== 'ManagedValid') return { kind: 'Refused', relativePath };
      fs.targets.delete(key(root, provider));
      return { kind: 'Removed', relativePath };
    },
  };
}

export function createFakeHarnessAdapters(
  fs: FakeHarnessFilesystem,
  root: string,
): Record<ProviderFamily, HarnessAdapter> {
  return {
    codex: createFakeHarnessAdapter(fs, root, 'codex'),
    claude_code: createFakeHarnessAdapter(fs, root, 'claude_code'),
    kilo_code: createFakeHarnessAdapter(fs, root, 'kilo_code'),
  };
}

import type {
  HarnessClassification,
  HarnessClassifyResult,
  HarnessInjectOutcome,
  HarnessRemoveOutcome,
  ManagedHeaderFields,
} from '../api/contracts';
import type { InstructionRole, ProviderFamily } from '../instructions/types';
import type { HarnessAdapter } from './contracts';
import { MANAGED_HEADER_FORMAT_VERSION } from './types';

const TARGET_PATHS: Record<ProviderFamily, string> = {
  codex: 'AGENTS.md',
  claude_code: 'CLAUDE.md',
  kilo_code: '.kilocode/rules/hammond.md',
};

/**
 * What is actually on disk for one provider's target, independent of any caller's expected
 * identity: `header` is non-null exactly when the content carries a structurally valid Hammond
 * header (mirrors the real native layer's own `Classification::ManagedValid` vs `ManagedForeign`
 * split — both are "a valid header is present", differing only in whether it matches what the
 * *caller* expects).
 */
export interface FakeHarnessTarget {
  content: string | null;
  header: ManagedHeaderFields | null;
}

export interface FakeHarnessFilesystem {
  targets: Map<string, FakeHarnessTarget>;
}

function key(root: string, provider: ProviderFamily): string {
  return `${root}|${provider}`;
}

/**
 * Mirrors the native `render_managed_document` formatter (`src-tauri/src/harness.rs`) exactly:
 * the header comment block, a blank line, then the composed content verbatim. This is the only
 * place that duplicates the canonical format rather than calling it, because tests run without a
 * Tauri runtime; `harness/service.test.ts` cross-checks a rendered sample against the literal
 * string the Rust side is documented to produce so the two cannot silently drift apart.
 */
export function renderManagedDocumentText(
  header: ManagedHeaderFields,
  composedContent: string,
): string {
  const overrideLine = header.overrideVersionId ?? 'null';
  return (
    '<!-- hammond:managed\n' +
    `format_version: ${header.formatVersion}\n` +
    `project_id: ${header.projectId}\n` +
    `role: ${header.role}\n` +
    `provider: ${header.provider}\n` +
    `shared_role_version_id: ${header.sharedRoleVersionId}\n` +
    `provider_version_id: ${header.providerVersionId}\n` +
    `override_version_id: ${overrideLine}\n` +
    `generated_at: ${header.generatedAt}\n` +
    '-->\n\n' +
    composedContent
  );
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
  fs.targets.set(key(root, provider), { content, header: null });
}

/** Seeds an existing Hammond-managed document for an arbitrary (possibly foreign) identity. */
export function seedManaged(
  fs: FakeHarnessFilesystem,
  root: string,
  provider: ProviderFamily,
  header: ManagedHeaderFields,
  content: string,
) {
  fs.targets.set(key(root, provider), { content, header });
}

/**
 * In-memory `HarnessAdapter` fake mirroring the load-bearing native invariants: `classify`/
 * `remove` compare the current on-disk header (if any) against the caller's own expected
 * `(projectId, role)` — a structurally valid header that does not match comes back
 * `ManagedForeign`, never `ManagedValid`. Inject refuses (`RequiresConfirmation`) an Unmanaged
 * target *or* a `ManagedForeign` one unless `forceReplace` is set, and Remove only ever deletes a
 * target whose *current* content is `ManagedValid` for exactly the caller's own identity.
 */
export function createFakeHarnessAdapter(
  fs: FakeHarnessFilesystem,
  root: string,
  provider: ProviderFamily,
): HarnessAdapter {
  const relativePath = TARGET_PATHS[provider];

  function classifyNow(projectId: string, role: InstructionRole): HarnessClassification {
    const existing = fs.targets.get(key(root, provider));
    if (!existing) return { kind: 'Missing' };
    if (!existing.header) return { kind: 'Unmanaged' };
    const header = existing.header;
    if (header.projectId === projectId && header.role === role && header.provider === provider) {
      return { kind: 'ManagedValid', header };
    }
    return { kind: 'ManagedForeign', header };
  }

  return {
    async targetPath() {
      return relativePath;
    },

    async classify(_root, projectId, role): Promise<HarnessClassifyResult> {
      return { relativePath, classification: classifyNow(projectId, role) };
    },

    async inject(_root, fields, composedContent, forceReplace): Promise<HarnessInjectOutcome> {
      const classification = classifyNow(fields.projectId, fields.role);
      const needsConfirmation =
        classification.kind === 'Unmanaged' || classification.kind === 'ManagedForeign';
      if (needsConfirmation && !forceReplace) {
        return { kind: 'RequiresConfirmation', relativePath };
      }
      const header: ManagedHeaderFields = {
        ...fields,
        provider,
        formatVersion: MANAGED_HEADER_FORMAT_VERSION,
      };
      fs.targets.set(key(root, provider), { content: composedContent, header });
      return { kind: 'Written', relativePath };
    },

    async remove(_root, projectId, role): Promise<HarnessRemoveOutcome> {
      const classification = classifyNow(projectId, role);
      if (classification.kind === 'Missing') return { kind: 'NotFound', relativePath };
      if (classification.kind !== 'ManagedValid') return { kind: 'Refused', relativePath };
      fs.targets.delete(key(root, provider));
      return { kind: 'Removed', relativePath };
    },

    async renderDocumentPreview(fields, composedContent): Promise<string> {
      const header: ManagedHeaderFields = {
        ...fields,
        provider,
        formatVersion: MANAGED_HEADER_FORMAT_VERSION,
      };
      return renderManagedDocumentText(header, composedContent);
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

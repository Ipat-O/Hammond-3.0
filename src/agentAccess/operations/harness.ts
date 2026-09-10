import { z } from 'zod';

import { INSTRUCTION_ROLES } from '../../instructions/types';
import { AgentAccessError } from '../errors';
import { defineOperation } from '../types';

const role = z.enum(INSTRUCTION_ROLES);
const harnessTarget = { root: z.string().min(1), projectId: z.string().min(1), role };
const classificationKind = z.enum([
  'Missing',
  'ManagedValid',
  'ManagedForeign',
  'ManagedMalformed',
  'Unmanaged',
]);

export const harnessOperations = [
  defineOperation(
    'harness.preview',
    "Classification of the current on-disk target plus the full generated document Inject/Update would write right now — read-only, writes nothing. Call this immediately before harness.inject and pass its `generatedHeader` version ids, `classification.kind`, and `targetDigest` back as harness.inject's `expected*` fields.",
    z.object(harnessTarget),
    (deps, input) => deps.harness.preview(input),
  ),

  defineOperation(
    'harness.inject',
    'Writes (creates or updates) the managed harness document (AGENTS.md / CLAUDE.md / .kilocode/rules/hammond.md) for one project role. This is the ONLY operation in this registry that writes a harness file, and only fires on an explicit, separate request — preparing/saving instructions (instructions.prepare) never calls this implicitly. Requires the exact version ids, classification, AND `targetDigest` a fresh harness.preview just returned; if the prepared instructions changed, or the on-disk target changed in any way since that preview (including a body edit that leaves its classification unchanged), this refuses to write and returns `stale_preview` with a fresh preview attached instead, so the caller can review before trying again — it never silently writes over what changed. `forceReplace` is required to overwrite an Unmanaged file or one belonging to a different project/role, exactly like the existing UI safeguard.',
    z.object({
      ...harnessTarget,
      expectedSharedRoleVersionId: z.string().min(1),
      expectedProviderVersionId: z.string().min(1),
      expectedOverrideVersionId: z.string().nullable(),
      expectedClassificationKind: classificationKind,
      expectedTargetDigest: z.string().nullable(),
      forceReplace: z.boolean().optional(),
    }),
    async (deps, input) => {
      const fresh = await deps.harness.preview({
        root: input.root,
        projectId: input.projectId,
        role: input.role,
      });
      const matches =
        fresh.generatedHeader.sharedRoleVersionId === input.expectedSharedRoleVersionId &&
        fresh.generatedHeader.providerVersionId === input.expectedProviderVersionId &&
        fresh.generatedHeader.overrideVersionId === input.expectedOverrideVersionId &&
        fresh.classification.kind === input.expectedClassificationKind &&
        fresh.targetDigest === input.expectedTargetDigest;
      if (!matches) {
        throw new AgentAccessError(
          'stale_preview',
          'The prepared instructions or the target file changed since this preview was taken. Review the attached fresh preview before injecting again.',
          { preview: fresh },
        );
      }
      return deps.harness.inject({
        root: input.root,
        projectId: input.projectId,
        role: input.role,
        forceReplace: input.forceReplace,
      });
    },
  ),

  defineOperation(
    'harness.remove',
    "Removes the currently assigned provider's managed target for one role — refused unless its current on-disk content is Hammond-managed and valid for exactly this project and role.",
    z.object(harnessTarget),
    (deps, input) => deps.harness.remove(input),
  ),

  defineOperation(
    'harness.import',
    "Preserves an Unmanaged target's existing content into the project-override instruction layer, then replaces it with the managed document. Refused unless the target is genuinely Unmanaged.",
    z.object(harnessTarget),
    (deps, input) => deps.harness.importThenReplace(input),
  ),
];

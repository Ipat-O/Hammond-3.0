import { z } from 'zod';

import { INSTRUCTION_LAYERS, INSTRUCTION_ROLES, PROVIDER_FAMILIES } from '../../instructions/types';
import { defineOperation } from '../types';

const role = z.enum(INSTRUCTION_ROLES);
const provider = z.enum(PROVIDER_FAMILIES);
const layer = z.enum(INSTRUCTION_LAYERS);

export const instructionOperations = [
  defineOperation(
    'instructions.listVersions',
    "One slot's own version history, newest first (`[]` if never saved). `provider`/`projectId` are null for the shared_role layer / non-project-scoped slots.",
    z.object({
      role,
      provider: provider.nullable(),
      layer,
      projectId: z.string().min(1).nullable(),
    }),
    (deps, input) => deps.instructions.listOwnerVersions(input),
  ),

  defineOperation(
    'instructions.getEffective',
    'The exact active version ids per layer, their content, and the deterministic composed preview for one project role/provider — full provenance, read-only.',
    z.object({ projectId: z.string().min(1), role, provider }),
    async (deps, input) => {
      const [activeVersionIds, layers, composed] = await Promise.all([
        deps.instructions.resolveActiveVersionIds(input),
        deps.instructions.getActiveLayerContents(input),
        deps.instructions.composePreview(input),
      ]);
      return { activeVersionIds, layers, composed };
    },
  ),

  defineOperation(
    'instructions.getSelection',
    'The currently active version-id selection for one project role/provider, or null if never activated.',
    z.object({ projectId: z.string().min(1), role, provider }),
    (deps, input) => deps.instructions.getSelection(input),
  ),

  defineOperation(
    'instructions.prepare',
    'Saves owner content as a new version for one layer and activates it in Hammond — this ONLY writes to Hammond storage; it never writes or touches an AGENTS.md/CLAUDE.md/.kilocode file. Injection is a separate, explicitly-requested operation (harness.inject).',
    z.object({ projectId: z.string().min(1), role, provider, layer, content: z.string() }),
    (deps, input) => deps.instructions.saveAndActivate(input),
  ),

  defineOperation(
    'instructions.restore',
    "Restores one layer's historical version (a new version carrying that content) and activates it. Also never touches a harness file.",
    z.object({
      projectId: z.string().min(1),
      role,
      provider,
      layer,
      sourceVersionId: z.string().min(1),
    }),
    (deps, input) => deps.instructions.restoreAndActivate(input),
  ),

  defineOperation(
    'instructions.activateExisting',
    'Activates an already-existing version for one layer without creating a new one.',
    z.object({ projectId: z.string().min(1), role, provider, layer, versionId: z.string().min(1) }),
    (deps, input) => deps.instructions.activateExistingVersion(input),
  ),
];

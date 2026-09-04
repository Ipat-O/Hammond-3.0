import { composeInstructions } from './composition';
import type { InstructionRepository } from './contracts';
import { InstructionDomainError, toInstructionDomainError } from './errors';
import type {
  ActiveVersionIds,
  InstructionLayer,
  InstructionRole,
  InstructionSelection,
  InstructionVersion,
  ProviderFamily,
} from './types';

function roleLabel(role: InstructionRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function providerLabel(provider: ProviderFamily): string {
  return provider
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function applyLayer(
  current: ActiveVersionIds,
  layer: InstructionLayer,
  versionId: string,
): ActiveVersionIds {
  if (layer === 'shared_role') return { ...current, sharedRoleVersionId: versionId };
  if (layer === 'provider') return { ...current, providerVersionId: versionId };
  return { ...current, overrideVersionId: versionId };
}

function defaultTemplateName(params: {
  role: InstructionRole;
  provider: ProviderFamily | null;
  layer: InstructionLayer;
}): string {
  const { role, provider, layer } = params;
  if (layer === 'shared_role') return `${roleLabel(role)} / Shared (custom)`;
  if (layer === 'provider')
    return `${roleLabel(role)} / ${providerLabel(provider as ProviderFamily)} (custom)`;
  return `${roleLabel(role)} / ${providerLabel(provider as ProviderFamily)} / Project override`;
}

/**
 * Orchestrates the versioned instruction domain over an injected
 * `InstructionRepository`. Every method here is plain async orchestration
 * over the port, so it is exercisable with an in-memory fake with no
 * Supabase, React, or filesystem involved.
 */
export class InstructionsService {
  constructor(private readonly repo: InstructionRepository) {}

  /** The caller's own version history for one slot, newest first; `[]` if never created. */
  async listOwnerVersions(params: {
    role: InstructionRole;
    provider: ProviderFamily | null;
    layer: InstructionLayer;
    projectId: string | null;
  }): Promise<InstructionVersion[]> {
    const template = await this.repo.getOwnerTemplate(params);
    if (!template) return [];
    return this.repo.listVersions(template.id);
  }

  /**
   * Saves owner-controlled content as a new version, creating the owner's
   * editable template for this slot on first save. Never touches a base row.
   */
  async saveOwnerVersion(params: {
    role: InstructionRole;
    provider: ProviderFamily | null;
    layer: InstructionLayer;
    projectId: string | null;
    content: string;
  }): Promise<InstructionVersion> {
    const { role, provider, layer, projectId, content } = params;
    try {
      let template = await this.repo.getOwnerTemplate({ role, provider, layer, projectId });
      if (!template) {
        template = await this.repo.createOwnerTemplate({
          role,
          provider,
          layer,
          projectId,
          name: defaultTemplateName({ role, provider, layer }),
        });
      }
      return await this.repo.insertVersion({ templateId: template.id, content });
    } catch (error) {
      throw toInstructionDomainError(error);
    }
  }

  /**
   * Restores historical version `sourceVersionId`: inserts a new version
   * carrying its exact content and provenance. Never mutates the source row
   * and never touches any selection on its own.
   */
  async restoreVersion(sourceVersionId: string): Promise<InstructionVersion> {
    try {
      const source = await this.repo.getVersion(sourceVersionId);
      return await this.repo.insertVersion({
        templateId: source.templateId,
        content: source.content,
        restoredFromVersionId: source.id,
      });
    } catch (error) {
      throw toInstructionDomainError(error);
    }
  }

  async getSelection(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
  }): Promise<InstructionSelection | null> {
    return this.repo.getSelection(params);
  }

  /** Throws `missing_selection` instead of returning null, for callers that require an active selection. */
  async requireSelection(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
  }): Promise<InstructionSelection> {
    const selection = await this.repo.getSelection(params);
    if (!selection) {
      throw new InstructionDomainError(
        'missing_selection',
        `No active instruction selection for project ${params.projectId}, role ${params.role}, provider ${params.provider}`,
      );
    }
    return selection;
  }

  /**
   * The version ids that would compose right now: the active selection's
   * pointers when one exists, otherwise the base shared-role and base
   * provider versions with no project override.
   */
  async resolveActiveVersionIds(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
  }): Promise<ActiveVersionIds> {
    const selection = await this.repo.getSelection(params);
    if (selection) {
      return {
        sharedRoleVersionId: selection.sharedRoleVersionId,
        providerVersionId: selection.providerVersionId,
        overrideVersionId: selection.overrideVersionId,
      };
    }
    const [sharedBase, providerBase] = await Promise.all([
      this.repo.getBaseVersion({ role: params.role, provider: null, layer: 'shared_role' }),
      this.repo.getBaseVersion({ role: params.role, provider: params.provider, layer: 'provider' }),
    ]);
    return {
      sharedRoleVersionId: sharedBase.id,
      providerVersionId: providerBase.id,
      overrideVersionId: null,
    };
  }

  /** Selects exact active versions for one project/role/provider. Only takes effect once persisted. */
  async activateSelection(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
    sharedRoleVersionId: string;
    providerVersionId: string;
    overrideVersionId: string | null;
  }): Promise<InstructionSelection> {
    try {
      return await this.repo.upsertSelection(params);
    } catch (error) {
      throw toInstructionDomainError(error);
    }
  }

  /**
   * Restores one layer's historical version and activates it for the given
   * selection, leaving the other two layers exactly as they were. Backed by
   * the repository's atomic `saveAndActivate`: the append-version and
   * activate-selection steps happen in a single database transaction, so a
   * failure at either step (including selection validation) never leaves an
   * unselected "ghost" version behind, and never touches the prior
   * selection.
   */
  async restoreAndActivate(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
    layer: InstructionLayer;
    sourceVersionId: string;
  }): Promise<{ version: InstructionVersion; selection: InstructionSelection }> {
    try {
      return await this.repo.saveAndActivate({
        projectId: params.projectId,
        role: params.role,
        provider: params.provider,
        layer: params.layer,
        restoredFromVersionId: params.sourceVersionId,
      });
    } catch (error) {
      throw toInstructionDomainError(error);
    }
  }

  /**
   * Saves owner content as a new version for one layer and immediately
   * activates it for the given selection, leaving the other two layers
   * exactly as they were. Backed by the repository's atomic
   * `saveAndActivate`: see `restoreAndActivate` above for the same
   * atomicity guarantee.
   */
  async saveAndActivate(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
    layer: InstructionLayer;
    content: string;
  }): Promise<{ version: InstructionVersion; selection: InstructionSelection }> {
    try {
      return await this.repo.saveAndActivate({
        projectId: params.projectId,
        role: params.role,
        provider: params.provider,
        layer: params.layer,
        content: params.content,
      });
    } catch (error) {
      throw toInstructionDomainError(error);
    }
  }

  /** Activates an already-existing version for one layer without creating a new one. */
  async activateExistingVersion(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
    layer: InstructionLayer;
    versionId: string;
  }): Promise<InstructionSelection> {
    const { projectId, role, provider, layer, versionId } = params;
    const current = await this.resolveActiveVersionIds({ projectId, role, provider });
    return this.activateSelection({
      projectId,
      role,
      provider,
      ...applyLayer(current, layer, versionId),
    });
  }

  /** The active (or default) content for each of the three durable layers, by content rather than id. */
  async getActiveLayerContents(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
  }): Promise<{ sharedRole: string; provider: string; projectOverride: string }> {
    const active = await this.resolveActiveVersionIds(params);
    const ids = [
      active.sharedRoleVersionId,
      active.providerVersionId,
      active.overrideVersionId,
    ].filter((id): id is string => id !== null);
    const versions = await this.repo.getVersionsByIds(ids);
    const byId = new Map(versions.map((version) => [version.id, version.content]));

    return {
      sharedRole: byId.get(active.sharedRoleVersionId) ?? '',
      provider: byId.get(active.providerVersionId) ?? '',
      projectOverride: active.overrideVersionId ? (byId.get(active.overrideVersionId) ?? '') : '',
    };
  }

  /** The deterministic composed preview for the currently active (or default) versions, plus optional transient task work order. */
  async composePreview(params: {
    projectId: string;
    role: InstructionRole;
    provider: ProviderFamily;
    taskWorkOrder?: string;
  }): Promise<string> {
    const layers = await this.getActiveLayerContents(params);
    return composeInstructions({ ...layers, taskWorkOrder: params.taskWorkOrder ?? '' });
  }
}

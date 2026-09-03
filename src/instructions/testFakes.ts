import type { InstructionRepository } from './contracts';
import { INSTRUCTION_ROLES, PROVIDER_FAMILIES } from './types';
import type {
  InstructionLayer,
  InstructionSelection,
  InstructionTemplate,
  InstructionVersion,
} from './types';

let uidCounter = 0;
function nextId(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

function postgresError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export interface FakeInstructionStore {
  templates: Map<string, InstructionTemplate>;
  versions: Map<string, InstructionVersion>;
  selections: Map<string, InstructionSelection>;
}

function selectionKey(projectId: string, role: string, provider: string): string {
  return `${projectId}|${role}|${provider}`;
}

/** Seeds the same base shared-role + provider templates/versions the real migration creates. */
export function createFakeInstructionStore(): FakeInstructionStore {
  const templates = new Map<string, InstructionTemplate>();
  const versions = new Map<string, InstructionVersion>();
  const selections = new Map<string, InstructionSelection>();

  function seedBase(
    template: Omit<InstructionTemplate, 'id' | 'ownerId' | 'isBase' | 'name'> & { name: string },
  ) {
    const id = nextId('base-tmpl');
    templates.set(id, { id, ownerId: null, isBase: true, ...template });
    const versionId = nextId('base-ver');
    versions.set(versionId, {
      id: versionId,
      templateId: id,
      ownerId: null,
      version: 1,
      content: '',
      restoredFromVersionId: null,
      createdAt: new Date(0).toISOString(),
    });
  }

  for (const role of INSTRUCTION_ROLES) {
    seedBase({
      role,
      provider: null,
      layer: 'shared_role',
      projectId: null,
      name: `${role} / Shared`,
    });
    for (const provider of PROVIDER_FAMILIES) {
      seedBase({
        role,
        provider,
        layer: 'provider',
        projectId: null,
        name: `${role} / ${provider}`,
      });
    }
  }

  return { templates, versions, selections };
}

/**
 * In-memory `InstructionRepository` fake that mirrors the load-bearing
 * server invariants: append-only, server-assigned version numbers; base
 * templates are seeded and immutable; a selection must reference the
 * correct layer/role/provider/project/owner or is rejected — matching the
 * real `project_instruction_selections_validate` trigger closely enough
 * that service tests exercise the same error paths the database enforces.
 */
export function createFakeInstructionRepository(
  store: FakeInstructionStore = createFakeInstructionStore(),
  ownerId = 'owner-1',
): InstructionRepository & { store: FakeInstructionStore } {
  const repo: InstructionRepository = {
    async getBaseVersion({ role, provider, layer }) {
      const template = Array.from(store.templates.values()).find(
        (t) => t.isBase && t.role === role && t.layer === layer && t.provider === provider,
      );
      if (!template) throw new Error('base template not found');
      const version = Array.from(store.versions.values()).find((v) => v.templateId === template.id);
      if (!version) throw new Error('base version not found');
      return version;
    },

    async getOwnerTemplate({ role, provider, layer, projectId }) {
      return (
        Array.from(store.templates.values()).find(
          (t) =>
            !t.isBase &&
            t.ownerId === ownerId &&
            t.role === role &&
            t.provider === provider &&
            t.layer === layer &&
            t.projectId === projectId,
        ) ?? null
      );
    },

    async createOwnerTemplate({ role, provider, layer, projectId, name }) {
      const existing = await this.getOwnerTemplate({ role, provider, layer, projectId });
      if (existing) throw postgresError('23505', 'duplicate key value violates unique constraint');

      const template: InstructionTemplate = {
        id: nextId('owner-tmpl'),
        ownerId,
        role,
        provider,
        layer,
        projectId,
        name,
        isBase: false,
      };
      store.templates.set(template.id, template);
      return template;
    },

    async insertVersion({ templateId, content, restoredFromVersionId }) {
      const template = store.templates.get(templateId);
      if (!template) throw new Error('template not found');
      if (template.isBase) {
        throw postgresError('42501', 'permission denied for table instruction_template_versions');
      }
      if (restoredFromVersionId) {
        const source = store.versions.get(restoredFromVersionId);
        if (!source || source.templateId !== templateId) {
          throw postgresError(
            '23514',
            'restored_from_version_id must reference a version of the same template',
          );
        }
      }
      const siblingVersions = Array.from(store.versions.values()).filter(
        (v) => v.templateId === templateId,
      );
      const nextVersion = siblingVersions.reduce((max, v) => Math.max(max, v.version), 0) + 1;
      const version: InstructionVersion = {
        id: nextId('owner-ver'),
        templateId,
        ownerId,
        version: nextVersion,
        content,
        restoredFromVersionId: restoredFromVersionId ?? null,
        createdAt: new Date().toISOString(),
      };
      store.versions.set(version.id, version);
      return version;
    },

    async listVersions(templateId) {
      return Array.from(store.versions.values())
        .filter((v) => v.templateId === templateId)
        .sort((a, b) => b.version - a.version);
    },

    async getVersion(id) {
      const version = store.versions.get(id);
      if (!version) throw new Error('version not found');
      return version;
    },

    async getVersionsByIds(ids) {
      return ids
        .map((id) => store.versions.get(id))
        .filter((v): v is InstructionVersion => v !== undefined);
    },

    async getSelection({ projectId, role, provider }) {
      return store.selections.get(selectionKey(projectId, role, provider)) ?? null;
    },

    async upsertSelection(params) {
      const validate = (versionId: string | null, expectedLayer: InstructionLayer) => {
        if (versionId === null) return;
        const version = store.versions.get(versionId);
        if (!version) throw postgresError('23514', 'invalid version reference for selection');
        const template = store.templates.get(version.templateId);
        const providerMismatch =
          expectedLayer !== 'shared_role' && template?.provider !== params.provider;
        const projectMismatch =
          expectedLayer === 'project_override' && template?.projectId !== params.projectId;
        const ownerMismatch = template ? !template.isBase && template.ownerId !== ownerId : true;
        if (
          !template ||
          template.layer !== expectedLayer ||
          template.role !== params.role ||
          providerMismatch ||
          projectMismatch ||
          ownerMismatch
        ) {
          throw postgresError('23514', 'invalid version reference for selection');
        }
      };
      validate(params.sharedRoleVersionId, 'shared_role');
      validate(params.providerVersionId, 'provider');
      validate(params.overrideVersionId, 'project_override');

      const key = selectionKey(params.projectId, params.role, params.provider);
      const existing = store.selections.get(key);
      const selection: InstructionSelection = {
        id: existing?.id ?? nextId('selection'),
        ownerId,
        projectId: params.projectId,
        role: params.role,
        provider: params.provider,
        sharedRoleVersionId: params.sharedRoleVersionId,
        providerVersionId: params.providerVersionId,
        overrideVersionId: params.overrideVersionId,
      };
      store.selections.set(key, selection);
      return selection;
    },

    async saveAndActivate(params) {
      const { projectId, role, provider, layer, content, restoredFromVersionId } = params;
      if ((content === undefined) === (restoredFromVersionId === undefined)) {
        throw new Error('exactly one of content or restoredFromVersionId must be provided');
      }

      let createdTemplateId: string | null = null;
      let insertedVersionId: string | null = null;

      try {
        let templateId: string;
        let versionContent: string;

        if (restoredFromVersionId !== undefined) {
          const source = store.versions.get(restoredFromVersionId);
          const sourceTemplate = source ? store.templates.get(source.templateId) : undefined;
          const providerMismatch = layer !== 'shared_role' && sourceTemplate?.provider !== provider;
          const projectMismatch =
            layer === 'project_override' && sourceTemplate?.projectId !== projectId;
          if (
            !source ||
            !sourceTemplate ||
            sourceTemplate.layer !== layer ||
            sourceTemplate.role !== role ||
            providerMismatch ||
            projectMismatch
          ) {
            throw postgresError(
              '23514',
              'restored_from_version_id does not match the requested layer/role/provider/project',
            );
          }
          templateId = source.templateId;
          versionContent = source.content;
        } else {
          const templateProvider = layer === 'shared_role' ? null : provider;
          const templateProjectId = layer === 'project_override' ? projectId : null;
          let template = Array.from(store.templates.values()).find(
            (t) =>
              !t.isBase &&
              t.ownerId === ownerId &&
              t.role === role &&
              t.provider === templateProvider &&
              t.layer === layer &&
              t.projectId === templateProjectId,
          );
          if (!template) {
            template = {
              id: nextId('owner-tmpl'),
              ownerId,
              role,
              provider: templateProvider,
              layer,
              projectId: templateProjectId,
              name: `${role} / ${layer} (custom)`,
              isBase: false,
            };
            store.templates.set(template.id, template);
            createdTemplateId = template.id;
          }
          templateId = template.id;
          versionContent = content as string;
        }

        const version = await this.insertVersion({
          templateId,
          content: versionContent,
          restoredFromVersionId,
        });
        insertedVersionId = version.id;

        const current = await this.getSelection({ projectId, role, provider });
        let sharedRoleVersionId = current?.sharedRoleVersionId;
        let providerVersionId = current?.providerVersionId;
        let overrideVersionId = current?.overrideVersionId ?? null;
        if (!current) {
          sharedRoleVersionId = (
            await this.getBaseVersion({ role, provider: null, layer: 'shared_role' })
          ).id;
          providerVersionId = (await this.getBaseVersion({ role, provider, layer: 'provider' })).id;
          overrideVersionId = null;
        }
        if (layer === 'shared_role') sharedRoleVersionId = version.id;
        else if (layer === 'provider') providerVersionId = version.id;
        else overrideVersionId = version.id;

        const selection = await this.upsertSelection({
          projectId,
          role,
          provider,
          sharedRoleVersionId: sharedRoleVersionId as string,
          providerVersionId: providerVersionId as string,
          overrideVersionId,
        });
        return { version, selection };
      } catch (error) {
        // Mirrors the real instructions_save_and_activate transaction: any
        // failure after the version (and possibly template) was prepared
        // rolls the whole attempt back, so a retry never finds a ghost row.
        if (insertedVersionId) store.versions.delete(insertedVersionId);
        if (createdTemplateId) store.templates.delete(createdTemplateId);
        throw error;
      }
    },
  };

  return Object.assign(repo, { store });
}

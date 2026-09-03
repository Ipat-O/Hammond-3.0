import { InstructionsService } from './service';
import { createFakeInstructionRepository } from './testFakes';
import type { InstructionRepository } from './contracts';

const project1 = 'project-1';

function findBaseVersionId(
  repo: ReturnType<typeof createFakeInstructionRepository>,
  role: string,
  layer: 'shared_role' | 'provider',
  provider: string | null = null,
) {
  const template = Array.from(repo.store.templates.values()).find(
    (t) => t.isBase && t.role === role && t.layer === layer && t.provider === provider,
  )!;
  return Array.from(repo.store.versions.values()).find((v) => v.templateId === template.id)!.id;
}

describe('InstructionsService', () => {
  describe('saveOwnerVersion / listOwnerVersions', () => {
    it('creates the owner template and version 1 on the first save', async () => {
      const repo = createFakeInstructionRepository();
      const service = new InstructionsService(repo);

      const version = await service.saveOwnerVersion({
        role: 'worker',
        provider: 'claude_code',
        layer: 'provider',
        projectId: null,
        content: 'first draft',
      });

      expect(version.version).toBe(1);
      expect(version.content).toBe('first draft');
      expect(version.restoredFromVersionId).toBeNull();
    });

    it('appends sequential versions on repeated saves without creating a second template', async () => {
      const repo = createFakeInstructionRepository();
      const service = new InstructionsService(repo);
      const params = {
        role: 'worker' as const,
        provider: 'claude_code' as const,
        layer: 'provider' as const,
        projectId: null,
      };

      await service.saveOwnerVersion({ ...params, content: 'v1' });
      await service.saveOwnerVersion({ ...params, content: 'v2' });
      const v3 = await service.saveOwnerVersion({ ...params, content: 'v3' });

      expect(v3.version).toBe(3);
      const ownerTemplates = Array.from(repo.store.templates.values()).filter(
        (t) =>
          !t.isBase &&
          t.role === 'worker' &&
          t.provider === 'claude_code' &&
          t.layer === 'provider',
      );
      expect(ownerTemplates).toHaveLength(1);
    });

    it('lists history newest-first', async () => {
      const repo = createFakeInstructionRepository();
      const service = new InstructionsService(repo);
      const params = {
        role: 'worker' as const,
        provider: 'claude_code' as const,
        layer: 'provider' as const,
        projectId: null,
      };
      await service.saveOwnerVersion({ ...params, content: 'v1' });
      await service.saveOwnerVersion({ ...params, content: 'v2' });

      const history = await service.listOwnerVersions(params);
      expect(history.map((v) => v.version)).toEqual([2, 1]);
      expect(history.map((v) => v.content)).toEqual(['v2', 'v1']);
    });

    it('returns an empty history for a slot the owner never created', async () => {
      const repo = createFakeInstructionRepository();
      const service = new InstructionsService(repo);
      const history = await service.listOwnerVersions({
        role: 'auditor',
        provider: 'kilo_code',
        layer: 'provider',
        projectId: null,
      });
      expect(history).toEqual([]);
    });

    it('rejects saving onto a base template', async () => {
      const repo = createFakeInstructionRepository();
      const baseTemplate = Array.from(repo.store.templates.values()).find(
        (t) => t.isBase && t.role === 'worker' && t.layer === 'provider' && t.provider === 'codex',
      )!;
      await expect(
        repo.insertVersion({ templateId: baseTemplate.id, content: 'sneaking in' }),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('selections', () => {
    it('falls back to base defaults when no selection has ever been made', async () => {
      const repo = createFakeInstructionRepository();
      const service = new InstructionsService(repo);

      const active = await service.resolveActiveVersionIds({
        projectId: project1,
        role: 'worker',
        provider: 'codex',
      });

      expect(active.sharedRoleVersionId).toBe(findBaseVersionId(repo, 'worker', 'shared_role'));
      expect(active.providerVersionId).toBe(findBaseVersionId(repo, 'worker', 'provider', 'codex'));
      expect(active.overrideVersionId).toBeNull();
    });

    it('activates and persists an exact selection', async () => {
      const repo = createFakeInstructionRepository();
      const service = new InstructionsService(repo);
      const sharedId = findBaseVersionId(repo, 'worker', 'shared_role');
      const providerId = findBaseVersionId(repo, 'worker', 'provider', 'claude_code');

      await service.activateSelection({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
        sharedRoleVersionId: sharedId,
        providerVersionId: providerId,
        overrideVersionId: null,
      });

      const selection = await service.getSelection({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
      });
      expect(selection).toMatchObject({
        sharedRoleVersionId: sharedId,
        providerVersionId: providerId,
      });
    });

    it('keeps two providers for the same project/role independent', async () => {
      const repo = createFakeInstructionRepository();
      const service = new InstructionsService(repo);
      const sharedId = findBaseVersionId(repo, 'worker', 'shared_role');

      await service.activateSelection({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
        sharedRoleVersionId: sharedId,
        providerVersionId: findBaseVersionId(repo, 'worker', 'provider', 'claude_code'),
        overrideVersionId: null,
      });
      await service.activateSelection({
        projectId: project1,
        role: 'worker',
        provider: 'codex',
        sharedRoleVersionId: sharedId,
        providerVersionId: findBaseVersionId(repo, 'worker', 'provider', 'codex'),
        overrideVersionId: null,
      });

      const claude = await service.getSelection({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
      });
      const codex = await service.getSelection({
        projectId: project1,
        role: 'worker',
        provider: 'codex',
      });
      expect(claude!.providerVersionId).toBe(
        findBaseVersionId(repo, 'worker', 'provider', 'claude_code'),
      );
      expect(codex!.providerVersionId).toBe(findBaseVersionId(repo, 'worker', 'provider', 'codex'));
      expect(claude!.providerVersionId).not.toBe(codex!.providerVersionId);
    });

    it('rejects a selection referencing the wrong category of version', async () => {
      const repo = createFakeInstructionRepository();
      const service = new InstructionsService(repo);
      const providerId = findBaseVersionId(repo, 'worker', 'provider', 'claude_code');

      await expect(
        service.activateSelection({
          projectId: project1,
          role: 'worker',
          provider: 'claude_code',
          sharedRoleVersionId: providerId, // a provider-layer version used as the shared-role slot
          providerVersionId: providerId,
          overrideVersionId: null,
        }),
      ).rejects.toMatchObject({ code: 'wrong_category_version' });
    });

    it("rejects a selection referencing another owner's private version", async () => {
      const store = createFakeInstructionRepository().store;
      const ownerOneRepo = createFakeInstructionRepository(store, 'owner-one');
      const ownerTwoRepo = createFakeInstructionRepository(store, 'owner-two');
      const ownerTwoService = new InstructionsService(ownerTwoRepo);

      const ownerOneVersion = await ownerOneRepo
        .createOwnerTemplate({
          role: 'worker',
          provider: 'claude_code',
          layer: 'provider',
          projectId: null,
          name: 'owner one custom',
        })
        .then((template) =>
          ownerOneRepo.insertVersion({ templateId: template.id, content: 'private' }),
        );

      await expect(
        ownerTwoService.activateSelection({
          projectId: project1,
          role: 'worker',
          provider: 'claude_code',
          sharedRoleVersionId: findBaseVersionId(ownerTwoRepo, 'worker', 'shared_role'),
          providerVersionId: ownerOneVersion.id,
          overrideVersionId: null,
        }),
      ).rejects.toMatchObject({ code: 'wrong_category_version' });
    });

    it('throws missing_selection from requireSelection when nothing has been chosen yet', async () => {
      const repo = createFakeInstructionRepository();
      const service = new InstructionsService(repo);
      await expect(
        service.requireSelection({ projectId: project1, role: 'auditor', provider: 'kilo_code' }),
      ).rejects.toMatchObject({ code: 'missing_selection' });
    });
  });

  describe('restore', () => {
    it('creates a new version carrying the source content and provenance, without mutating the source', async () => {
      const repo = createFakeInstructionRepository();
      const service = new InstructionsService(repo);
      const params = {
        role: 'worker' as const,
        provider: 'claude_code' as const,
        layer: 'provider' as const,
        projectId: null,
      };
      const v1 = await service.saveOwnerVersion({ ...params, content: 'original' });
      await service.saveOwnerVersion({ ...params, content: 'changed' });

      const restored = await service.restoreVersion(v1.id);

      expect(restored.version).toBe(3);
      expect(restored.content).toBe('original');
      expect(restored.restoredFromVersionId).toBe(v1.id);
      const sourceStillIntact = await repo.getVersion(v1.id);
      expect(sourceStillIntact).toEqual(v1);
    });

    it('restoreAndActivate updates only the targeted layer, leaving the others as they were', async () => {
      const repo = createFakeInstructionRepository();
      const service = new InstructionsService(repo);
      const sharedParams = {
        role: 'worker' as const,
        provider: null,
        layer: 'shared_role' as const,
        projectId: null,
      };
      const sharedV1 = await service.saveOwnerVersion({ ...sharedParams, content: 'shared v1' });
      const providerId = findBaseVersionId(repo, 'worker', 'provider', 'claude_code');

      await service.activateSelection({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
        sharedRoleVersionId: sharedV1.id,
        providerVersionId: providerId,
        overrideVersionId: null,
      });
      await service.saveOwnerVersion({ ...sharedParams, content: 'shared v2' });

      const { selection } = await service.restoreAndActivate({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
        layer: 'shared_role',
        sourceVersionId: sharedV1.id,
      });

      expect(selection.providerVersionId).toBe(providerId);
      const restoredSharedVersion = await repo.getVersion(selection.sharedRoleVersionId);
      expect(restoredSharedVersion.content).toBe('shared v1');
      expect(restoredSharedVersion.restoredFromVersionId).toBe(sharedV1.id);
    });

    it('saveAndActivate creates a new version and makes it active in one step, without touching other layers', async () => {
      const repo = createFakeInstructionRepository();
      const service = new InstructionsService(repo);
      const providerId = findBaseVersionId(repo, 'worker', 'provider', 'claude_code');
      const sharedId = findBaseVersionId(repo, 'worker', 'shared_role');
      await service.activateSelection({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
        sharedRoleVersionId: sharedId,
        providerVersionId: providerId,
        overrideVersionId: null,
      });

      const { version, selection } = await service.saveAndActivate({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
        layer: 'provider',
        content: 'new provider content',
      });

      expect(version.content).toBe('new provider content');
      expect(selection.providerVersionId).toBe(version.id);
      expect(selection.sharedRoleVersionId).toBe(sharedId);
    });

    it('activateExistingVersion re-selects a historical version without creating a new one', async () => {
      const repo = createFakeInstructionRepository();
      const service = new InstructionsService(repo);
      const params = {
        role: 'worker' as const,
        provider: 'claude_code' as const,
        layer: 'provider' as const,
        projectId: null,
      };
      const v1 = await service.saveOwnerVersion({ ...params, content: 'v1' });
      const v2 = await service.saveOwnerVersion({ ...params, content: 'v2' });
      await service.activateSelection({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
        sharedRoleVersionId: findBaseVersionId(repo, 'worker', 'shared_role'),
        providerVersionId: v2.id,
        overrideVersionId: null,
      });

      const selection = await service.activateExistingVersion({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
        layer: 'provider',
        versionId: v1.id,
      });

      expect(selection.providerVersionId).toBe(v1.id);
      const versionCountAfter = Array.from(repo.store.versions.values()).filter(
        (v) => v.templateId === v1.templateId,
      ).length;
      expect(versionCountAfter).toBe(2); // still just v1 and v2 - nothing new was created
    });

    it('leaves the active selection untouched when a restore fails partway through', async () => {
      const repo = createFakeInstructionRepository();
      const service = new InstructionsService(repo);
      const sharedId = findBaseVersionId(repo, 'worker', 'shared_role');
      const providerId = findBaseVersionId(repo, 'worker', 'provider', 'claude_code');
      await service.activateSelection({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
        sharedRoleVersionId: sharedId,
        providerVersionId: providerId,
        overrideVersionId: null,
      });

      const failingRepo: InstructionRepository = {
        ...repo,
        insertVersion: async () => {
          throw new Error('network dropped mid-save');
        },
      };
      const failingService = new InstructionsService(failingRepo);

      await expect(
        failingService.restoreAndActivate({
          projectId: project1,
          role: 'worker',
          provider: 'claude_code',
          layer: 'provider',
          sourceVersionId: providerId,
        }),
      ).rejects.toMatchObject({ code: 'persistence_failed' });

      const selectionAfterFailure = await service.getSelection({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
      });
      expect(selectionAfterFailure).toMatchObject({
        sharedRoleVersionId: sharedId,
        providerVersionId: providerId,
      });
    });

    it('retains the draft and supports retry after a failed save', async () => {
      const repo = createFakeInstructionRepository();
      let shouldFail = true;
      const flakyRepo: InstructionRepository = {
        ...repo,
        insertVersion: async (params) => {
          if (shouldFail) {
            shouldFail = false;
            throw new Error('simulated transient failure');
          }
          return repo.insertVersion(params);
        },
      };
      const service = new InstructionsService(flakyRepo);
      const params = {
        role: 'worker' as const,
        provider: 'claude_code' as const,
        layer: 'provider' as const,
        projectId: null,
      };

      await expect(service.saveOwnerVersion({ ...params, content: 'draft' })).rejects.toMatchObject(
        {
          code: 'persistence_failed',
        },
      );

      // Retrying with the same retained draft content now succeeds.
      const saved = await service.saveOwnerVersion({ ...params, content: 'draft' });
      expect(saved.version).toBe(1);
      expect(saved.content).toBe('draft');
    });
  });

  describe('composePreview', () => {
    it('composes from base defaults when nothing has been selected, and drops empty base content', async () => {
      const repo = createFakeInstructionRepository();
      const service = new InstructionsService(repo);
      const preview = await service.composePreview({
        projectId: project1,
        role: 'auditor',
        provider: 'kilo_code',
      });
      expect(preview).toBe('');
    });

    it('composes shared -> provider -> override -> task work order in exact order with the active selection', async () => {
      const repo = createFakeInstructionRepository();
      const service = new InstructionsService(repo);
      const shared = await service.saveOwnerVersion({
        role: 'worker',
        provider: null,
        layer: 'shared_role',
        projectId: null,
        content: 'SHARED',
      });
      const provider = await service.saveOwnerVersion({
        role: 'worker',
        provider: 'claude_code',
        layer: 'provider',
        projectId: null,
        content: 'PROVIDER',
      });
      const override = await service.saveOwnerVersion({
        role: 'worker',
        provider: 'claude_code',
        layer: 'project_override',
        projectId: project1,
        content: 'OVERRIDE',
      });
      await service.activateSelection({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
        sharedRoleVersionId: shared.id,
        providerVersionId: provider.id,
        overrideVersionId: override.id,
      });

      const preview = await service.composePreview({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
        taskWorkOrder: 'WORK ORDER',
      });

      expect(preview).toBe('SHARED\n\nPROVIDER\n\nOVERRIDE\n\nWORK ORDER');
    });
  });
});

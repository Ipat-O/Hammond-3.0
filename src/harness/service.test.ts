import { AssignmentsService } from '../assignments/service';
import { createFakeAssignmentRepository, seedProjectDefaults } from '../assignments/testFakes';
import { InstructionsService } from '../instructions/service';
import { createFakeInstructionRepository } from '../instructions/testFakes';
import type { HarnessAdapter } from './contracts';
import { ImportPostSaveFailure } from './errors';
import { HarnessInjectionService } from './service';
import {
  createFakeHarnessAdapters,
  createFakeHarnessFilesystem,
  renderManagedDocumentText,
  seedManaged,
  seedUnmanaged,
  type FakeHarnessFilesystem,
} from './testFakes';
import { MANAGED_HEADER_FORMAT_VERSION } from './types';

const project1 = 'project-1';
const project2 = 'project-2';
const root = '/home/owner/project-1';

function foreignHeader(
  overrides: { projectId?: string; role?: 'worker' | 'orchestrator' | 'auditor' } = {},
) {
  return {
    formatVersion: MANAGED_HEADER_FORMAT_VERSION,
    projectId: overrides.projectId ?? project2,
    role: overrides.role ?? ('worker' as const),
    provider: 'claude_code' as const,
    sharedRoleVersionId: 'shared-v1',
    providerVersionId: 'provider-v1',
    overrideVersionId: null,
    generatedAt: '2026-09-04T16:00:00Z',
  };
}

function buildService(fakeFs: FakeHarnessFilesystem = createFakeHarnessFilesystem()) {
  const assignmentRepo = createFakeAssignmentRepository();
  seedProjectDefaults(assignmentRepo.store, project1, 'owner-1');
  const assignments = new AssignmentsService(assignmentRepo);

  const instructionRepo = createFakeInstructionRepository();
  const instructions = new InstructionsService(instructionRepo);

  const adapters = createFakeHarnessAdapters(fakeFs, root);

  const filesystem = {
    async readTextFile(fsRoot: string, relativePath: string) {
      const provider = (Object.keys(adapters) as (keyof typeof adapters)[]).find(
        (p) =>
          ({
            codex: 'AGENTS.md',
            claude_code: 'CLAUDE.md',
            kilo_code: '.kilocode/rules/hammond.md',
          })[p] === relativePath,
      );
      if (!provider) throw new Error(`no fake target for ${relativePath}`);
      const target = fakeFs.targets.get(`${fsRoot}|${provider}`);
      if (!target || target.content === null) throw new Error('not found');
      return target.content;
    },
  };

  return {
    assignments,
    assignmentRepo,
    instructions,
    instructionRepo,
    adapters,
    fakeFs,
    filesystem,
    service: new HarnessInjectionService({ assignments, instructions, adapters, filesystem }),
  };
}

describe('HarnessInjectionService', () => {
  describe('preview', () => {
    it('shows the assigned role/provider, target path, classification, and create action for a fresh project', async () => {
      const { service } = buildService();

      const preview = await service.preview({ root, projectId: project1, role: 'worker' });

      expect(preview.role).toBe('worker');
      expect(preview.provider).toBe('claude_code');
      expect(preview.relativePath).toBe('CLAUDE.md');
      expect(preview.classification).toEqual({ kind: 'Missing' });
      expect(preview.action).toBe('create');
    });

    it('shows update as the action once a managed document already exists', async () => {
      const { service } = buildService();
      await service.inject({ root, projectId: project1, role: 'worker' });

      const preview = await service.preview({ root, projectId: project1, role: 'worker' });

      expect(preview.classification.kind).toBe('ManagedValid');
      expect(preview.action).toBe('update');
    });

    it('shows requires_decision for a preexisting unmanaged file', async () => {
      const fakeFs = createFakeHarnessFilesystem();
      seedUnmanaged(fakeFs, root, 'claude_code', '# my own notes');
      const { service } = buildService(fakeFs);

      const preview = await service.preview({ root, projectId: project1, role: 'worker' });

      expect(preview.classification).toEqual({ kind: 'Unmanaged' });
      expect(preview.action).toBe('requires_decision');
    });

    // ---------------------------------------------------------------------
    // Correction 1: a valid Hammond header recorded for a DIFFERENT project
    // (or role) is a distinct foreign conflict, never a normal current
    // ManagedValid target — this is the owner-visible resolution path.
    // ---------------------------------------------------------------------

    it('shows a distinct managed_foreign classification (not managed_valid) for a document belonging to a different project', async () => {
      const fakeFs = createFakeHarnessFilesystem();
      const foreign = foreignHeader({ projectId: project2, role: 'worker' });
      seedManaged(fakeFs, root, 'claude_code', foreign, "project two's content");
      const { service } = buildService(fakeFs);

      const preview = await service.preview({ root, projectId: project1, role: 'worker' });

      expect(preview.classification).toEqual({ kind: 'ManagedForeign', header: foreign });
      expect(preview.action).toBe('requires_decision');
    });

    it('shows managed_foreign for a document belonging to the same project but a different role', async () => {
      const fakeFs = createFakeHarnessFilesystem();
      // worker already defaults to claude_code (D-014); seed CLAUDE.md as if orchestrator had
      // switched onto claude_code and injected there, without worker ever writing it.
      const foreign = foreignHeader({ projectId: project1, role: 'orchestrator' });
      seedManaged(fakeFs, root, 'claude_code', foreign, 'orchestrator content');
      const { service } = buildService(fakeFs);

      const preview = await service.preview({ root, projectId: project1, role: 'worker' });

      expect(preview.classification.kind).toBe('ManagedForeign');
      expect(preview.action).toBe('requires_decision');
    });

    it('exposes the complete generated document, byte-identical to the canonical managed-document format, distinct from the bare effective content', async () => {
      const { service, instructions } = buildService();
      await instructions.saveAndActivate({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
        layer: 'project_override',
        content: 'be precise',
      });

      const preview = await service.preview({ root, projectId: project1, role: 'worker' });

      expect(preview.generatedDocument).not.toBe(preview.effectiveContent);
      expect(preview.generatedDocument).toContain(preview.effectiveContent);
      expect(preview.generatedDocument.startsWith('<!-- hammond:managed')).toBe(true);
      expect(preview.generatedHeader.projectId).toBe(project1);
      expect(preview.generatedHeader.role).toBe('worker');
      expect(preview.generatedHeader.provider).toBe('claude_code');
      expect(preview.generatedDocument).toBe(
        renderManagedDocumentText(preview.generatedHeader, preview.effectiveContent),
      );
    });

    it("uses the preview call's own generation time, independent of a later Inject's timestamp", async () => {
      let tick = 0;
      const now = () => `2026-09-0${(tick += 1)}T00:00:00.000Z`;
      const assignmentRepo = createFakeAssignmentRepository();
      seedProjectDefaults(assignmentRepo.store, project1, 'owner-1');
      const assignments = new AssignmentsService(assignmentRepo);
      const instructions = new InstructionsService(createFakeInstructionRepository());
      const fakeFs = createFakeHarnessFilesystem();
      const adapters = createFakeHarnessAdapters(fakeFs, root);
      const service = new HarnessInjectionService({
        assignments,
        instructions,
        adapters,
        filesystem: {
          async readTextFile() {
            throw new Error('unused');
          },
        },
        now,
      });

      const preview = await service.preview({ root, projectId: project1, role: 'worker' });
      expect(preview.generatedHeader.generatedAt).toBe('2026-09-01T00:00:00.000Z');

      await service.inject({ root, projectId: project1, role: 'worker' });
      const writtenHeader = fakeFs.targets.get(`${root}|claude_code`)?.header;
      expect(writtenHeader?.generatedAt).toBe('2026-09-02T00:00:00.000Z');
      expect(writtenHeader?.generatedAt).not.toBe(preview.generatedHeader.generatedAt);
    });
  });

  describe('inject', () => {
    it('creates the managed document on first inject', async () => {
      const { service, fakeFs } = buildService();

      const outcome = await service.inject({ root, projectId: project1, role: 'worker' });

      expect(outcome).toEqual({ kind: 'Written', relativePath: 'CLAUDE.md' });
      expect(fakeFs.targets.get(`${root}|claude_code`)?.header).not.toBeNull();
    });

    it('updates an existing managed document in place on a second inject', async () => {
      const { service } = buildService();
      await service.inject({ root, projectId: project1, role: 'worker' });

      const outcome = await service.inject({ root, projectId: project1, role: 'worker' });

      expect(outcome).toEqual({ kind: 'Written', relativePath: 'CLAUDE.md' });
    });

    it('refuses to overwrite an unmanaged target without forceReplace', async () => {
      const fakeFs = createFakeHarnessFilesystem();
      seedUnmanaged(fakeFs, root, 'claude_code', '# my own notes');
      const { service } = buildService(fakeFs);

      const outcome = await service.inject({ root, projectId: project1, role: 'worker' });

      expect(outcome).toEqual({ kind: 'RequiresConfirmation', relativePath: 'CLAUDE.md' });
      expect(fakeFs.targets.get(`${root}|claude_code`)?.content).toBe('# my own notes');
    });

    it('replaces an unmanaged target when forceReplace is set (explicit Replace action)', async () => {
      const fakeFs = createFakeHarnessFilesystem();
      seedUnmanaged(fakeFs, root, 'claude_code', '# my own notes');
      const { service } = buildService(fakeFs);

      const outcome = await service.inject({
        root,
        projectId: project1,
        role: 'worker',
        forceReplace: true,
      });

      expect(outcome).toEqual({ kind: 'Written', relativePath: 'CLAUDE.md' });
    });

    it('refuses to silently overwrite a valid document belonging to a different project', async () => {
      const fakeFs = createFakeHarnessFilesystem();
      const foreign = foreignHeader({ projectId: project2, role: 'worker' });
      seedManaged(fakeFs, root, 'claude_code', foreign, "project two's content");
      const { service } = buildService(fakeFs);

      const outcome = await service.inject({ root, projectId: project1, role: 'worker' });

      expect(outcome).toEqual({ kind: 'RequiresConfirmation', relativePath: 'CLAUDE.md' });
      expect(fakeFs.targets.get(`${root}|claude_code`)?.header).toEqual(foreign);
      expect(fakeFs.targets.get(`${root}|claude_code`)?.content).toBe("project two's content");
    });

    it('replaces a foreign-project document when forceReplace is explicitly set', async () => {
      const fakeFs = createFakeHarnessFilesystem();
      const foreign = foreignHeader({ projectId: project2, role: 'worker' });
      seedManaged(fakeFs, root, 'claude_code', foreign, "project two's content");
      const { service } = buildService(fakeFs);

      const outcome = await service.inject({
        root,
        projectId: project1,
        role: 'worker',
        forceReplace: true,
      });

      expect(outcome).toEqual({ kind: 'Written', relativePath: 'CLAUDE.md' });
      expect(fakeFs.targets.get(`${root}|claude_code`)?.header).toMatchObject({
        projectId: project1,
        role: 'worker',
      });
    });

    it('never reaches the local filesystem when the project has no assignment for the role', async () => {
      const { instructions, fakeFs } = buildService();
      const emptyProjectService = new HarnessInjectionService({
        assignments: new AssignmentsService(createFakeAssignmentRepository()),
        instructions,
        adapters: createFakeHarnessAdapters(fakeFs, root),
        filesystem: {
          async readTextFile() {
            throw new Error('unused');
          },
        },
      });

      await expect(
        emptyProjectService.inject({ root, projectId: 'unseeded-project', role: 'worker' }),
      ).rejects.toMatchObject({ code: 'missing_assignment' });
      expect(fakeFs.targets.has(`${root}|claude_code`)).toBe(false);
    });

    it('a saved assignment survives a local injection failure', async () => {
      const { assignments, instructions, adapters } = buildService();
      await assignments.updateAssignment({
        projectId: project1,
        role: 'worker',
        provider: 'kilo_code',
      });

      const throwingAdapter: HarnessAdapter = {
        async targetPath() {
          return '.kilocode/rules/hammond.md';
        },
        async classify() {
          return {
            relativePath: '.kilocode/rules/hammond.md',
            classification: { kind: 'Missing' },
          };
        },
        async inject() {
          throw new Error('disk full');
        },
        async remove() {
          throw new Error('unused');
        },
        async renderDocumentPreview() {
          throw new Error('unused');
        },
      };
      const service = new HarnessInjectionService({
        assignments,
        instructions,
        adapters: { ...adapters, kilo_code: throwingAdapter },
        filesystem: {
          async readTextFile() {
            throw new Error('unused');
          },
        },
      });

      await expect(service.inject({ root, projectId: project1, role: 'worker' })).rejects.toThrow(
        'disk full',
      );

      // The provider switch to kilo_code, saved before the failed local write, is untouched.
      const assignment = await assignments.getAssignment({ projectId: project1, role: 'worker' });
      expect(assignment?.provider).toBe('kilo_code');
    });
  });

  describe('remove', () => {
    it('removes the currently assigned provider target', async () => {
      const { service, fakeFs } = buildService();
      await service.inject({ root, projectId: project1, role: 'worker' });

      const outcome = await service.remove({ root, projectId: project1, role: 'worker' });

      expect(outcome).toEqual({ kind: 'Removed', relativePath: 'CLAUDE.md' });
      expect(fakeFs.targets.has(`${root}|claude_code`)).toBe(false);
    });

    it('refuses to remove an unmanaged target', async () => {
      const fakeFs = createFakeHarnessFilesystem();
      seedUnmanaged(fakeFs, root, 'claude_code', '# my own notes');
      const { service } = buildService(fakeFs);

      const outcome = await service.remove({ root, projectId: project1, role: 'worker' });

      expect(outcome).toEqual({ kind: 'Refused', relativePath: 'CLAUDE.md' });
    });

    it('refuses to remove a valid document belonging to a different project, leaving it untouched', async () => {
      const fakeFs = createFakeHarnessFilesystem();
      const foreign = foreignHeader({ projectId: project2, role: 'worker' });
      seedManaged(fakeFs, root, 'claude_code', foreign, "project two's content");
      const { service } = buildService(fakeFs);

      const outcome = await service.remove({ root, projectId: project1, role: 'worker' });

      expect(outcome).toEqual({ kind: 'Refused', relativePath: 'CLAUDE.md' });
      expect(fakeFs.targets.get(`${root}|claude_code`)?.header).toEqual(foreign);
    });
  });

  describe('importThenReplace', () => {
    it('saves the existing unmanaged content as the project override layer, then replaces the target', async () => {
      const fakeFs = createFakeHarnessFilesystem();
      seedUnmanaged(fakeFs, root, 'claude_code', '# hand-written notes\nkeep these ideas');
      const { service, instructions } = buildService(fakeFs);

      const result = await service.importThenReplace({ root, projectId: project1, role: 'worker' });

      expect(result.importedVersion.content).toBe('# hand-written notes\nkeep these ideas');
      expect(result.injected).toEqual({ kind: 'Written', relativePath: 'CLAUDE.md' });
      expect(fakeFs.targets.get(`${root}|claude_code`)?.header).not.toBeNull();

      // The imported content is now active as the project override layer.
      const layers = await instructions.getActiveLayerContents({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
      });
      expect(layers.projectOverride).toBe('# hand-written notes\nkeep these ideas');
    });

    it('never writes locally when the import save itself fails', async () => {
      const fakeFs = createFakeHarnessFilesystem();
      seedUnmanaged(fakeFs, root, 'claude_code', '# hand-written notes');
      const { assignments, adapters } = buildService(fakeFs);
      const throwingInstructions = {
        async saveAndActivate(): Promise<never> {
          throw new Error('network error');
        },
      } as unknown as InstructionsService;
      const service = new HarnessInjectionService({
        assignments,
        instructions: throwingInstructions,
        adapters,
        filesystem: {
          async readTextFile(fsRoot: string) {
            return fakeFs.targets.get(`${fsRoot}|claude_code`)!.content!;
          },
        },
      });

      await expect(
        service.importThenReplace({ root, projectId: project1, role: 'worker' }),
      ).rejects.toThrow('network error');
      // The owner's original unmanaged file is exactly as it was.
      expect(fakeFs.targets.get(`${root}|claude_code`)?.header).toBeNull();
      expect(fakeFs.targets.get(`${root}|claude_code`)?.content).toBe('# hand-written notes');
    });

    it('wraps a post-save local write failure as ImportPostSaveFailure carrying the already-saved version, distinct from any pre-save failure', async () => {
      const fakeFs = createFakeHarnessFilesystem();
      seedUnmanaged(fakeFs, root, 'claude_code', '# hand-written notes');
      const { assignments, instructions, adapters } = buildService(fakeFs);
      const throwingAdapter: HarnessAdapter = {
        ...adapters.claude_code,
        async inject() {
          throw new Error('disk full');
        },
      };
      const service = new HarnessInjectionService({
        assignments,
        instructions,
        adapters: { ...adapters, claude_code: throwingAdapter },
        filesystem: {
          async readTextFile(fsRoot: string) {
            return fakeFs.targets.get(`${fsRoot}|claude_code`)!.content!;
          },
        },
      });

      const error = await service
        .importThenReplace({ root, projectId: project1, role: 'worker' })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ImportPostSaveFailure);
      expect((error as ImportPostSaveFailure).importedVersion.content).toBe('# hand-written notes');
      expect((error as Error).message).toBe('disk full');
      // The preservation save happened and is not rolled back by the local write failure.
      const layers = await instructions.getActiveLayerContents({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
      });
      expect(layers.projectOverride).toBe('# hand-written notes');
    });

    it("refuses to import a valid document belonging to a different project as this project's own content", async () => {
      const fakeFs = createFakeHarnessFilesystem();
      const foreign = foreignHeader({ projectId: project2, role: 'worker' });
      seedManaged(fakeFs, root, 'claude_code', foreign, "project two's private content");
      const { service, instructions } = buildService(fakeFs);

      await expect(
        service.importThenReplace({ root, projectId: project1, role: 'worker' }),
      ).rejects.toThrow(/not an unmanaged owner file/);

      // Nothing was imported into project one's override layer, and the foreign file is untouched.
      const layers = await instructions.getActiveLayerContents({
        projectId: project1,
        role: 'worker',
        provider: 'claude_code',
      });
      expect(layers.projectOverride).toBe('');
      expect(fakeFs.targets.get(`${root}|claude_code`)?.header).toEqual(foreign);
    });
  });

  describe('switchProviderAndInject', () => {
    it('removes the prior managed target and injects the new one, leaving no duplicate', async () => {
      const { service, fakeFs } = buildService();
      await service.inject({ root, projectId: project1, role: 'worker' }); // seeds CLAUDE.md for worker/claude_code

      const result = await service.switchProviderAndInject({
        root,
        projectId: project1,
        role: 'worker',
        newProvider: 'kilo_code',
      });

      expect(result.assignment.provider).toBe('kilo_code');
      expect(result.removedPrior).toEqual({ kind: 'Removed', relativePath: 'CLAUDE.md' });
      expect(result.injected).toEqual({
        kind: 'Written',
        relativePath: '.kilocode/rules/hammond.md',
      });
      expect(fakeFs.targets.has(`${root}|claude_code`)).toBe(false);
      expect(fakeFs.targets.has(`${root}|kilo_code`)).toBe(true);
    });

    it('never removes a prior target a different role currently occupies, even when both roles were assigned to that provider', async () => {
      const { service, assignments, fakeFs } = buildService();
      // Both worker and orchestrator point at codex, but only orchestrator has actually injected
      // (so AGENTS.md's managed header currently says role=orchestrator, not worker).
      await assignments.updateAssignment({
        projectId: project1,
        role: 'worker',
        provider: 'codex',
      });
      await service.inject({ root, projectId: project1, role: 'orchestrator' });

      const result = await service.switchProviderAndInject({
        root,
        projectId: project1,
        role: 'worker',
        newProvider: 'kilo_code',
      });

      expect(result.removedPrior).toBeNull();
      expect(result.injected).toEqual({
        kind: 'Written',
        relativePath: '.kilocode/rules/hammond.md',
      });
      // AGENTS.md is untouched: still orchestrator's managed content, never worker's to remove.
      const orchestratorPreview = await service.preview({
        root,
        projectId: project1,
        role: 'orchestrator',
      });
      expect(orchestratorPreview.classification.kind).toBe('ManagedValid');
      expect(fakeFs.targets.get(`${root}|codex`)?.header).toMatchObject({ role: 'orchestrator' });
    });

    // Permanent regression test for the intake defect (Correction 1): a valid Hammond document
    // for a DIFFERENT PROJECT sharing this role/provider must survive a provider switch on this
    // project's own role, exactly as it must survive a same-project different-role switch above.
    it('never removes a valid document belonging to a different project when switching this project away from that provider', async () => {
      const fakeFs = createFakeHarnessFilesystem();
      const foreign = foreignHeader({ projectId: project2, role: 'worker' });
      seedManaged(fakeFs, root, 'claude_code', foreign, "project two's content");
      const { service } = buildService(fakeFs);

      const result = await service.switchProviderAndInject({
        root,
        projectId: project1,
        role: 'worker',
        newProvider: 'kilo_code',
      });

      expect(result.removedPrior).toBeNull();
      expect(fakeFs.targets.get(`${root}|claude_code`)?.header).toEqual(foreign);
      expect(fakeFs.targets.get(`${root}|claude_code`)?.content).toBe("project two's content");
      expect(result.injected).toEqual({
        kind: 'Written',
        relativePath: '.kilocode/rules/hammond.md',
      });
    });

    it('does not attempt removal when the role was never previously assigned to a different provider', async () => {
      const { service, fakeFs } = buildService();

      const result = await service.switchProviderAndInject({
        root,
        projectId: project1,
        role: 'worker',
        newProvider: 'claude_code', // same as the D-014 default it already has
      });

      expect(result.removedPrior).toBeNull();
      expect(fakeFs.targets.has(`${root}|claude_code`)).toBe(true);
    });
  });
});

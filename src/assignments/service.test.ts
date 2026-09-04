import { AssignmentsService } from './service';
import { AssignmentDomainError } from './errors';
import { createFakeAssignmentRepository, seedProjectDefaults } from './testFakes';

const project1 = 'project-1';

describe('AssignmentsService', () => {
  describe('listForProject', () => {
    it('returns the three D-014 default assignments a freshly seeded project carries', async () => {
      const repo = createFakeAssignmentRepository();
      seedProjectDefaults(repo.store, project1, 'owner-1');
      const service = new AssignmentsService(repo);

      const assignments = await service.listForProject(project1);

      expect(assignments.map((a) => [a.role, a.provider])).toEqual([
        ['orchestrator', 'codex'],
        ['worker', 'claude_code'],
        ['auditor', 'kilo_code'],
      ]);
    });

    it('returns an empty list for a project that was never seeded', async () => {
      const repo = createFakeAssignmentRepository();
      const service = new AssignmentsService(repo);

      expect(await service.listForProject('missing-project')).toEqual([]);
    });
  });

  describe('getAssignment / requireAssignment', () => {
    it('resolves the currently assigned provider for one role', async () => {
      const repo = createFakeAssignmentRepository();
      seedProjectDefaults(repo.store, project1, 'owner-1');
      const service = new AssignmentsService(repo);

      const assignment = await service.getAssignment({ projectId: project1, role: 'worker' });

      expect(assignment?.provider).toBe('claude_code');
    });

    it('getAssignment returns null instead of throwing when there is no assignment yet', async () => {
      const repo = createFakeAssignmentRepository();
      const service = new AssignmentsService(repo);

      expect(await service.getAssignment({ projectId: project1, role: 'worker' })).toBeNull();
    });

    it('requireAssignment throws a typed missing_assignment error instead of returning null', async () => {
      const repo = createFakeAssignmentRepository();
      const service = new AssignmentsService(repo);

      await expect(
        service.requireAssignment({ projectId: project1, role: 'worker' }),
      ).rejects.toMatchObject({ code: 'missing_assignment' });
    });
  });

  describe('updateAssignment', () => {
    it('reassigns a role to a different execution provider', async () => {
      const repo = createFakeAssignmentRepository();
      seedProjectDefaults(repo.store, project1, 'owner-1');
      const service = new AssignmentsService(repo);

      const updated = await service.updateAssignment({
        projectId: project1,
        role: 'worker',
        provider: 'kilo_code',
      });

      expect(updated.provider).toBe('kilo_code');
      expect(await service.getAssignment({ projectId: project1, role: 'worker' })).toMatchObject({
        provider: 'kilo_code',
      });
    });

    it('leaves the other two roles for the same project untouched', async () => {
      const repo = createFakeAssignmentRepository();
      seedProjectDefaults(repo.store, project1, 'owner-1');
      const service = new AssignmentsService(repo);

      await service.updateAssignment({
        projectId: project1,
        role: 'worker',
        provider: 'kilo_code',
      });

      const orchestrator = await service.getAssignment({
        projectId: project1,
        role: 'orchestrator',
      });
      const auditor = await service.getAssignment({ projectId: project1, role: 'auditor' });
      expect(orchestrator?.provider).toBe('codex');
      expect(auditor?.provider).toBe('kilo_code');
    });

    it('wraps a persistence failure into a typed AssignmentDomainError instead of a raw driver error', async () => {
      const repo = createFakeAssignmentRepository();
      seedProjectDefaults(repo.store, project1, 'owner-1');
      const service = new AssignmentsService(repo);

      await expect(
        service.updateAssignment({
          projectId: 'someone-elses-project',
          role: 'worker',
          provider: 'codex',
        }),
      ).rejects.toBeInstanceOf(AssignmentDomainError);
    });

    it('distinguishes a stale/missing project from a not-yet-existing assignment row', async () => {
      const repo = createFakeAssignmentRepository();
      seedProjectDefaults(repo.store, project1, 'owner-1');
      const service = new AssignmentsService(repo);

      await expect(
        service.updateAssignment({
          projectId: 'someone-elses-project',
          role: 'worker',
          provider: 'codex',
        }),
      ).rejects.toMatchObject({ code: 'stale_reference' });
    });

    it('never fabricates a saved assignment when the underlying write fails', async () => {
      const repo = createFakeAssignmentRepository();
      seedProjectDefaults(repo.store, project1, 'owner-1');
      const service = new AssignmentsService(repo);

      await expect(
        service.updateAssignment({
          projectId: 'someone-elses-project',
          role: 'worker',
          provider: 'codex',
        }),
      ).rejects.toThrow();
      // The real project's assignments are exactly what they were before the failed call.
      const assignments = await service.listForProject(project1);
      expect(assignments.map((a) => a.provider)).toEqual(['codex', 'claude_code', 'kilo_code']);
    });
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';

import { AssignmentsService } from '../assignments/service';
import { createFakeAssignmentRepository, seedProjectDefaults } from '../assignments/testFakes';
import { HarnessInjectionService } from '../harness/service';
import { createFakeHarnessAdapters, createFakeHarnessFilesystem } from '../harness/testFakes';
import { InstructionsService } from '../instructions/service';
import { createFakeInstructionRepository } from '../instructions/testFakes';
import { AgentAssignmentPanel } from './AgentAssignmentPanel';

const project = { id: 'project-1', name: 'Hammond project' };
const root = '/home/owner/project-1';

function buildServices() {
  const assignmentRepo = createFakeAssignmentRepository();
  seedProjectDefaults(assignmentRepo.store, project.id, 'owner-1');
  const assignmentsService = new AssignmentsService(assignmentRepo);
  const instructionsService = new InstructionsService(createFakeInstructionRepository());
  const fakeFs = createFakeHarnessFilesystem();
  const adapters = createFakeHarnessAdapters(fakeFs, root);
  const harnessService = new HarnessInjectionService({
    assignments: assignmentsService,
    instructions: instructionsService,
    adapters,
    filesystem: {
      async readTextFile() {
        throw new Error('unused');
      },
    },
  });
  return { assignmentsService, harnessService, fakeFs };
}

describe('AgentAssignmentPanel', () => {
  it('shows distinct Execution provider controls for orchestrator, worker, and auditor with the D-014 defaults', async () => {
    const { assignmentsService, harnessService } = buildServices();
    render(
      <AgentAssignmentPanel
        assignmentsService={assignmentsService}
        harnessService={harnessService}
        project={project}
        directoryRoot={null}
      />,
    );

    expect(await screen.findByLabelText('Orchestrator execution provider')).toHaveValue('codex');
    expect(screen.getByLabelText('Worker execution provider')).toHaveValue('claude_code');
    expect(screen.getByLabelText('Auditor execution provider')).toHaveValue('kilo_code');
  });

  it('updates the assignment directly when no directory is linked, and calls onAssignmentChanged', async () => {
    const { assignmentsService, harnessService } = buildServices();
    const onAssignmentChanged = vi.fn();
    render(
      <AgentAssignmentPanel
        assignmentsService={assignmentsService}
        harnessService={harnessService}
        project={project}
        directoryRoot={null}
        onAssignmentChanged={onAssignmentChanged}
      />,
    );

    fireEvent.change(await screen.findByLabelText('Worker execution provider'), {
      target: { value: 'kilo_code' },
    });

    await waitFor(async () => {
      const assignment = await assignmentsService.getAssignment({
        projectId: project.id,
        role: 'worker',
      });
      expect(assignment?.provider).toBe('kilo_code');
    });
    expect(onAssignmentChanged).toHaveBeenCalledTimes(1);
  });

  it('uses the safe provider-switch workflow (injects the new target and cleans up the prior one) when a directory is linked', async () => {
    const { assignmentsService, harnessService, fakeFs } = buildServices();
    await harnessService.inject({ root, projectId: project.id, role: 'worker' }); // seeds CLAUDE.md
    expect(fakeFs.targets.has(`${root}|claude_code`)).toBe(true);

    render(
      <AgentAssignmentPanel
        assignmentsService={assignmentsService}
        harnessService={harnessService}
        project={project}
        directoryRoot={root}
      />,
    );

    fireEvent.change(await screen.findByLabelText('Worker execution provider'), {
      target: { value: 'kilo_code' },
    });

    await waitFor(() => expect(fakeFs.targets.has(`${root}|kilo_code`)).toBe(true));
    expect(fakeFs.targets.has(`${root}|claude_code`)).toBe(false);
  });

  it('surfaces an assignment load failure with a Retry control', async () => {
    const { harnessService } = buildServices();
    const failingAssignments = {
      listForProject: vi
        .fn()
        .mockRejectedValueOnce(new Error('network dropped'))
        .mockResolvedValue([]),
    } as unknown as AssignmentsService;

    render(
      <AgentAssignmentPanel
        assignmentsService={failingAssignments}
        harnessService={harnessService}
        project={project}
        directoryRoot={null}
      />,
    );

    expect(await screen.findByText('network dropped')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(failingAssignments.listForProject).toHaveBeenCalledTimes(2));
  });

  it('highlights the selected role and calls onSelectRole when a row is chosen', async () => {
    const { assignmentsService, harnessService } = buildServices();
    const onSelectRole = vi.fn();
    render(
      <AgentAssignmentPanel
        assignmentsService={assignmentsService}
        harnessService={harnessService}
        project={project}
        directoryRoot={null}
        selectedRole="worker"
        onSelectRole={onSelectRole}
      />,
    );

    const workerButton = await screen.findByRole('button', { name: 'Worker' });
    expect(workerButton).toHaveAttribute('aria-pressed', 'true');
    const orchestratorButton = screen.getByRole('button', { name: 'Orchestrator' });
    expect(orchestratorButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(orchestratorButton);
    expect(onSelectRole).toHaveBeenCalledWith('orchestrator');
  });

  it('renders plain role labels (no button) when onSelectRole is not provided', async () => {
    const { assignmentsService, harnessService } = buildServices();
    render(
      <AgentAssignmentPanel
        assignmentsService={assignmentsService}
        harnessService={harnessService}
        project={project}
        directoryRoot={null}
      />,
    );

    await screen.findByLabelText('Worker execution provider');
    expect(screen.queryByRole('button', { name: 'Worker' })).not.toBeInTheDocument();
    expect(screen.getByText('Worker')).toBeInTheDocument();
  });
});

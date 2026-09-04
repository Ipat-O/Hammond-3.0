import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AssignmentsService } from '../assignments/service';
import { createFakeAssignmentRepository, seedProjectDefaults } from '../assignments/testFakes';
import { HarnessInjectionService } from '../harness/service';
import {
  createFakeHarnessAdapters,
  createFakeHarnessFilesystem,
  seedUnmanaged,
  type FakeHarnessFilesystem,
} from '../harness/testFakes';
import { InstructionsService } from '../instructions/service';
import { createFakeInstructionRepository } from '../instructions/testFakes';
import { AgentAssignmentPanel } from './AgentAssignmentPanel';

const project = { id: 'project-1', name: 'Hammond project' };
const root = '/home/owner/project-1';

function renderPanel(options: { linked?: boolean; fakeFs?: FakeHarnessFilesystem } = {}) {
  const linked = options.linked ?? true;
  const fakeFs = options.fakeFs ?? createFakeHarnessFilesystem();

  const assignmentRepo = createFakeAssignmentRepository();
  seedProjectDefaults(assignmentRepo.store, project.id, 'owner-1');
  const assignmentsService = new AssignmentsService(assignmentRepo);

  const instructionsService = new InstructionsService(createFakeInstructionRepository());
  const adapters = createFakeHarnessAdapters(fakeFs, root);
  const filesystem = {
    async readTextFile(fsRoot: string, relativePath: string) {
      const provider =
        relativePath === 'CLAUDE.md'
          ? 'claude_code'
          : relativePath === 'AGENTS.md'
            ? 'codex'
            : 'kilo_code';
      const target = fakeFs.targets.get(`${fsRoot}|${provider}`);
      if (!target || target.content === null) throw new Error('not found');
      return target.content;
    },
  };
  const harnessService = new HarnessInjectionService({
    assignments: assignmentsService,
    instructions: instructionsService,
    adapters,
    filesystem,
  });

  render(
    <AgentAssignmentPanel
      assignmentsService={assignmentsService}
      harnessService={harnessService}
      project={project}
      directoryRoot={linked ? root : null}
    />,
  );

  return { assignmentsService, harnessService, fakeFs };
}

describe('AgentAssignmentPanel', () => {
  it('shows distinct Execution provider controls for orchestrator, worker, and auditor with the D-014 defaults', async () => {
    renderPanel();

    expect(await screen.findByLabelText('Orchestrator execution provider')).toHaveValue('codex');
    expect(screen.getByLabelText('Worker execution provider')).toHaveValue('claude_code');
    expect(screen.getByLabelText('Auditor execution provider')).toHaveValue('kilo_code');
  });

  it('uses "Worker instructions for Claude Code" style language in the preview heading, not merely "Provider"', async () => {
    renderPanel();

    expect(
      await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Provider')).not.toBeInTheDocument();
  });

  it('prompts to link a directory instead of showing a preview when none is linked', async () => {
    renderPanel({ linked: false });

    expect(await screen.findByText(/Link a local directory/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Composed preview')).not.toBeInTheDocument();
  });

  it('shows the exact relative target path and Missing status, then Inject creates the managed document', async () => {
    renderPanel();

    await waitFor(() => expect(screen.getByText('CLAUDE.md')).toBeInTheDocument());
    expect(screen.getByText('Not created yet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Inject' }));

    await waitFor(() => expect(screen.getByText('Hammond-managed')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('Update writes the document again once it is already managed', async () => {
    const { fakeFs } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Inject' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() =>
      expect(fakeFs.targets.get(`${root}|claude_code`)?.classification.kind).toBe('ManagedValid'),
    );
  });

  it('Remove deletes a managed document and the action reverts to Inject', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Inject' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(screen.getByText('Not created yet')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Inject' })).toBeInTheDocument();
  });

  it('offers Import / Replace / Cancel for an unmanaged target and never writes without an explicit choice', async () => {
    const fakeFs = createFakeHarnessFilesystem();
    seedUnmanaged(fakeFs, root, 'claude_code', '# hand-written notes');
    renderPanel({ fakeFs });

    await waitFor(() => expect(screen.getByText(/Unmanaged/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Import existing content' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(fakeFs.targets.get(`${root}|claude_code`)?.content).toBe('# hand-written notes');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fakeFs.targets.get(`${root}|claude_code`)?.content).toBe('# hand-written notes');
  });

  it('Replace overwrites an unmanaged target when the owner explicitly chooses it', async () => {
    const fakeFs = createFakeHarnessFilesystem();
    seedUnmanaged(fakeFs, root, 'claude_code', '# hand-written notes');
    renderPanel({ fakeFs });

    fireEvent.click(await screen.findByRole('button', { name: 'Replace' }));

    await waitFor(() => expect(screen.getByText('Hammond-managed')).toBeInTheDocument());
  });

  it('Import preserves the existing content as the project override layer before rewriting', async () => {
    const fakeFs = createFakeHarnessFilesystem();
    seedUnmanaged(fakeFs, root, 'claude_code', '# hand-written notes');
    const { harnessService } = renderPanel({ fakeFs });

    fireEvent.click(await screen.findByRole('button', { name: 'Import existing content' }));

    await waitFor(() => expect(screen.getByText('Hammond-managed')).toBeInTheDocument());
    const preview = await harnessService.preview({ root, projectId: project.id, role: 'worker' });
    expect(preview.effectiveContent).toContain('# hand-written notes');
  });

  it('shows no Retry control on the happy path, and Retry re-runs the exact failed action until it succeeds', async () => {
    const fakeFs = createFakeHarnessFilesystem();
    const assignmentRepo = createFakeAssignmentRepository();
    seedProjectDefaults(assignmentRepo.store, project.id, 'owner-1');
    const assignmentsService = new AssignmentsService(assignmentRepo);
    const instructionsService = new InstructionsService(createFakeInstructionRepository());
    const adapters = createFakeHarnessAdapters(fakeFs, root);
    let failNextInject = true;
    const flakyAdapters = {
      ...adapters,
      claude_code: {
        ...adapters.claude_code,
        async inject(...args: Parameters<(typeof adapters)['claude_code']['inject']>) {
          if (failNextInject) {
            failNextInject = false;
            throw new Error('transient write error');
          }
          return adapters.claude_code.inject(...args);
        },
      },
    };
    const harnessService = new HarnessInjectionService({
      assignments: assignmentsService,
      instructions: instructionsService,
      adapters: flakyAdapters,
      filesystem: {
        async readTextFile() {
          throw new Error('unused');
        },
      },
    });

    render(
      <AgentAssignmentPanel
        assignmentsService={assignmentsService}
        harnessService={harnessService}
        project={project}
        directoryRoot={root}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Inject' }));

    await waitFor(() => expect(screen.getByText('transient write error')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.getByText('Hammond-managed')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('changing the Execution provider persists the assignment and updates the preview target path', async () => {
    const { assignmentsService } = renderPanel();
    await waitFor(() => expect(screen.getByText('CLAUDE.md')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Worker execution provider'), {
      target: { value: 'kilo_code' },
    });

    await waitFor(async () => {
      const assignment = await assignmentsService.getAssignment({
        projectId: project.id,
        role: 'worker',
      });
      expect(assignment?.provider).toBe('kilo_code');
    });
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Worker instructions for Kilo Code' }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('.kilocode/rules/hammond.md')).toBeInTheDocument();
  });

  it('provider switch removes the prior managed target so the directory never accumulates duplicates', async () => {
    const { fakeFs } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Inject' })); // writes CLAUDE.md for worker
    await waitFor(() => expect(fakeFs.targets.has(`${root}|claude_code`)).toBe(true));

    fireEvent.change(screen.getByLabelText('Worker execution provider'), {
      target: { value: 'kilo_code' },
    });

    await waitFor(() => expect(fakeFs.targets.has(`${root}|kilo_code`)).toBe(true));
    expect(fakeFs.targets.has(`${root}|claude_code`)).toBe(false);
  });

  it('assignment and instruction data remain saved when the native (local) write fails', async () => {
    const fakeFs = createFakeHarnessFilesystem();
    const assignmentRepo = createFakeAssignmentRepository();
    seedProjectDefaults(assignmentRepo.store, project.id, 'owner-1');
    const assignmentsService = new AssignmentsService(assignmentRepo);
    const instructionsService = new InstructionsService(createFakeInstructionRepository());
    const adapters = createFakeHarnessAdapters(fakeFs, root);
    const throwingAdapters = {
      ...adapters,
      claude_code: {
        ...adapters.claude_code,
        async inject(): Promise<never> {
          throw new Error('disk full');
        },
      },
    };
    const harnessService = new HarnessInjectionService({
      assignments: assignmentsService,
      instructions: instructionsService,
      adapters: throwingAdapters,
      filesystem: {
        async readTextFile() {
          throw new Error('unused');
        },
      },
    });

    render(
      <AgentAssignmentPanel
        assignmentsService={assignmentsService}
        harnessService={harnessService}
        project={project}
        directoryRoot={root}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Inject' }));

    await waitFor(() => expect(screen.getByText('disk full')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The assignment (unaffected by the local failure) is still exactly what it was.
    const assignment = await assignmentsService.getAssignment({
      projectId: project.id,
      role: 'worker',
    });
    expect(assignment?.provider).toBe('claude_code');
  });
});

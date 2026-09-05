import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';

import type { Database } from '../data';
import { AssignmentsService } from '../assignments/service';
import { createFakeAssignmentRepository, seedProjectDefaults } from '../assignments/testFakes';
import { HarnessInjectionService } from '../harness/service';
import { createFakeHarnessAdapters, createFakeHarnessFilesystem } from '../harness/testFakes';
import { InstructionsService } from '../instructions/service';
import { createFakeInstructionRepository } from '../instructions/testFakes';
import { createFakeDirectoryContextServices } from '../settings/testFakes';
import type { TrackerRepositories, TrackerServices } from './contracts';
import { TrackerPage } from './TrackerPage';
import { createFakeWindowLifecycle } from './windowLifecycle';

type Project = Database['public']['Tables']['projects']['Row'];

const ownerId = 'owner-1';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    owner_id: ownerId,
    name: 'Hammond project',
    description: 'A project for testing the tracker.',
    archived_at: null,
    created_at: '2026-08-13T08:00:00.000Z',
    updated_at: '2026-08-13T08:00:00.000Z',
    ...overrides,
  };
}

function makeServices(projects: Project[] = [project()]) {
  const repositories: TrackerRepositories = {
    projects: {
      list: vi.fn().mockResolvedValue(projects),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
    },
    tasks: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
    },
    memory: {
      listComments: vi.fn().mockResolvedValue([]),
      addComment: vi.fn(),
    },
  };

  const assignmentRepo = createFakeAssignmentRepository();
  seedProjectDefaults(assignmentRepo.store, project().id, 'owner-1');
  const assignments = new AssignmentsService(assignmentRepo);
  const instructions = new InstructionsService(createFakeInstructionRepository());
  const harnessFs = createFakeHarnessFilesystem();

  const services: TrackerServices = {
    repositories,
    auth: {} as TrackerServices['auth'],
    directoryContext: createFakeDirectoryContextServices(),
    instructions,
    assignments,
    harness: new HarnessInjectionService({
      assignments,
      instructions,
      adapters: createFakeHarnessAdapters(harnessFs, '/fake/root'),
      filesystem: { readTextFile: vi.fn().mockRejectedValue(new Error('unused in these tests')) },
    }),
  };
  return { services, instructions, assignments };
}

describe('TrackerPage navigation and Instruction Studio integration', () => {
  it('switching Worker execution provider from Instructions stays coherent across a Workspace/Instructions round-trip', async () => {
    const { services, instructions } = makeServices();
    await instructions.saveAndActivate({
      projectId: project().id,
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      content: 'CLAUDE CODE OVERRIDE',
    });
    await instructions.saveAndActivate({
      projectId: project().id,
      role: 'worker',
      provider: 'kilo_code',
      layer: 'project_override',
      content: 'KILO CODE OVERRIDE',
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    await waitFor(() =>
      expect(screen.getByLabelText('Effective instructions preview')).toHaveTextContent(
        'CLAUDE CODE OVERRIDE',
      ),
    );

    fireEvent.change(await screen.findByLabelText('Worker execution provider'), {
      target: { value: 'kilo_code' },
    });
    await screen.findByRole('heading', { name: 'Worker instructions for Kilo Code' });
    await waitFor(() =>
      expect(screen.getByLabelText('Effective instructions preview')).toHaveTextContent(
        'KILO CODE OVERRIDE',
      ),
    );

    // Leaving to Workspace and back never resurrects the stale claude_code editor next to the
    // now-switched (and persisted) kilo_code assignment.
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Kilo Code' });
    expect(screen.getByLabelText('Worker execution provider')).toHaveValue('kilo_code');
    await waitFor(() =>
      expect(screen.getByLabelText('Effective instructions preview')).toHaveTextContent(
        'KILO CODE OVERRIDE',
      ),
    );
  });

  it('guards a primary-nav switch away from Instructions with unsaved edits: Cancel stays, Save persists then navigates, Discard drops then navigates', async () => {
    const { services, instructions } = makeServices();

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });

    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'unsaved nav draft' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    let dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Project override content')).toHaveValue('unsaved nav draft');

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(async () =>
      expect(
        (await screen.findAllByRole('heading', { name: 'Hammond project' })).length,
      ).toBeGreaterThan(0),
    );
    const versions = await instructions.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project().id,
    });
    expect(versions.map((v) => v.content)).toContain('unsaved nav draft');

    // Discard: make a second dirty edit, then discard through the nav guard.
    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'never saved' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));

    await waitFor(async () =>
      expect(
        (await screen.findAllByRole('heading', { name: 'Hammond project' })).length,
      ).toBeGreaterThan(0),
    );
    const versionsAfterDiscard = await instructions.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project().id,
    });
    expect(versionsAfterDiscard.map((v) => v.content)).not.toContain('never saved');
  });

  it('the nav Unsaved changes dialog focuses itself, traps Tab, treats Escape as Cancel, and returns focus afterward', async () => {
    const { services } = makeServices();

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'dirty nav draft' },
    });

    const workspaceButton = screen.getByRole('button', { name: 'Workspace' });
    workspaceButton.focus();
    fireEvent.click(workspaceButton);
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    const saveButton = within(dialog).getByRole('button', { name: 'Save changes' });
    const cancelButton = within(dialog).getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(saveButton).toHaveFocus());

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(cancelButton).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      screen.getByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Project override content')).toHaveValue('dirty nav draft');
    expect(workspaceButton).toHaveFocus();
  });

  it('a nav Save left pending when Cancelled can never execute the cancelled navigation once it resolves', async () => {
    const { services } = makeServices();
    let resolveSave!: () => void;
    const originalSaveAndActivate = services.instructions.saveAndActivate.bind(
      services.instructions,
    );
    services.instructions.saveAndActivate = ((params) =>
      new Promise((resolve) => {
        resolveSave = () => resolve(originalSaveAndActivate(params));
      })) as typeof services.instructions.saveAndActivate;

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'pending nav save' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      screen.getByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();

    resolveSave();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Still on Instructions: the late save success never executed the cancelled nav to Workspace.
    expect(
      screen.getByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();
  });

  it('app/window-close dirty protection: a dirty Instruction Studio blocks the close and shows the guard dialog; Save then lets it proceed', async () => {
    const { services, instructions } = makeServices();
    const windowLifecycle = createFakeWindowLifecycle();

    render(
      <TrackerPage
        services={services}
        ownerId={ownerId}
        onSignOut={vi.fn()}
        windowLifecycle={windowLifecycle}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'unsaved before close' },
    });

    let closeResolved: boolean | undefined;
    void windowLifecycle.fireCloseRequested().then((allowed) => {
      closeResolved = allowed;
    });
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    expect(closeResolved).toBeUndefined(); // the close is held open, not yet decided

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(closeResolved).toBe(true));
    const versions = await instructions.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project().id,
    });
    expect(versions.map((v) => v.content)).toContain('unsaved before close');
  });

  it('app/window-close dirty protection: Cancel keeps the window open and the draft intact', async () => {
    const { services } = makeServices();
    const windowLifecycle = createFakeWindowLifecycle();

    render(
      <TrackerPage
        services={services}
        ownerId={ownerId}
        onSignOut={vi.fn()}
        windowLifecycle={windowLifecycle}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'keep me' },
    });

    let closeResolved: boolean | undefined;
    void windowLifecycle.fireCloseRequested().then((allowed) => {
      closeResolved = allowed;
    });
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(closeResolved).toBe(false));
    expect(screen.getByLabelText('Project override content')).toHaveValue('keep me');
  });

  it('app/window-close protection lets a non-dirty close proceed immediately, with no dialog', async () => {
    const { services } = makeServices();
    const windowLifecycle = createFakeWindowLifecycle();

    render(
      <TrackerPage
        services={services}
        ownerId={ownerId}
        onSignOut={vi.fn()}
        windowLifecycle={windowLifecycle}
      />,
    );
    expect((await screen.findAllByRole('heading', { name: 'Hammond project' })).length).toBeGreaterThan(0);

    const allowed = await windowLifecycle.fireCloseRequested();
    expect(allowed).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

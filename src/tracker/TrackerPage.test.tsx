import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';

import type { Database } from '../data';
import { AssignmentsService } from '../assignments/service';
import { createFakeAssignmentRepository, seedProjectDefaults } from '../assignments/testFakes';
import { HarnessInjectionService } from '../harness/service';
import { createFakeHarnessAdapters, createFakeHarnessFilesystem } from '../harness/testFakes';
import { InstructionsService } from '../instructions/service';
import { createFakeInstructionRepository } from '../instructions/testFakes';
import type { DirectoryContextServices } from '../settings/contracts';
import { DirectoryContextManager } from '../settings/directoryContextManager';
import { LOCAL_SETTINGS_KEY, LOCAL_SETTINGS_VERSION, type LocalSettingsStateV2 } from '../settings/state';
import { createFakeDirectoryContextServices, createFakeFilesystem, createFakeLocalSettings } from '../settings/testFakes';
import type { TrackerRepositories, TrackerServices } from './contracts';
import { TrackerPage } from './TrackerPage';
import { createFakeWindowLifecycle } from './windowLifecycle';

type Project = Database['public']['Tables']['projects']['Row'];
type Task = Database['public']['Tables']['tasks']['Row'];

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

/**
 * The sidebar's "Open directory" action is always present (top-level, not tied to a selected
 * project); Home's own directory section can render a second, identically-labeled button once a
 * project with no active directory is selected. Scope to the sidebar explicitly so a test never
 * depends on which one an unscoped query happens to resolve first.
 */
function openDirectoryButton() {
  return within(screen.getByRole('complementary', { name: 'Application navigation' })).getByRole(
    'button',
    { name: 'Open directory' },
  );
}

/** Waits for device-local settings to finish loading (the button is disabled until then) before clicking it. */
async function clickOpenDirectory() {
  await waitFor(() => expect(openDirectoryButton()).not.toBeDisabled());
  fireEvent.click(openDirectoryButton());
}

function task(overrides: Partial<Task> & Pick<Task, 'id' | 'project_id'>): Task {
  return {
    owner_id: ownerId,
    title: overrides.id,
    description: '',
    status: 'backlog',
    priority: 0,
    parent_task_id: null,
    due_at: null,
    archived_at: null,
    created_at: '2026-08-13T08:00:00.000Z',
    updated_at: '2026-08-13T08:00:00.000Z',
    ...overrides,
  };
}

interface MakeServicesOptions {
  tasksByProject?: Record<string, Task[]>;
  directoryContext?: DirectoryContextServices;
}

function makeServices(projects: Project[] = [project()], options: MakeServicesOptions = {}) {
  const tasksByProject = options.tasksByProject ?? {};
  const repositories: TrackerRepositories = {
    projects: {
      list: vi.fn().mockResolvedValue(projects),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
    },
    tasks: {
      list: vi.fn((projectId: string) => Promise.resolve(tasksByProject[projectId] ?? [])),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
    },
    memory: {
      listComments: vi.fn().mockResolvedValue([]),
      addComment: vi.fn(),
      listRecentComments: vi.fn().mockResolvedValue([]),
      listActivity: vi.fn().mockResolvedValue([]),
      listEvidence: vi.fn().mockResolvedValue([]),
    },
  };

  const assignmentRepo = createFakeAssignmentRepository();
  for (const seededProject of projects) {
    seedProjectDefaults(assignmentRepo.store, seededProject.id, ownerId);
  }
  const assignments = new AssignmentsService(assignmentRepo);
  const instructions = new InstructionsService(createFakeInstructionRepository());
  const harnessFs = createFakeHarnessFilesystem();

  const services: TrackerServices = {
    repositories,
    auth: {} as TrackerServices['auth'],
    directoryContext: options.directoryContext ?? createFakeDirectoryContextServices(),
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

  it('a completed Save-and-navigate never leaves a later nav dialog stuck on a stale Saving state', async () => {
    const { services, instructions } = makeServices();

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'first nav save' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    let dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(async () =>
      expect(
        (await screen.findAllByRole('heading', { name: 'Hammond project' })).length,
      ).toBeGreaterThan(0),
    );

    // Back to Instructions, a second dirty edit, and a second guarded nav. The first Save's own
    // completion invalidated its token via `dismissPendingNav` — that must not leave THIS
    // brand-new dialog's Save permanently busy/disabled.
    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'second nav save' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    const saveButton = within(dialog).getByRole('button', { name: 'Save changes' });
    expect(saveButton).not.toBeDisabled();
    expect(saveButton).toHaveTextContent('Save changes');
    fireEvent.click(saveButton);

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
    expect(versions.map((v) => v.content)).toEqual(
      expect.arrayContaining(['first nav save', 'second nav save']),
    );
    expect(versions).toHaveLength(2);
  });

  it('a nav Save left pending when Cancelled resets busy so a later dialog Save still works', async () => {
    const { services, instructions } = makeServices();
    // Each call to saveAndActivate resolves only when the test explicitly triggers it, so a Save
    // started from one dialog can be left in flight while a completely separate Save (from a
    // later, independent dialog) runs and resolves first.
    const pendingSaves: Array<() => void> = [];
    const originalSaveAndActivate = services.instructions.saveAndActivate.bind(
      services.instructions,
    );
    services.instructions.saveAndActivate = ((params) =>
      new Promise((resolve) => {
        pendingSaves.push(() => resolve(originalSaveAndActivate(params)));
      })) as typeof services.instructions.saveAndActivate;

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'pending nav save' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    let dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    // Cancel while that Save is still in flight.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      screen.getByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();

    // A second, independent dirty edit and dialog must behave normally rather than inheriting
    // the cancelled Save's busy state.
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'second nav edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    const saveButton = within(dialog).getByRole('button', { name: 'Save changes' });
    expect(saveButton).not.toBeDisabled();
    expect(saveButton).toHaveTextContent('Save changes');
    fireEvent.click(saveButton);
    expect(pendingSaves).toHaveLength(2);
    pendingSaves[1]();
    await waitFor(async () =>
      expect(
        (await screen.findAllByRole('heading', { name: 'Hammond project' })).length,
      ).toBeGreaterThan(0),
    );

    // The FIRST save (from the cancelled dialog) finally resolves late — it must not retroactively
    // execute the cancelled nav, nor disturb the state left by the second, completed save.
    pendingSaves[0]();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      (await screen.findAllByRole('heading', { name: 'Hammond project' })).length,
    ).toBeGreaterThan(0);

    const versions = await instructions.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project().id,
    });
    expect(versions.map((v) => v.content)).toContain('second nav edit');
  });

  it('a nav Discard during a pending Save cannot let that stale completion clear a later save busy state', async () => {
    const { services, instructions } = makeServices();
    const pendingSaves: Array<() => void> = [];
    const originalSaveAndActivate = services.instructions.saveAndActivate.bind(
      services.instructions,
    );
    services.instructions.saveAndActivate = ((params) =>
      new Promise((resolve) => {
        pendingSaves.push(() => resolve(originalSaveAndActivate(params)));
      })) as typeof services.instructions.saveAndActivate;

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'will be discarded via nav' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    let dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    // Discard while that Save is still in flight — it proceeds immediately, without waiting.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));
    await waitFor(async () =>
      expect(
        (await screen.findAllByRole('heading', { name: 'Hammond project' })).length,
      ).toBeGreaterThan(0),
    );

    // Back to Instructions with a completely fresh dirty edit and a new Save.
    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'kept nav edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    const saveButton = within(dialog).getByRole('button', { name: 'Save changes' });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);
    expect(pendingSaves).toHaveLength(2);
    pendingSaves[1](); // resolve the SECOND (new) save so the UI can proceed
    await waitFor(async () =>
      expect(
        (await screen.findAllByRole('heading', { name: 'Hammond project' })).length,
      ).toBeGreaterThan(0),
    );

    // The FIRST (discarded) save finally resolves late — it must not retroactively clear or
    // otherwise disturb the state left by the second, already-completed save.
    pendingSaves[0]();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      (await screen.findAllByRole('heading', { name: 'Hammond project' })).length,
    ).toBeGreaterThan(0);

    const versions = await instructions.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project().id,
    });
    expect(versions.map((v) => v.content)).toContain('kept nav edit');
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

describe('Home screen default and resume', () => {
  it('defaults to the Home screen with no saved resume state', async () => {
    const { services } = makeServices();

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);

    expect((await screen.findAllByRole('heading', { name: 'Hammond project' })).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Where this project lives on disk' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Home' })).toHaveClass('nav-item-active');
  });

  it('resumes to a previously saved primary screen instead of defaulting to Home', async () => {
    const settings = createFakeLocalSettings();
    const savedState: LocalSettingsStateV2 = {
      version: LOCAL_SETTINGS_VERSION,
      directoryContexts: [],
      lastOpenContextId: null,
      selectedProjectId: project().id,
      selectedTaskId: null,
      resumeScreen: 'workspace',
    };
    await settings.write(LOCAL_SETTINGS_KEY, savedState);
    const directoryContext: DirectoryContextServices = { filesystem: createFakeFilesystem(), settings };
    const { services } = makeServices([project()], { directoryContext });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Workspace' })).toHaveClass('nav-item-active'));
    expect(screen.getByRole('heading', { name: 'See the work in context.' })).toBeInTheDocument();
  });

  it('falls back to Home for a corrupt/unrecognized saved screen value instead of failing to render', async () => {
    const settings = createFakeLocalSettings();
    await settings.write(LOCAL_SETTINGS_KEY, {
      version: LOCAL_SETTINGS_VERSION,
      directoryContexts: [],
      lastOpenContextId: null,
      selectedProjectId: project().id,
      selectedTaskId: null,
      resumeScreen: 'a-screen-from-a-future-version',
    });
    const directoryContext: DirectoryContextServices = { filesystem: createFakeFilesystem(), settings };
    const { services } = makeServices([project()], { directoryContext });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Home' })).toHaveClass('nav-item-active'));
  });

  it('persists project, task, and screen so a remount over the same settings resumes exactly there, with a nested task reachable', async () => {
    const filesystem = createFakeFilesystem();
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem, settings };
    const parent = task({ id: 'parent', project_id: project().id, title: 'Parent task' });
    const child = task({ id: 'child', project_id: project().id, title: 'Child task', parent_task_id: 'parent' });
    const tasksByProject = { [project().id]: [parent, child] };

    const { services } = makeServices([project()], { directoryContext, tasksByProject });
    const { unmount } = render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Parent task' }));
    fireEvent.click(screen.getByRole('button', { name: /^Child task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(async () => {
      const stored = await settings.read<LocalSettingsStateV2>(LOCAL_SETTINGS_KEY);
      expect(stored?.selectedTaskId).toBe('child');
      expect(stored?.resumeScreen).toBe('workspace');
    });
    unmount();

    const { services: resumedServices } = makeServices([project()], { directoryContext, tasksByProject });
    render(<TrackerPage services={resumedServices} ownerId={ownerId} onSignOut={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Workspace' })).toHaveClass('nav-item-active'));
    // The child is visible without manually expanding: its ancestor chain was restored expanded.
    const childTitle = await screen.findByText('Child task', { selector: '.outliner-task-title' });
    expect(childTitle.closest('.outliner-row')).toHaveClass('outliner-row-selected');
  });

  it('device resume never leaks across owners: a different ownerId ignores a stale selection meant for someone else', async () => {
    const settings = createFakeLocalSettings();
    await settings.write(LOCAL_SETTINGS_KEY, {
      version: LOCAL_SETTINGS_VERSION,
      directoryContexts: [],
      lastOpenContextId: null,
      selectedProjectId: 'ghost-project-from-another-owner',
      selectedTaskId: null,
      resumeScreen: 'workspace',
    });
    const directoryContext: DirectoryContextServices = { filesystem: createFakeFilesystem(), settings };
    const { services } = makeServices([project()], { directoryContext });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);

    // The stale project id does not resolve against this account's own projects, so it falls back
    // to an ordinary default rather than rendering nothing or throwing.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Workspace' })).toHaveClass('nav-item-active'));
    expect(screen.getAllByRole('heading', { name: 'Hammond project' }).length).toBeGreaterThan(0);
  });
});

describe('Open directory flow', () => {
  it('opening an already-linked directory selects its own project, never staying on the previously selected one', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const filesystem = createFakeFilesystem();
    filesystem.existingRoots.add('/home/owner/project-b-repo');
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem, settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    let seededState = await seedManager.loadState();
    seededState = (await seedManager.linkDirectory(seededState, projectB.id, '/home/owner/project-b-repo')).state;
    seededState = await seedManager.closeActive(seededState);
    await seedManager.updateResumeSelection(seededState, {
      selectedProjectId: projectA.id,
      selectedTaskId: null,
      resumeScreen: 'home',
    });

    const { services } = makeServices([projectA, projectB], { directoryContext });
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue('/home/owner/project-b-repo');

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    expect((await screen.findAllByRole('heading', { name: 'Project A' })).length).toBeGreaterThan(0);

    await clickOpenDirectory();

    await waitFor(() =>
      expect(screen.queryAllByRole('heading', { name: 'Project B' }).length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole('heading', { name: 'Project A' })).not.toBeInTheDocument();
  });

  it('picking the picker Cancel changes nothing', async () => {
    const filesystem = createFakeFilesystem();
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { services } = makeServices([project()], {
      directoryContext: { filesystem, settings: createFakeLocalSettings() },
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    await clickOpenDirectory();

    await waitFor(() => expect(openDirectoryButton()).not.toBeDisabled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect((await screen.findAllByRole('heading', { name: 'Hammond project' })).length).toBeGreaterThan(0);
  });

  it('an unlinked directory offers Create project / Link to existing project / Cancel; Cancel changes nothing', async () => {
    const filesystem = createFakeFilesystem();
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue('/home/owner/unlinked-repo');
    const { services } = makeServices([project()], {
      directoryContext: { filesystem, settings: createFakeLocalSettings() },
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    await clickOpenDirectory();

    const dialog = await screen.findByRole('dialog', { name: 'Unlinked directory' });
    expect(within(dialog).getByText('/home/owner/unlinked-repo')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create project' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Link to existing project' })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect((await screen.findAllByRole('heading', { name: 'Hammond project' })).length).toBeGreaterThan(0);
  });

  it('creating a project from an unknown directory creates it, links it, and switches to it', async () => {
    const filesystem = createFakeFilesystem();
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue('/home/owner/new-repo');
    const { services } = makeServices([project()], {
      directoryContext: { filesystem, settings: createFakeLocalSettings() },
    });
    const created = project({ id: 'project-new', name: 'new-repo' });
    (services.repositories.projects.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    await clickOpenDirectory();
    let dialog = await screen.findByRole('dialog', { name: 'Unlinked directory' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
    dialog = screen.getByRole('dialog', { name: 'Unlinked directory' });
    expect(within(dialog).getByLabelText('Project name')).toHaveValue('new-repo');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create and link' }));

    await waitFor(() =>
      expect(screen.queryAllByRole('heading', { name: 'new-repo' }).length).toBeGreaterThan(0),
    );
    expect(services.repositories.projects.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'new-repo' }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('when project creation succeeds but linking fails, retry links the SAME project without duplicating it', async () => {
    const filesystem = createFakeFilesystem();
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue('/home/owner/new-repo');
    const settings = createFakeLocalSettings();
    const { services } = makeServices([project()], { directoryContext: { filesystem, settings } });
    const created = project({ id: 'project-new', name: 'new-repo' });
    (services.repositories.projects.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    expect((await screen.findAllByRole('heading', { name: 'Hammond project' })).length).toBeGreaterThan(0);
    // Let the initial device-resume write settle before arming the induced failure, so it targets
    // the upcoming linkDirectory write specifically rather than an unrelated earlier one.
    await waitFor(() => expect(settings.write).toHaveBeenCalled());
    (settings.write as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'));

    await clickOpenDirectory();
    const unknownDialog = await screen.findByRole('dialog', { name: 'Unlinked directory' });
    fireEvent.click(within(unknownDialog).getByRole('button', { name: 'Create project' }));
    fireEvent.click(within(unknownDialog).getByRole('button', { name: 'Create and link' }));

    const retryDialog = await screen.findByRole('dialog', { name: 'Finish linking the new project' });
    expect(within(retryDialog).getByText('disk full')).toBeInTheDocument();
    expect(services.repositories.projects.create).toHaveBeenCalledTimes(1);

    fireEvent.click(within(retryDialog).getByRole('button', { name: 'Retry linking' }));

    await waitFor(() =>
      expect(screen.queryAllByRole('heading', { name: 'new-repo' }).length).toBeGreaterThan(0),
    );
    // Retry must never re-create the project — only the failed link is retried.
    expect(services.repositories.projects.create).toHaveBeenCalledTimes(1);
  });

  it('linking to an existing project from an unknown directory switches to it without creating a new one', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const filesystem = createFakeFilesystem();
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue('/home/owner/unlinked-repo');
    const { services } = makeServices([projectA, projectB], {
      directoryContext: { filesystem, settings: createFakeLocalSettings() },
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    await clickOpenDirectory();
    const dialog = await screen.findByRole('dialog', { name: 'Unlinked directory' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Link to existing project' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Project B' }));

    await waitFor(() =>
      expect(screen.queryAllByRole('heading', { name: 'Project B' }).length).toBeGreaterThan(0),
    );
    expect(services.repositories.projects.create).not.toHaveBeenCalled();
  });

  it('an ambiguous legacy binding (one path linked to two projects) is resolved explicitly, never guessed', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const filesystem = createFakeFilesystem();
    filesystem.existingRoots.add('/shared/path');
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem, settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    let seededState = await seedManager.loadState();
    seededState = (await seedManager.linkDirectory(seededState, projectA.id, '/shared/path')).state;
    seededState = (await seedManager.linkDirectory(seededState, projectB.id, '/shared/path')).state;
    await seedManager.updateResumeSelection(seededState, {
      selectedProjectId: projectA.id,
      selectedTaskId: null,
      resumeScreen: 'home',
    });

    const { services } = makeServices([projectA, projectB], { directoryContext });
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue('/shared/path');

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    expect((await screen.findAllByRole('heading', { name: 'Project A' })).length).toBeGreaterThan(0);

    await clickOpenDirectory();
    const dialog = await screen.findByRole('dialog', { name: 'Choose a project' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Project B' }));

    await waitFor(() =>
      expect(screen.queryAllByRole('heading', { name: 'Project B' }).length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Close preserves the binding without an injection-target fallback', () => {
  it('closing the active directory clears the injection target but keeps the binding remembered', async () => {
    const filesystem = createFakeFilesystem();
    filesystem.existingRoots.add('/home/owner/repo');
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem, settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    let seededState = await seedManager.loadState();
    seededState = (await seedManager.linkDirectory(seededState, project().id, '/home/owner/repo')).state;
    await seedManager.updateResumeSelection(seededState, { resumeScreen: 'home' });

    const { services } = makeServices([project()], { directoryContext });
    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('/home/owner/repo', { selector: 'code' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByText('No directory is open for this project.')).toBeInTheDocument());

    // Never falls back to injecting into the closed binding.
    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    expect(await screen.findByText(/Link a local directory for/)).toBeInTheDocument();

    // The binding itself is still remembered — visible in Workspace's full directory panel, and
    // reopenable rather than forgotten.
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    expect(screen.getByText('/home/owner/repo', { selector: '.directory-context-path' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open repo' })).toBeInTheDocument();
  });
});

describe('Guarded transitions extend to directory and project actions', () => {
  it('a dirty Instruction Studio blocks a sidebar project switch until Save/Discard/Cancel', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const { services } = makeServices([projectA, projectB]);

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'dirty project-switch draft' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.getByLabelText('Project override content')).toHaveValue('dirty project-switch draft');
  });

  it('a dirty Instruction Studio blocks opening an already-linked directory (and the project switch it implies)', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const filesystem = createFakeFilesystem();
    filesystem.existingRoots.add('/home/owner/b-repo');
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue('/home/owner/b-repo');
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem, settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    let seededState = await seedManager.loadState();
    seededState = (await seedManager.linkDirectory(seededState, projectB.id, '/home/owner/b-repo')).state;
    await seedManager.updateResumeSelection(seededState, {
      selectedProjectId: projectA.id,
      selectedTaskId: null,
      resumeScreen: 'home',
    });
    const { services } = makeServices([projectA, projectB], { directoryContext });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'dirty open-directory draft' },
    });

    await clickOpenDirectory();
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.getByLabelText('Project override content')).toHaveValue('dirty open-directory draft');
    expect(screen.queryByRole('dialog', { name: 'Unlinked directory' })).not.toBeInTheDocument();
  });
});

describe('Rapid-switching and wrong-project safeguards (mutation-proof targets)', () => {
  it('a late-resolving tasks response for the previous project never overwrites the newly selected project (late prior-project response)', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const taskB = task({ id: 'task-b', project_id: 'project-b', title: 'Task in B' });

    let resolveA!: (tasks: Task[]) => void;
    const listSpy = vi.fn((projectId: string) => {
      if (projectId === 'project-a') {
        return new Promise<Task[]>((resolve) => {
          resolveA = resolve;
        });
      }
      return Promise.resolve(projectId === 'project-b' ? [taskB] : []);
    });
    const { services } = makeServices([projectA, projectB]);
    services.repositories.tasks.list = listSpy as unknown as typeof services.repositories.tasks.list;

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    // Project A's task list is still pending when we switch away to B.
    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { name: 'Project B' }).length).toBeGreaterThan(0),
    );
    expect(await screen.findByText('Task in B', { selector: '.outliner-task-title' })).toBeInTheDocument();

    // Project A's delayed response finally arrives — it must never clobber B's now-current view.
    resolveA([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getAllByRole('heading', { name: 'Project B' }).length).toBeGreaterThan(0);
    expect(screen.getByText('Task in B', { selector: '.outliner-task-title' })).toBeInTheDocument();
  });

  it('a pending resumed task-selection for one project is never applied to a different project the owner switched to first (wrong-project task restoration)', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    // Deliberately colliding ids across projects: only a correct project-scoped guard prevents
    // B's pending resumed selection from being (mis)applied once it resolves against A's list.
    const taskInA = task({ id: 'shared-id', project_id: 'project-a', title: 'Task in A' });
    const taskInB = task({ id: 'shared-id', project_id: 'project-b', title: 'Task in B' });

    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem: createFakeFilesystem(), settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    const seededState = await seedManager.loadState();
    await seedManager.updateResumeSelection(seededState, {
      selectedProjectId: projectB.id,
      selectedTaskId: 'shared-id',
      resumeScreen: 'workspace',
    });

    let resolveB!: (tasks: Task[]) => void;
    const listSpy = vi.fn((projectId: string) => {
      if (projectId === 'project-b') {
        return new Promise<Task[]>((resolve) => {
          resolveB = resolve;
        });
      }
      return Promise.resolve(projectId === 'project-a' ? [taskInA] : []);
    });
    const { services } = makeServices([projectA, projectB], { directoryContext });
    services.repositories.tasks.list = listSpy as unknown as typeof services.repositories.tasks.list;

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { name: 'Project B' }).length).toBeGreaterThan(0),
    );

    // Before B's (resumed) task list resolves, the owner switches away to Project A.
    fireEvent.click(screen.getByRole('button', { name: 'Project A' }));
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { name: 'Project A' }).length).toBeGreaterThan(0),
    );
    const taskInATitle = await screen.findByText('Task in A', { selector: '.outliner-task-title' });
    expect(taskInATitle.closest('.outliner-row')).not.toHaveClass('outliner-row-selected');

    // Project B's delayed resumed task list finally arrives — it must not retroactively select
    // "shared-id" in whichever project happens to be showing now.
    resolveB([taskInB]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getAllByRole('heading', { name: 'Project A' }).length).toBeGreaterThan(0);
    expect(
      screen.getByText('Task in A', { selector: '.outliner-task-title' }).closest('.outliner-row'),
    ).not.toHaveClass('outliner-row-selected');
  });

  it('creating a new project while a task is selected never carries that task id into the new project', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Task in A' });
    const created = project({ id: 'project-new', name: 'Fresh project' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [taskA] } });
    (services.repositories.projects.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Task in A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Selected task')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create project' });
    fireEvent.change(within(dialog).getByLabelText('Project name'), { target: { value: 'Fresh project' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));

    await waitFor(() =>
      expect(screen.getAllByRole('heading', { name: 'Fresh project' }).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText('Selected task')).not.toBeInTheDocument();
    expect(
      screen.getByText('Select a task to inspect its context, hierarchy, and comments.'),
    ).toBeInTheDocument();
  });
});

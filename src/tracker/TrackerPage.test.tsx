import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';

import type { Database } from '../data';
import { AssignmentsService } from '../assignments/service';
import { createFakeAssignmentRepository, seedProjectDefaults } from '../assignments/testFakes';
import { HarnessInjectionService } from '../harness/service';
import { createFakeHarnessAdapters, createFakeHarnessFilesystem } from '../harness/testFakes';
import type { InjectionPreview } from '../harness/types';
import { InstructionsService } from '../instructions/service';
import { createFakeInstructionRepository } from '../instructions/testFakes';
import type { DirectoryContextServices } from '../settings/contracts';
import { DirectoryContextManager } from '../settings/directoryContextManager';
import { LOCAL_SETTINGS_KEY, LOCAL_SETTINGS_VERSION, type LocalSettingsStateV2 } from '../settings/state';
import { createFakeDirectoryContextServices, createFakeFilesystem, createFakeLocalSettings } from '../settings/testFakes';
import type { TrackerRepositories, TrackerServices } from './contracts';
import { TrackerPage } from './TrackerPage';
import { createFakeWindowLifecycle } from './windowLifecycle';
import { WorkOrderInjectionService } from '../workOrders/injection';
import { WorkOrderLocalStore } from '../workOrders/localStore';
import { WorkOrdersService } from '../workOrders/service';
import { createFakeWorkOrderFilesystem } from '../workOrders/testFakes';

type Project = Database['public']['Tables']['projects']['Row'];
type Task = Database['public']['Tables']['tasks']['Row'];
type Comment = Database['public']['Tables']['comments']['Row'];

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

/** A minimal, valid-enough `InjectionPreview` for F1's tests below — only `.classification.kind`
 * is ever read by the component under test (`classificationBadge`), so the rest is unused filler. */
function fakePreview(kind: 'Missing' | 'ManagedValid'): InjectionPreview {
  return { classification: { kind } } as unknown as InjectionPreview;
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
    workOrders: new WorkOrdersService({
      localStore: new WorkOrderLocalStore(createFakeLocalSettings()),
      injection: new WorkOrderInjectionService({ filesystem: createFakeWorkOrderFilesystem() }),
      assignments,
      instructions,
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

describe('Correction 1 — the complete directory transition is guarded before any state changes', () => {
  it('Cancel on a dirty-Studio guard during a known-directory open leaves the active context, persisted settings, and selected project completely untouched (and shows only one dialog)', async () => {
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
    await seedManager.closeActive(seededState);
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
      target: { value: 'dirty draft untouched by a cancelled directory open' },
    });

    await clickOpenDirectory();
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    // Never a second, open-directory dialog stacked behind/alongside the unsaved-changes guard.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.getByLabelText('Project override content')).toHaveValue(
      'dirty draft untouched by a cancelled directory open',
    );
    expect(
      screen.getByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();
    const stored = await settings.read<LocalSettingsStateV2>(LOCAL_SETTINGS_KEY);
    expect(stored?.selectedProjectId).toBe(projectA.id);
    expect(stored?.lastOpenContextId).toBeNull();
  });

  it('linking a new directory to the SAME project currently open in a dirty Studio does not bind the directory until the guard is accepted', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const filesystem = createFakeFilesystem();
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue('/home/owner/new-repo');
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem, settings };
    const { services } = makeServices([projectA], { directoryContext });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'dirty draft' },
    });

    await clickOpenDirectory();
    const unknownDialog = await screen.findByRole('dialog', { name: 'Unlinked directory' });
    fireEvent.click(within(unknownDialog).getByRole('button', { name: 'Link to existing project' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Unlinked directory' })).getByRole('button', {
        name: 'Project A',
      }),
    );

    const guardDialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(within(guardDialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.getByLabelText('Project override content')).toHaveValue('dirty draft');
    const stored = await settings.read<LocalSettingsStateV2>(LOCAL_SETTINGS_KEY);
    expect(stored?.directoryContexts ?? []).toHaveLength(0);

    // The dialog is left exactly where it was (still offering Link), never silently dismissed.
    expect(screen.getByRole('dialog', { name: 'Unlinked directory' })).toBeInTheDocument();
  });
});

describe('Correction 2 — serialized writes merge the current resume state, not a stale snapshot', () => {
  it('a saved task-resume selection is not overwritten with null in persisted settings while its own lookup is still pending', async () => {
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem: createFakeFilesystem(), settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    const seededState = await seedManager.loadState();
    await seedManager.updateResumeSelection(seededState, {
      selectedProjectId: project().id,
      selectedTaskId: 'task-a',
      resumeScreen: 'workspace',
    });

    let resolveTasks!: (tasks: Task[]) => void;
    const listSpy = vi.fn(
      () =>
        new Promise<Task[]>((resolve) => {
          resolveTasks = resolve;
        }),
    );
    const { services } = makeServices([project()], { directoryContext });
    services.repositories.tasks.list = listSpy as unknown as typeof services.repositories.tasks.list;

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Workspace' })).toHaveClass('nav-item-active'));

    // The saved task's own lookup is still pending — give any premature persistence write below a
    // chance to actually land before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 20));
    let stored = await settings.read<LocalSettingsStateV2>(LOCAL_SETTINGS_KEY);
    expect(stored?.selectedTaskId).toBe('task-a');

    resolveTasks([task({ id: 'task-a', project_id: project().id, title: 'Task A' })]);
    await waitFor(async () => {
      stored = await settings.read<LocalSettingsStateV2>(LOCAL_SETTINGS_KEY);
      expect(stored?.selectedTaskId).toBe('task-a');
    });
    expect(await screen.findByText('Task A', { selector: '.outliner-task-title' })).toBeInTheDocument();
  });

  it('a saved task-resume selection pointing at an archived task is not restored (archived tasks are hidden by default)', async () => {
    const archivedTask = task({
      id: 'archived-task',
      project_id: project().id,
      title: 'Archived Task',
      archived_at: '2026-01-01T00:00:00.000Z',
    });
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem: createFakeFilesystem(), settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    const seededState = await seedManager.loadState();
    await seedManager.updateResumeSelection(seededState, {
      selectedProjectId: project().id,
      selectedTaskId: 'archived-task',
      resumeScreen: 'workspace',
    });
    const { services } = makeServices([project()], {
      directoryContext,
      tasksByProject: { [project().id]: [archivedTask] },
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Workspace' })).toHaveClass('nav-item-active'));
    // The archived task is hidden by the default filter — its lookup concludes with nothing
    // visible to restore, rather than silently selecting a task the outliner does not even show.
    await screen.findByText('No tasks in this view yet.');
    expect(screen.queryByText('Selected task')).not.toBeInTheDocument();
  });
});

describe('Correction 3 — stale project/task data is cleared immediately and in-flight drafts are protected across navigation', () => {
  it("switching projects clears the previous project's task rows immediately, not only once the new list resolves or fails", async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const taskInA = task({ id: 'task-in-a', project_id: 'project-a', title: 'Alpha Task' });

    let resolveB!: (tasks: Task[]) => void;
    const listSpy = vi.fn((projectId: string) => {
      if (projectId === 'project-b') {
        return new Promise<Task[]>((resolve) => {
          resolveB = resolve;
        });
      }
      return Promise.resolve(projectId === 'project-a' ? [taskInA] : []);
    });
    const { services } = makeServices([projectA, projectB]);
    services.repositories.tasks.list = listSpy as unknown as typeof services.repositories.tasks.list;

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    await screen.findByText('Alpha Task', { selector: '.outliner-task-title' });

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    // Immediately — before Project B's own list resolves — A's rows must already be gone.
    expect(screen.queryByText('Alpha Task', { selector: '.outliner-task-title' })).not.toBeInTheDocument();

    resolveB([]);
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { name: 'Project B' }).length).toBeGreaterThan(0),
    );
  });

  it('an in-flight comment save for a task the owner has navigated away from does not land under whichever task/thread is showing now', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const firstTask = task({ id: 'first-task', project_id: 'project-a', title: 'First task' });
    const secondTask = task({ id: 'second-task', project_id: 'project-a', title: 'Second task' });
    const { services } = makeServices([projectA], {
      tasksByProject: { 'project-a': [firstTask, secondTask] },
    });

    let resolveComment!: (comment: Comment) => void;
    (services.repositories.memory.addComment as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Comment>((resolve) => {
          resolveComment = resolve;
        }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^First task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // Waits for the first task's own (empty) comment list to finish loading, so the submit button
    // reads "Add comment" rather than still being disabled on "Loading comments…".
    await screen.findByRole('button', { name: 'Add comment' });
    fireEvent.change(screen.getByLabelText('Add a comment'), {
      target: { value: 'a note on the first task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));

    // Navigate away to the second task before that save resolves — the unsent (still in-flight)
    // draft is now guarded (Correction 2, F2): explicitly discard it to proceed, the same as
    // abandoning any other unsaved tracker draft.
    fireEvent.click(screen.getByRole('button', { name: /^Second task/ }));
    const guardDialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(guardDialog).getByRole('button', { name: 'Discard changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('a note on the first task')).not.toBeInTheDocument();
    expect(screen.getByText('No comments yet. Leave the first useful note.')).toBeInTheDocument();

    resolveComment({
      id: 'comment-1',
      owner_id: ownerId,
      project_id: 'project-a',
      task_id: 'first-task',
      body: 'a note on the first task',
      created_at: '2026-08-13T08:00:00.000Z',
      updated_at: '2026-08-13T08:00:00.000Z',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The second task's own (still empty) thread must not show the first task's late completion.
    expect(screen.queryByText('a note on the first task')).not.toBeInTheDocument();
    expect(screen.getByText('No comments yet. Leave the first useful note.')).toBeInTheDocument();
  });
});

describe('Correction 4 — Home instruction status refreshes without polling, and role-scoped setup opens the right role', () => {
  it('Home refreshes from Missing to Configured after a Studio injection and back to Missing after Remove, showing truthful shared-defaults version context throughout', async () => {
    const filesystem = createFakeFilesystem();
    filesystem.existingRoots.add('/fake/root');
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem, settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    const seededState = await seedManager.loadState();
    await seedManager.linkDirectory(seededState, project().id, '/fake/root');

    const { services } = makeServices([project()], { directoryContext });
    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);

    const workerRow = () => screen.getByText('Worker').closest('li') as HTMLElement;
    await waitFor(() => expect(within(workerRow()).getByText('Not set up')).toBeInTheDocument());
    expect(within(workerRow()).getByText('Using shared defaults')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Inject' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(within(workerRow()).getByText('Configured')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('button', { name: 'Remove' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Inject' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(within(workerRow()).getByText('Not set up')).toBeInTheDocument());
  });

  it('a failed instruction-status classification read shows as a distinct error (never silently absent), and Retry recovers just that role', async () => {
    const filesystem = createFakeFilesystem();
    filesystem.existingRoots.add('/fake/root');
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem, settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    const seededState = await seedManager.loadState();
    await seedManager.linkDirectory(seededState, project().id, '/fake/root');

    const { services } = makeServices([project()], { directoryContext });
    const originalPreview = services.harness.preview.bind(services.harness);
    let failNext = true;
    services.harness.preview = vi.fn((params: Parameters<typeof originalPreview>[0]) => {
      if (params.role === 'worker' && failNext) {
        failNext = false;
        return Promise.reject(new Error('classification blew up'));
      }
      return originalPreview(params);
    }) as typeof services.harness.preview;

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    const workerRow = () => screen.getByText('Worker').closest('li') as HTMLElement;
    await waitFor(() => expect(within(workerRow()).getByText('classification blew up')).toBeInTheDocument());
    expect(within(workerRow()).queryByText('Not set up')).not.toBeInTheDocument();

    fireEvent.click(within(workerRow()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(workerRow()).getByText('Not set up')).toBeInTheDocument());
    expect(within(workerRow()).queryByText('classification blew up')).not.toBeInTheDocument();
  });

  it("Home's role-scoped Set up instructions action opens Instruction Studio on that role, not the default", async () => {
    const filesystem = createFakeFilesystem();
    filesystem.existingRoots.add('/fake/root');
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem, settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    const seededState = await seedManager.loadState();
    await seedManager.linkDirectory(seededState, project().id, '/fake/root');

    const { services } = makeServices([project()], { directoryContext });
    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);

    const auditorRow = await waitFor(() => {
      const row = screen.getByText('Auditor').closest('li') as HTMLElement;
      expect(within(row).getByText('Not set up')).toBeInTheDocument();
      return row;
    });
    fireEvent.click(within(auditorRow).getByRole('button', { name: 'Set up instructions' }));

    expect(await screen.findByRole('heading', { name: /^Auditor instructions for/ })).toBeInTheDocument();

    // A later PLAIN nav to Instructions (not a role-scoped setup action) is never pinned to the
    // stale auditor role from the earlier visit.
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    expect(await screen.findByRole('heading', { name: /^Worker instructions for/ })).toBeInTheDocument();
  });
});

describe('Correction 5 — owner changes and known-path resolution use only currently accessible projects', () => {
  it('a mounted account change (no full remount) resets project-dependent state, and a delayed request from the old owner never leaks into the new one', async () => {
    const owner1 = 'owner-real-1';
    const owner2 = 'owner-real-2';
    const projectOwner1 = project({ id: 'p-owner1', owner_id: owner1, name: 'Owner1 Project' });
    const projectOwner2 = project({ id: 'p-owner2', owner_id: owner2, name: 'Owner2 Project' });

    let resolveOwner1Projects!: (projects: Project[]) => void;
    const listSpy = vi.fn(
      () =>
        new Promise<Project[]>((resolve) => {
          resolveOwner1Projects = resolve;
        }),
    );
    const { services } = makeServices([projectOwner1]);
    services.repositories.projects.list = listSpy as unknown as typeof services.repositories.projects.list;

    const { rerender } = render(<TrackerPage services={services} ownerId={owner1} onSignOut={vi.fn()} />);
    expect(screen.getByText('Gathering your projects…')).toBeInTheDocument();

    // Owner1's own initial fetch is still pending when the mounted session switches to owner2.
    listSpy.mockResolvedValueOnce([projectOwner2]);
    rerender(<TrackerPage services={services} ownerId={owner2} onSignOut={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { name: 'Owner2 Project' }).length).toBeGreaterThan(0),
    );

    // Owner1's stale, now-delayed fetch finally resolves — it must never resurrect their project
    // under the now-current owner2 session.
    resolveOwner1Projects([projectOwner1]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('heading', { name: 'Owner1 Project' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Owner2 Project' }).length).toBeGreaterThan(0);
  });

  it('a stale directory binding for a project no longer accessible falls through to the create/link recovery flow instead of switching to it', async () => {
    const accessibleProject = project({ id: 'accessible', name: 'Accessible Project' });
    const filesystem = createFakeFilesystem();
    filesystem.existingRoots.add('/home/owner/ghost-repo');
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue('/home/owner/ghost-repo');
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem, settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    let seededState = await seedManager.loadState();
    // Bound to a project id this owner's session does not currently return — e.g. deleted, or a
    // stale/migrated binding that never belonged to this account in the first place.
    seededState = (
      await seedManager.linkDirectory(seededState, 'ghost-project-id', '/home/owner/ghost-repo')
    ).state;
    await seedManager.updateResumeSelection(seededState, {
      selectedProjectId: accessibleProject.id,
      selectedTaskId: null,
      resumeScreen: 'home',
    });

    const { services } = makeServices([accessibleProject], { directoryContext });
    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    expect((await screen.findAllByRole('heading', { name: 'Accessible Project' })).length).toBeGreaterThan(0);

    await clickOpenDirectory();

    const dialog = await screen.findByRole('dialog', { name: 'Unlinked directory' });
    expect(within(dialog).getByRole('button', { name: 'Create project' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Link to existing project' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Accessible Project' }).length).toBeGreaterThan(0);
  });
});

describe('Independent-audit Correction 2 — F1: instruction-status retries are scoped to the full resolution context', () => {
  const workerRow = () => screen.getByText('Worker').closest('li') as HTMLElement;

  it('a stale retry issued against a previous directory root does not win after a same-project switch to a fresh root (A -> B)', async () => {
    const rootA = '/home/owner/root-a';
    const rootB = '/home/owner/root-b';
    const filesystem = createFakeFilesystem();
    filesystem.existingRoots.add(rootA);
    filesystem.existingRoots.add(rootB);
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem, settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    const seededState = await seedManager.loadState();
    // Linked in this order so A (linked last) ends up the active context.
    const afterB = (await seedManager.linkDirectory(seededState, project().id, rootB)).state;
    await seedManager.linkDirectory(afterB, project().id, rootA);

    const { services } = makeServices([project()], { directoryContext });
    // Root A's classification read always fails until a retry is explicitly armed to be held
    // open instead (`deferNextA`) — root B always resolves immediately to a real "Configured".
    // Every non-worker role is answered immediately so it never affects this test.
    let deferNextA = false;
    let resolveARetry!: (value: InjectionPreview) => void;
    services.harness.preview = vi.fn((params: { root: string; projectId: string; role: string }) => {
      if (params.role !== 'worker') return Promise.resolve(fakePreview('Missing'));
      if (params.root === rootB) return Promise.resolve(fakePreview('ManagedValid'));
      if (deferNextA) {
        deferNextA = false;
        return new Promise<InjectionPreview>((resolve) => {
          resolveARetry = resolve;
        });
      }
      return Promise.reject(new Error('classification blew up'));
    }) as typeof services.harness.preview;

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    await waitFor(() => expect(within(workerRow()).getByText('classification blew up')).toBeInTheDocument());

    deferNextA = true;
    fireEvent.click(within(workerRow()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(workerRow()).getByText('Checking…')).toBeInTheDocument());

    // Same project, different directory root — via DirectoryContextPanel's own "Open" action.
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open root-b' }));
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(within(workerRow()).getByText('Configured')).toBeInTheDocument());

    // The stale A retry finally resolves — it must never overwrite B's already-current result.
    resolveARetry(fakePreview('Missing'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(workerRow()).getByText('Configured')).toBeInTheDocument();
    expect(within(workerRow()).queryByText('Not set up')).not.toBeInTheDocument();
    expect(within(workerRow()).queryByText('classification blew up')).not.toBeInTheDocument();
  });

  it('a stale retry from before a Close does not win after the SAME directory is reopened (close/reopen)', async () => {
    const rootA = '/home/owner/root-a';
    const filesystem = createFakeFilesystem();
    filesystem.existingRoots.add(rootA);
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(rootA);
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem, settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    const seededState = await seedManager.loadState();
    await seedManager.linkDirectory(seededState, project().id, rootA);

    const { services } = makeServices([project()], { directoryContext });
    let mode: 'reject' | 'defer' | 'configured' = 'reject';
    let resolveDeferred!: (value: InjectionPreview) => void;
    services.harness.preview = vi.fn((params: { root: string; projectId: string; role: string }) => {
      if (params.role !== 'worker') return Promise.resolve(fakePreview('Missing'));
      if (mode === 'defer') {
        mode = 'reject';
        return new Promise<InjectionPreview>((resolve) => {
          resolveDeferred = resolve;
        });
      }
      if (mode === 'configured') return Promise.resolve(fakePreview('ManagedValid'));
      return Promise.reject(new Error('classification blew up'));
    }) as typeof services.harness.preview;

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    await waitFor(() => expect(within(workerRow()).getByText('classification blew up')).toBeInTheDocument());

    mode = 'defer';
    fireEvent.click(within(workerRow()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(workerRow()).getByText('Checking…')).toBeInTheDocument());

    // Close: no root at all, so nothing is even attempted for this role while it's closed.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(within(workerRow()).getByText('Link a directory to check file status')).toBeInTheDocument(),
    );

    // Reopen the exact same path — this fresh resolution must win even though the root's path
    // text is identical to the one the still-pending stale retry above was issued against.
    mode = 'configured';
    await clickOpenDirectory();
    await waitFor(() => expect(within(workerRow()).getByText('Configured')).toBeInTheDocument());

    resolveDeferred(fakePreview('Missing'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(workerRow()).getByText('Configured')).toBeInTheDocument();
    expect(within(workerRow()).queryByText('classification blew up')).not.toBeInTheDocument();
  });

  it('a stale retry is superseded by a newer full refresh even when the directory root never changes (superseded request)', async () => {
    const rootA = '/home/owner/root-a';
    const filesystem = createFakeFilesystem();
    filesystem.existingRoots.add(rootA);
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem, settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    const seededState = await seedManager.loadState();
    await seedManager.linkDirectory(seededState, project().id, rootA);

    const { services } = makeServices([project()], { directoryContext });
    let mode: 'reject' | 'defer' | 'configured' = 'reject';
    let resolveDeferred!: (value: InjectionPreview) => void;
    services.harness.preview = vi.fn((params: { root: string; projectId: string; role: string }) => {
      if (params.role !== 'worker') return Promise.resolve(fakePreview('Missing'));
      if (mode === 'defer') {
        mode = 'reject';
        return new Promise<InjectionPreview>((resolve) => {
          resolveDeferred = resolve;
        });
      }
      if (mode === 'configured') return Promise.resolve(fakePreview('ManagedValid'));
      return Promise.reject(new Error('classification blew up'));
    }) as typeof services.harness.preview;

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    await waitFor(() => expect(within(workerRow()).getByText('classification blew up')).toBeInTheDocument());

    mode = 'defer';
    fireEvent.click(within(workerRow()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(workerRow()).getByText('Checking…')).toBeInTheDocument());

    // A later full refresh (Home revisit, event-driven per Correction 4) — same root, same
    // project — must supersede the still-pending retry above.
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    mode = 'configured';
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(within(workerRow()).getByText('Configured')).toBeInTheDocument());

    resolveDeferred(fakePreview('Missing'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(workerRow()).getByText('Configured')).toBeInTheDocument();
    expect(within(workerRow()).queryByText('classification blew up')).not.toBeInTheDocument();
  });
});

describe('Independent-audit Correction 2 — F2: unsaved task edits and unsent comments are guarded, not silently discarded', () => {
  it('an unsaved task edit blocks a sidebar project switch until Save/Discard/Cancel; Cancel retains the exact draft', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
    const { services } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [existingTask] },
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Edited title, not yet saved' } });

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    expect(
      within(dialog).getByText('You have an unsaved task edit. Save it, discard it, or stay here.'),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.getByLabelText('Task title')).toHaveValue('Edited title, not yet saved');
    expect(screen.getAllByRole('heading', { name: 'Project A' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Project B' })).not.toBeInTheDocument();
  });

  it('Save on a guarded unsaved task edit persists it to the originating task/project, then the project switch proceeds', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
    const { services } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [existingTask] },
    });
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...existingTask,
      title: 'Edited and saved',
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Edited and saved' } });

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(services.repositories.tasks.update).toHaveBeenCalledWith(
        'existing-task',
        expect.objectContaining({ title: 'Edited and saved' }),
      ),
    );
    await waitFor(() => expect(screen.getAllByRole('heading', { name: 'Project B' }).length).toBeGreaterThan(0));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Discard on a guarded unsaved task edit abandons it (never saved) and the project switch proceeds', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
    const { services } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [existingTask] },
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Should never be saved' } });

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));

    await waitFor(() => expect(screen.getAllByRole('heading', { name: 'Project B' }).length).toBeGreaterThan(0));
    expect(services.repositories.tasks.update).not.toHaveBeenCalled();

    // Switching back to A shows the original, unedited task — the discarded draft never landed.
    fireEvent.click(screen.getByRole('button', { name: 'Project A' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    expect(screen.getByLabelText('Task title')).toHaveValue('Original title');
  });

  it('an unsent comment draft blocks selecting a different task; Cancel keeps it exactly as typed on the originating task', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const firstTask = task({ id: 'first-task', project_id: 'project-a', title: 'First task' });
    const secondTask = task({ id: 'second-task', project_id: 'project-a', title: 'Second task' });
    const { services } = makeServices([projectA], {
      tasksByProject: { 'project-a': [firstTask, secondTask] },
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^First task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('button', { name: 'Add comment' });
    fireEvent.change(screen.getByLabelText('Add a comment'), { target: { value: 'not yet sent' } });

    fireEvent.click(screen.getByRole('button', { name: /^Second task/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    expect(
      within(dialog).getByText('You have an unsent comment. Save it, discard it, or stay here.'),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.getByLabelText('Add a comment')).toHaveValue('not yet sent');
    const detailPanel = screen.getByRole('complementary', { name: 'Selected task detail' });
    expect(within(detailPanel).getByRole('heading', { name: 'First task' })).toBeInTheDocument();
  });

  it('an unsaved task edit also blocks a directory-driven project switch (opening an already-linked directory for a different project)', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
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
      resumeScreen: 'workspace',
    });
    const { services } = makeServices([projectA, projectB], {
      directoryContext,
      tasksByProject: { 'project-a': [existingTask] },
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Workspace' })).toHaveClass('nav-item-active'));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'dirty via directory switch' } });

    await clickOpenDirectory();
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.getByLabelText('Task title')).toHaveValue('dirty via directory switch');
    expect(screen.queryByRole('dialog', { name: 'Unlinked directory' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Project A' }).length).toBeGreaterThan(0);
  });

  it('a failed Save on a guarded unsaved task edit shows the error and does not navigate away', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
    const { services } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [existingTask] },
    });
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('save blew up'));

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'will fail to save' } });

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Save failed — see the error above for details.');
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Project A' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Project B' })).not.toBeInTheDocument();
  });
});

describe('Correction 4 — F2a: every dirty context affected by a transition is protected, not just one', () => {
  it('dirtying a task then Studio (task+Studio) makes a sidebar project switch report BOTH drafts, truthfully', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
    const { services } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [existingTask] },
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'dirty task, still open' } });

    // A plain screen switch never discards tracker state, so the task edit stays open (and dirty)
    // while Studio is dirtied too — the auditor's exact repro.
    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'dirty studio draft' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    // Pre-fix, this dialog would report ONLY "unsaved instruction edits" (Studio wins the single
    // priority pick) despite the task edit being just as much at risk.
    expect(
      within(dialog).getByText(
        'You have unsaved instruction edits and an unsaved task edit. Save them, discard them, or stay here.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Project override content')).toHaveValue('dirty studio draft');

    // Re-triggering the guard proves the task edit was never silently lost by Cancel either — if it
    // had been, this second dialog would report only Studio.
    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const secondDialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    expect(
      within(secondDialog).getByText(
        'You have unsaved instruction edits and an unsaved task edit. Save them, discard them, or stay here.',
      ),
    ).toBeInTheDocument();
  });

  it('Save-all on a task+Studio guard persists BOTH drafts to their originating task and instructions target, then navigates', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
    const { services, instructions } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [existingTask] },
    });
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...existingTask,
      title: 'saved via save-all',
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'saved via save-all' } });

    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'studio saved via save-all' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(services.repositories.tasks.update).toHaveBeenCalledWith(
        'existing-task',
        expect.objectContaining({ title: 'saved via save-all' }),
      ),
    );
    const versions = await instructions.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: 'project-a',
    });
    expect(versions.map((v) => v.content)).toContain('studio saved via save-all');
    // Still on Instructions (a project switch never changes the primary view) — but now for B.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Project B' })).toHaveClass('project-nav-item-active'),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('explicit Discard-all on a task+Studio guard abandons BOTH drafts, then navigates', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
    const { services, instructions } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [existingTask] },
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'should never be saved' } });

    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'should also never be saved' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Project B' })).toHaveClass('project-nav-item-active'),
    );
    expect(services.repositories.tasks.update).not.toHaveBeenCalled();
    const versions = await instructions.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: 'project-a',
    });
    expect(versions.map((v) => v.content)).not.toContain('should also never be saved');

    // Switching back to A confirms neither draft survived.
    fireEvent.click(screen.getByRole('button', { name: 'Project A' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    expect(screen.getByLabelText('Task title')).toHaveValue('Original title');
  });

  it('one save succeeding (task) and the other failing (Studio) keeps the guard open, preserves the successful save, and a retry saves only the remaining kind — no duplicate task update', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
    const { services, instructions } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [existingTask] },
    });
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...existingTask,
      title: 'task half of partial success',
    });
    let studioAttempts = 0;
    const originalSaveAndActivate = services.instructions.saveAndActivate.bind(services.instructions);
    services.instructions.saveAndActivate = ((params) => {
      studioAttempts += 1;
      if (studioAttempts === 1) return Promise.reject(new Error('studio blew up'));
      return originalSaveAndActivate(params);
    }) as typeof services.instructions.saveAndActivate;

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'task half of partial success' } });

    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'studio half of partial success' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    let dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Save failed — see the error in Instruction Studio for details.');
    dialog = screen.getByRole('dialog', { name: 'Unsaved changes' });
    // Only Studio remains outstanding — the task half already saved and must never be re-saved.
    expect(
      within(dialog).getByText('You have unsaved instruction edits. Save them, discard them, or stay here.'),
    ).toBeInTheDocument();
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Project A' })).toHaveClass('project-nav-item-active');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Project B' })).toHaveClass('project-nav-item-active'),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Still exactly one task write — the retry never re-saved the already-successful half.
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);
    const versions = await instructions.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: 'project-a',
    });
    expect(versions.map((v) => v.content)).toContain('studio half of partial success');
  });

  it('Cancelling a task+Studio guard while its combined Save is still in flight never lets a later success execute the abandoned navigation', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
    const { services } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [existingTask] },
    });
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...existingTask,
      title: 'saved during pending cancel',
    });
    let resolveStudioSave!: () => void;
    const originalSaveAndActivate = services.instructions.saveAndActivate.bind(services.instructions);
    services.instructions.saveAndActivate = ((params) =>
      new Promise((resolve) => {
        resolveStudioSave = () => resolve(originalSaveAndActivate(params));
      })) as typeof services.instructions.saveAndActivate;

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'saved during pending cancel' } });

    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'pending studio save' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      screen.getByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();

    resolveStudioSave();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Still on Instructions/Project A: the late combined success never executed the cancelled nav.
    expect(
      screen.getByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Project B' })).not.toBeInTheDocument();
  });

  it('a directory-driven project switch also protects a simultaneously dirty task edit and Studio draft', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
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
      resumeScreen: 'workspace',
    });
    const { services } = makeServices([projectA, projectB], {
      directoryContext,
      tasksByProject: { 'project-a': [existingTask] },
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Workspace' })).toHaveClass('nav-item-active'));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'dirty via directory switch' } });

    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'dirty studio via directory switch' },
    });

    await clickOpenDirectory();
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    expect(
      within(dialog).getByText(
        'You have unsaved instruction edits and an unsaved task edit. Save them, discard them, or stay here.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.getByLabelText('Project override content')).toHaveValue('dirty studio via directory switch');
    expect(screen.queryByRole('dialog', { name: 'Unlinked directory' })).not.toBeInTheDocument();
  });

  it('dirtying a comment then Studio (comment+Studio) makes a sidebar project switch report BOTH drafts, truthfully', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const firstTask = task({ id: 'first-task', project_id: 'project-a', title: 'First task' });
    const { services } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [firstTask] },
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^First task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('button', { name: 'Add comment' });
    fireEvent.change(screen.getByLabelText('Add a comment'), { target: { value: 'not yet sent' } });

    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'dirty studio draft' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    expect(
      within(dialog).getByText(
        'You have unsaved instruction edits and an unsent comment. Save them, discard them, or stay here.',
      ),
    ).toBeInTheDocument();
  });

  it('Save-all on a comment+Studio guard sends the comment and saves Studio, then navigates', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const firstTask = task({ id: 'first-task', project_id: 'project-a', title: 'First task' });
    const { services, instructions } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [firstTask] },
    });
    (services.repositories.memory.addComment as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'comment-1',
      owner_id: ownerId,
      project_id: 'project-a',
      task_id: 'first-task',
      body: 'sent via save-all',
      created_at: '2026-08-13T08:00:00.000Z',
      updated_at: '2026-08-13T08:00:00.000Z',
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^First task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('button', { name: 'Add comment' });
    fireEvent.change(screen.getByLabelText('Add a comment'), { target: { value: 'sent via save-all' } });

    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'saved via save-all' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(services.repositories.memory.addComment).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: 'project-a',
          task_id: 'first-task',
          body: 'sent via save-all',
        }),
      ),
    );
    const versions = await instructions.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: 'project-a',
    });
    expect(versions.map((v) => v.content)).toContain('saved via save-all');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Project B' })).toHaveClass('project-nav-item-active'),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('explicit Discard-all on a comment+Studio guard abandons BOTH drafts, then navigates', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const firstTask = task({ id: 'first-task', project_id: 'project-a', title: 'First task' });
    const { services, instructions } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [firstTask] },
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^First task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('button', { name: 'Add comment' });
    fireEvent.change(screen.getByLabelText('Add a comment'), { target: { value: 'discarded comment' } });

    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'discarded studio draft' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Project B' })).toHaveClass('project-nav-item-active'),
    );
    expect(services.repositories.memory.addComment).not.toHaveBeenCalled();
    const versions = await instructions.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: 'project-a',
    });
    expect(versions.map((v) => v.content)).not.toContain('discarded studio draft');

    fireEvent.click(screen.getByRole('button', { name: 'Project A' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^First task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Add a comment')).toHaveValue('');
  });
});

describe('Correction 4 — F2b: the task-editor dirty baseline reflects durable save success, not an optimistic record', () => {
  it("a rejected task save's optimistic record no longer masks the guard: switching project after 'save blew up' still shows the Unsaved changes dialog; Cancel keeps the failed draft", async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
    const { services } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [existingTask] },
    });
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('save blew up'),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'edited then rejected' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(screen.getAllByText('save blew up').length).toBeGreaterThan(0));

    // Pre-F2b, the optimistic (never-persisted) record now equals the draft, so
    // `isTaskEditorDirty` returned false and this dialog never appeared.
    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    expect(
      within(dialog).getByText('You have an unsaved task edit. Save it, discard it, or stay here.'),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.getByLabelText('Task title')).toHaveValue('edited then rejected');
    expect(screen.getAllByRole('heading', { name: 'Project A' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Project B' })).not.toBeInTheDocument();
  });

  it('an explicit Discard on the guard triggered by a rejected task save abandons it for good; the original record is untouched on return', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
    const { services } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [existingTask] },
    });
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('save blew up'),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'should never be saved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(screen.getAllByText('save blew up').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));

    await waitFor(() => expect(screen.getAllByRole('heading', { name: 'Project B' }).length).toBeGreaterThan(0));
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Project A' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    expect(screen.getByLabelText('Task title')).toHaveValue('Original title');
  });

  it('a successful retry from the guard (after a rejected save) persists to the ORIGINAL record, then navigates', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
    const { services } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [existingTask] },
    });
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('save blew up'))
      .mockResolvedValueOnce({ ...existingTask, title: 'edited then retried' });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'edited then retried' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(screen.getAllByText('save blew up').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(2));
    expect(services.repositories.tasks.update).toHaveBeenNthCalledWith(
      2,
      'existing-task',
      expect.objectContaining({ title: 'edited then retried' }),
    );
    await waitFor(() => expect(screen.getAllByRole('heading', { name: 'Project B' }).length).toBeGreaterThan(0));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a rejected NEW-task save is also guarded, and a successful retry creates exactly one task (no duplicate)', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    // A mutable backing array (rather than a fresh literal) so a later re-fetch of project A's
    // tasks — triggered by switching away and back — reflects the create below, proving no
    // duplicate row was left behind by the failed first attempt.
    const projectATasks: Task[] = [];
    const { services } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': projectATasks },
    });
    (services.repositories.tasks.create as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('create blew up'))
      .mockImplementationOnce(async () => {
        const created = task({ id: 'new-task-1', project_id: 'project-a', title: 'Freshly created' });
        projectATasks.push(created);
        return created;
      });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Freshly created' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(screen.getAllByText('create blew up').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    expect(
      within(dialog).getByText('You have an unsaved task edit. Save it, discard it, or stay here.'),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(services.repositories.tasks.create).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByRole('heading', { name: 'Project B' }).length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Project A' }));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^Freshly created/ }).length).toBe(1),
    );
  });

  it('a directory-driven project switch also shows the guard after a rejected task save (not masked by the optimistic record)', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
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
      resumeScreen: 'workspace',
    });
    const { services } = makeServices([projectA, projectB], {
      directoryContext,
      tasksByProject: { 'project-a': [existingTask] },
    });
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('save blew up'),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Workspace' })).toHaveClass('nav-item-active'));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), {
      target: { value: 'dirty then rejected via directory switch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(screen.getAllByText('save blew up').length).toBeGreaterThan(0));

    await clickOpenDirectory();
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    expect(
      within(dialog).getByText('You have an unsaved task edit. Save it, discard it, or stay here.'),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Task title')).toHaveValue('dirty then rejected via directory switch');
  });

  it('a delayed successful save resolving after a NEWER edit was made keeps the editor open and protected on the newer draft, never reverting it', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
    const { services } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [existingTask] },
    });
    let resolveUpdate!: (task: Task) => void;
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'first edit, saving now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await screen.findByRole('button', { name: 'Saving…' });

    // A further, NEWER edit lands while the first save is still in flight — inputs are not
    // disabled while saving, only the submit button is.
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'newer edit, never submitted' } });

    // The held write now resolves successfully — but only for the FIRST (now-stale) content.
    resolveUpdate({ ...existingTask, title: 'first edit, saving now' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument());

    // The editor must still be open, still showing the NEWER (unsaved) draft — a stale success
    // must never close the editor over a draft it never actually saved (Correction 4, F2b).
    expect(screen.getByLabelText('Task title')).toHaveValue('newer edit, never submitted');
    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    expect(
      within(dialog).getByText('You have an unsaved task edit. Save it, discard it, or stay here.'),
    ).toBeInTheDocument();
  });

  it("Correction 5 — an explicit Cancel on a rejected task edit rolls the list back to confirmed content, so reopening the same task (without leaving the project) never recaptures the failed draft as a new baseline", async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
    const { services } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [existingTask] },
    });
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('save blew up'),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'edited after failure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(screen.getAllByText('save blew up').length).toBeGreaterThan(0));

    // Pre-Correction-5, the rejected optimistic row kept showing "edited after failure" in the
    // outliner even after this explicit Cancel abandoned it — an unsaved edit silently displayed
    // as if it had been saved.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: /^edited after failure/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Original title/ })).toBeInTheDocument();

    // Reopening the SAME task, still on the SAME project (no project switch/refetch to paper over
    // a stale row), must capture "Original title" — not the abandoned "edited after failure" — as
    // its baseline.
    fireEvent.click(screen.getByRole('button', { name: /^Original title/ }));
    expect(screen.getByLabelText('Task title')).toHaveValue('Original title');

    // With nothing actually dirty now, switching project needs no guard, and truthfully so — the
    // failed edit was abandoned the moment Cancel was clicked, not silently "saved" and then lost.
    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { name: 'Project B' }).length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);
  });

  it('Correction 5 — a REPEATED rejection/Cancel/reopen cycle never accumulates a stale baseline', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
    const { services } = makeServices([projectA], {
      tasksByProject: { 'project-a': [existingTask] },
    });
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('save blew up once'))
      .mockRejectedValueOnce(new Error('save blew up twice'));

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));

    for (const [attempt, editedValue] of [
      ['first', 'first failed edit'],
      ['second', 'second failed edit'],
    ] as const) {
      fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
      expect(screen.getByLabelText('Task title')).toHaveValue('Original title');
      fireEvent.change(screen.getByLabelText('Task title'), { target: { value: editedValue } });
      fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
      await waitFor(() =>
        expect(screen.getAllByText(`save blew up ${attempt === 'first' ? 'once' : 'twice'}`).length).toBeGreaterThan(0),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('button', { name: new RegExp(`^${editedValue}`) })).not.toBeInTheDocument();
    }

    expect(await screen.findByRole('button', { name: /^Original title/ })).toBeInTheDocument();
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(2);
  });

  it('Correction 5 — an explicit Discard on the unsaved-changes guard also rolls the rejected row back, without needing a project switch/refetch to mask it', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const existingTask = task({ id: 'existing-task', project_id: 'project-a', title: 'Original title' });
    const otherTask = task({ id: 'other-task', project_id: 'project-a', title: 'Other task' });
    const { services } = makeServices([projectA], {
      tasksByProject: { 'project-a': [existingTask, otherTask] },
    });
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('save blew up'),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'edited then rejected' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(screen.getAllByText('save blew up').length).toBeGreaterThan(0));

    // Trigger the guard via a same-project task switch (no project change, so nothing refetches
    // and papers over a stale optimistic row) and Discard through the dialog instead of the
    // editor's own Cancel button.
    fireEvent.click(screen.getByRole('button', { name: /^Other task/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));

    expect(await screen.findByLabelText('Task title')).toHaveValue('Other task');
    expect(screen.queryByRole('button', { name: /^edited then rejected/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    expect(screen.getByLabelText('Task title')).toHaveValue('Original title');
  });
});

/**
 * Correction 6 (Round-4 independent audit, DeepSeek) — `saveTask`'s success branch reselected
 * whichever task it had just persisted (`setSelectedTaskId(saved.id)`) guarded only by the
 * project match, not by `taskEditorGenRef` — unlike the adjacent editor-close/rebase branch it
 * sits beside. A delayed save for an ABANDONED editing context could therefore steal selection
 * back from a newer editor the owner had already moved on to, and a subsequent Save from that
 * newer editor would then silently target the OLD task's id with the NEW task's fields.
 */
describe('Correction 6 — a delayed task-save completion must never steal a newer editor\'s selection or redirect its save target', () => {
  it('cancelling task A mid-save, then opening task B, then resolving A\'s save as success: the editor/selection stays on B, and saving B updates task-b (never task-a) with B\'s own fields', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Task Alpha' });
    const taskB = task({ id: 'task-b', project_id: 'project-a', title: 'Task Bravo' });
    const { services } = makeServices([projectA], {
      tasksByProject: { 'project-a': [taskA, taskB] },
    });
    let resolveTaskASave!: (task: Task) => void;
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(
        () =>
          new Promise<Task>((resolve) => {
            resolveTaskASave = resolve;
          }),
      )
      .mockImplementationOnce((id: string, patch: Partial<Task>) =>
        Promise.resolve({ ...taskB, ...patch, id } as Task),
      );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));

    // Start editing and saving task A — the write is held pending.
    fireEvent.click(await screen.findByRole('button', { name: /^Task Alpha/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Task Alpha edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await screen.findByRole('button', { name: 'Saving…' });

    // The editor's own Cancel is not disabled while saving — an explicit abandon of THIS
    // editing context, independent of whatever the in-flight write eventually does.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Open a DIFFERENT task in the same project — a new editing generation.
    fireEvent.click(await screen.findByRole('button', { name: /^Task Bravo/ }));
    expect(screen.getByLabelText('Task title')).toHaveValue('Task Bravo');

    // Task A's held save now resolves successfully — durably, for task-a.
    resolveTaskASave({ ...taskA, title: 'Task Alpha edited' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Task Alpha edited/ })).toBeInTheDocument();
    });

    // The stale completion reconciled task-a's row, but must NOT have stolen focus/selection
    // back onto it — the editor is still B's, untouched.
    expect(screen.getByLabelText('Task title')).toHaveValue('Task Bravo');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Saving B now must target task-b with B's own fields — never task-a.
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Task Bravo edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));

    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(2));
    expect(services.repositories.tasks.update).toHaveBeenNthCalledWith(
      1,
      'task-a',
      expect.objectContaining({ title: 'Task Alpha edited' }),
    );
    expect(services.repositories.tasks.update).toHaveBeenNthCalledWith(
      2,
      'task-b',
      expect.objectContaining({ title: 'Task Bravo edited' }),
    );

    // Task A retains only its own legitimate first-save content — never contaminated by B's
    // payload from the second, unrelated update call — and B's own row reflects its own save.
    expect(screen.getByRole('button', { name: /^Task Alpha edited/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Task Bravo edited/ })).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /^Task Alpha/ }).length).toBe(1);
    expect(screen.queryAllByRole('button', { name: /^Task Bravo/ }).length).toBe(1);
  });

  it('discarding task A\'s dirty edit (via the Unsaved-changes guard, not the editor\'s own Cancel) while its save is pending, then resolving that save as success, still leaves task B\'s selection alone and its save targeting task-b', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Task Alpha' });
    const taskB = task({ id: 'task-b', project_id: 'project-a', title: 'Task Bravo' });
    const { services } = makeServices([projectA], {
      tasksByProject: { 'project-a': [taskA, taskB] },
    });
    let resolveTaskASave!: (task: Task) => void;
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(
        () =>
          new Promise<Task>((resolve) => {
            resolveTaskASave = resolve;
          }),
      )
      .mockImplementationOnce((id: string, patch: Partial<Task>) =>
        Promise.resolve({ ...taskB, ...patch, id } as Task),
      );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Task Alpha/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Task Alpha edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await screen.findByRole('button', { name: 'Saving…' });

    // Click straight through to task B instead of Cancel first — still dirty (the baseline
    // hasn't moved yet; this save hasn't resolved), so the guard dialog appears.
    fireEvent.click(screen.getByRole('button', { name: /^Task Bravo/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));

    expect(await screen.findByLabelText('Task title')).toHaveValue('Task Bravo');

    resolveTaskASave({ ...taskA, title: 'Task Alpha edited' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Task Alpha edited/ })).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Task title')).toHaveValue('Task Bravo');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Task Bravo edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(2));
    expect(services.repositories.tasks.update).toHaveBeenNthCalledWith(
      2,
      'task-b',
      expect.objectContaining({ title: 'Task Bravo edited' }),
    );
  });

  it('reopening the SAME task (a fresh editor generation) after Cancelling its pending save: the stale success must not close or revert the freshly reopened, newly-dirty editor, and a LATER Cancel of that reopened draft reveals the stale save\'s now-confirmed value rather than the obsolete pre-save baseline (Correction 7, Finding B)', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Original title' });
    const { services } = makeServices([projectA], {
      tasksByProject: { 'project-a': [taskA] },
    });
    let resolveFirstSave!: (task: Task) => void;
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise<Task>((resolve) => {
          resolveFirstSave = resolve;
        }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'first edit, saving now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await screen.findByRole('button', { name: 'Saving…' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: /^Original title/ })).toBeInTheDocument();

    // Reopen the SAME task — a brand-new editor generation — and make a DIFFERENT, unsaved edit.
    fireEvent.click(screen.getByRole('button', { name: /^Original title/ }));
    expect(screen.getByLabelText('Task title')).toHaveValue('Original title');
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'second edit, from reopened editor' } });

    // The FIRST save (against the now-abandoned generation) resolves successfully.
    resolveFirstSave({ ...taskA, title: 'first edit, saving now' });

    // The reopened editor's own newer, unsaved draft must survive untouched — not reverted, not
    // closed over by the stale completion.
    await waitFor(() =>
      expect(screen.getByLabelText('Task title')).toHaveValue('second edit, from reopened editor'),
    );
    expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument();

    // An explicit Cancel now must reveal the CURRENT confirmed value — "first edit, saving now",
    // durably persisted by the stale completion above — never the obsolete "Original title" this
    // reopened editor happened to start from. Pre-Correction-7, Cancel rolled back to whatever
    // baseline this editing context captured at open time, silently resurrecting a value the
    // backend no longer holds and burying the save that actually landed.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: /^first edit, saving now/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Original title/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^second edit/ })).not.toBeInTheDocument();
  });

  it('discarding task A and switching to a DIFFERENT project while its save is pending, then resolving that save: the new project\'s task list is never contaminated', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Task Alpha' });
    const taskB = task({ id: 'task-b', project_id: 'project-b', title: 'Task Bravo' });
    const { services } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [taskA], 'project-b': [taskB] },
    });
    let resolveTaskASave!: (task: Task) => void;
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise<Task>((resolve) => {
          resolveTaskASave = resolve;
        }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Task Alpha/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Task Alpha edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await screen.findByRole('button', { name: 'Saving…' });

    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));

    await waitFor(() => expect(screen.getAllByRole('heading', { name: 'Project B' }).length).toBeGreaterThan(0));
    expect(await screen.findByRole('button', { name: /^Task Bravo/ })).toBeInTheDocument();

    // Task A's held save now resolves successfully — AFTER the project switch away from it.
    resolveTaskASave({ ...taskA, title: 'Task Alpha edited' });
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));
    // Give the resolved promise's continuation inside `saveTask` a tick to run (it intentionally
    // does nothing observable here — this proves that, not just that the call happened).
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Project B's list, selection, and dialog state are all untouched by the stale completion —
    // no old collection update contaminates the new project.
    expect(screen.getByRole('button', { name: /^Task Bravo/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Task Alpha/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a Cancelled task A\'s pending save later REJECTING (after task B is opened) must not surface its stale error on task B\'s clean editor', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Task Alpha' });
    const taskB = task({ id: 'task-b', project_id: 'project-a', title: 'Task Bravo' });
    const { services } = makeServices([projectA], {
      tasksByProject: { 'project-a': [taskA, taskB] },
    });
    let rejectTaskASave!: (error: Error) => void;
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise<Task>((_resolve, reject) => {
          rejectTaskASave = reject;
        }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Task Alpha/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Task Alpha edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await screen.findByRole('button', { name: 'Saving…' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Task Bravo/ }));
    expect(screen.getByLabelText('Task title')).toHaveValue('Task Bravo');

    rejectTaskASave(new Error('task A save blew up'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Task B's clean, freshly opened editor must show no error and remain untouched by the stale
    // rejection for the abandoned task-a editing context.
    expect(screen.queryByText('task A save blew up')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Task title')).toHaveValue('Task Bravo');
  });
});

/**
 * Correction 7 (owner round-5 audit) originally fixed Finding A (an older, superseded save
 * response settling after a newer one must never regress the collection) with a per-task
 * "highest ISSUED revision" watermark, and Finding B (Cancel must reveal the CURRENT confirmed
 * value, not a frozen editor-open baseline) with a separately-maintained confirmed-row ref.
 *
 * Round 6's independent audit found a residual: the watermark tracked ISSUANCE order, not
 * SUCCESS — so in the sequence "issue v1, issue v2, v2 REJECTS, v1 SUCCEEDS", v1's own success
 * carried the lower (now-superseded) revision number and was excluded from confirmation entirely,
 * even though it was the only request that actually persisted anything. Cancel then revealed the
 * stale pre-save baseline instead of the durable v1 value.
 *
 * HAM3-008 Correction 8 removes the race those two mechanisms were patching, instead of adding
 * another watermark exception: at most one persistence request per task id is ever in flight at a
 * time (`TaskSaveCoordinator`, `src/tracker/taskSaveCoordinator.ts`), dispatched strictly FIFO. A
 * second overlapping save for the SAME task (a normal form Save plus an overlapping guard
 * Save-all, sharing one open editing context) now QUEUES instead of racing a concurrent request —
 * so "two requests genuinely in flight for the same task at once" is no longer reachable, and
 * "highest issued" and "highest successful" collapse into the same thing by construction. The
 * tests below replace the three that asserted the OLD concurrent-dispatch shape (two `update`
 * calls already both in flight before either settles) with tests that instead prove that shape is
 * now IMPOSSIBLE, while preserving every content/Cancel/error guarantee the originals proved.
 */
describe('Correction 7/8 — task state stays consistent across overlapping saves and Cancel; overlapping dispatch is now impossible', () => {
  it("v1 saving, then v2 requested for the SAME task while v1 is still held: v2's own repository call does not begin until v1 settles (overlapping dispatch is impossible); once v1 succeeds it is reconciled immediately, then v2 dispatches and also succeeds — confirmed advances v1 then v2, ending on v2", async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Task Alpha' });
    const taskB = task({ id: 'task-b', project_id: 'project-a', title: 'Task Bravo' });
    const { services } = makeServices([projectA], {
      tasksByProject: { 'project-a': [taskA, taskB] },
    });

    const resolvers: Array<(task: Task) => void> = [];
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Task>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Task Alpha/ }));

    // Edit task A to v1 and click the form's own Save. Held.
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await screen.findByRole('button', { name: 'Saving…' });
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));

    // Change the input to v2 while v1's write is still in flight — a newer, unsaved edit — and
    // explicitly request it via the guard dialog's own "Save changes" (triggered by clicking away
    // to task B, still dirty against the original baseline).
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Task Bravo/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    // v2 has been explicitly requested, but the coordinator must not dispatch it while v1 is
    // still in flight — give a wrongly-eager implementation a chance to fire, then prove it
    // didn't: still exactly ONE `update` call, still v1's own payload. The rest of the app stays
    // usable — the dialog itself is still interactive, nothing is globally frozen.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);
    expect(services.repositories.tasks.update).toHaveBeenNthCalledWith(
      1,
      'task-a',
      expect.objectContaining({ title: 'v1' }),
    );
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();

    // Settle v1 — this both reconciles task-a's row to "v1" AND is what lets the coordinator
    // dispatch v2 (its repository call happens strictly after, never before, v1 settles).
    resolvers[0]({ ...taskA, title: 'v1' });
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(2));
    expect(services.repositories.tasks.update).toHaveBeenNthCalledWith(
      2,
      'task-a',
      expect.objectContaining({ title: 'v2' }),
    );

    // v2 now succeeds — the guard's Save-all completes and navigates to B.
    resolvers[1]({ ...taskA, title: 'v2' });
    await waitFor(() => expect(screen.getByRole('button', { name: /^v2/ })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText('Task title')).toHaveValue('Task Bravo'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^v1/ })).not.toBeInTheDocument();
  });

  it("different tasks' own overlapping-save activity is tracked strictly PER TASK: a completely independent outliner status move for task B dispatches and settles on its OWN schedule while task A's own form Save is still held, and neither task's confirmed content leaks into the other's", async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Task Alpha' });
    const taskB = task({ id: 'task-b', project_id: 'project-a', title: 'Task Bravo', status: 'backlog' });
    const { services } = makeServices([projectA], {
      tasksByProject: { 'project-a': [taskA, taskB] },
    });
    const resolvers: Array<{ id: string; resolve: (task: Task) => void }> = [];
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) =>
        new Promise<Task>((resolve) => {
          resolvers.push({ id, resolve });
        }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));

    // Task A: v1 held via its own form Save.
    fireEvent.click(await screen.findByRole('button', { name: /^Task Alpha/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'A-v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));

    // While task A's own save is still held, move task B's status directly from the outliner — a
    // fully independent per-task request. It must dispatch immediately, never queuing behind
    // task A's own unrelated activity (different tasks save independently).
    fireEvent.change(screen.getByLabelText('Move Task Bravo'), { target: { value: 'done' } });
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(2));
    expect(services.repositories.tasks.update).toHaveBeenNthCalledWith(2, 'task-b', { status: 'done' });

    const taskBCall = resolvers.find((entry) => entry.id === 'task-b')!;
    taskBCall.resolve({ ...taskB, status: 'done' });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Task Bravo/ })).toBeInTheDocument());
    // Task A's own editor is entirely unaffected by task B's unrelated completion — still open,
    // still showing its own held save, never stolen or disturbed.
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeInTheDocument();
    expect(screen.getByLabelText('Task title')).toHaveValue('A-v1');

    // NOW resolve task A's own save — its confirmed content is exactly its own, never task B's.
    const taskACall = resolvers.find((entry) => entry.id === 'task-a')!;
    taskACall.resolve({ ...taskA, title: 'A-v1' });
    await waitFor(() => expect(screen.getByRole('button', { name: /^A-v1/ })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^Task Bravo/ })).toBeInTheDocument();
  });

  it('v1 succeeds while v2 is still queued behind it, and v2 (once it finally dispatches) REJECTS: v1 stays confirmed — never excluded because a later, now-failed v2 was requested after it — the dialog stays open with the error, and an explicit Cancel with NO third retry reveals v1, never the stale pre-save baseline (closes the round-6 residual under Finding A)', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Task Alpha' });
    const taskB = task({ id: 'task-b', project_id: 'project-a', title: 'Task Bravo' });
    const { services } = makeServices([projectA], {
      tasksByProject: { 'project-a': [taskA, taskB] },
    });
    const resolvers: Array<{ resolve: (task: Task) => void; reject: (error: Error) => void }> = [];
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Task>((resolve, reject) => {
          resolvers.push({ resolve, reject });
        }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Task Alpha/ }));

    // v1 — the form's own Save — dispatched, held.
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await screen.findByRole('button', { name: 'Saving…' });
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));

    // v2 — requested via the guard dialog while v1 is still held — QUEUES behind it and must not
    // dispatch yet.
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Task Bravo/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);

    // v1 succeeds — reconciles task-a's row to "v1" AND lets the coordinator dispatch v2.
    resolvers[0].resolve({ ...taskA, title: 'v1' });
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(2));
    expect(services.repositories.tasks.update).toHaveBeenNthCalledWith(
      2,
      'task-a',
      expect.objectContaining({ title: 'v2' }),
    );

    // v2 — the only request now outstanding — rejects. Its error surfaces (shown in both the
    // outliner's banner and the form's own error box) and the dialog stays put.
    resolvers[1].reject(new Error('v2 rejected'));
    await waitFor(() => expect(screen.getAllByText('v2 rejected').length).toBeGreaterThan(0));
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();

    // The round-6 residual this closes: v1's earlier SUCCESS must still be confirmed — pre-
    // Correction-8, the issuance-order watermark excluded it because a later (now-rejected) v2
    // had been requested after it.
    expect(screen.getByRole('button', { name: /^v1/ })).toBeInTheDocument();

    // Dismiss the nav prompt itself first (its own Cancel just stays on task A) so the editor's
    // OWN Cancel button is the one being exercised next, unambiguously.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Task title')).toHaveValue('v2');
    expect(screen.getAllByText('v2 rejected').length).toBeGreaterThan(0);

    // The editor's own explicit Cancel — with NO third retry — must reveal v1, the actual durable
    // value, never "Task Alpha" (the stale pre-save baseline).
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: /^v1/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^v2/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Task Alpha/ })).not.toBeInTheDocument();
  });

  it("a REJECTED save's optimistic content never becomes confirmed: after Cancel abandons it, reopens the same task with a second draft, and that second draft is also Cancelled, the row reveals the ORIGINAL confirmed value — never either rejected/abandoned draft (Finding B, combined with the rejected-save protection)", async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Original title' });
    const { services } = makeServices([projectA], {
      tasksByProject: { 'project-a': [taskA] },
    });
    let rejectFirstSave!: (error: Error) => void;
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise<Task>((_resolve, reject) => {
          rejectFirstSave = reject;
        }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'first attempt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await screen.findByRole('button', { name: 'Saving…' });

    // Cancel while the save is still held — abandons this draft before it even fails.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: /^Original title/ })).toBeInTheDocument();

    // Reopen the SAME task (a fresh generation) and make a second, different unsaved edit.
    fireEvent.click(screen.getByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'second attempt' } });

    // The FIRST save now rejects — stale (abandoned generation). Its rejection must produce no
    // visible error on this fresh editor and, critically, must NOT be recorded as confirmed.
    rejectFirstSave(new Error('first attempt blew up'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByLabelText('Task title')).toHaveValue('second attempt');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // Cancel the second draft too — with nothing ever having been confirmed beyond the original
    // load, this must reveal "Original title", never "first attempt" (which never became
    // confirmed — it was rejected) and never "second attempt" (never saved at all).
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: /^Original title/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^first attempt/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^second attempt/ })).not.toBeInTheDocument();
  });

  it('the SAME sequence resolved via the Unsaved-changes guard\'s Discard (not the editor\'s own Cancel button) also reveals the confirmed value from a stale completion, not the obsolete open-time baseline (Finding B)', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Original title' });
    const otherTask = task({ id: 'other-task', project_id: 'project-a', title: 'Other task' });
    const { services } = makeServices([projectA], {
      tasksByProject: { 'project-a': [taskA, otherTask] },
    });
    let resolveFirstSave!: (task: Task) => void;
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise<Task>((resolve) => {
          resolveFirstSave = resolve;
        }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'first edit, saving now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await screen.findByRole('button', { name: 'Saving…' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'second edit, from reopened editor' } });

    // The first, now-abandoned save resolves successfully — durably, into the confirmed store.
    resolveFirstSave({ ...taskA, title: 'first edit, saving now' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByLabelText('Task title')).toHaveValue('second edit, from reopened editor');

    // Trigger the guard via a same-project task switch and Discard through the DIALOG rather than
    // the editor's own Cancel button.
    fireEvent.click(screen.getByRole('button', { name: /^Other task/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));

    expect(await screen.findByLabelText('Task title')).toHaveValue('Other task');
    // Switching back confirms task-a's row itself reveals the confirmed "first edit, saving now"
    // — never the obsolete "Original title" baseline this abandoned editor started from.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: /^first edit, saving now/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Original title/ })).not.toBeInTheDocument();
  });
});

describe('Independent-audit Correction 2 — F3: no competing state publisher regresses the mirrored directory context', () => {
  it('a pending resume-selection write does not regress the mirrored directory context after a subsequent Close; durable settings still end up correct', async () => {
    const rootA = '/home/owner/root-a';
    const filesystem = createFakeFilesystem();
    filesystem.existingRoots.add(rootA);
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem, settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    const seededState = await seedManager.loadState();
    await seedManager.linkDirectory(seededState, project().id, rootA);

    const originalWriteImpl = (settings.write as ReturnType<typeof vi.fn>).getMockImplementation() as (
      key: string,
      value: unknown,
    ) => Promise<void>;
    let resolveHeldWrite!: () => void;
    let heldCallSeen = false;
    (settings.write as ReturnType<typeof vi.fn>).mockImplementation((key: string, value: unknown) => {
      if (!heldCallSeen) {
        heldCallSeen = true;
        return new Promise<void>((resolve) => {
          resolveHeldWrite = () => {
            void originalWriteImpl(key, value).then(resolve);
          };
        });
      }
      return originalWriteImpl(key, value);
    });

    const { services } = makeServices([project()], { directoryContext });
    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(rootA, { selector: 'code' })).toBeInTheDocument());
    // The resume-persistence effect's own write for this mount is now the one being held pending.
    await waitFor(() => expect(heldCallSeen).toBe(true));

    // Close, then resolve the stale held write immediately — deliberately no other navigation
    // (each of which would itself re-run the resume-persistence effect and issue a further,
    // NOT-stale write) in between, so a regression from the held write alone is never masked by
    // a later write correcting it back before this check runs.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByText('No directory is open for this project.')).toBeInTheDocument());

    // Resolve the OLD, held resume write now — before Correction 2 (F3), its own
    // `.then(directory.setState)` would regress the mirror back to "root A open" here, with
    // nothing else queued yet to correct it back.
    resolveHeldWrite();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByText('No directory is open for this project.')).toBeInTheDocument();
    expect(screen.queryByText(rootA, { selector: 'code' })).not.toBeInTheDocument();

    // Now safe to navigate further — Home and Studio must still show no active directory.
    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    expect(await screen.findByText(/Link a local directory for/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(screen.getByText('No directory is open for this project.')).toBeInTheDocument();

    await waitFor(async () => {
      const stored = await settings.read<LocalSettingsStateV2>(LOCAL_SETTINGS_KEY);
      expect(stored?.lastOpenContextId).toBeNull();
    });
  });

  it('DirectoryContextPanel is never wired to a second, competing state publisher in production', async () => {
    const rootA = '/home/owner/root-a';
    const filesystem = createFakeFilesystem();
    filesystem.existingRoots.add(rootA);
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem, settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    const seededState = await seedManager.loadState();
    await seedManager.linkDirectory(seededState, project().id, rootA);

    const { services } = makeServices([project()], { directoryContext });
    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    await waitFor(() => expect(screen.getByText(rootA, { selector: '.directory-context-path' })).toBeInTheDocument());

    // The only correct way for TrackerPage to learn about a DirectoryContextPanel-driven mutation
    // (Close, Forget, Open, Link, Locate replacement) is the manager's own `subscribe` — confirmed
    // by exercising one such action (Close) here and by `directoryContextManager.test.ts` proving
    // every mutating method (including `forget`) publishes synchronously ahead of its own write.
    fireEvent.click(screen.getByRole('button', { name: 'Close root-a' }));
    expect(screen.getByText('No directory is open for this project yet.')).toBeInTheDocument();
  });
});

describe('Correction 5 — a mounted owner change invalidates every old-owner pending-nav/guard state', () => {
  it('a pending-nav guard dialog still open (Save never clicked) when the owner changes is dismissed, and its action never executes under the new owner', async () => {
    const owner1 = 'owner-real-3';
    const owner2 = 'owner-real-4';
    const projectA = project({ id: 'project-a2', owner_id: owner1, name: 'Project A2' });
    const projectB = project({ id: 'project-b2', owner_id: owner1, name: 'Project B2' });
    const projectC = project({ id: 'project-c2', owner_id: owner2, name: 'Owner2 Project 2' });
    const existingTask = task({ id: 'existing-task-2', project_id: 'project-a2', title: 'Original title 2' });
    const { services } = makeServices([projectA, projectB, projectC], {
      tasksByProject: { 'project-a2': [existingTask] },
    });
    const listSpy = vi.fn();
    listSpy.mockResolvedValueOnce([projectA, projectB]).mockResolvedValueOnce([projectC]);
    services.repositories.projects.list = listSpy as unknown as typeof services.repositories.projects.list;

    const { rerender } = render(<TrackerPage services={services} ownerId={owner1} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title 2/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'never saved before owner change' } });

    fireEvent.click(screen.getByRole('button', { name: 'Project B2' }));
    await screen.findByRole('dialog', { name: 'Unsaved changes' });

    // Owner changes (mounted account switch) while the dialog is showing, nobody having clicked
    // Save/Discard/Cancel yet.
    rerender(<TrackerPage services={services} ownerId={owner2} onSignOut={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { name: 'Owner2 Project 2' }).length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Project B2' })).not.toBeInTheDocument();
    expect(services.repositories.tasks.update).not.toHaveBeenCalled();
  });

  it("an owner change while a combined task+Studio Save is still in flight discards the old navigation, and a later resolution of that old save never leaks into the new owner's session or guard", async () => {
    const owner1 = 'owner-real-5';
    const owner2 = 'owner-real-6';
    const projectA = project({ id: 'project-a3', owner_id: owner1, name: 'Project A3' });
    const projectB = project({ id: 'project-b3', owner_id: owner1, name: 'Project B3' });
    const projectC = project({ id: 'project-c3', owner_id: owner2, name: 'Owner2 Project 3' });
    const existingTask = task({ id: 'existing-task-3', project_id: 'project-a3', title: 'Original title 3' });
    const { services } = makeServices([projectA, projectB, projectC], {
      tasksByProject: { 'project-a3': [existingTask] },
    });
    const listSpy = vi.fn();
    listSpy.mockResolvedValueOnce([projectA, projectB]).mockResolvedValueOnce([projectC]);
    services.repositories.projects.list = listSpy as unknown as typeof services.repositories.projects.list;

    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...existingTask,
      title: 'saved before owner change',
    });
    let resolveStudioSave!: () => void;
    const originalSaveAndActivate = services.instructions.saveAndActivate.bind(services.instructions);
    services.instructions.saveAndActivate = ((params) =>
      new Promise((resolve) => {
        resolveStudioSave = () => resolve(originalSaveAndActivate(params));
      })) as typeof services.instructions.saveAndActivate;

    const { rerender } = render(<TrackerPage services={services} ownerId={owner1} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title 3/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'saved before owner change' } });

    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'pending studio save at owner change' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Project B3' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    // Owner changes (mounted account switch) while the combined Save is still in flight — only
    // the Studio half is held; the task half resolves synchronously above. (Device-local resume
    // settings are not owner-scoped, so owner2 may legitimately resume straight into whichever
    // screen owner1's session last recorded — the assertions below key off the sidebar's own
    // active-project state, which IS owner-scoped, rather than assuming a particular screen.)
    rerender(<TrackerPage services={services} ownerId={owner2} onSignOut={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Owner2 Project 3' })).toHaveClass('project-nav-item-active'),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Project B3' })).not.toBeInTheDocument();

    // The old owner's held Studio save finally resolves.
    resolveStudioSave();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The stale completion must never execute the old navigation (selecting Project B3) nor
    // resurrect any of owner1's UI under the now-current owner2 session.
    expect(screen.queryByRole('button', { name: 'Project B3' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Project A3' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Owner2 Project 3' })).toHaveClass('project-nav-item-active');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // And the new owner's OWN guard must still work — the shared guard state was invalidated, not
    // left permanently broken (stuck "Saving…", or a token that can never match again).
    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: /^Worker instructions for/ });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), { target: { value: 'owner2 own draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    const newDialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    expect(
      within(newDialog).getByText('You have unsaved instruction edits. Save them, discard them, or stay here.'),
    ).toBeInTheDocument();
  });

  it('an owner change during a partial Save-all success (task saved, Studio still failing) discards the narrowed guard instead of leaking it into the new owner', async () => {
    const owner1 = 'owner-real-7';
    const owner2 = 'owner-real-8';
    const projectA = project({ id: 'project-a4', owner_id: owner1, name: 'Project A4' });
    const projectB = project({ id: 'project-b4', owner_id: owner1, name: 'Project B4' });
    const projectC = project({ id: 'project-c4', owner_id: owner2, name: 'Owner2 Project 4' });
    const existingTask = task({ id: 'existing-task-4', project_id: 'project-a4', title: 'Original title 4' });
    const { services } = makeServices([projectA, projectB, projectC], {
      tasksByProject: { 'project-a4': [existingTask] },
    });
    const listSpy = vi.fn();
    listSpy.mockResolvedValueOnce([projectA, projectB]).mockResolvedValueOnce([projectC]);
    services.repositories.projects.list = listSpy as unknown as typeof services.repositories.projects.list;

    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...existingTask,
      title: 'task half saved before owner change',
    });
    services.instructions.saveAndActivate = (() =>
      Promise.reject(new Error('studio blew up'))) as typeof services.instructions.saveAndActivate;

    const { rerender } = render(<TrackerPage services={services} ownerId={owner1} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title 4/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'task half saved before owner change' } });

    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'studio half fails before owner change' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Project B4' }));
    let dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Save failed — see the error in Instruction Studio for details.');
    dialog = screen.getByRole('dialog', { name: 'Unsaved changes' });
    expect(
      within(dialog).getByText('You have unsaved instruction edits. Save them, discard them, or stay here.'),
    ).toBeInTheDocument();
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);

    // Owner changes while the narrowed (Studio-only) guard is still showing its error. (Device-
    // local resume settings are not owner-scoped, so owner2 may legitimately resume straight into
    // whichever screen owner1's session last recorded — key off the sidebar's own owner-scoped
    // active-project state rather than assuming a particular screen.)
    rerender(<TrackerPage services={services} ownerId={owner2} onSignOut={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Owner2 Project 4' })).toHaveClass('project-nav-item-active'),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Save failed — see the error in Instruction Studio for details.')).not.toBeInTheDocument();
    // Still exactly one task write — the abandoned guard's own retry path never re-fires under owner2.
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);
  });

  it('a directory-driven transition awaiting guardTransition when the owner changes is cancelled and never later activates the old binding', async () => {
    const owner1 = 'owner-real-9';
    const owner2 = 'owner-real-10';
    const projectA = project({ id: 'project-a5', owner_id: owner1, name: 'Project A5' });
    const projectB = project({ id: 'project-b5', owner_id: owner1, name: 'Project B5' });
    const projectC = project({ id: 'project-c5', owner_id: owner2, name: 'Owner2 Project 5' });
    const existingTask = task({ id: 'existing-task-5', project_id: 'project-a5', title: 'Original title 5' });

    const filesystem = createFakeFilesystem();
    filesystem.existingRoots.add('/home/owner/b5-repo');
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue('/home/owner/b5-repo');
    const settings = createFakeLocalSettings();
    const directoryContext: DirectoryContextServices = { filesystem, settings };
    const seedManager = new DirectoryContextManager(directoryContext);
    let seededState = await seedManager.loadState();
    seededState = (await seedManager.linkDirectory(seededState, projectB.id, '/home/owner/b5-repo')).state;
    await seedManager.updateResumeSelection(seededState, {
      selectedProjectId: projectA.id,
      selectedTaskId: null,
      resumeScreen: 'workspace',
    });

    const { services } = makeServices([projectA, projectB, projectC], {
      directoryContext,
      tasksByProject: { 'project-a5': [existingTask] },
    });
    const listSpy = vi.fn();
    listSpy.mockResolvedValueOnce([projectA, projectB]).mockResolvedValueOnce([projectC]);
    services.repositories.projects.list = listSpy as unknown as typeof services.repositories.projects.list;

    const { rerender } = render(<TrackerPage services={services} ownerId={owner1} onSignOut={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Workspace' })).toHaveClass('nav-item-active'));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title 5/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'dirty before directory switch' } });

    await clickOpenDirectory();
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    expect(
      within(dialog).getByText('You have an unsaved task edit. Save it, discard it, or stay here.'),
    ).toBeInTheDocument();

    // Owner changes while `openDirectory()`'s own `guardTransition()` promise is still awaiting a
    // decision nobody made.
    rerender(<TrackerPage services={services} ownerId={owner2} onSignOut={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { name: 'Owner2 Project 5' }).length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('heading', { name: 'Project B5' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Owner2 Project 5' }).length).toBeGreaterThan(0);
  });
});

/**
 * HAM3-008 Correction 8 — the remaining rows of the mandated transition matrix not already
 * exercised (unchanged) by the existing suite above: "save first draft, edit newer text without
 * saving" is the existing Correction 4 F2b delayed-success test; "Cancel/reopen same task while
 * save pending" is the existing Correction 6 reopen test; "Save-all across Studio/task/comment
 * with partial failure" is the existing Correction 4 F2a partial-success test — all three continue
 * to pass unmodified against the coordinator (see the full run in the Correction 8 report). The
 * tests below cover the rows that genuinely need NEW coverage: failure-then-success ordering,
 * total failure, duplicate-request dedup, a brand-new task's overlapping creates, queued-save
 * cancellation, cross-task busy-state isolation, an old-owner queued (not just in-flight) save,
 * and a same-task save/archive race.
 */
describe('Correction 8 — remaining per-task save coordinator matrix rows', () => {
  it('v1 fails, v2 succeeds: the failure does not poison the queue (v2 still dispatches and settles), confirmed ends on v2, and no stale error from v1 ever flashes once a newer attempt is already on its way to superseding it', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Task Alpha' });
    const taskB = task({ id: 'task-b', project_id: 'project-a', title: 'Task Bravo' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [taskA, taskB] } });
    const resolvers: Array<{ resolve: (task: Task) => void; reject: (error: Error) => void }> = [];
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Task>((resolve, reject) => {
          resolvers.push({ resolve, reject });
        }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Task Alpha/ }));

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Task Bravo/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);

    resolvers[0].reject(new Error('v1 rejected'));
    // v1's own rejection never surfaces here — v2 is already on its way to superseding it.
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(2));
    expect(services.repositories.tasks.update).toHaveBeenNthCalledWith(
      2,
      'task-a',
      expect.objectContaining({ title: 'v2' }),
    );
    expect(screen.queryByText('v1 rejected')).not.toBeInTheDocument();

    resolvers[1].resolve({ ...taskA, title: 'v2' });
    await waitFor(() => expect(screen.getByRole('button', { name: /^v2/ })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText('Task title')).toHaveValue('Task Bravo'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('v1 rejected')).not.toBeInTheDocument();
  });

  it('both v1 and v2 fail: confirmed stays at the ORIGINAL pre-edit value — never either failed attempt — and the exact latest draft (v2) remains protected/retryable throughout', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Original title' });
    const taskB = task({ id: 'task-b', project_id: 'project-a', title: 'Task Bravo' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [taskA, taskB] } });
    const rejecters: Array<(error: Error) => void> = [];
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Task>((_resolve, reject) => {
          rejecters.push(reject);
        }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Task Bravo/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);

    rejecters[0](new Error('v1 rejected'));
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(2));
    rejecters[1](new Error('v2 rejected'));

    await waitFor(() => expect(screen.getAllByText('v2 rejected').length).toBeGreaterThan(0));
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
    // The exact latest draft is untouched — still "v2", not lost, reverted, or half-applied.
    expect(screen.getByLabelText('Task title')).toHaveValue('v2');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Neither failed attempt was ever confirmed — the row reveals the ORIGINAL value.
    expect(await screen.findByRole('button', { name: /^Original title/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^v1/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^v2/ })).not.toBeInTheDocument();
  });

  it('a resubmit of the EXACT same still-unsaved snapshot (no further edit) while the first save is held shares its pending result instead of issuing a duplicate write', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Task Alpha' });
    const taskB = task({ id: 'task-b', project_id: 'project-a', title: 'Task Bravo' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [taskA, taskB] } });
    let resolveSave!: (task: Task) => void;
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Task>((resolve) => {
          resolveSave = resolve;
        }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Task Alpha/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));

    // Trigger the guard WITHOUT any further edit — still the exact "v1" snapshot the form's own
    // Save already dispatched (the guard still fires: the draft remains dirty against the
    // ORIGINAL pre-edit baseline, which the still-pending save has not yet cleared).
    fireEvent.click(screen.getByRole('button', { name: /^Task Bravo/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Still exactly ONE request — the resubmit shared the already-pending one.
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);

    resolveSave({ ...taskA, title: 'v1' });
    await waitFor(() => expect(screen.getByLabelText('Task title')).toHaveValue('Task Bravo'));
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a brand-new task: overlapping explicit saves before it is ever durably created issue exactly ONE create, and the queued second save becomes an update against the real durable id once it exists — no orphaned or duplicated draft', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const otherTask = task({ id: 'other-task', project_id: 'project-a', title: 'Other task' });
    const { services } = makeServices([projectA], {
      tasksByProject: { 'project-a': [otherTask] },
    });
    let resolveCreate!: (task: Task) => void;
    (services.repositories.tasks.create as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Task>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string, patch: Record<string, unknown>) =>
        Promise.resolve({ ...otherTask, ...patch, id, project_id: 'project-a' } as Task),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(services.repositories.tasks.create).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Other task/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    // The second save must not begin until the create settles — still exactly one create, zero
    // updates, no matter how long we wait.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.create).toHaveBeenCalledTimes(1);
    expect(services.repositories.tasks.update).not.toHaveBeenCalled();

    resolveCreate({ ...otherTask, id: 'new-task-real-id', title: 'v1', parent_task_id: null });
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));
    expect(services.repositories.tasks.update).toHaveBeenCalledWith(
      'new-task-real-id',
      expect.objectContaining({ title: 'v2' }),
    );
    // Still exactly one create — the queued save became an update, never a second create.
    expect(services.repositories.tasks.create).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(screen.getByLabelText('Task title')).toHaveValue('Other task'));
    expect(screen.getByRole('button', { name: /^v2/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^v1/ })).not.toBeInTheDocument();
  });

  it('Discard mid-flight (via the Unsaved-changes guard) while a QUEUED (already explicitly requested, not yet dispatched) save is still waiting behind an earlier held one drops the queued request outright — it never reaches the repository — while the earlier, already-sent request still finishes durably', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Original title' });
    const taskB = task({ id: 'task-b', project_id: 'project-a', title: 'Task Bravo' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [taskA, taskB] } });
    let resolveV1!: (task: Task) => void;
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Task>((resolve) => {
          resolveV1 = resolve;
        }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Task Bravo/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    // Explicitly request v2 — it queues behind the still-held v1.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);

    // Before v1 ever settles, Discard the whole guard mid-flight instead of waiting for Save-all.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));
    expect(await screen.findByLabelText('Task title')).toHaveValue('Task Bravo');

    // Give the now-cancelled queued v2 every chance to wrongly fire anyway, then prove it never did.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);

    // v1 — already sent before any of this happened — still finishes durably, reconciled into
    // the row; the cancelled v2 never dispatches even now that v1's slot has freed up.
    resolveV1({ ...taskA, title: 'v1' });
    await waitFor(() => expect(screen.getByRole('button', { name: /^v1/ })).toBeInTheDocument());
    expect(screen.getByLabelText('Task title')).toHaveValue('Task Bravo');
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /^v2/ })).not.toBeInTheDocument();
  });

  it('opening a DIFFERENT task while an earlier one is still saving never inherits its busy state: the freshly opened editor never shows "Saving…" before its OWN save is ever invoked', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Task Alpha' });
    const taskB = task({ id: 'task-b', project_id: 'project-a', title: 'Task Bravo' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [taskA, taskB] } });
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Task>(() => {}),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Task Alpha/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'A-v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await screen.findByRole('button', { name: 'Saving…' });

    // Abandon task A's editor (its own Cancel — not a Save-all) while its save is still held,
    // then open a completely different, clean task.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Task Bravo/ }));

    // Task B's own editor must show its OWN idle Save label, never a busy state it never entered
    // (A's stale in-flight save must never disable/relabel a completely different task's editor).
    expect(screen.getByRole('button', { name: 'Save task' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument();
  });

  it("an owner change with an in-flight AND a QUEUED save for the same old-owner task: the queued one is cancelled outright (never dispatched, even once the in-flight one later settles), and nothing leaks into the new owner's UI", async () => {
    const owner1 = 'owner-real-20';
    const owner2 = 'owner-real-21';
    const projectA = project({ id: 'project-a20', owner_id: owner1, name: 'Project A20' });
    const projectC = project({ id: 'project-c20', owner_id: owner2, name: 'Owner2 Project 20' });
    const existingTask = task({ id: 'existing-task-20', project_id: 'project-a20', title: 'Original title 20' });
    const otherTask = task({ id: 'other-task-20', project_id: 'project-a20', title: 'Other task 20' });
    const { services } = makeServices([projectA, projectC], {
      tasksByProject: { 'project-a20': [existingTask, otherTask] },
    });
    const listSpy = vi.fn();
    listSpy.mockResolvedValueOnce([projectA]).mockResolvedValueOnce([projectC]);
    services.repositories.projects.list = listSpy as unknown as typeof services.repositories.projects.list;

    let resolveV1!: (task: Task) => void;
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Task>((resolve) => {
          resolveV1 = resolve;
        }),
    );

    const { rerender } = render(<TrackerPage services={services} ownerId={owner1} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Original title 20/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Other task 20/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);

    // Owner changes while v1 is in flight and v2 is queued behind it, with the guard's own
    // Save-all `Promise.all` still pending.
    rerender(<TrackerPage services={services} ownerId={owner2} onSignOut={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Owner2 Project 20' })).toHaveClass('project-nav-item-active'),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // The old, already-sent v1 finally settles — under the now-abandoned old-owner coordinator
    // instance. The queued v2 must never dispatch as a result: still exactly one `update` call
    // ever, and nothing resurrects the old owner's project/dialog under the new owner.
    resolveV1({ ...existingTask, title: 'v1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Project A20' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Owner2 Project 20' })).toHaveClass('project-nav-item-active');
  });

  it('archiving a task while an edit-form save for that SAME task is still in flight serializes behind it: the archive does not dispatch until the save settles, and the final state is correctly archived — a stale save response cannot leave the row looking un-archived', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Task Alpha' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [taskA] } });
    let resolveSave!: (task: Task) => void;
    let archiveCalled = false;
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Task>((resolve) => {
          resolveSave = resolve;
        }),
    );
    (services.repositories.tasks.archive as ReturnType<typeof vi.fn>).mockImplementation(() => {
      archiveCalled = true;
      return Promise.resolve([{ ...taskA, archived_at: '2026-09-06T12:00:00.000Z' }]);
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    // "Show archived" is on from the start so the archived row stays visible (with its own
    // "Archived" badge) throughout, instead of disappearing the moment the archive applies.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show archived' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Task Alpha/ }));
    // Captured before the edit below changes the outliner row's own accessible name.
    const outlinerRow = screen.getByRole('button', { name: /^Task Alpha/ }).closest('li')!;
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'edited while saving' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));

    // Archive the SAME task from the outliner while its own edit-form save is still held — the
    // archive must not dispatch until the save settles (same per-task coordinator queue). Scoped
    // to the task's own outliner row: the project detail card has its own, identically-labeled
    // "Archive" button elsewhere on the page.
    fireEvent.click(within(outlinerRow).getByRole('button', { name: 'Archive' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(archiveCalled).toBe(false);

    resolveSave({ ...taskA, title: 'edited while saving' });
    await waitFor(() => expect(archiveCalled).toBe(true));
    await waitFor(() => expect(within(outlinerRow).getByText('Archived')).toBeInTheDocument());
  });
});

/**
 * HAM3-008 Correction 9 — DeepSeek's round-7 independent audit (PR #10) confirmed the round-6
 * residual CLOSED but found two new, narrower residuals in Correction 8's own coordinator:
 *
 * Finding 1 (Medium): `durableIds` (draft key -> real id, learned from a create's own response)
 * was consulted only for the dispatch context and `getConfirmedForKey` — never by `submit`,
 * `hasPending`, or `cancelQueued`. A caller who only ever learns of a just-created task's REAL id
 * (the outliner, once `saveTask`'s continuation rewrites the row's `id`) could open a SECOND,
 * independent queue under that real id while the FIRST queue — still holding a genuinely queued
 * update issued against the original draft id before the create resolved — was still draining. Two
 * requests for one logical task could then be in flight/queued at once.
 *
 * Finding 2 (Low): `cancelTaskEditor`'s `cancelQueued(selectedTaskId)` dropped EVERY queued entry
 * for that key, including an independently requested outliner move/archive queued behind an
 * in-flight form save — not just the discarded draft the doc comment describes.
 *
 * Fixed in `src/tracker/taskSaveCoordinator.ts`: every `queues`/`inFlight` operation now resolves
 * its key through a real-id/draft-id alias map before touching state (Finding 1), and each queued
 * entry is tagged with who submitted it (`'editor'` vs `'outliner'`) so `cancelQueued` can scope
 * its drop to one owner (Finding 2). `moveTask`/`archiveTask` (`src/tracker/TrackerPage.tsx`) also
 * now resolve their target id through the coordinator's `durableId` dispatch context rather than a
 * closed-over `task.id`, so an action requested on a still-synthetic row defers correctly behind
 * its pending create instead of sending a `draft-task-…` id to a durable repository call.
 */
describe('Correction 9 — canonical queue identity (F1) and scoped cancellation (F2)', () => {
  it('F1 exact repro (archive): a second edit queued under the draft key while Create is in flight, then Cancelling the guard and Archiving the now-real-id row from the outliner — the archive queues behind the still-in-flight draft-keyed update rather than opening a second, independent queue, and the final state is correctly archived (never left looking un-archived by a later stale response)', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const otherTask = task({ id: 'other-task', project_id: 'project-a', title: 'Other task' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [otherTask] } });
    let resolveCreate!: (task: Task) => void;
    (services.repositories.tasks.create as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Task>((resolve) => { resolveCreate = resolve; }),
    );
    let resolveV2!: (task: Task) => void;
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Task>((resolve) => { resolveV2 = resolve; }),
    );
    let archiveCalled = false;
    (services.repositories.tasks.archive as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      archiveCalled = true;
      return Promise.resolve([{ ...otherTask, id, title: 'v2', archived_at: '2026-09-07T00:00:00.000Z' }]);
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show archived' }));

    // 1. New task; Create stays in flight.
    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(services.repositories.tasks.create).toHaveBeenCalledTimes(1));

    // 2. Edit v2, click another task, choose guard Save changes — v2 queues under the draft key.
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Other task/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.update).not.toHaveBeenCalled();

    // 3. Create succeeds, maps to the real id, starts the queued v2 update; hold v2's own response.
    resolveCreate({ ...otherTask, id: 'new-task-real-id', title: 'v1', parent_task_id: null });
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));
    expect(services.repositories.tasks.update).toHaveBeenCalledWith(
      'new-task-real-id',
      expect.objectContaining({ title: 'v2' }),
    );

    // 4. Cancel the navigation guard; the outliner now displays the real-id row.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const outlinerRow = screen.getByRole('button', { name: /^v1/ }).closest('li')!;

    // 5. Archive that row. It must NOT dispatch immediately under the real id — v2 (sharing the
    // same canonical queue via the coordinator's alias) is still in flight.
    fireEvent.click(within(outlinerRow).getByRole('button', { name: 'Archive' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(archiveCalled).toBe(false);

    // Settling v2 lets the archive dispatch next, against the real id it produced.
    resolveV2({ ...otherTask, id: 'new-task-real-id', title: 'v2', parent_task_id: null });
    await waitFor(() => expect(archiveCalled).toBe(true));
    expect(services.repositories.tasks.archive).toHaveBeenCalledWith('new-task-real-id');
    await waitFor(() => {
      const row = screen.getByRole('button', { name: /^v2/ }).closest('li')!;
      expect(within(row).getByText('Archived')).toBeInTheDocument();
    });
  });

  it('F1 exact repro (move): the same sequence, but the outliner action is a status Move instead of Archive — it also queues behind the still-in-flight draft-keyed v2 update rather than opening a second, independent queue', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const otherTask = task({ id: 'other-task', project_id: 'project-a', title: 'Other task' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [otherTask] } });
    let resolveCreate!: (task: Task) => void;
    (services.repositories.tasks.create as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Task>((resolve) => { resolveCreate = resolve; }),
    );
    const updateResolvers: Array<(task: Task) => void> = [];
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Task>((resolve) => { updateResolvers.push(resolve); }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));

    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(services.repositories.tasks.create).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Other task/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.update).not.toHaveBeenCalled();

    resolveCreate({ ...otherTask, id: 'new-task-real-id', title: 'v1', parent_task_id: null });
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Move v1'), { target: { value: 'done' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Still exactly ONE update call — the queued v2 save. The move must not have opened an
    // independent second queue under the real id and dispatched immediately.
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);

    updateResolvers[0]({ ...otherTask, id: 'new-task-real-id', title: 'v2', parent_task_id: null });
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(2));
    expect(services.repositories.tasks.update).toHaveBeenNthCalledWith(2, 'new-task-real-id', { status: 'done' });

    updateResolvers[1]({ ...otherTask, id: 'new-task-real-id', title: 'v2', status: 'done', parent_task_id: null });
    await waitFor(() => {
      const row = screen.getByRole('button', { name: /^v2/ }).closest('li')!;
      expect(row.textContent).toContain('Done');
    });
  });

  it('F1 (pending create, synthetic-row Archive, successful create): archiving a brand-new task before its create ever settles defers behind the create and targets the REAL id the create produces — never the synthetic draft id', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [] } });
    let resolveCreate!: (task: Task) => void;
    (services.repositories.tasks.create as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Task>((resolve) => { resolveCreate = resolve; }),
    );
    let archiveCalled = false;
    (services.repositories.tasks.archive as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      archiveCalled = true;
      return Promise.resolve([{ owner_id: ownerId, id, project_id: 'project-a', title: 'v1', description: '', status: 'backlog' as const, priority: 0, parent_task_id: null, due_at: null, archived_at: '2026-09-07T00:00:00.000Z', created_at: '2026-08-13T08:00:00.000Z', updated_at: '2026-08-13T08:00:00.000Z' }]);
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show archived' }));

    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(services.repositories.tasks.create).toHaveBeenCalledTimes(1));

    // Archive the still-synthetic row immediately — before the create has ever settled.
    const outlinerRow = screen.getByRole('button', { name: /^v1/ }).closest('li')!;
    fireEvent.click(within(outlinerRow).getByRole('button', { name: 'Archive' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(archiveCalled).toBe(false);
    expect(services.repositories.tasks.archive).not.toHaveBeenCalledWith(expect.stringMatching(/^draft-task-/));

    resolveCreate({ owner_id: ownerId, id: 'new-task-real-id', project_id: 'project-a', title: 'v1', description: '', status: 'backlog', priority: 0, parent_task_id: null, due_at: null, archived_at: null, created_at: '2026-08-13T08:00:00.000Z', updated_at: '2026-08-13T08:00:00.000Z' });
    await waitFor(() => expect(archiveCalled).toBe(true));
    expect(services.repositories.tasks.archive).toHaveBeenCalledWith('new-task-real-id');
    expect(services.repositories.tasks.create).toHaveBeenCalledTimes(1);
  });

  it('F1 (pending create, synthetic-row Archive, FAILED create): with no durable id ever assigned, the queued archive fails truthfully once the create rejects — it never sends the synthetic draft id to the repository, and never triggers a second create', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [] } });
    let rejectCreate!: (error: Error) => void;
    (services.repositories.tasks.create as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Task>((_resolve, reject) => { rejectCreate = reject; }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show archived' }));

    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(services.repositories.tasks.create).toHaveBeenCalledTimes(1));

    const outlinerRow = screen.getByRole('button', { name: /^v1/ }).closest('li')!;
    fireEvent.click(within(outlinerRow).getByRole('button', { name: 'Archive' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.archive).not.toHaveBeenCalled();

    rejectCreate(new Error('create blew up'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The queued archive now dispatches — but no durable id was ever assigned, so it must fail
    // truthfully instead of sending the synthetic `draft-task-…` id to the repository, and it must
    // never itself retry the create (no duplicate, no second `create` call).
    expect(services.repositories.tasks.archive).not.toHaveBeenCalled();
    expect(services.repositories.tasks.create).toHaveBeenCalledTimes(1);
  });

  it("F2 (move): the editor's own explicit Cancel drops only its own unsent form draft — an independently queued outliner Move for the SAME task survives, and dispatches once the in-flight save ahead of it settles", async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Task Alpha', status: 'backlog' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [taskA] } });
    const resolvers: Array<(task: Task) => void> = [];
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Task>((resolve) => { resolvers.push(resolve); }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Task Alpha/ }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));

    // An independent outliner status Move on the SAME task, requested while the form's own Save is
    // still held — it queues (owner 'outliner') behind the in-flight save (owner 'editor').
    fireEvent.change(screen.getByLabelText('Move v1'), { target: { value: 'done' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1);

    // The editor's own explicit Cancel (HAM3-008 Correction 9): must drop only its OWN unsent
    // work, never the independently queued move.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    resolvers[0]({ ...taskA, title: 'v1' });
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(2));
    expect(services.repositories.tasks.update).toHaveBeenNthCalledWith(2, 'task-a', { status: 'done' });

    resolvers[1]({ ...taskA, title: 'v1', status: 'done' });
    await waitFor(() => {
      const row = screen.getByRole('button', { name: /^v1/ }).closest('li')!;
      expect(row.textContent).toContain('Done');
    });
  });

  it("F2 (archive): the editor's own explicit Cancel drops only its own unsent form draft — an independently queued outliner Archive for the SAME task survives, and dispatches once the in-flight save ahead of it settles", async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Task Alpha' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [taskA] } });
    let resolveSave!: (task: Task) => void;
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Task>((resolve) => { resolveSave = resolve; }),
    );
    let archiveCalled = false;
    (services.repositories.tasks.archive as ReturnType<typeof vi.fn>).mockImplementation(() => {
      archiveCalled = true;
      return Promise.resolve([{ ...taskA, title: 'v1', archived_at: '2026-09-07T00:00:00.000Z' }]);
    });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show archived' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Task Alpha/ }));
    const outlinerRow = screen.getByRole('button', { name: /^Task Alpha/ }).closest('li')!;
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));

    // An independent outliner Archive on the SAME task, requested while the form's own Save is
    // still held — it queues (owner 'outliner') behind the in-flight save (owner 'editor').
    fireEvent.click(within(outlinerRow).getByRole('button', { name: 'Archive' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(archiveCalled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    resolveSave({ ...taskA, title: 'v1' });
    await waitFor(() => expect(archiveCalled).toBe(true));
    await waitFor(() => expect(within(outlinerRow).getByText('Archived')).toBeInTheDocument());
  });

  it('F2 combined with a create-to-real transition: Discard drops the queued SECOND editor draft (v2) but the independently queued outliner Archive requested on the same still-synthetic row survives, and eventually dispatches against the REAL id once the create settles — the discarded v2 snapshot never reaches the repository', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const otherTask = task({ id: 'other-task', project_id: 'project-a', title: 'Other task' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [otherTask] } });
    let resolveCreate!: (task: Task) => void;
    (services.repositories.tasks.create as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Task>((resolve) => { resolveCreate = resolve; }),
    );
    (services.repositories.tasks.archive as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      Promise.resolve([{ ...otherTask, id, title: 'v1', archived_at: '2026-09-07T00:00:00.000Z' }]),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show archived' }));

    // New task; Create stays in flight.
    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(services.repositories.tasks.create).toHaveBeenCalledTimes(1));

    // A second explicit save (v2), requested via the guard while the create is still held, queues
    // (owner 'editor') behind it under the SAME draft key.
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Other task/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.update).not.toHaveBeenCalled();

    // Dismiss the guard without deciding ("stay here") — the editor and its queued v2 draft are
    // untouched by this; the navigation-decision Cancel is distinct from an explicit draft discard.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // An independent outliner Archive on this SAME (still-synthetic) row queues a THIRD entry
    // (owner 'outliner') behind v2 — the very same logical task's one canonical queue.
    const outlinerRow = screen.getByRole('button', { name: /^v2/ }).closest('li')!;
    fireEvent.click(within(outlinerRow).getByRole('button', { name: 'Archive' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.archive).not.toHaveBeenCalled();

    // The editor's own explicit Cancel/Discard must drop only ITS unsent v2 draft — never the
    // independently queued archive behind it (HAM3-008 Correction 9, Finding 2).
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // The create itself finally settles, establishing the real id and letting the queue drain.
    resolveCreate({ ...otherTask, id: 'new-task-real-id', title: 'v1', parent_task_id: null });

    // v2 was cancelled while still queued: it never reaches the repository.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.update).not.toHaveBeenCalled();

    // The independently queued archive survives, dispatches against the REAL id the create
    // produced (never the synthetic draft id), and its result is what ends up rendered.
    await waitFor(() => expect(services.repositories.tasks.archive).toHaveBeenCalledTimes(1));
    expect(services.repositories.tasks.archive).toHaveBeenCalledWith('new-task-real-id');
    await waitFor(() => {
      const row = screen.getByRole('button', { name: /^v1/ }).closest('li')!;
      expect(within(row).getByText('Archived')).toBeInTheDocument();
    });
  });
});

describe('Correction 10 — synthetic-row Move display reconciles by real id; Retry normalizes a stale synthetic id', () => {
  const realTask = (overrides: Partial<Task> & Pick<Task, 'id' | 'project_id'>): Task => ({
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
  });

  it('A. SUCCESS: an outliner Move issued on a still-synthetic row is reconciled and rendered by the REAL id once its pending create durably completes — never silently dropped by the vanished draft id captured at click time', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [] } });
    let resolveCreate!: (task: Task) => void;
    (services.repositories.tasks.create as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Task>((resolve) => { resolveCreate = resolve; }),
    );
    let resolveMove!: (task: Task) => void;
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Task>((resolve) => { resolveMove = resolve; }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));

    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(services.repositories.tasks.create).toHaveBeenCalledTimes(1));

    // The row is still synthetic (its create has not settled) at the moment the outliner Move is
    // issued — this is the exact repro: capturing the draft id here is the bug.
    const moveSelect = screen.getByLabelText('Move v1') as HTMLSelectElement;
    expect(moveSelect.value).toBe('backlog');
    fireEvent.change(moveSelect, { target: { value: 'done' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The move queues behind the still-in-flight create; nothing dispatched yet.
    expect(services.repositories.tasks.update).not.toHaveBeenCalled();

    resolveCreate(realTask({ id: 'new-task-real-id', project_id: 'project-a', title: 'v1' }));

    // The queued move dispatches against the REAL id the create produced, with the requested
    // status — never a bogus request against the synthetic draft id.
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));
    expect(services.repositories.tasks.update).toHaveBeenCalledWith('new-task-real-id', { status: 'done' });
    expect(services.repositories.tasks.create).toHaveBeenCalledTimes(1);
    expect(services.repositories.tasks.update).not.toHaveBeenCalledWith(
      expect.stringMatching(/^draft-task-/),
      expect.anything(),
    );

    resolveMove(realTask({ id: 'new-task-real-id', project_id: 'project-a', title: 'v1', status: 'done' }));

    // The persisted status update must be reflected in the RENDERED row/select without a reload.
    // At baseline (captured-id-only reconciliation) this select stays stuck on 'backlog' forever —
    // the successful response never matches the vanished synthetic id in the rendered collection.
    await waitFor(() => {
      const select = screen.getByLabelText('Move v1') as HTMLSelectElement;
      expect(select.value).toBe('done');
    });
    const row = screen.getByRole('button', { name: /^v1/ }).closest('li')!;
    expect(row.textContent).toContain('Done');
  });

  it('B. FAILURE THEN RETRY: a failed outliner Move on a since-durable row lets Retry dispatch a second update against the CURRENT real id with the originally-requested status — never a no-op against the vanished synthetic id', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [] } });
    let resolveCreate!: (task: Task) => void;
    (services.repositories.tasks.create as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Task>((resolve) => { resolveCreate = resolve; }),
    );
    const updateResolvers: Array<(task: Task) => void> = [];
    const updateRejecters: Array<(error: Error) => void> = [];
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Task>((resolve, reject) => {
          updateResolvers.push(resolve);
          updateRejecters.push(reject);
        }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));

    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(services.repositories.tasks.create).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Move v1'), { target: { value: 'done' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.update).not.toHaveBeenCalled();

    resolveCreate(realTask({ id: 'new-task-real-id', project_id: 'project-a', title: 'v1' }));
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));
    expect(services.repositories.tasks.update).toHaveBeenNthCalledWith(1, 'new-task-real-id', { status: 'done' });

    updateRejecters[0](new Error('move blew up'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('move blew up');
    const retryButton = within(alert).getByRole('button', { name: 'Retry save' });

    fireEvent.click(retryButton);

    // The Retry must issue a SECOND update against the REAL id with the originally-requested
    // status. At baseline, the retry target still names the vanished synthetic draft id, `tasks`
    // no longer contains it, and this click is a silent no-op — no second call is ever made.
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(2));
    expect(services.repositories.tasks.update).toHaveBeenNthCalledWith(2, 'new-task-real-id', { status: 'done' });

    updateResolvers[1](realTask({ id: 'new-task-real-id', project_id: 'project-a', title: 'v1', status: 'done' }));

    await waitFor(() => {
      const select = screen.getByLabelText('Move v1') as HTMLSelectElement;
      expect(select.value).toBe('done');
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('C. failed create with a queued Move sends no bogus id: with no durable id ever assigned, the queued move fails truthfully once the create rejects — never the synthetic draft id sent to the repository, and never a second create', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const { services } = makeServices([projectA], { tasksByProject: { 'project-a': [] } });
    let rejectCreate!: (error: Error) => void;
    (services.repositories.tasks.create as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Task>((_resolve, reject) => { rejectCreate = reject; }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));

    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(services.repositories.tasks.create).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Move v1'), { target: { value: 'done' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(services.repositories.tasks.update).not.toHaveBeenCalled();

    rejectCreate(new Error('create blew up'));

    // The still-open "New task" form and the outliner's shared error banner both surface the same
    // `taskSaveError`, so two identical alerts are expected here — assert at least one carries it.
    await waitFor(() => {
      const alerts = screen.getAllByRole('alert');
      expect(alerts.some((el) => el.textContent?.includes('never created'))).toBe(true);
    });
    expect(services.repositories.tasks.update).not.toHaveBeenCalled();
    expect(services.repositories.tasks.create).toHaveBeenCalledTimes(1);
  });

  it("C. moving Task A then switching to a different project while the move is held: the stale completion can never select A over the newer context, and can never clear/overwrite Project B's own newer retry/error state", async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const taskA = task({ id: 'task-a', project_id: 'project-a', title: 'Task Alpha', status: 'backlog' });
    const taskB = task({ id: 'task-b', project_id: 'project-b', title: 'Task Bravo', status: 'backlog' });
    const { services } = makeServices([projectA, projectB], {
      tasksByProject: { 'project-a': [taskA], 'project-b': [taskB] },
    });
    const resolvers: Array<{ id: string; resolve: (task: Task) => void; reject: (error: Error) => void }> = [];
    (services.repositories.tasks.update as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) =>
        new Promise<Task>((resolve, reject) => {
          resolvers.push({ id, resolve, reject });
        }),
    );

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));

    // Task A: an outliner Move held in flight.
    fireEvent.change(await screen.findByLabelText('Move Task Alpha'), { target: { value: 'done' } });
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(1));

    // Switching to Project B proceeds immediately — an outliner Move never dirties the guard.
    fireEvent.click(screen.getByRole('button', { name: 'Project B' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('heading', { name: 'Project B' }).length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: /^Task Bravo/ })).toBeInTheDocument();

    // Project B develops its own, strictly newer failure/retry state.
    fireEvent.change(screen.getByLabelText('Move Task Bravo'), { target: { value: 'done' } });
    await waitFor(() => expect(services.repositories.tasks.update).toHaveBeenCalledTimes(2));
    const bravoCall = resolvers.find((entry) => entry.id === 'task-b')!;
    bravoCall.reject(new Error('bravo blew up'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('bravo blew up');

    // Task A's stale, cross-project completion now resolves as a SUCCESS, after the switch.
    const alphaCall = resolvers.find((entry) => entry.id === 'task-a')!;
    alphaCall.resolve({ ...taskA, status: 'done' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Project B's own newer error/retry banner is completely untouched, and its list/selection are
    // never contaminated by task A's unrelated, stale, cross-project completion.
    expect(screen.getByRole('alert').textContent).toContain('bravo blew up');
    expect(screen.getByRole('button', { name: /^Task Bravo/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Task Alpha/ })).not.toBeInTheDocument();
  });
});

describe('TrackerPage Work orders integration', () => {
  it('shows an empty-state prompt until a task is selected, then records a real immutable dispatch through the wired WorkOrdersService', async () => {
    const existingTask = task({ id: 'task-1', project_id: project().id, title: 'Ship the feature' });
    const { services } = makeServices([project()], { tasksByProject: { [project().id]: [existingTask] } });

    render(<TrackerPage services={services} ownerId={ownerId} ownerEmail="owner@example.test" onSignOut={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Work orders' }));
    expect(screen.getByText('Select a task to prepare a work order.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Ship the feature/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Work orders' }));

    await screen.findByRole('region', { name: 'Work orders for Ship the feature' });
    expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.test');

    fireEvent.change(screen.getByLabelText('Repository path'), { target: { value: '/scratch/project' } });
    fireEvent.change(screen.getByLabelText('Work branch'), { target: { value: 'claude/task-1' } });
    fireEvent.change(screen.getByLabelText('Start SHA (exact, full)'), { target: { value: 'a'.repeat(40) } });
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'Scope.' } });
    fireEvent.change(screen.getByLabelText('Non-scope'), { target: { value: 'Non-scope.' } });
    fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: 'Acceptance.' } });
    fireEvent.change(screen.getByLabelText('Verification'), { target: { value: 'Verification.' } });
    fireEvent.change(screen.getByLabelText('Required return evidence'), { target: { value: 'Evidence.' } });
    fireEvent.change(screen.getByLabelText('Stop rules'), { target: { value: 'Stop rules.' } });
    for (const legend of ['Active orchestrator', 'Assigned worker', 'Assigned auditor (after delivery)']) {
      const group = screen.getByRole('group', { name: legend });
      fireEvent.change(within(group).getByLabelText('Model'), { target: { value: 'some-model' } });
    }
    const auditorGroup = screen.getByRole('group', { name: 'Assigned auditor (after delivery)' });
    fireEvent.change(within(auditorGroup).getByLabelText('Provider'), { target: { value: 'DeepSeek' } });
    for (const input of screen.getAllByPlaceholderText('Reason it is not available')) {
      fireEvent.change(input, { target: { value: 'not tracked by Hammond' } });
    }

    await waitFor(() => expect(screen.getByRole('button', { name: 'Record dispatch' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() => expect(screen.getByText('History (1)')).toBeInTheDocument());

    // Prove the dispatch actually went through the real, App-wired WorkOrdersService/local store —
    // not a test-local mock — by reading it back directly off the service.
    const [recorded] = await services.workOrders.listHistory(ownerId, 'task-1');
    expect(recorded.content).toContain('Scope.');
    expect(recorded.projectId).toBe(project().id);
  });

  it('an in-progress draft survives navigating away to Workspace and back', async () => {
    const existingTask = task({ id: 'task-1', project_id: project().id, title: 'Ship the feature' });
    const { services } = makeServices([project()], { tasksByProject: { [project().id]: [existingTask] } });

    render(<TrackerPage services={services} ownerId={ownerId} onSignOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Ship the feature/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Work orders' }));
    await screen.findByRole('region', { name: 'Work orders for Ship the feature' });

    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'Draft in progress.' } });
    await waitFor(() =>
      expect(services.workOrders.readDraft({ ownerId, projectId: project().id, taskId: 'task-1', stage: 'worker' })).resolves.not.toBeNull(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Work orders' }));
    await waitFor(() => expect(screen.getByLabelText('Scope')).toHaveValue('Draft in progress.'));
  });
});

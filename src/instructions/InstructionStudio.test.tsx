import { createRef } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { AssignmentsService } from '../assignments/service';
import { createFakeAssignmentRepository, seedProjectDefaults } from '../assignments/testFakes';
import { HarnessInjectionService } from '../harness/service';
import {
  createFakeHarnessAdapters,
  createFakeHarnessFilesystem,
  renderManagedDocumentText,
  seedManaged,
  seedUnmanaged,
  type FakeHarnessFilesystem,
} from '../harness/testFakes';
import { MANAGED_HEADER_FORMAT_VERSION } from '../harness/types';
import { InstructionStudio } from './InstructionStudio';
import type { InstructionStudioHandle } from './InstructionStudio';
import { InstructionsService } from './service';
import { createFakeInstructionRepository } from './testFakes';

const project = { id: 'project-1', name: 'Hammond project' };
const root = '/home/owner/project-1';
const FIXED_NOW = '2026-09-04T16:00:00.000Z';

function buildServices(fakeFs: FakeHarnessFilesystem = createFakeHarnessFilesystem()) {
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
    now: () => FIXED_NOW,
  });
  return { assignmentsService, instructionsService, harnessService, fakeFs };
}

type Services = ReturnType<typeof buildServices>;

function renderStudio(options: { services?: Services; directoryRoot?: string | null } = {}) {
  const services = options.services ?? buildServices();
  const ref = createRef<InstructionStudioHandle>();
  render(
    <InstructionStudio
      ref={ref}
      instructionsService={services.instructionsService}
      assignmentsService={services.assignmentsService}
      harnessService={services.harnessService}
      project={project}
      directoryRoot={options.directoryRoot === undefined ? root : options.directoryRoot}
    />,
  );
  return { ...services, ref };
}

function foreignHeader() {
  return {
    formatVersion: MANAGED_HEADER_FORMAT_VERSION,
    projectId: 'other-project',
    role: 'worker' as const,
    provider: 'claude_code' as const,
    sharedRoleVersionId: 'shared-v1',
    providerVersionId: 'provider-v1',
    overrideVersionId: null,
    generatedAt: FIXED_NOW,
  };
}

describe('InstructionStudio', () => {
  // -------------------------------------------------------------------
  // 1. Assignment/customization independence, project/role/provider/path
  // -------------------------------------------------------------------

  it('shows a role- and provider-specific heading, and switching roles never reassigns a provider', async () => {
    const { assignmentsService } = renderStudio();

    expect(
      await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator' }));

    expect(
      await screen.findByRole('heading', { name: 'Orchestrator instructions for Codex' }),
    ).toBeInTheDocument();
    const assignment = await assignmentsService.getAssignment({
      projectId: project.id,
      role: 'orchestrator',
    });
    expect(assignment?.provider).toBe('codex');
  });

  it('reads defaults, shows loading, and surfaces a load error with Retry', async () => {
    const services = buildServices();
    const original = services.instructionsService.getActiveLayerContents.bind(
      services.instructionsService,
    );
    let shouldFail = true;
    services.instructionsService.getActiveLayerContents = (async (params) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('network dropped');
      }
      return original(params);
    }) as typeof services.instructionsService.getActiveLayerContents;

    renderStudio({ services });

    await screen.findByText(/network dropped/);
    for (const button of screen.getAllByRole('button', { name: 'Retry' })) {
      fireEvent.click(button);
    }
    await waitFor(() => expect(screen.queryByText(/network dropped/)).not.toBeInTheDocument());
    expect(screen.getByLabelText('Effective instructions preview')).toBeInTheDocument();
  });

  it('reads instructions without a linked directory, explaining the missing directory only for local actions', async () => {
    renderStudio({ directoryRoot: null });

    expect(
      await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText('Effective instructions preview')).toBeInTheDocument();
    expect(screen.getByText(/Link a local directory/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Inject' })).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------
  // 2. Default -> Customize -> save -> effective preview, no duplication;
  //    failed save retains draft; restore creates a new active version.
  // -------------------------------------------------------------------

  it('composes shared + provider + override exactly once each, in order, and never copies inheritance into the stored override', async () => {
    const services = buildServices();
    await services.instructionsService.saveAndActivate({
      projectId: project.id,
      role: 'worker',
      provider: 'claude_code',
      layer: 'shared_role',
      content: 'SHARED-TEXT',
    });
    await services.instructionsService.saveAndActivate({
      projectId: project.id,
      role: 'worker',
      provider: 'claude_code',
      layer: 'provider',
      content: 'PROVIDER-TEXT',
    });

    renderStudio({ services });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    await screen.findByText(/Using default/);

    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    const inherited = screen.getByLabelText('Inherited defaults preview');
    expect(inherited).toHaveTextContent('SHARED-TEXT');
    expect(inherited).toHaveTextContent('PROVIDER-TEXT');

    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'OVERRIDE-TEXT' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText(/Saved · v1/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    const finalPreview = await screen.findByLabelText('Effective instructions preview');
    const text = finalPreview.textContent ?? '';
    expect((text.match(/SHARED-TEXT/g) ?? []).length).toBe(1);
    expect((text.match(/PROVIDER-TEXT/g) ?? []).length).toBe(1);
    expect((text.match(/OVERRIDE-TEXT/g) ?? []).length).toBe(1);
    expect(text.indexOf('SHARED-TEXT')).toBeLessThan(text.indexOf('PROVIDER-TEXT'));
    expect(text.indexOf('PROVIDER-TEXT')).toBeLessThan(text.indexOf('OVERRIDE-TEXT'));

    const overrideVersions = await services.instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project.id,
    });
    expect(overrideVersions[0].content).toBe('OVERRIDE-TEXT');
    expect(await screen.findByText(/Customized for this project · v1/)).toBeInTheDocument();
  });

  it('a failed save keeps the draft text and prior active state, with an actionable error, and a retry then succeeds', async () => {
    const services = buildServices();
    renderStudio({ services });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'will fail' },
    });

    const original = services.instructionsService.saveAndActivate.bind(
      services.instructionsService,
    );
    let shouldFail = true;
    services.instructionsService.saveAndActivate = (async (params) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('network dropped');
      }
      return original(params);
    }) as typeof services.instructionsService.saveAndActivate;

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('network dropped');
    expect(screen.getByLabelText('Project override content')).toHaveValue('will fail');
    expect(screen.queryByText(/Customized for this project/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText(/Saved · v1/)).toBeInTheDocument());
  });

  it('restoring a version creates a new active version with provenance and refreshes previews without any local write', async () => {
    const services = buildServices();
    await services.instructionsService.saveAndActivate({
      projectId: project.id,
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      content: 'v1 text',
    });
    // No directory linked at all: proves the restore path never touches the filesystem.
    renderStudio({ services, directoryRoot: null });
    await screen.findByText(/Customized for this project · v1/);

    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'v2 text' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText(/Saved · v2/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    const dialog = await screen.findByRole('dialog', { name: /Project override history/ });
    const v1Row = within(dialog).getByText(/^v1/).closest('li') as HTMLElement;
    fireEvent.click(within(v1Row).getByRole('button', { name: 'Restore this version' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Restoring refreshes the draft in place (still in Customize mode) without any local write.
    await waitFor(() =>
      expect(screen.getByLabelText('Project override content')).toHaveValue('v1 text'),
    );
    expect(screen.getByText(/Saved · v3/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.getByText(/Customized for this project · v3/)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    const dialog2 = await screen.findByRole('dialog');
    expect(within(dialog2).getByText(/restored from an earlier version/)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------
  // 3. Draft/task previews never persist or leak into injection; hostile
  //    Markdown/HTML/links cannot execute.
  // -------------------------------------------------------------------

  it('never leaks an unsaved draft override or the task-specific test text into Inject output or durable history', async () => {
    const services = buildServices();
    renderStudio({ services });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });

    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'UNSAVED DRAFT' },
    });
    fireEvent.change(screen.getByLabelText('Task-specific test text'), {
      target: { value: 'TASK ONLY TEXT' },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Task preview')).toHaveTextContent('TASK ONLY TEXT'),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Inject' }));
    await waitFor(() =>
      expect(services.fakeFs.targets.get(`${root}|claude_code`)?.header).toBeTruthy(),
    );

    const written = services.fakeFs.targets.get(`${root}|claude_code`)!.content ?? '';
    expect(written).not.toContain('UNSAVED DRAFT');
    expect(written).not.toContain('TASK ONLY TEXT');

    const overrideVersions = await services.instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project.id,
    });
    expect(overrideVersions).toHaveLength(0);

    // Saving the override (with task-preview text still present in its own separate box) must
    // persist only the override draft — never the task-specific text — into the durable version.
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText(/Saved · v1/)).toBeInTheDocument());
    const savedVersions = await services.instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project.id,
    });
    expect(savedVersions[0].content).toBe('UNSAVED DRAFT');
    expect(savedVersions[0].content).not.toContain('TASK ONLY TEXT');
  });

  it('sanitizes hostile Markdown/HTML in the effective, draft, and task previews', async () => {
    const services = buildServices();
    await services.instructionsService.saveAndActivate({
      projectId: project.id,
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      content: '<script>window.__pwned = true</script>\n\n[click](javascript:alert(1))',
    });
    renderStudio({ services });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });

    const preview = await screen.findByLabelText('Effective instructions preview');
    expect(preview.innerHTML).not.toContain('<script');
    expect(preview.querySelector('a')?.getAttribute('href') ?? null).not.toBe(
      'javascript:alert(1)',
    );
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();

    fireEvent.change(screen.getByLabelText('Task-specific test text'), {
      target: { value: '<img src=x onerror="window.__pwned2=true">' },
    });
    await waitFor(() => expect(screen.getByLabelText('Task preview')).toBeInTheDocument());
    expect(screen.getByLabelText('Task preview').innerHTML).not.toContain('onerror');
  });

  // -------------------------------------------------------------------
  // 4. Local-write failure preserves saved version; retry creates no
  //    extra version. Unmanaged / ManagedForeign, incl. import-then-fail.
  // -------------------------------------------------------------------

  it('a local write failure does not lose the saved version, and Retry rewrites the file without creating another version', async () => {
    const fakeFs = createFakeHarnessFilesystem();
    const services = buildServices(fakeFs);
    await services.instructionsService.saveAndActivate({
      projectId: project.id,
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      content: 'stable content',
    });
    let failNext = true;
    const inject = services.harnessService.inject.bind(services.harnessService);
    services.harnessService.inject = (async (params) => {
      if (failNext) {
        failNext = false;
        throw new Error('disk full');
      }
      return inject(params);
    }) as typeof services.harnessService.inject;

    renderStudio({ services });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });

    fireEvent.click(await screen.findByRole('button', { name: 'Inject' }));
    await screen.findByText('disk full');

    const versionsBefore = await services.instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project.id,
    });
    expect(versionsBefore).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Hammond-managed')).toBeInTheDocument());

    const versionsAfter = await services.instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project.id,
    });
    expect(versionsAfter).toHaveLength(1);
  });

  it('offers Import/Replace/Cancel for an Unmanaged target and never writes without an explicit choice', async () => {
    const fakeFs = createFakeHarnessFilesystem();
    seedUnmanaged(fakeFs, root, 'claude_code', '# hand-written notes');
    renderStudio({ services: buildServices(fakeFs) });

    await screen.findByText(/Unmanaged/);
    expect(screen.getByRole('button', { name: 'Import existing content' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fakeFs.targets.get(`${root}|claude_code`)?.content).toBe('# hand-written notes');
  });

  it('shows a distinct ManagedForeign conflict, never offers Import, and Replace overwrites it explicitly', async () => {
    const fakeFs = createFakeHarnessFilesystem();
    const foreign = foreignHeader();
    seedManaged(fakeFs, root, 'claude_code', foreign, 'foreign content');
    renderStudio({ services: buildServices(fakeFs) });

    await screen.findByText(/Belongs to a different project or role/);
    expect(
      screen.queryByRole('button', { name: 'Import existing content' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(screen.getByText('Hammond-managed')).toBeInTheDocument());
  });

  it('preserves the imported version on a local write failure and never duplicates the import on Retry', async () => {
    const fakeFs = createFakeHarnessFilesystem();
    seedUnmanaged(fakeFs, root, 'claude_code', '# hand-written notes');
    const assignmentRepo = createFakeAssignmentRepository();
    seedProjectDefaults(assignmentRepo.store, project.id, 'owner-1');
    const assignmentsService = new AssignmentsService(assignmentRepo);
    const instructionsService = new InstructionsService(createFakeInstructionRepository());
    const adapters = createFakeHarnessAdapters(fakeFs, root);
    let failNext = true;
    const flakyAdapters = {
      ...adapters,
      claude_code: {
        ...adapters.claude_code,
        async inject(...args: Parameters<(typeof adapters)['claude_code']['inject']>) {
          if (failNext) {
            failNext = false;
            throw new Error('disk full during import');
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
        async readTextFile(fsRoot: string) {
          const target = fakeFs.targets.get(`${fsRoot}|claude_code`);
          if (!target || target.content === null) throw new Error('not found');
          return target.content;
        },
      },
      now: () => FIXED_NOW,
    });

    renderStudio({ services: { assignmentsService, instructionsService, harnessService, fakeFs } });
    fireEvent.click(await screen.findByRole('button', { name: 'Import existing content' }));

    await screen.findByText('disk full during import');
    const versionsAfterFailure = await instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project.id,
    });
    expect(versionsAfterFailure).toHaveLength(1); // the import's cloud save survived the local failure
    expect(versionsAfterFailure[0].content).toBe('# hand-written notes');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Hammond-managed')).toBeInTheDocument());

    const versionsAfterRetry = await instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project.id,
    });
    expect(versionsAfterRetry).toHaveLength(1); // retry did not re-import / duplicate
  });

  // -------------------------------------------------------------------
  // 5. Dirty-navigation Save/Discard/Cancel; overlapping/out-of-order
  //    async; stale retries after a context switch.
  // -------------------------------------------------------------------

  it('guards a role switch with unsaved edits: Cancel stays, Discard proceeds and drops the draft', async () => {
    renderStudio();
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'dirty edit' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(
      screen.getByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Project override content')).toHaveValue('dirty edit');

    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /Orchestrator instructions/ }),
      ).toBeInTheDocument(),
    );
  });

  it('guards a role switch with unsaved edits: Save persists the draft before switching', async () => {
    const services = buildServices();
    renderStudio({ services });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'save me' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /Orchestrator instructions/ }),
      ).toBeInTheDocument(),
    );
    const versions = await services.instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project.id,
    });
    expect(versions).toHaveLength(1);
    expect(versions[0].content).toBe('save me');
  });

  it('clears a failed action and its Retry when the role changes, so a stale retry can never fire against the old role', async () => {
    const fakeFs = createFakeHarnessFilesystem();
    const services = buildServices(fakeFs);
    const inject = services.harnessService.inject.bind(services.harnessService);
    services.harnessService.inject = (async (params) => {
      if (params.role === 'worker') throw new Error('worker inject failed');
      return inject(params);
    }) as typeof services.harnessService.inject;

    renderStudio({ services });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Inject' }));
    await screen.findByText('worker inject failed');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator' }));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /Orchestrator instructions/ }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('worker inject failed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('never lets an out-of-order effective-instructions load overwrite the currently selected role', async () => {
    const services = buildServices();
    await services.instructionsService.saveAndActivate({
      projectId: project.id,
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      content: 'WORKER TEXT',
    });
    await services.instructionsService.saveAndActivate({
      projectId: project.id,
      role: 'orchestrator',
      provider: 'codex',
      layer: 'project_override',
      content: 'ORCHESTRATOR TEXT',
    });

    // Gate every Worker-role load (there are several concurrent call sites — loadEffective, the
    // task preview, and the harness preview — and any one of them could otherwise slip through
    // unblocked while a different call site claims to be "the first"); every Orchestrator-role
    // call proceeds immediately.
    const original = services.instructionsService.getActiveLayerContents.bind(
      services.instructionsService,
    );
    let workerGateArmed = false;
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    services.instructionsService.getActiveLayerContents = (async (params) => {
      if (params.role === 'worker') {
        workerGateArmed = true;
        await workerGate;
      }
      return original(params);
    }) as typeof services.instructionsService.getActiveLayerContents;

    renderStudio({ services });
    await waitFor(() => expect(workerGateArmed).toBe(true));

    fireEvent.click(await screen.findByRole('button', { name: 'Orchestrator' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Effective instructions preview')).toHaveTextContent(
        'ORCHESTRATOR TEXT',
      ),
    );

    // Only now does the stale Worker load resolve, well after Orchestrator's own load completed.
    releaseWorker();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByLabelText('Effective instructions preview')).toHaveTextContent(
      'ORCHESTRATOR TEXT',
    );
    expect(screen.getByLabelText('Effective instructions preview')).not.toHaveTextContent(
      'WORKER TEXT',
    );
  });

  it('exposes an imperative handle so a host screen can query dirtiness, save, or discard before navigating away', async () => {
    const { ref } = renderStudio();
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    expect(ref.current?.isDirty()).toBe(false);

    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), { target: { value: 'x' } });
    expect(ref.current?.isDirty()).toBe(true);

    ref.current?.discard();
    await waitFor(() => expect(ref.current?.isDirty()).toBe(false));
  });

  // -------------------------------------------------------------------
  // 6. Keyboard/dialog behavior.
  // -------------------------------------------------------------------

  it('closes the History drawer on Escape', async () => {
    renderStudio();
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'History' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  // -------------------------------------------------------------------
  // 7. Full generated preview matches canonical formatting.
  // -------------------------------------------------------------------

  it('shows a complete generated document byte-identical to the canonical managed-document format', async () => {
    const services = buildServices();
    renderStudio({ services });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });

    const preview = await services.harnessService.preview({
      root,
      projectId: project.id,
      role: 'worker',
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Generated document').textContent).toBe(
        preview.generatedDocument,
      ),
    );
    expect(preview.generatedDocument).toBe(
      renderManagedDocumentText(preview.generatedHeader, preview.effectiveContent),
    );
  });
});

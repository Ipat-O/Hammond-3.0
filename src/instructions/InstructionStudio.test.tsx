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
  const view = render(
    <InstructionStudio
      ref={ref}
      instructionsService={services.instructionsService}
      assignmentsService={services.assignmentsService}
      harnessService={services.harnessService}
      project={project}
      directoryRoot={options.directoryRoot === undefined ? root : options.directoryRoot}
    />,
  );
  return { ...services, ref, rerender: view.rerender };
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

  // -------------------------------------------------------------------
  // 1b. Changing Worker's execution provider from Agent assignment must
  //     refresh the WHOLE Studio, not just the child panel — heading,
  //     effective content, generated document/target, and subsequent
  //     saves all have to move onto the new provider together.
  // -------------------------------------------------------------------

  it('refreshes heading, effective content, generated document/target, and subsequent saves after a provider change with no linked directory', async () => {
    const services = buildServices();
    await services.instructionsService.saveAndActivate({
      projectId: project.id,
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      content: 'CLAUDE CODE OVERRIDE',
    });
    await services.instructionsService.saveAndActivate({
      projectId: project.id,
      role: 'worker',
      provider: 'kilo_code',
      layer: 'project_override',
      content: 'KILO CODE OVERRIDE',
    });

    renderStudio({ services, directoryRoot: null });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    await waitFor(() =>
      expect(screen.getByLabelText('Effective instructions preview')).toHaveTextContent(
        'CLAUDE CODE OVERRIDE',
      ),
    );

    fireEvent.change(await screen.findByLabelText('Worker execution provider'), {
      target: { value: 'kilo_code' },
    });

    // The heading, the "assigned provider" reflected there, and the composed effective content
    // all move onto kilo_code together — never a stale claude_code editor next to an already-
    // switched assignment control.
    await screen.findByRole('heading', { name: 'Worker instructions for Kilo Code' });
    await waitFor(() =>
      expect(screen.getByLabelText('Effective instructions preview')).toHaveTextContent(
        'KILO CODE OVERRIDE',
      ),
    );
    expect(screen.getByLabelText('Effective instructions preview')).not.toHaveTextContent(
      'CLAUDE CODE OVERRIDE',
    );

    // A subsequent Customize + Save targets the NEW provider's override layer, not the old one.
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'kilo override v2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(async () => {
      const versions = await services.instructionsService.listOwnerVersions({
        role: 'worker',
        provider: 'kilo_code',
        layer: 'project_override',
        projectId: project.id,
      });
      expect(versions.map((v) => v.content)).toContain('kilo override v2');
    });
    const claudeVersions = await services.instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project.id,
    });
    expect(claudeVersions.map((v) => v.content)).not.toContain('kilo override v2');
  });

  it('refreshes the assignment, effective content, and generated-document target after a linked-directory provider switch, and exposes pending local state when the local write itself fails', async () => {
    const fakeFs = createFakeHarnessFilesystem();
    const services = buildServices(fakeFs);
    await services.harnessService.inject({ root, projectId: project.id, role: 'worker' }); // seeds CLAUDE.md
    await services.instructionsService.saveAndActivate({
      projectId: project.id,
      role: 'worker',
      provider: 'kilo_code',
      layer: 'project_override',
      content: 'KILO CODE OVERRIDE',
    });
    const originalInject = services.harnessService.inject.bind(services.harnessService);
    let failNextInject = true;
    services.harnessService.inject = (async (params) => {
      if (params.role === 'worker' && failNextInject) {
        failNextInject = false;
        throw new Error('disk full during switch');
      }
      return originalInject(params);
    }) as typeof services.harnessService.inject;

    renderStudio({ services });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });

    fireEvent.change(await screen.findByLabelText('Worker execution provider'), {
      target: { value: 'kilo_code' },
    });

    await screen.findByText('disk full during switch');
    // The assignment durably switched even though the local write failed: the Studio must show
    // it, not silently keep showing claude_code as if nothing had changed.
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Worker instructions for Kilo Code' }),
      ).toBeInTheDocument(),
    );
    const assignment = await services.assignmentsService.getAssignment({
      projectId: project.id,
      role: 'worker',
    });
    expect(assignment?.provider).toBe('kilo_code');
    await waitFor(() =>
      expect(screen.getByLabelText('Effective instructions preview')).toHaveTextContent(
        'KILO CODE OVERRIDE',
      ),
    );
    // The failed local write is visible as pending local state: the new target was never
    // actually written, so Inject/Update still shows "not created yet", never a false success.
    await waitFor(() => expect(screen.getByText('Not created yet')).toBeInTheDocument());
  });

  it('guards a dirty edit before changing execution provider: Cancel keeps the old provider and the draft, Discard proceeds and drops it, Save persists to the old provider first', async () => {
    const services = buildServices();
    renderStudio({ services, directoryRoot: null });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'dirty draft' },
    });

    fireEvent.change(screen.getByLabelText('Worker execution provider'), {
      target: { value: 'kilo_code' },
    });
    let dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    // Cancelling never carries the draft into a different provider's slot: the assignment stays
    // on claude_code and the draft is exactly as the owner left it.
    expect(
      screen.getByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Worker execution provider')).toHaveValue('claude_code');
    expect(screen.getByLabelText('Project override content')).toHaveValue('dirty draft');

    fireEvent.change(screen.getByLabelText('Worker execution provider'), {
      target: { value: 'kilo_code' },
    });
    dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Worker instructions for Kilo Code' }),
      ).toBeInTheDocument(),
    );
    const claudeVersions = await services.instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project.id,
    });
    // Save targeted the OLD (about-to-be-replaced) provider's slot — the one the draft was
    // actually open against — never the new one it was switching to.
    expect(claudeVersions.map((v) => v.content)).toContain('dirty draft');
  });

  it('a late-resolving old-provider load can never overwrite the screen once the provider has already switched', async () => {
    const services = buildServices();
    await services.instructionsService.saveAndActivate({
      projectId: project.id,
      role: 'worker',
      provider: 'kilo_code',
      layer: 'project_override',
      content: 'KILO CODE OVERRIDE',
    });
    const original = services.instructionsService.getActiveLayerContents.bind(
      services.instructionsService,
    );
    let releaseClaude!: () => void;
    const claudeGate = new Promise<void>((resolve) => {
      releaseClaude = resolve;
    });
    let claudeGateArmed = false;
    services.instructionsService.getActiveLayerContents = (async (params) => {
      if (params.provider === 'claude_code') {
        claudeGateArmed = true;
        await claudeGate;
      }
      return original(params);
    }) as typeof services.instructionsService.getActiveLayerContents;

    renderStudio({ services, directoryRoot: null });
    await waitFor(() => expect(claudeGateArmed).toBe(true));

    fireEvent.change(await screen.findByLabelText('Worker execution provider'), {
      target: { value: 'kilo_code' },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Effective instructions preview')).toHaveTextContent(
        'KILO CODE OVERRIDE',
      ),
    );

    // The stale claude_code load (issued before the switch) resolves only now, well after
    // kilo_code's own load completed.
    releaseClaude();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByLabelText('Effective instructions preview')).toHaveTextContent(
      'KILO CODE OVERRIDE',
    );
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
    // A wider bound than the default 1s: this re-runs the whole import (assignment lookup,
    // instructions save, harness inject) chained through several awaits, which a loaded run can
    // legitimately take longer than 1s to settle without anything actually being wrong.
    await waitFor(() => expect(screen.getByText('Hammond-managed')).toBeInTheDocument(), {
      timeout: 3000,
    });

    const versionsAfterRetry = await instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project.id,
    });
    expect(versionsAfterRetry).toHaveLength(1); // retry did not re-import / duplicate
  });

  it('never forces an unconditional Replace on Retry after a PRE-save import failure — it safely re-attempts preservation instead', async () => {
    const fakeFs = createFakeHarnessFilesystem();
    seedUnmanaged(fakeFs, root, 'claude_code', '# hand-written notes');
    const assignmentRepo = createFakeAssignmentRepository();
    seedProjectDefaults(assignmentRepo.store, project.id, 'owner-1');
    const assignmentsService = new AssignmentsService(assignmentRepo);
    const instructionsService = new InstructionsService(createFakeInstructionRepository());
    const adapters = createFakeHarnessAdapters(fakeFs, root);
    let failNextRead = true;
    const harnessService = new HarnessInjectionService({
      assignments: assignmentsService,
      instructions: instructionsService,
      adapters,
      filesystem: {
        async readTextFile(fsRoot: string, relativePath: string) {
          if (failNextRead) {
            failNextRead = false;
            throw new Error('read failed before anything was saved');
          }
          const provider = relativePath === 'CLAUDE.md' ? 'claude_code' : relativePath;
          const target = fakeFs.targets.get(`${fsRoot}|${provider}`);
          if (!target || target.content === null) throw new Error('not found');
          return target.content;
        },
      },
      now: () => FIXED_NOW,
    });

    renderStudio({ services: { assignmentsService, instructionsService, harnessService, fakeFs } });
    fireEvent.click(await screen.findByRole('button', { name: 'Import existing content' }));

    await screen.findByText('read failed before anything was saved');
    // Nothing was preserved yet, and the owner's original file is exactly as it was.
    const versionsAfterFailure = await instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project.id,
    });
    expect(versionsAfterFailure).toHaveLength(0);
    expect(fakeFs.targets.get(`${root}|claude_code`)?.header).toBeNull();
    expect(fakeFs.targets.get(`${root}|claude_code`)?.content).toBe('# hand-written notes');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // A wider bound than the default 1s: this re-runs the whole import (assignment lookup,
    // instructions save, harness inject) chained through several awaits, which a loaded run can
    // legitimately take longer than 1s to settle without anything actually being wrong.
    await waitFor(() => expect(screen.getByText('Hammond-managed')).toBeInTheDocument(), {
      timeout: 3000,
    });

    // The safe retry re-ran the whole import — preservation happened exactly once, and the
    // preserved content is exactly the original unmanaged file, never empty/generic content.
    const versionsAfterRetry = await instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project.id,
    });
    expect(versionsAfterRetry).toHaveLength(1);
    expect(versionsAfterRetry[0].content).toBe('# hand-written notes');
    expect(fakeFs.targets.get(`${root}|claude_code`)?.header).not.toBeNull();
  });

  it('never forces an unconditional Replace on Retry when the import save itself fails (also pre-save)', async () => {
    const fakeFs = createFakeHarnessFilesystem();
    seedUnmanaged(fakeFs, root, 'claude_code', '# hand-written notes');
    const services = buildServices(fakeFs);
    const originalSave = services.instructionsService.saveAndActivate.bind(
      services.instructionsService,
    );
    let failNextSave = true;
    services.instructionsService.saveAndActivate = (async (params) => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error('network dropped before saving');
      }
      return originalSave(params);
    }) as typeof services.instructionsService.saveAndActivate;

    renderStudio({ services });
    fireEvent.click(await screen.findByRole('button', { name: 'Import existing content' }));

    await screen.findByText('network dropped before saving');
    expect(fakeFs.targets.get(`${root}|claude_code`)?.header).toBeNull();
    expect(fakeFs.targets.get(`${root}|claude_code`)?.content).toBe('# hand-written notes');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Hammond-managed')).toBeInTheDocument());

    const versions = await services.instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project.id,
    });
    expect(versions).toHaveLength(1);
    expect(versions[0].content).toBe('# hand-written notes');
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
  // 5b. Advanced provider-variant selector: dirty-guard + overlapping/
  //     stale-load protection, and retry invalidation on provider/
  //     directory change.
  // -------------------------------------------------------------------

  it('guards an unsaved variant edit before switching variants: Cancel stays on the edited variant, Discard drops it and switches, Save persists to the OLD variant first', async () => {
    const services = buildServices();
    renderStudio({ services });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByText('Advanced'));
    fireEvent.change(screen.getByLabelText('Provider variant content'), {
      target: { value: 'edited claude_code variant' },
    });

    fireEvent.change(screen.getByLabelText('Provider variant'), {
      target: { value: 'codex' },
    });
    let dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.getByLabelText('Provider variant')).toHaveValue('claude_code');
    expect(screen.getByLabelText('Provider variant content')).toHaveValue(
      'edited claude_code variant',
    );

    fireEvent.change(screen.getByLabelText('Provider variant'), {
      target: { value: 'codex' },
    });
    dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));

    await waitFor(() => expect(screen.getByLabelText('Provider variant')).toHaveValue('codex'));
    const claudeVersions = await services.instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'provider',
      projectId: null,
    });
    expect(claudeVersions.map((v) => v.content)).not.toContain('edited claude_code variant');

    // Edit again, then Save: it must land on claude_code (the variant open when Save was
    // clicked), never on codex (the one being switched to).
    fireEvent.change(screen.getByLabelText('Provider variant'), {
      target: { value: 'claude_code' },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Provider variant')).toHaveValue('claude_code'),
    );
    fireEvent.change(screen.getByLabelText('Provider variant content'), {
      target: { value: 'saved before switch' },
    });
    fireEvent.change(screen.getByLabelText('Provider variant'), {
      target: { value: 'codex' },
    });
    dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByLabelText('Provider variant')).toHaveValue('codex'));
    const versionsAfterSave = await services.instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'provider',
      projectId: null,
    });
    expect(versionsAfterSave.map((v) => v.content)).toContain('saved before switch');
    const codexVersions = await services.instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'codex',
      layer: 'provider',
      projectId: null,
    });
    expect(codexVersions.map((v) => v.content)).not.toContain('saved before switch');
  });

  it('a late-resolving load for a previously picked variant can never overwrite a since-picked different variant', async () => {
    const services = buildServices();
    await services.instructionsService.saveAndActivate({
      projectId: project.id,
      role: 'worker',
      provider: 'kilo_code',
      layer: 'provider',
      content: 'KILO VARIANT',
    });
    await services.instructionsService.saveAndActivate({
      projectId: project.id,
      role: 'worker',
      provider: 'codex',
      layer: 'provider',
      content: 'CODEX VARIANT',
    });
    const original = services.instructionsService.getActiveLayerContents.bind(
      services.instructionsService,
    );
    let releaseKilo!: () => void;
    const kiloGate = new Promise<void>((resolve) => {
      releaseKilo = resolve;
    });
    let kiloGateArmed = false;
    services.instructionsService.getActiveLayerContents = (async (params) => {
      if (params.provider === 'kilo_code') {
        kiloGateArmed = true;
        await kiloGate;
      }
      return original(params);
    }) as typeof services.instructionsService.getActiveLayerContents;

    renderStudio({ services });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByText('Advanced'));

    fireEvent.change(screen.getByLabelText('Provider variant'), {
      target: { value: 'kilo_code' },
    });
    await waitFor(() => expect(kiloGateArmed).toBe(true));

    // Before kilo_code's load resolves, the owner picks codex instead — which resolves right away.
    fireEvent.change(screen.getByLabelText('Provider variant'), {
      target: { value: 'codex' },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Provider variant content')).toHaveValue('CODEX VARIANT'),
    );

    // The stale kilo_code load resolves only now, well after codex's own load completed.
    releaseKilo();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByLabelText('Provider variant')).toHaveValue('codex');
    expect(screen.getByLabelText('Provider variant content')).toHaveValue('CODEX VARIANT');
  });

  it('clears a queued action Retry when the assigned provider or the linked directory changes, so a stale retry can never fire against a different target', async () => {
    const fakeFs = createFakeHarnessFilesystem();
    const services = buildServices(fakeFs);
    const inject = services.harnessService.inject.bind(services.harnessService);
    services.harnessService.inject = (async (params) => {
      if (params.role === 'worker') throw new Error('worker inject failed');
      return inject(params);
    }) as typeof services.harnessService.inject;

    const { rerender } = renderStudio({ services });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Inject' }));
    await screen.findByText('worker inject failed');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    // Re-linking the directory (still the same role/provider) invalidates the queued retry.
    rerender(
      <InstructionStudio
        instructionsService={services.instructionsService}
        assignmentsService={services.assignmentsService}
        harnessService={services.harnessService}
        project={project}
        directoryRoot="/home/owner/project-1-relinked"
      />,
    );
    await waitFor(() => expect(screen.queryByText('worker inject failed')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
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

  it('the Unsaved changes dialog focuses itself, traps Tab, treats Escape as Cancel, and returns focus afterward', async () => {
    renderStudio();
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    const customizeButton = await screen.findByRole('button', { name: 'Customize' });
    customizeButton.focus();
    fireEvent.click(customizeButton);
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'dirty edit' },
    });

    const orchestratorButton = screen.getByRole('button', { name: 'Orchestrator' });
    orchestratorButton.focus();
    fireEvent.click(orchestratorButton);
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    const saveButton = within(dialog).getByRole('button', { name: 'Save changes' });
    const discardButton = within(dialog).getByRole('button', { name: 'Discard changes' });
    const cancelButton = within(dialog).getByRole('button', { name: 'Cancel' });
    // Focus enters the dialog on its first focusable control.
    await waitFor(() => expect(saveButton).toHaveFocus());

    // Shift+Tab from the dialog container wraps to the LAST focusable control.
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(cancelButton).toHaveFocus();
    // Tab from the last control wraps back to the first.
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(saveButton).toHaveFocus();
    void discardButton; // exists between Save and Cancel in the trapped tab order

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Escape acted as Cancel: the role switch never happened, and the draft is untouched.
    expect(
      screen.getByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Project override content')).toHaveValue('dirty edit');
    // Focus returns to whatever had it before the dialog opened.
    expect(orchestratorButton).toHaveFocus();
  });

  it('a Save left pending when the dialog is Cancelled can never execute the cancelled transition once it resolves', async () => {
    const services = buildServices();
    let resolveSave!: () => void;
    const originalSaveAndActivate = services.instructionsService.saveAndActivate.bind(
      services.instructionsService,
    );
    services.instructionsService.saveAndActivate = ((params) =>
      new Promise((resolve) => {
        resolveSave = () => resolve(originalSaveAndActivate(params));
      })) as typeof services.instructionsService.saveAndActivate;

    renderStudio({ services });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'pending save' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    // The Save is now in flight (awaiting `resolveSave`). Before it resolves, cancel the dialog.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      screen.getByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();

    // The save finally completes — it must NOT retroactively execute the role switch the owner
    // already cancelled their way out of.
    resolveSave();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      screen.getByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /Orchestrator instructions/ }),
    ).not.toBeInTheDocument();
  });

  /** Waits for the effective-instructions fetch for the CURRENT role/provider to settle, so a
   * subsequent guarded action reads fresh (not still-loading, possibly stale) dirty flags. */
  async function waitForEffectiveLoaded() {
    await waitFor(() =>
      expect(screen.queryByText('Loading instructions…')).not.toBeInTheDocument(),
    );
  }

  it('a completed Save-and-transition never leaves a later dialog stuck on a stale Saving state', async () => {
    const services = buildServices();
    renderStudio({ services });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'first save' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator' }));
    let dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /Orchestrator instructions/ }),
      ).toBeInTheDocument(),
    );
    await waitForEffectiveLoaded();

    // Back to Worker (clean — no dialog), a second dirty edit, and a second guarded switch. The
    // first Save's own completion invalidated its token via `dismissPendingTransition` — that
    // must not leave THIS brand-new dialog's Save permanently busy/disabled.
    fireEvent.click(screen.getByRole('button', { name: 'Worker' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    await waitForEffectiveLoaded();
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'second edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator' }));
    dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    const saveButton = within(dialog).getByRole('button', { name: 'Save changes' });
    expect(saveButton).not.toBeDisabled();
    expect(saveButton).toHaveTextContent('Save changes');
    fireEvent.click(saveButton);

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
    expect(versions.map((v) => v.content)).toEqual(
      expect.arrayContaining(['first save', 'second edit']),
    );
    expect(versions).toHaveLength(2);
  });

  it('a Save left pending when Cancelled resets busy so a later dialog Save still works, and the stale save never fires', async () => {
    const services = buildServices();
    // Each call to saveAndActivate resolves only when the test explicitly triggers it, so a
    // Save started from one dialog can be left in flight while a completely separate Save
    // (from a later, independent dialog) runs and resolves first.
    const pendingSaves: Array<() => void> = [];
    const originalSaveAndActivate = services.instructionsService.saveAndActivate.bind(
      services.instructionsService,
    );
    services.instructionsService.saveAndActivate = ((params) =>
      new Promise((resolve) => {
        pendingSaves.push(() => resolve(originalSaveAndActivate(params)));
      })) as typeof services.instructionsService.saveAndActivate;

    renderStudio({ services });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'pending save' },
    });

    // First dialog targets Orchestrator — Save it, then Cancel while it is still in flight.
    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator' }));
    let dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      screen.getByRole('heading', { name: 'Worker instructions for Claude Code' }),
    ).toBeInTheDocument();

    // A second, independent dirty edit and dialog — targeting a DIFFERENT role (Auditor), so the
    // eventual heading unambiguously proves which transition actually ran — must behave normally
    // rather than inheriting the cancelled Save's busy state.
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'second dirty edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Auditor' }));
    dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    const saveButton = within(dialog).getByRole('button', { name: 'Save changes' });
    expect(saveButton).not.toBeDisabled();
    expect(saveButton).toHaveTextContent('Save changes');
    fireEvent.click(saveButton);
    expect(pendingSaves).toHaveLength(2);
    pendingSaves[1]();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Auditor instructions/ })).toBeInTheDocument(),
    );

    // The FIRST save (from the cancelled Orchestrator dialog) finally resolves late — it must not
    // retroactively execute the cancelled switch to Orchestrator, nor disturb the second save.
    pendingSaves[0]();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole('heading', { name: /Auditor instructions/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /Orchestrator instructions/ }),
    ).not.toBeInTheDocument();
  });

  it("Discard during a pending Save cannot let that stale completion clear a later save's busy state", async () => {
    const services = buildServices();
    const pendingSaves: Array<() => void> = [];
    const originalSaveAndActivate = services.instructionsService.saveAndActivate.bind(
      services.instructionsService,
    );
    services.instructionsService.saveAndActivate = ((params) =>
      new Promise((resolve) => {
        pendingSaves.push(() => resolve(originalSaveAndActivate(params)));
      })) as typeof services.instructionsService.saveAndActivate;

    renderStudio({ services });
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'will be discarded' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator' }));
    let dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    // Discard while that Save is still in flight — it proceeds immediately, without waiting.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /Orchestrator instructions/ }),
      ).toBeInTheDocument(),
    );
    await waitForEffectiveLoaded();

    // Back to Worker with a completely fresh dirty edit and a new Save.
    fireEvent.click(screen.getByRole('button', { name: 'Worker' }));
    await screen.findByRole('heading', { name: 'Worker instructions for Claude Code' });
    await waitForEffectiveLoaded();
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.change(screen.getByLabelText('Project override content'), {
      target: { value: 'kept edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator' }));
    dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    const saveButton = within(dialog).getByRole('button', { name: 'Save changes' });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);
    expect(pendingSaves).toHaveLength(2);
    pendingSaves[1](); // resolve the SECOND (new) save so the UI can proceed
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /Orchestrator instructions/ }),
      ).toBeInTheDocument(),
    );

    // The FIRST (discarded) save finally resolves late — it must not retroactively clear or
    // otherwise disturb the state left by the second, already-completed save.
    pendingSaves[0]();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole('heading', { name: /Orchestrator instructions/ })).toBeInTheDocument();

    const versions = await services.instructionsService.listOwnerVersions({
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      projectId: project.id,
    });
    expect(versions.map((v) => v.content)).toContain('kept edit');
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

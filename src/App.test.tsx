import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';

import App from './App';
import type { Database } from './data';
import { AssignmentsService } from './assignments/service';
import { createFakeAssignmentRepository } from './assignments/testFakes';
import { HarnessInjectionService } from './harness/service';
import { createFakeHarnessAdapters, createFakeHarnessFilesystem } from './harness/testFakes';
import { InstructionsService } from './instructions/service';
import { createFakeInstructionRepository } from './instructions/testFakes';
import { LOCAL_SETTINGS_KEY, type LocalSettingsStateV1 } from './settings/state';
import {
  createFakeDirectoryContextServices,
  createFakeFilesystem,
  createFakeLocalSettings,
} from './settings/testFakes';
import type { DirectoryContextServices } from './settings/contracts';
import type { TrackerRepositories, TrackerServices } from './tracker/contracts';
import type { TaskStatus } from './data';

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

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    owner_id: ownerId,
    project_id: 'project-1',
    title: 'First task',
    description: 'Task detail.',
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

function makeServices(projects: Project[] = [], tasks: Task[] = []): TrackerServices {
  const repositories: TrackerRepositories = {
    projects: {
      list: vi.fn().mockResolvedValue(projects),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
    },
    tasks: {
      list: vi.fn().mockResolvedValue(tasks),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
    },
    memory: {
      listComments: vi.fn().mockResolvedValue([]),
      addComment: vi.fn(),
    },
  };

  const assignments = new AssignmentsService(createFakeAssignmentRepository());
  const instructions = new InstructionsService(createFakeInstructionRepository());
  const harnessFs = createFakeHarnessFilesystem();

  return {
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
}

const session = { user: { id: ownerId, email: 'owner@example.test' } } as Session;

describe('Hammond tracker workspace', () => {
  it('renders the empty workspace and preserves the foundation boundary map', async () => {
    render(<App services={makeServices()} initialSession={session} />);

    expect(
      await screen.findByRole('heading', { name: 'Good morning, owner.' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Clear boundaries, ready to extend.' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Local workspace')).toBeInTheDocument();
    expect(screen.getByText('Project memory')).toBeInTheDocument();
    expect(screen.getByText('Local settings')).toBeInTheDocument();
  });

  it('keeps an edited project visible after a failed save and retries it explicitly', async () => {
    const services = makeServices([project()]);
    const updated = project({ name: 'Updated project', updated_at: '2026-08-13T09:00:00.000Z' });
    const update = services.repositories.projects.update as ReturnType<typeof vi.fn>;
    update
      .mockRejectedValueOnce(new Error('induced network failure'))
      .mockResolvedValueOnce(updated);

    render(<App services={services} initialSession={session} />);
    expect(
      (await screen.findAllByRole('heading', { name: 'Hammond project' })).length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Edit project' }));
    const nameInput = screen.getByLabelText('Project name');
    fireEvent.change(nameInput, { target: { value: 'Updated project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }));

    expect(
      (await screen.findAllByRole('alert')).some((alert) =>
        alert.textContent?.includes('induced network failure'),
      ),
    ).toBe(true);
    expect(screen.getByLabelText('Project name')).toHaveValue('Updated project');
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));

    await waitFor(async () =>
      expect(
        (await screen.findAllByRole('heading', { name: 'Updated project' })).length,
      ).toBeGreaterThan(0),
    );
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('shows the full manual status vocabulary, including distinct merged and shipped states', async () => {
    const statuses: TaskStatus[] = ['merged', 'shipped', 'cancelled'];
    render(
      <App
        services={makeServices(
          [project()],
          statuses.map((status, index) => task({ id: `task-${index}`, status })),
        )}
        initialSession={session}
      />,
    );

    expect(
      (await screen.findAllByRole('heading', { name: 'Hammond project' })).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Merged' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Shipped' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Cancelled' })).toBeInTheDocument();
  });

  it('opens task detail and supports nested task and comment entry through the UI', async () => {
    const services = makeServices([project()], [task()]);
    const savedComment: Comment = {
      id: 'comment-1',
      owner_id: ownerId,
      project_id: 'project-1',
      task_id: 'task-1',
      body: 'Useful note',
      created_at: '2026-08-13T09:00:00.000Z',
      updated_at: '2026-08-13T09:00:00.000Z',
    };
    const addComment = services.repositories.memory.addComment as ReturnType<typeof vi.fn>;
    addComment.mockResolvedValue(savedComment);

    render(<App services={services} initialSession={session} />);
    expect(await screen.findByRole('button', { name: /First task/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /First task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Comments')).toBeInTheDocument();
    expect(
      await screen.findByText('No comments yet. Leave the first useful note.'),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Add a comment'), { target: { value: 'Useful note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(await screen.findByText('Useful note')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '+ child' }));
    expect(screen.getByLabelText('Parent task')).toHaveValue('task-1');
  });

  it('renders a collapsed outliner, expands exact children, focuses, and preserves stored rows', async () => {
    const parent = task({ id: 'parent', title: 'Parent task', status: 'ready' });
    const child = task({
      id: 'child',
      title: 'Child task',
      parent_task_id: 'parent',
      status: 'in_progress',
    });
    const secondChild = task({
      id: 'child-2',
      title: 'Second child',
      parent_task_id: 'parent',
      status: 'done',
    });
    const other = task({ id: 'other', title: 'Other top-level task', status: 'blocked' });
    const tasks = [parent, child, secondChild, other];
    const storedRows = structuredClone(tasks);
    const services = makeServices([project()], tasks);

    render(<App services={services} initialSession={session} />);
    expect(await screen.findByRole('button', { name: /Parent taskReady/ })).toBeInTheDocument();
    expect(screen.queryByText('Child task')).not.toBeInTheDocument();
    expect(screen.getByText('2 children')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Parent task' }));
    expect(screen.getByText('Child task')).toBeInTheDocument();
    expect(screen.getByText('Second child')).toBeInTheDocument();
    expect(screen.queryByText('2 children')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Parent task' }));
    expect(screen.queryByText('Child task')).not.toBeInTheDocument();
    expect(screen.getByText('2 children')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Focus' })[0]);
    expect(screen.getByText('Focused task')).toBeInTheDocument();
    expect(screen.getAllByText('Parent task').length).toBeGreaterThan(0);
    expect(screen.getByText('Child task')).toBeInTheDocument();
    expect(screen.getByText('Second child')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to all tasks' }));
    expect(screen.getByText('Other top-level task')).toBeInTheDocument();
    expect(screen.getByText('Child task')).toBeInTheDocument();

    expect(tasks).toEqual(storedRows);
    expect(services.repositories.tasks.list).toHaveBeenCalledTimes(1);
    expect(services.repositories.tasks.create).not.toHaveBeenCalled();
    expect(services.repositories.tasks.update).not.toHaveBeenCalled();
    expect(services.repositories.tasks.archive).not.toHaveBeenCalled();
  });

  it('creates a second child from a selected parent without a false depth rejection', async () => {
    const parent = task({ id: 'parent', title: 'Parent task' });
    const child = task({ id: 'child', title: 'Child task', parent_task_id: 'parent' });
    const services = makeServices([project()], [parent, child]);
    const secondChild = task({
      id: 'second-child',
      title: 'Second child',
      parent_task_id: 'parent',
    });
    const create = services.repositories.tasks.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue(secondChild);

    render(<App services={services} initialSession={session} />);

    // Select the parent (opens edit, then cancel) so selectedTaskId still identifies
    // the parent when the ordinary "+ child" create flow is opened from its row.
    fireEvent.click(await screen.findByRole('button', { name: /^Parent task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: '+ child' }));
    expect(screen.getByLabelText('Parent task')).toHaveValue('parent');

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Second child' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ parent_task_id: 'parent' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders, expands, and operates a four-level outliner without task writes or stored-row mutation', async () => {
    const level1 = task({ id: 'level-1', title: 'Level one', status: 'backlog' });
    const level2 = task({
      id: 'level-2',
      title: 'Level two',
      parent_task_id: 'level-1',
      status: 'ready',
    });
    const level3 = task({
      id: 'level-3',
      title: 'Level three',
      parent_task_id: 'level-2',
      status: 'in_progress',
    });
    const level4 = task({
      id: 'level-4',
      title: 'Level four',
      parent_task_id: 'level-3',
      status: 'blocked',
    });
    const tasks = [level1, level2, level3, level4];
    const storedRows = structuredClone(tasks);
    const services = makeServices([project()], tasks);

    render(<App services={services} initialSession={session} />);

    expect(await screen.findByRole('button', { name: /Level oneBacklog/ })).toBeInTheDocument();
    expect(screen.queryByText('Level two')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Level one' }));
    expect(screen.getByText('Level two')).toBeInTheDocument();
    expect(screen.queryByText('Level three')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Level two' }));
    expect(screen.getByText('Level three')).toBeInTheDocument();
    expect(screen.queryByText('Level four')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Level three' }));
    expect(screen.getByText('Level four')).toBeInTheDocument();

    // + child at the deepest visible row pre-selects that row as the parent.
    const addChildButtons = screen.getAllByRole('button', { name: '+ child' });
    fireEvent.click(addChildButtons[addChildButtons.length - 1]);
    expect(screen.getByLabelText('Parent task')).toHaveValue('level-4');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Collapsing the root hides every descendant regardless of depth.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Level one' }));
    expect(screen.queryByText('Level two')).not.toBeInTheDocument();
    expect(screen.queryByText('Level four')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Level one' }));
    expect(screen.getByText('Level four')).toBeInTheDocument();

    // Focus the third-level task and confirm only its subtree renders.
    const focusButtons = screen.getAllByRole('button', { name: 'Focus' });
    fireEvent.click(focusButtons[2]);
    expect(screen.getByText('Focused task')).toBeInTheDocument();
    expect(screen.getAllByText('Level three').length).toBeGreaterThan(0);
    expect(screen.getByText('Level four')).toBeInTheDocument();
    expect(screen.queryByText('Level one')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to all tasks' }));
    expect(screen.getByText('Level one')).toBeInTheDocument();

    expect(tasks).toEqual(storedRows);
    expect(services.repositories.tasks.list).toHaveBeenCalledTimes(1);
    expect(services.repositories.tasks.create).not.toHaveBeenCalled();
    expect(services.repositories.tasks.update).not.toHaveBeenCalled();
    expect(services.repositories.tasks.archive).not.toHaveBeenCalled();
  });

  it('persists a legal re-parent at least four levels deep from the task editor', async () => {
    const level1 = task({ id: 'level-1', title: 'Level one' });
    const level2 = task({ id: 'level-2', title: 'Level two', parent_task_id: 'level-1' });
    const level3 = task({ id: 'level-3', title: 'Level three', parent_task_id: 'level-2' });
    const level4 = task({ id: 'level-4', title: 'Level four', parent_task_id: 'level-3' });
    const newTopLevel = task({ id: 'new-task', title: 'Movable task' });
    const services = makeServices([project()], [level1, level2, level3, level4, newTopLevel]);
    const reparented = { ...newTopLevel, parent_task_id: 'level-4' };
    const update = services.repositories.tasks.update as ReturnType<typeof vi.fn>;
    update.mockResolvedValue(reparented);

    render(<App services={services} initialSession={session} />);

    fireEvent.click(await screen.findByRole('button', { name: /^Movable task/ }));
    fireEvent.change(screen.getByLabelText('Parent task'), { target: { value: 'level-4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(
      'new-task',
      expect.objectContaining({ parent_task_id: 'level-4' }),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('gives status, Focus, + child, and Archive controls distinct functional classes', async () => {
    const parent = task({ id: 'parent', title: 'Parent task' });
    const services = makeServices([project()], [parent]);

    render(<App services={services} initialSession={session} />);
    const title = await screen.findByText('Parent task', { selector: '.outliner-task-title' });
    const row = within(title.closest('.outliner-row') as HTMLElement);

    expect(row.getByLabelText('Move Parent task')).toHaveClass('outliner-action-status');
    expect(row.getByRole('button', { name: 'Focus' })).toHaveClass('outliner-action-focus');
    expect(row.getByRole('button', { name: '+ child' })).toHaveClass('outliner-action-child');
    expect(row.getByRole('button', { name: 'Archive' })).toHaveClass('outliner-action-archive');
  });

  it('shows an explicit non-interactive Archived state for an archived task under Show archived', async () => {
    const archived = task({
      id: 'archived-task',
      title: 'Archived task',
      archived_at: '2026-08-13T10:00:00.000Z',
    });
    const services = makeServices([project()], [archived]);

    render(<App services={services} initialSession={session} />);
    fireEvent.click(await screen.findByLabelText('Show archived'));

    const title = await screen.findByText('Archived task');
    expect(title).toHaveClass('outliner-task-title-archived');
    const row = within(title.closest('.outliner-row') as HTMLElement);
    expect(row.getByText('Archived')).toHaveClass('outliner-action-archived');
    expect(title.closest('.outliner-row')).toHaveClass('outliner-row-archived');
    expect(row.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(services.repositories.tasks.archive).not.toHaveBeenCalled();
  });
});

describe('task archive cascades to the complete subtree', () => {
  function buildLineage() {
    const parent = task({ id: 'parent', title: 'Parent task', status: 'ready' });
    const child = task({
      id: 'child',
      title: 'Child task',
      parent_task_id: 'parent',
      status: 'in_progress',
    });
    const grandchild = task({
      id: 'grandchild',
      title: 'Grandchild task',
      parent_task_id: 'child',
      status: 'blocked',
    });
    const other = task({ id: 'other', title: 'Other top-level task', status: 'backlog' });
    return { parent, child, grandchild, other };
  }

  function archivedRows(rows: Task[], archivedAt: string): Task[] {
    return rows.map((row) => ({ ...row, archived_at: archivedAt }));
  }

  it('optimistically removes the whole subtree from the active outliner and status counts, promoting no child to root', async () => {
    const { parent, child, grandchild, other } = buildLineage();
    const tasks = [parent, child, grandchild, other];
    const services = makeServices([project()], tasks);
    const archive = services.repositories.tasks.archive as ReturnType<typeof vi.fn>;
    archive.mockReturnValue(new Promise(() => {})); // never resolves; assert on the optimistic state

    render(<App services={services} initialSession={session} />);
    expect(
      await screen.findByText('Parent task', { selector: '.outliner-task-title' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ready' }).nextSibling).toHaveTextContent('1');
    expect(screen.getByRole('heading', { name: 'In progress' }).nextSibling).toHaveTextContent('1');
    expect(screen.getByRole('heading', { name: 'Blocked' }).nextSibling).toHaveTextContent('1');
    expect(screen.getByRole('heading', { name: 'Backlog' }).nextSibling).toHaveTextContent('1');

    const parentTitle = screen.getByText('Parent task', { selector: '.outliner-task-title' });
    const parentRow = within(parentTitle.closest('.outliner-row') as HTMLElement);
    fireEvent.click(parentRow.getByRole('button', { name: 'Archive' }));

    expect(
      screen.queryByText('Parent task', { selector: '.outliner-task-title' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Child task')).not.toBeInTheDocument();
    expect(screen.queryByText('Grandchild task')).not.toBeInTheDocument();
    expect(screen.getByText('Other top-level task')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ready' }).nextSibling).toHaveTextContent('0');
    expect(screen.getByRole('heading', { name: 'In progress' }).nextSibling).toHaveTextContent('0');
    expect(screen.getByRole('heading', { name: 'Blocked' }).nextSibling).toHaveTextContent('0');
    expect(screen.getByRole('heading', { name: 'Backlog' }).nextSibling).toHaveTextContent('1');
  });

  it('reveals the archived parent and every descendant with explicit archived states once Show archived is on, reconciling the repository rows', async () => {
    const { parent, child, grandchild, other } = buildLineage();
    const tasks = [parent, child, grandchild, other];
    const services = makeServices([project()], tasks);
    const archivedAt = '2026-08-14T10:00:00.000Z';
    const archive = services.repositories.tasks.archive as ReturnType<typeof vi.fn>;
    archive.mockResolvedValue(archivedRows([parent, child, grandchild], archivedAt));

    render(<App services={services} initialSession={session} />);
    const parentTitle = await screen.findByText('Parent task', {
      selector: '.outliner-task-title',
    });
    const parentRow = within(parentTitle.closest('.outliner-row') as HTMLElement);
    fireEvent.click(parentRow.getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
    expect(archive).toHaveBeenCalledWith('parent');

    fireEvent.click(screen.getByLabelText('Show archived'));
    const revealedParentTitle = await screen.findByText('Parent task', {
      selector: '.outliner-task-title',
    });
    expect(revealedParentTitle).toHaveClass('outliner-task-title-archived');
    expect(revealedParentTitle.closest('.outliner-row')).toHaveClass('outliner-row-archived');

    fireEvent.click(screen.getByRole('button', { name: 'Expand Parent task' }));
    const childTitle = screen.getByText('Child task', { selector: '.outliner-task-title' });
    expect(childTitle).toHaveClass('outliner-task-title-archived');
    expect(childTitle.closest('.outliner-row')).toHaveClass('outliner-row-archived');

    fireEvent.click(screen.getByRole('button', { name: 'Expand Child task' }));
    const grandchildTitle = screen.getByText('Grandchild task', {
      selector: '.outliner-task-title',
    });
    expect(grandchildTitle).toHaveClass('outliner-task-title-archived');
    expect(grandchildTitle.closest('.outliner-row')).toHaveClass('outliner-row-archived');

    expect(screen.getByText('Other top-level task')).not.toHaveClass(
      'outliner-task-title-archived',
    );
  });

  it('leaves siblings and ancestors active when a leaf task is archived', async () => {
    const { parent, child, grandchild } = buildLineage();
    const tasks = [parent, child, grandchild];
    const services = makeServices([project()], tasks);
    const archivedAt = '2026-08-14T10:00:00.000Z';
    const archive = services.repositories.tasks.archive as ReturnType<typeof vi.fn>;
    archive.mockResolvedValue(archivedRows([grandchild], archivedAt));

    render(<App services={services} initialSession={session} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Parent task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Child task' }));

    const grandchildTitle = screen.getByText('Grandchild task', {
      selector: '.outliner-task-title',
    });
    const grandchildRow = within(grandchildTitle.closest('.outliner-row') as HTMLElement);
    fireEvent.click(grandchildRow.getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(archive).toHaveBeenCalledWith('grandchild'));
    expect(screen.queryByText('Grandchild task')).not.toBeInTheDocument();
    expect(
      screen.getByText('Parent task', { selector: '.outliner-task-title' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Child task', { selector: '.outliner-task-title' })).not.toHaveClass(
      'outliner-task-title-archived',
    );
    expect(screen.getByRole('heading', { name: 'Ready' }).nextSibling).toHaveTextContent('1');
    expect(screen.getByRole('heading', { name: 'In progress' }).nextSibling).toHaveTextContent('1');
  });

  it('exposes retry on a failed archive and retries the same subtree bound to the original root', async () => {
    const { parent, child, other } = buildLineage();
    const tasks = [parent, child, other];
    const services = makeServices([project()], tasks);
    const archivedAt = '2026-08-14T10:00:00.000Z';
    const archive = services.repositories.tasks.archive as ReturnType<typeof vi.fn>;
    archive
      .mockRejectedValueOnce(new Error('induced archive failure'))
      .mockResolvedValueOnce(archivedRows([parent, child], archivedAt));

    render(<App services={services} initialSession={session} />);
    const parentTitle = await screen.findByText('Parent task', {
      selector: '.outliner-task-title',
    });
    const parentRow = within(parentTitle.closest('.outliner-row') as HTMLElement);
    fireEvent.click(parentRow.getByRole('button', { name: 'Archive' }));

    expect(
      (await screen.findAllByRole('alert')).some((alert) =>
        alert.textContent?.includes('induced archive failure'),
      ),
    ).toBe(true);
    // The optimistic cascade already removed the subtree from the active view, even though the write failed.
    expect(
      screen.queryByText('Parent task', { selector: '.outliner-task-title' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Other top-level task')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));

    await waitFor(() => expect(archive).toHaveBeenCalledTimes(2));
    expect(archive).toHaveBeenNthCalledWith(1, 'parent');
    expect(archive).toHaveBeenNthCalledWith(2, 'parent');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('clears a selected or focused descendant instead of leaving it as a hidden ghost once the subtree is archived', async () => {
    const { parent, child, grandchild, other } = buildLineage();
    const tasks = [parent, child, grandchild, other];
    const services = makeServices([project()], tasks);
    const archive = services.repositories.tasks.archive as ReturnType<typeof vi.fn>;
    archive.mockReturnValue(new Promise(() => {}));

    render(<App services={services} initialSession={session} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Parent task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Child task' }));

    // Select the grandchild (open its editor, then cancel so the detail panel shows the plain summary).
    fireEvent.click(screen.getByRole('button', { name: /^Grandchild task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Selected task')).toBeInTheDocument();

    // Focus the child, which is both the archive root and an ancestor of the selected grandchild.
    const focusButtons = screen.getAllByRole('button', { name: 'Focus' });
    fireEvent.click(focusButtons[1]);
    expect(screen.getByText('Focused task')).toBeInTheDocument();

    const childTitle = screen.getByText('Child task', { selector: '.outliner-task-title' });
    const childRow = within(childTitle.closest('.outliner-row') as HTMLElement);
    fireEvent.click(childRow.getByRole('button', { name: 'Archive' }));

    expect(screen.queryByText('Focused task')).not.toBeInTheDocument();
    expect(screen.queryByText('Selected task')).not.toBeInTheDocument();
    expect(
      screen.getByText('Select a task to inspect its context, hierarchy, and comments.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Parent task', { selector: '.outliner-task-title' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Other top-level task')).toBeInTheDocument();
  });
});

describe('directory context restoration on cold restart', () => {
  function seededState(overrides: Partial<LocalSettingsStateV1['directoryContexts'][number]> = {}) {
    const context = {
      id: 'ctx-1',
      projectId: 'project-b',
      path: '/home/owner/project-b-repo',
      label: 'project-b-repo',
      createdAt: '2026-08-01T00:00:00.000Z',
      lastOpenedAt: '2026-08-01T00:00:00.000Z',
      ...overrides,
    };
    const state: LocalSettingsStateV1 = {
      version: 1,
      directoryContexts: [context],
      lastOpenContextId: context.id,
      resumeScreen: 'workspace',
    };
    return { state, context };
  }

  it('restores the last-open directory context and switches to its project on mount', async () => {
    const projectA = project({ id: 'project-a', name: 'Project A' });
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const { state } = seededState();
    const filesystem = createFakeFilesystem();
    filesystem.existingRoots.add(state.directoryContexts[0].path);
    const settings = createFakeLocalSettings();
    await settings.write(LOCAL_SETTINGS_KEY, state);
    const directoryContext: DirectoryContextServices = { filesystem, settings };

    const services = makeServices([projectA, projectB], []);
    services.directoryContext = directoryContext;

    render(<App services={services} initialSession={session} />);

    expect((await screen.findAllByRole('heading', { name: 'Project B' })).length).toBeGreaterThan(
      0,
    );
    expect(
      await screen.findByText('/home/owner/project-b-repo', {
        selector: '.directory-context-path',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
  });

  it('reports a missing last-open directory without blocking the rest of the app', async () => {
    const projectB = project({ id: 'project-b', name: 'Project B' });
    const { state } = seededState();
    // The context's path is deliberately never added to existingRoots, simulating a
    // directory that was deleted or moved while Hammond was closed.
    const filesystem = createFakeFilesystem();
    const settings = createFakeLocalSettings();
    await settings.write(LOCAL_SETTINGS_KEY, state);
    const directoryContext: DirectoryContextServices = { filesystem, settings };

    const services = makeServices([projectB], [task()]);
    services.directoryContext = directoryContext;

    render(<App services={services} initialSession={session} />);

    expect((await screen.findAllByRole('heading', { name: 'Project B' })).length).toBeGreaterThan(
      0,
    );
    expect(
      await screen.findByText('Missing — this directory could not be found.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Locate replacement' })).toBeInTheDocument();
    // The rest of the workspace still renders and is usable.
    expect(
      await screen.findByText('First task', { selector: '.outliner-task-title' }),
    ).toBeInTheDocument();
  });
});

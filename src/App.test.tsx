import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';

import App from './App';
import type { Database } from './data';
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

  return {
    repositories,
    auth: {} as TrackerServices['auth'],
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

  it('rejects a third nesting level with a visible message before the task write', async () => {
    const parent = task({ id: 'parent', title: 'Parent task' });
    const child = task({ id: 'child', title: 'Child task', parent_task_id: 'parent' });
    const services = makeServices([project()], [parent, child]);

    render(<App services={services} initialSession={session} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Parent task' }));
    const addChildButtons = screen.getAllByRole('button', { name: '+ child' });
    fireEvent.click(addChildButtons[1]);

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Grandchild task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));

    expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent(
      'Tasks can have at most one level of subtasks',
    );
    expect(services.repositories.tasks.create).not.toHaveBeenCalled();
  });
});

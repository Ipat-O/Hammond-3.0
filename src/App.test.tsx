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
});

import { AssignmentsService } from '../assignments/service';
import { createFakeAssignmentRepository, seedProjectDefaults } from '../assignments/testFakes';
import {
  createFakeInstructionRepository,
  createFakeInstructionStore,
} from '../instructions/testFakes';
import { InstructionsService } from '../instructions/service';
import { TaskRevisionConflictError } from '../data/taskValidation';
import type { TaskStatus } from '../data/taskValidation';
import type { TrackerServices } from '../tracker/contracts';
import { callFacadeTool } from './facade';
import type { FacadeContext } from './types';

const OWNER_ID = 'owner-1';
const PROJECT_ID = 'project-1';

interface FakeTaskRow {
  id: string;
  owner_id: string;
  project_id: string;
  parent_task_id: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  due_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

interface FakeCommentRow {
  id: string;
  owner_id: string;
  task_id: string;
  project_id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

function buildServices(
  options: {
    tasks?: FakeTaskRow[];
    comments?: FakeCommentRow[];
    createError?: unknown;
    updateError?: unknown;
  } = {},
): { services: TrackerServices; tasks: FakeTaskRow[]; comments: FakeCommentRow[] } {
  const tasks = options.tasks ?? [];
  const comments = options.comments ?? [];
  let nextId = 100;

  const assignmentStore = createFakeAssignmentRepository();
  seedProjectDefaults(assignmentStore.store, PROJECT_ID, OWNER_ID);
  const instructionStore = createFakeInstructionStore();

  const services: TrackerServices = {
    auth: {
      setup: async () => ({ data: { session: null }, error: null }) as never,
      signIn: async () => ({ data: { session: null }, error: null }) as never,
      getPersistedSession: async () => ({ data: { session: null }, error: null }) as never,
      signOut: async () => ({ error: null }) as never,
      onAuthStateChange: (() => ({ data: { subscription: { unsubscribe: () => {} } } })) as never,
    },
    repositories: {
      projects: {
        list: async () => [
          {
            id: PROJECT_ID,
            owner_id: OWNER_ID,
            name: 'Scratch project',
            description: '',
            archived_at: null,
            created_at: '',
            updated_at: '',
          },
        ],
        create: (async () => {
          throw new Error('not used');
        }) as never,
        update: (async () => {
          throw new Error('not used');
        }) as never,
        archive: (async () => {
          throw new Error('not used');
        }) as never,
      },
      tasks: {
        list: async (projectId: string, opts: { includeArchived?: boolean } = {}) =>
          tasks.filter(
            (t) => t.project_id === projectId && (opts.includeArchived || !t.archived_at),
          ),
        create: async (input: Partial<FakeTaskRow>) => {
          if (options.createError) throw options.createError;
          const row: FakeTaskRow = {
            id: `task-${(nextId += 1)}`,
            owner_id: OWNER_ID,
            project_id: input.project_id ?? PROJECT_ID,
            parent_task_id: input.parent_task_id ?? null,
            title: input.title ?? '',
            description: input.description ?? '',
            status: 'backlog',
            priority: 0,
            due_at: null,
            archived_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            revision: 1,
          };
          tasks.push(row);
          return row;
        },
        update: async (
          id: string,
          input: Partial<FakeTaskRow> & { status?: TaskStatus },
          expectedRevision: number,
        ) => {
          if (options.updateError) throw options.updateError;
          const row = tasks.find((t) => t.id === id);
          if (!row) throw new Error('not found');
          if (row.revision !== expectedRevision) throw new TaskRevisionConflictError('stale');
          Object.assign(row, {
            title: input.title ?? row.title,
            description: input.description ?? row.description,
            status: input.status ?? row.status,
          });
          row.revision += 1;
          return row;
        },
        archive: (async () => {
          throw new Error('not used');
        }) as never,
      },
      memory: {
        listComments: async (taskId: string) => comments.filter((c) => c.task_id === taskId),
        addComment: async (input: { task_id: string; project_id: string; body: string }) => {
          const row: FakeCommentRow = {
            id: `comment-${(nextId += 1)}`,
            owner_id: OWNER_ID,
            task_id: input.task_id,
            project_id: input.project_id,
            body: input.body,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          comments.push(row);
          return row;
        },
        listRecentComments: (async () => []) as never,
        listActivity: (async () => []) as never,
        listEvidence: (async () => []) as never,
      },
    },
    directoryContext: {} as never,
    instructions: new InstructionsService(
      createFakeInstructionRepository(instructionStore, OWNER_ID),
    ),
    assignments: new AssignmentsService(assignmentStore),
    harness: {} as never,
  };

  return { services, tasks, comments };
}

function ctx(overrides: Partial<FacadeContext> = {}): FacadeContext {
  return { ownerId: OWNER_ID, projectId: PROJECT_ID, permission: 'read_only', ...overrides };
}

function makeTask(overrides: Partial<FakeTaskRow> & Pick<FakeTaskRow, 'id'>): FakeTaskRow {
  return {
    owner_id: OWNER_ID,
    project_id: PROJECT_ID,
    parent_task_id: null,
    title: overrides.id,
    description: '',
    status: 'backlog',
    priority: 0,
    due_at: null,
    archived_at: null,
    created_at: '2026-09-09T00:00:00.000Z',
    updated_at: '2026-09-09T00:00:00.000Z',
    revision: 1,
    ...overrides,
  };
}

describe('agentAccess facade', () => {
  describe('get_project_context', () => {
    it('reports project, assignments, permitted operations, and a bounded task summary', async () => {
      const { services } = buildServices({
        tasks: [makeTask({ id: 't1', status: 'backlog' }), makeTask({ id: 't2', status: 'done' })],
      });
      const result = (await callFacadeTool(services, ctx(), 'get_project_context', {})) as {
        project: { id: string };
        assignments: Array<{ role: string; provider: string }>;
        permittedOperations: string[];
        taskSummary: { total: number; byStatus: Record<string, number> };
      };
      expect(result.project.id).toBe(PROJECT_ID);
      expect(result.assignments).toHaveLength(3);
      expect(result.permittedOperations).not.toContain('create_task');
      expect(result.taskSummary.total).toBe(2);
      expect(result.taskSummary.byStatus).toEqual({ backlog: 1, done: 1 });
    });

    it('includes task-write tools in permittedOperations only for a task_write connection', async () => {
      const { services } = buildServices();
      const result = (await callFacadeTool(
        services,
        ctx({ permission: 'task_write' }),
        'get_project_context',
        {},
      )) as {
        permittedOperations: string[];
      };
      expect(result.permittedOperations).toContain('create_task');
      expect(result.permittedOperations).toContain('update_task');
      expect(result.permittedOperations).toContain('add_comment');
    });

    it('rejects a taskId from a different project', async () => {
      const { services } = buildServices({
        tasks: [makeTask({ id: 't1', project_id: 'other-project' })],
      });
      await expect(
        callFacadeTool(services, ctx(), 'get_project_context', { taskId: 't1' }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  describe('list_tasks', () => {
    it('filters by status and parentTaskId', async () => {
      const { services } = buildServices({
        tasks: [
          makeTask({ id: 'root', status: 'backlog' }),
          makeTask({ id: 'child', parent_task_id: 'root', status: 'done' }),
          makeTask({ id: 'other', status: 'done' }),
        ],
      });
      const result = (await callFacadeTool(services, ctx(), 'list_tasks', { status: 'done' })) as {
        tasks: Array<{ id: string }>;
      };
      expect(result.tasks.map((t) => t.id).sort()).toEqual(['child', 'other']);
    });

    it('paginates with a stable cursor and reports nextCursor until exhausted', async () => {
      const tasks = Array.from({ length: 5 }, (_, i) => makeTask({ id: `t${i}` }));
      const { services } = buildServices({ tasks });
      const page1 = (await callFacadeTool(services, ctx(), 'list_tasks', { limit: 2 })) as {
        tasks: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(page1.tasks).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = (await callFacadeTool(services, ctx(), 'list_tasks', {
        limit: 2,
        cursor: page1.nextCursor,
      })) as { tasks: Array<{ id: string }>; nextCursor: string | null };
      expect(page2.tasks).toHaveLength(2);
      expect(page2.tasks[0].id).not.toBe(page1.tasks[0].id);

      const page3 = (await callFacadeTool(services, ctx(), 'list_tasks', {
        limit: 2,
        cursor: page2.nextCursor,
      })) as { tasks: Array<{ id: string }>; nextCursor: string | null };
      expect(page3.tasks).toHaveLength(1);
      expect(page3.nextCursor).toBeNull();
    });
  });

  describe('get_task', () => {
    it('returns the task, its parent, children, and comments', async () => {
      const { services } = buildServices({
        tasks: [makeTask({ id: 'root' }), makeTask({ id: 'child', parent_task_id: 'root' })],
        comments: [
          {
            id: 'c1',
            owner_id: OWNER_ID,
            task_id: 'root',
            project_id: PROJECT_ID,
            body: 'hi',
            created_at: '2026-09-09T00:00:00.000Z',
            updated_at: '2026-09-09T00:00:00.000Z',
          },
        ],
      });
      const result = (await callFacadeTool(services, ctx(), 'get_task', { taskId: 'root' })) as {
        task: { id: string };
        children: { items: Array<{ id: string }> };
        comments: Array<{ body: string }>;
      };
      expect(result.task.id).toBe('root');
      expect(result.children.items.map((c) => c.id)).toEqual(['child']);
      expect(result.comments).toEqual([
        { id: 'c1', taskId: 'root', body: 'hi', createdAt: '2026-09-09T00:00:00.000Z' },
      ]);
    });

    it('throws not_found for an unknown or wrong-project task id, never leaking existence', async () => {
      const { services } = buildServices({
        tasks: [makeTask({ id: 't1', project_id: 'other-project' })],
      });
      await expect(
        callFacadeTool(services, ctx(), 'get_task', { taskId: 't1' }),
      ).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(
        callFacadeTool(services, ctx(), 'get_task', { taskId: 'missing' }),
      ).rejects.toMatchObject({
        code: 'not_found',
      });
    });
  });

  describe('get_instructions', () => {
    it('reports base provenance for both layers when nothing owner-authored is selected', async () => {
      const { services } = buildServices();
      const result = (await callFacadeTool(services, ctx(), 'get_instructions', {
        role: 'worker',
      })) as {
        provider: string;
        assignmentSource: string;
        layers: Array<{ layer: string; source: string; content: string | null }>;
      };
      expect(result.provider).toBe('claude_code');
      expect(result.assignmentSource).toBe('assignment_derived');
      const shared = result.layers.find((l) => l.layer === 'shared_role')!;
      const provider = result.layers.find((l) => l.layer === 'provider')!;
      const override = result.layers.find((l) => l.layer === 'project_override')!;
      expect(shared.source).toBe('base');
      expect(provider.source).toBe('base');
      expect(override.source).toBe('absent');
      expect(override.content).toBeNull();
    });

    it('reports an explicit provider and flags a mismatch against the project assignment', async () => {
      const { services } = buildServices();
      const result = (await callFacadeTool(services, ctx(), 'get_instructions', {
        role: 'worker',
        provider: 'codex',
      })) as {
        provider: string;
        assignmentSource: string;
        assignmentMismatch: { requestedProvider: string; assignedProvider: string } | null;
      };
      expect(result.provider).toBe('codex');
      expect(result.assignmentSource).toBe('explicit');
      expect(result.assignmentMismatch).toEqual({
        requestedProvider: 'codex',
        assignedProvider: 'claude_code',
      });
    });

    it('reports owner provenance and exact content after a project override is saved', async () => {
      const { services } = buildServices();
      await services.instructions.saveAndActivate({
        projectId: PROJECT_ID,
        role: 'worker',
        provider: 'claude_code',
        layer: 'project_override',
        content: 'Custom worker guidance',
      });
      const result = (await callFacadeTool(services, ctx(), 'get_instructions', {
        role: 'worker',
      })) as {
        layers: Array<{ layer: string; source: string; content: string | null }>;
        effectiveContent: string;
      };
      const override = result.layers.find((l) => l.layer === 'project_override')!;
      expect(override.source).toBe('owner');
      expect(override.content).toBe('Custom worker guidance');
      expect(result.effectiveContent).toContain('Custom worker guidance');
    });

    it('distinguishes an absent override from one explicitly saved as an empty string', async () => {
      const { services } = buildServices();
      await services.instructions.saveAndActivate({
        projectId: PROJECT_ID,
        role: 'worker',
        provider: 'claude_code',
        layer: 'project_override',
        content: '',
      });
      const result = (await callFacadeTool(services, ctx(), 'get_instructions', {
        role: 'worker',
      })) as {
        layers: Array<{ layer: string; source: string; content: string | null }>;
      };
      const override = result.layers.find((l) => l.layer === 'project_override')!;
      expect(override.source).toBe('owner');
      expect(override.content).toBe('');
    });

    it('includes validated task context separately from instruction text, never as a fabricated scope', async () => {
      const { services } = buildServices({
        tasks: [makeTask({ id: 't1', title: 'Fix bug', description: 'details' })],
      });
      const result = (await callFacadeTool(services, ctx(), 'get_instructions', {
        role: 'worker',
        taskId: 't1',
      })) as {
        taskInstructionScope: string;
        taskContext: { taskId: string; title: string } | null;
      };
      expect(result.taskInstructionScope).toBe('not_supported');
      expect(result.taskContext).toEqual({
        taskId: 't1',
        title: 'Fix bug',
        description: 'details',
      });
    });

    it('rejects an invalid role before touching any repository', async () => {
      const { services } = buildServices();
      await expect(
        callFacadeTool(services, ctx(), 'get_instructions', { role: 'not-a-role' }),
      ).rejects.toMatchObject({ code: 'invalid_params' });
    });
  });

  describe('list_instruction_versions / get_instruction_version', () => {
    it('lists owner versions newest first and marks the active one', async () => {
      const { services } = buildServices();
      const { version: v1 } = await services.instructions.saveAndActivate({
        projectId: PROJECT_ID,
        role: 'worker',
        provider: 'claude_code',
        layer: 'project_override',
        content: 'v1',
      });
      const { version: v2 } = await services.instructions.saveAndActivate({
        projectId: PROJECT_ID,
        role: 'worker',
        provider: 'claude_code',
        layer: 'project_override',
        content: 'v2',
      });
      const result = (await callFacadeTool(services, ctx(), 'list_instruction_versions', {
        role: 'worker',
        provider: 'claude_code',
        layer: 'project_override',
      })) as { versions: Array<{ id: string; active: boolean }> };
      expect(result.versions.map((v) => v.id)).toEqual([v2.id, v1.id]);
      expect(result.versions.find((v) => v.id === v2.id)!.active).toBe(true);
      expect(result.versions.find((v) => v.id === v1.id)!.active).toBe(false);
    });

    it('fetches one immutable version by id with its provenance', async () => {
      const { services } = buildServices();
      const { version } = await services.instructions.saveAndActivate({
        projectId: PROJECT_ID,
        role: 'worker',
        provider: 'claude_code',
        layer: 'project_override',
        content: 'hello',
      });
      const result = (await callFacadeTool(services, ctx(), 'get_instruction_version', {
        versionId: version.id,
      })) as { content: string; source: string };
      expect(result.content).toBe('hello');
      expect(result.source).toBe('owner');
    });

    it('throws not_found for an unrelated version id', async () => {
      const { services } = buildServices();
      await expect(
        callFacadeTool(services, ctx(), 'get_instruction_version', { versionId: 'nonexistent' }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  describe('write tools require task_write permission', () => {
    it('create_task, update_task, and add_comment all reject a read-only connection', async () => {
      const { services } = buildServices({ tasks: [makeTask({ id: 't1' })] });
      await expect(
        callFacadeTool(services, ctx(), 'create_task', { title: 'x', requestId: 'r1' }),
      ).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(
        callFacadeTool(services, ctx(), 'update_task', {
          taskId: 't1',
          expectedRevision: 1,
          requestId: 'r1',
        }),
      ).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(
        callFacadeTool(services, ctx(), 'add_comment', {
          taskId: 't1',
          text: 'hi',
          requestId: 'r1',
        }),
      ).rejects.toMatchObject({ code: 'permission_denied' });
    });
  });

  describe('create_task', () => {
    it('creates a task in the bound project, defaulting to backlog', async () => {
      const { services, tasks } = buildServices();
      const result = (await callFacadeTool(
        services,
        ctx({ permission: 'task_write' }),
        'create_task',
        {
          title: 'New task',
          requestId: 'req-1',
        },
      )) as { task: { title: string; status: string; projectId: string } };
      expect(result.task.title).toBe('New task');
      expect(result.task.status).toBe('backlog');
      expect(result.task.projectId).toBe(PROJECT_ID);
      expect(tasks).toHaveLength(1);
    });

    it('validates a given parentTaskId belongs to the bound project', async () => {
      const { services } = buildServices({
        tasks: [makeTask({ id: 'p1', project_id: 'other-project' })],
      });
      await expect(
        callFacadeTool(services, ctx({ permission: 'task_write' }), 'create_task', {
          title: 'New task',
          parentTaskId: 'p1',
          requestId: 'req-1',
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  describe('update_task', () => {
    it('updates title/description/status and returns the new revision', async () => {
      const { services } = buildServices({ tasks: [makeTask({ id: 't1', title: 'Old' })] });
      const result = (await callFacadeTool(
        services,
        ctx({ permission: 'task_write' }),
        'update_task',
        {
          taskId: 't1',
          expectedRevision: 1,
          requestId: 'req-1',
          title: 'New',
          status: 'in_progress',
        },
      )) as { task: { title: string; status: string; revision: number } };
      expect(result.task).toMatchObject({ title: 'New', status: 'in_progress', revision: 2 });
    });

    it('rejects an owner-only status transition', async () => {
      const { services } = buildServices({ tasks: [makeTask({ id: 't1' })] });
      await expect(
        callFacadeTool(services, ctx({ permission: 'task_write' }), 'update_task', {
          taskId: 't1',
          expectedRevision: 1,
          requestId: 'req-1',
          status: 'shipped',
        }),
      ).rejects.toMatchObject({ code: 'invalid_status' });
    });

    it('maps a stale expectedRevision into a revision_conflict error carrying the current task', async () => {
      const { services } = buildServices({ tasks: [makeTask({ id: 't1', title: 'Current' })] });
      await expect(
        callFacadeTool(services, ctx({ permission: 'task_write' }), 'update_task', {
          taskId: 't1',
          expectedRevision: 99,
          requestId: 'req-1',
          title: 'Attempt',
        }),
      ).rejects.toMatchObject({
        code: 'revision_conflict',
        data: { currentTask: { title: 'Current', revision: 1 } },
      });
    });

    it('rejects a taskId from a different project without mutating anything', async () => {
      const { services, tasks } = buildServices({
        tasks: [makeTask({ id: 't1', project_id: 'other-project' })],
      });
      await expect(
        callFacadeTool(services, ctx({ permission: 'task_write' }), 'update_task', {
          taskId: 't1',
          expectedRevision: 1,
          requestId: 'req-1',
          title: 'Hijack',
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(tasks[0].title).not.toBe('Hijack');
    });
  });

  describe('add_comment', () => {
    it('appends a comment to a task in the bound project', async () => {
      const { services, comments } = buildServices({ tasks: [makeTask({ id: 't1' })] });
      const result = (await callFacadeTool(
        services,
        ctx({ permission: 'task_write' }),
        'add_comment',
        {
          taskId: 't1',
          text: 'Progress update',
          requestId: 'req-1',
        },
      )) as { comment: { body: string; taskId: string } };
      expect(result.comment).toMatchObject({ body: 'Progress update', taskId: 't1' });
      expect(comments).toHaveLength(1);
    });
  });

  describe('unknown tool', () => {
    it('is rejected before any repository call', async () => {
      const { services } = buildServices();
      await expect(callFacadeTool(services, ctx(), 'delete_everything', {})).rejects.toMatchObject({
        code: 'unknown_tool',
      });
    });
  });
});

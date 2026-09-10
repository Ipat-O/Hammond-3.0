import { AgentAccessError } from './errors';
import { OperationRegistry, operationRegistry } from './registry';
import { createTestDeps, seedProjectWithDefaults } from './testFakes';
import { createFakeDirectoryContextServices } from '../settings/testFakes';

const HARNESS_ROOT = '/fake/root';

describe('agent-access operation registry: listing/dispatch', () => {
  it('rejects an unknown operation name without touching any dependency', async () => {
    const { deps } = createTestDeps();
    await expect(operationRegistry.invoke(deps, 'nope.doesNotExist', {})).rejects.toMatchObject({
      code: 'unknown_operation',
    });
  });

  it('rejects input that fails schema validation before the handler ever runs', async () => {
    const { deps } = createTestDeps();
    await expect(
      operationRegistry.invoke(deps, 'projects.create', { name: '' }),
    ).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('every listed operation carries a name, description, and a JSON Schema input schema', () => {
    const summaries = operationRegistry.listSummaries();
    expect(summaries.length).toBeGreaterThan(20);
    for (const summary of summaries) {
      expect(summary.name).toMatch(/^[a-zA-Z]+\.[a-zA-Z]+$/);
      expect(summary.description.length).toBeGreaterThan(0);
      expect(summary.inputSchema).toBeTruthy();
    }
    const names = summaries.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('refuses to construct a registry with a duplicate operation name', () => {
    const [first] = operationRegistry.listSummaries();
    const definition = {
      name: first.name,
      description: 'dup',
      inputSchema: {} as never,
      handler: async () => null,
    };
    expect(() => new OperationRegistry([definition, definition])).toThrow(/Duplicate/);
  });
});

describe('projects operations', () => {
  it('create, get, update, archive, delete round-trip', async () => {
    const { deps } = createTestDeps();
    const created = (await operationRegistry.invoke(deps, 'projects.create', {
      name: 'Test project',
      description: 'd',
    })) as { id: string };

    const fetched = await operationRegistry.invoke(deps, 'projects.get', { projectId: created.id });
    expect(fetched).toMatchObject({ id: created.id, name: 'Test project' });

    const updated = (await operationRegistry.invoke(deps, 'projects.update', {
      projectId: created.id,
      name: 'Renamed',
    })) as { name: string };
    expect(updated.name).toBe('Renamed');

    const archived = (await operationRegistry.invoke(deps, 'projects.archive', {
      projectId: created.id,
    })) as { archived_at: string | null };
    expect(archived.archived_at).not.toBeNull();

    await operationRegistry.invoke(deps, 'projects.delete', { projectId: created.id });
    await expect(
      operationRegistry.invoke(deps, 'projects.get', { projectId: created.id }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('paginates projects.list without omitting or duplicating rows across pages', async () => {
    const { deps } = createTestDeps();
    for (let i = 0; i < 5; i += 1) {
      await operationRegistry.invoke(deps, 'projects.create', { name: `Project ${i}` });
    }

    const page1 = (await operationRegistry.invoke(deps, 'projects.list', { limit: 2 })) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = (await operationRegistry.invoke(deps, 'projects.list', {
      limit: 2,
      cursor: page1.nextCursor,
    })) as { items: { id: string }[]; nextCursor: string | null };
    expect(page2.items).toHaveLength(2);

    const page3 = (await operationRegistry.invoke(deps, 'projects.list', {
      limit: 2,
      cursor: page2.nextCursor,
    })) as { items: { id: string }[]; nextCursor: string | null };
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const seenIds = [...page1.items, ...page2.items, ...page3.items].map((p) => p.id);
    expect(new Set(seenIds).size).toBe(5);
  });

  it('rejects an update with neither name nor description', async () => {
    const { deps } = createTestDeps();
    const created = (await operationRegistry.invoke(deps, 'projects.create', { name: 'P' })) as {
      id: string;
    };
    await expect(
      operationRegistry.invoke(deps, 'projects.update', { projectId: created.id }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('tasks operations', () => {
  async function createProject(deps: ReturnType<typeof createTestDeps>['deps']) {
    return (await operationRegistry.invoke(deps, 'projects.create', { name: 'P' })) as {
      id: string;
    };
  }

  it('creates a nested task, edits its status/hierarchy, and archives the whole subtree', async () => {
    const { deps } = createTestDeps();
    const project = await createProject(deps);

    const parent = (await operationRegistry.invoke(deps, 'tasks.create', {
      projectId: project.id,
      title: 'Parent',
    })) as { id: string };
    const child = (await operationRegistry.invoke(deps, 'tasks.create', {
      projectId: project.id,
      title: 'Child',
      parentTaskId: parent.id,
    })) as { id: string };

    const updated = (await operationRegistry.invoke(deps, 'tasks.update', {
      taskId: child.id,
      status: 'in_progress',
    })) as { status: string };
    expect(updated.status).toBe('in_progress');

    const archived = (await operationRegistry.invoke(deps, 'tasks.archive', {
      taskId: parent.id,
    })) as {
      id: string;
    }[];
    const archivedIds = archived.map((t) => t.id);
    expect(archivedIds).toContain(parent.id);
    expect(archivedIds).toContain(child.id);
  });

  it('rejects a hierarchy edit that would create a cycle, exactly like the existing UI path', async () => {
    const { deps } = createTestDeps();
    const project = await createProject(deps);
    const a = (await operationRegistry.invoke(deps, 'tasks.create', {
      projectId: project.id,
      title: 'A',
    })) as {
      id: string;
    };
    const b = (await operationRegistry.invoke(deps, 'tasks.create', {
      projectId: project.id,
      title: 'B',
      parentTaskId: a.id,
    })) as { id: string };

    await expect(
      operationRegistry.invoke(deps, 'tasks.update', { taskId: a.id, parentTaskId: b.id }),
    ).rejects.toThrow(/cycle/);
  });

  it('deletes a task', async () => {
    const { deps } = createTestDeps();
    const project = await createProject(deps);
    const task = (await operationRegistry.invoke(deps, 'tasks.create', {
      projectId: project.id,
      title: 'T',
    })) as {
      id: string;
    };
    await operationRegistry.invoke(deps, 'tasks.delete', { taskId: task.id });
    await expect(
      operationRegistry.invoke(deps, 'tasks.get', { taskId: task.id }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('comments operations', () => {
  it('paginates a thread with equal timestamps without omitting or duplicating any comment', async () => {
    const { deps } = createTestDeps();
    const project = (await operationRegistry.invoke(deps, 'projects.create', { name: 'P' })) as {
      id: string;
    };
    const task = (await operationRegistry.invoke(deps, 'tasks.create', {
      projectId: project.id,
      title: 'T',
    })) as { id: string };

    // Every comment shares the exact same created_at — the scenario the (created_at, id)
    // keyset tiebreaker exists for.
    const sameInstant = '2026-01-01T00:00:00.000Z';
    for (let i = 0; i < 7; i += 1) {
      await operationRegistry.invoke(deps, 'comments.add', {
        taskId: task.id,
        projectId: project.id,
        body: `comment-${i}`,
      });
    }

    // The fake client stamps `created_at` at insert time (each call a tick apart); normalize
    // every row to the same instant afterward to simulate comments saved simultaneously.
    const rawComments = (await operationRegistry.invoke(deps, 'comments.listForTask', {
      taskId: task.id,
      limit: 100,
    })) as { items: { id: string; created_at: string }[] };
    for (const comment of rawComments.items) {
      comment.created_at = sameInstant;
    }

    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = (await operationRegistry.invoke(deps, 'comments.listForTask', {
        taskId: task.id,
        limit: 3,
        cursor: cursor ?? undefined,
      })) as { items: { id: string }[]; nextCursor: string | null };
      seen.push(...page.items.map((c) => c.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('retrieves a comment by id with its correct task/project/body', async () => {
    const { deps } = createTestDeps();
    const project = (await operationRegistry.invoke(deps, 'projects.create', { name: 'P' })) as {
      id: string;
    };
    const task = (await operationRegistry.invoke(deps, 'tasks.create', {
      projectId: project.id,
      title: 'T',
    })) as { id: string };
    const comment = (await operationRegistry.invoke(deps, 'comments.add', {
      taskId: task.id,
      projectId: project.id,
      body: 'hello',
    })) as { id: string };

    const fetched = await operationRegistry.invoke(deps, 'comments.get', { commentId: comment.id });
    expect(fetched).toMatchObject({
      id: comment.id,
      task_id: task.id,
      project_id: project.id,
      body: 'hello',
    });
  });
});

describe('project/task target consistency (HAM3-015 Correction 1, F6)', () => {
  // Persistence-level guarantee: `comments`, `task_relations`, and `task_evidence` each carry a
  // composite `(task_id, owner_id, project_id)` FK onto `tasks(id, owner_id, project_id)` (and
  // `task_relations` a second one for `related_task_id`) — see
  // supabase/migrations/20260813075651_create_project_memory_schema.sql lines 20-32, 53-58 — so a
  // mismatched row cannot be inserted at all. These tests cover the service-layer pre-check that
  // turns that into a clean `validation_error` (400) instead of a raw constraint 500, and proves
  // nothing is persisted on the mismatch path.
  async function twoProjectsOneTask(deps: ReturnType<typeof createTestDeps>['deps']) {
    const projectA = (await operationRegistry.invoke(deps, 'projects.create', { name: 'A' })) as {
      id: string;
    };
    const projectB = (await operationRegistry.invoke(deps, 'projects.create', { name: 'B' })) as {
      id: string;
    };
    const taskInA = (await operationRegistry.invoke(deps, 'tasks.create', {
      projectId: projectA.id,
      title: 'T',
    })) as { id: string };
    return { projectA, projectB, taskInA };
  }

  it('comments.add rejects a taskId that belongs to a different project and persists nothing', async () => {
    const { deps, tables } = createTestDeps();
    const { projectB, taskInA } = await twoProjectsOneTask(deps);

    await expect(
      operationRegistry.invoke(deps, 'comments.add', {
        taskId: taskInA.id,
        projectId: projectB.id,
        body: 'mismatched',
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(tables.comments ?? []).toHaveLength(0);
  });

  it('comments.add reports an unknown/foreign task as not_found, never as a consistency error', async () => {
    const { deps } = createTestDeps();
    const project = (await operationRegistry.invoke(deps, 'projects.create', { name: 'P' })) as {
      id: string;
    };
    await expect(
      operationRegistry.invoke(deps, 'comments.add', {
        taskId: '00000000-0000-4000-8000-999999999999',
        projectId: project.id,
        body: 'x',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('context.addRelation requires BOTH tasks to belong to the given project', async () => {
    const { deps, tables } = createTestDeps();
    const { projectA, projectB, taskInA } = await twoProjectsOneTask(deps);
    const otherInA = (await operationRegistry.invoke(deps, 'tasks.create', {
      projectId: projectA.id,
      title: 'U',
    })) as { id: string };

    // Right project, but relatedTaskId lives in a project with no such task -> not_found.
    await expect(
      operationRegistry.invoke(deps, 'context.addRelation', {
        taskId: taskInA.id,
        projectId: projectA.id,
        relatedTaskId: '00000000-0000-4000-8000-777777777777',
        kind: 'relates_to',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    // Both tasks real and owned, but the project pointer is wrong -> validation_error.
    await expect(
      operationRegistry.invoke(deps, 'context.addRelation', {
        taskId: taskInA.id,
        projectId: projectB.id,
        relatedTaskId: otherInA.id,
        kind: 'relates_to',
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(tables.task_relations ?? []).toHaveLength(0);

    // Consistent -> persists.
    const relation = (await operationRegistry.invoke(deps, 'context.addRelation', {
      taskId: taskInA.id,
      projectId: projectA.id,
      relatedTaskId: otherInA.id,
      kind: 'relates_to',
    })) as { id: string };
    expect(relation.id).toBeTruthy();
  });

  it('context.addEvidence and context.recordActivity reject a cross-project taskId', async () => {
    const { deps, tables } = createTestDeps();
    const { projectB, taskInA } = await twoProjectsOneTask(deps);

    await expect(
      operationRegistry.invoke(deps, 'context.addEvidence', {
        taskId: taskInA.id,
        projectId: projectB.id,
        kind: 'note',
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(
      operationRegistry.invoke(deps, 'context.recordActivity', {
        taskId: taskInA.id,
        projectId: projectB.id,
        eventType: 'progress',
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(tables.task_evidence ?? []).toHaveLength(0);
  });
});

describe('instructions prepare/inject separation', () => {
  it('instructions.prepare saves and activates content without touching any harness file', async () => {
    const { deps } = createTestDeps();
    const project = (await operationRegistry.invoke(deps, 'projects.create', { name: 'P' })) as {
      id: string;
    };

    const result = (await operationRegistry.invoke(deps, 'instructions.prepare', {
      projectId: project.id,
      role: 'worker',
      provider: 'claude_code',
      layer: 'project_override',
      content: 'Prepared instructions body',
    })) as { version: { content: string }; selection: unknown };
    expect(result.version.content).toBe('Prepared instructions body');

    const effective = (await operationRegistry.invoke(deps, 'instructions.getEffective', {
      projectId: project.id,
      role: 'worker',
      provider: 'claude_code',
    })) as { layers: { projectOverride: string } };
    expect(effective.layers.projectOverride).toBe('Prepared instructions body');
  });

  it('harness.inject refuses a stale preview and returns a fresh one instead of writing', async () => {
    const testDeps = createTestDeps();
    const { deps } = testDeps;
    const project = (await operationRegistry.invoke(deps, 'projects.create', { name: 'P' })) as {
      id: string;
    };
    seedProjectWithDefaults(testDeps, project.id);

    const staleGuess = {
      root: HARNESS_ROOT,
      projectId: project.id,
      role: 'worker' as const,
      expectedSharedRoleVersionId: 'not-the-real-one',
      expectedProviderVersionId: 'not-the-real-one',
      expectedOverrideVersionId: null,
      expectedClassificationKind: 'Missing' as const,
      expectedTargetDigest: null,
    };

    let caught: unknown;
    try {
      await operationRegistry.invoke(deps, 'harness.inject', staleGuess);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentAccessError);
    expect((caught as AgentAccessError).code).toBe('stale_preview');
    expect((caught as AgentAccessError).details).toMatchObject({ preview: { role: 'worker' } });
  });

  it('harness.inject writes once the caller supplies the exact fields a fresh preview returned', async () => {
    const testDeps = createTestDeps();
    const { deps } = testDeps;
    const project = (await operationRegistry.invoke(deps, 'projects.create', { name: 'P' })) as {
      id: string;
    };
    seedProjectWithDefaults(testDeps, project.id);

    const preview = (await operationRegistry.invoke(deps, 'harness.preview', {
      root: HARNESS_ROOT,
      projectId: project.id,
      role: 'worker',
    })) as {
      classification: { kind: string };
      generatedHeader: {
        sharedRoleVersionId: string;
        providerVersionId: string;
        overrideVersionId: string | null;
      };
      targetDigest: string | null;
    };
    expect(preview.classification.kind).toBe('Missing');

    const outcome = (await operationRegistry.invoke(deps, 'harness.inject', {
      root: HARNESS_ROOT,
      projectId: project.id,
      role: 'worker',
      expectedSharedRoleVersionId: preview.generatedHeader.sharedRoleVersionId,
      expectedProviderVersionId: preview.generatedHeader.providerVersionId,
      expectedOverrideVersionId: preview.generatedHeader.overrideVersionId,
      expectedClassificationKind: preview.classification.kind,
      expectedTargetDigest: preview.targetDigest,
    })) as { kind: string };
    expect(outcome.kind).toBe('Written');
  });

  it('harness.inject refuses when only the target file BYTES changed since preview — same classification, same versions (HAM3-015 Correction 1, F7)', async () => {
    const testDeps = createTestDeps();
    const { deps, harnessFs } = testDeps;
    const project = (await operationRegistry.invoke(deps, 'projects.create', { name: 'P' })) as {
      id: string;
    };
    seedProjectWithDefaults(testDeps, project.id);

    type Preview = {
      classification: { kind: string };
      generatedHeader: {
        sharedRoleVersionId: string;
        providerVersionId: string;
        overrideVersionId: string | null;
      };
      targetDigest: string | null;
    };
    const currentPreview = () =>
      operationRegistry.invoke(deps, 'harness.preview', {
        root: HARNESS_ROOT,
        projectId: project.id,
        role: 'worker',
      }) as Promise<Preview>;
    const injectArgs = (preview: Preview) => ({
      root: HARNESS_ROOT,
      projectId: project.id,
      role: 'worker' as const,
      expectedSharedRoleVersionId: preview.generatedHeader.sharedRoleVersionId,
      expectedProviderVersionId: preview.generatedHeader.providerVersionId,
      expectedOverrideVersionId: preview.generatedHeader.overrideVersionId,
      expectedClassificationKind: preview.classification.kind,
      expectedTargetDigest: preview.targetDigest,
    });

    // First inject creates the managed file (Missing -> ManagedValid).
    await operationRegistry.invoke(deps, 'harness.inject', injectArgs(await currentPreview()));

    // Capture a preview of the now-ManagedValid file, then a human hand-edits its body — the
    // classification stays ManagedValid and no instruction version changed.
    const capturedPreview = await currentPreview();
    expect(capturedPreview.classification.kind).toBe('ManagedValid');
    expect(capturedPreview.targetDigest).not.toBeNull();

    const targetKey = `${HARNESS_ROOT}|claude_code`;
    const existing = harnessFs.targets.get(targetKey);
    if (!existing || existing.content === null)
      throw new Error('expected a written managed target');
    harnessFs.targets.set(targetKey, {
      ...existing,
      content: `${existing.content}\n\n<!-- a human appended this note -->`,
    });

    // Injecting with the captured (now byte-stale) preview must be refused, not silently
    // overwrite the human edit.
    await expect(
      operationRegistry.invoke(deps, 'harness.inject', injectArgs(capturedPreview)),
    ).rejects.toMatchObject({ code: 'stale_preview' });

    // Re-previewing and injecting with the fresh digest succeeds (explicit, reviewed update).
    const outcome = (await operationRegistry.invoke(
      deps,
      'harness.inject',
      injectArgs(await currentPreview()),
    )) as { kind: string };
    expect(outcome.kind).toBe('Written');
  });
});

describe('assignments.update', () => {
  it('changes a role (including orchestrator) and records the before/after in project activity', async () => {
    const testDeps = createTestDeps();
    const { deps } = testDeps;
    const project = (await operationRegistry.invoke(deps, 'projects.create', { name: 'P' })) as {
      id: string;
    };
    seedProjectWithDefaults(testDeps, project.id);

    const result = (await operationRegistry.invoke(deps, 'assignments.update', {
      projectId: project.id,
      role: 'orchestrator',
      provider: 'codex',
    })) as { assignment: { provider: string }; activityLogged: boolean };
    expect(result.assignment.provider).toBe('codex');
    expect(result.activityLogged).toBe(true);

    const activity = (await operationRegistry.invoke(deps, 'context.listActivity', {
      projectId: project.id,
    })) as { items: { event_type: string; details: unknown }[] };
    expect(activity.items.some((entry) => entry.event_type === 'assignment_updated')).toBe(true);
  });

  it('never claims rollback of an already-committed assignment when the activity write fails', async () => {
    const testDeps = createTestDeps();
    const { deps } = testDeps;
    const project = (await operationRegistry.invoke(deps, 'projects.create', { name: 'P' })) as {
      id: string;
    };
    seedProjectWithDefaults(testDeps, project.id);

    const originalRecordActivity = deps.memory.recordActivity.bind(deps.memory);
    deps.memory.recordActivity = async () => {
      throw new Error('simulated activity-log failure');
    };

    const result = (await operationRegistry.invoke(deps, 'assignments.update', {
      projectId: project.id,
      role: 'worker',
      provider: 'kilo_code',
    })) as { assignment: { provider: string }; activityLogged: boolean; activityError: string };

    expect(result.assignment.provider).toBe('kilo_code');
    expect(result.activityLogged).toBe(false);
    expect(result.activityError).toMatch(/simulated activity-log failure/);

    deps.memory.recordActivity = originalRecordActivity;
    const confirm = (await operationRegistry.invoke(deps, 'assignments.get', {
      projectId: project.id,
      role: 'worker',
    })) as { provider: string };
    expect(confirm.provider).toBe('kilo_code');
  });
});

describe('local contexts operations', () => {
  it('links, lists, and forgets a directory binding', async () => {
    const { deps } = createTestDeps();
    const project = (await operationRegistry.invoke(deps, 'projects.create', { name: 'P' })) as {
      id: string;
    };

    const context = (await operationRegistry.invoke(deps, 'localContexts.link', {
      projectId: project.id,
      path: '/home/owner/repo',
    })) as { id: string; path: string };
    expect(context.path).toBe('/home/owner/repo');

    const listed = (await operationRegistry.invoke(deps, 'localContexts.list', {
      projectId: project.id,
    })) as { contexts: { id: string }[] };
    expect(listed.contexts.map((c) => c.id)).toContain(context.id);

    await operationRegistry.invoke(deps, 'localContexts.forget', { contextId: context.id });
    const afterForget = (await operationRegistry.invoke(deps, 'localContexts.list', {
      projectId: project.id,
    })) as { contexts: { id: string }[] };
    expect(afterForget.contexts.map((c) => c.id)).not.toContain(context.id);
  });

  it('two concurrent localContexts.link calls with the first disk write deferred keep both bindings (HAM3-015 Correction 1, F2)', async () => {
    const store = new Map<string, unknown>();
    let writeCount = 0;
    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstWriteInvoked!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      firstWriteInvoked = resolve;
    });
    const settings = {
      read: async (key: string) => (store.has(key) ? store.get(key) : null),
      write: async (key: string, value: unknown) => {
        writeCount += 1;
        if (writeCount === 1) {
          firstWriteInvoked();
          await firstWriteGate;
        }
        store.set(key, value);
      },
      remove: async (key: string) => {
        store.delete(key);
      },
    } as unknown as ReturnType<typeof createFakeDirectoryContextServices>['settings'];
    const directoryServices = createFakeDirectoryContextServices({ settings });

    const { deps } = createTestDeps({}, directoryServices);

    const linkA = operationRegistry.invoke(deps, 'localContexts.link', {
      projectId: 'project-a',
      path: '/work/a',
    });
    await firstWriteStarted;
    const linkB = operationRegistry.invoke(deps, 'localContexts.link', {
      projectId: 'project-b',
      path: '/work/b',
    });
    releaseFirstWrite();
    await Promise.all([linkA, linkB]);

    const listed = (await operationRegistry.invoke(deps, 'localContexts.resolvePath', {
      path: '/work/a',
    })) as { matches: unknown[] };
    expect(listed.matches).toHaveLength(1);

    // Both survive a genuine reload from disk.
    const reloaded = (await operationRegistry.invoke(deps, 'localContexts.list', {})) as {
      contexts: { path: string }[];
    };
    expect(reloaded.contexts.map((c) => c.path).sort()).toEqual(['/work/a', '/work/b']);
  });
});

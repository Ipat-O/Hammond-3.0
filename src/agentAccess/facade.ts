import {
  composeInstructions,
  INSTRUCTION_LAYERS,
  INSTRUCTION_ROLES,
  PROVIDER_FAMILIES,
  type InstructionLayer,
  type InstructionRole,
  type InstructionTemplate,
  type InstructionVersion,
  type ProviderFamily,
} from '../instructions';
import { TASK_STATUSES, TaskRevisionConflictError, type TaskStatus } from '../data';
import type { TrackerServices } from '../tracker/contracts';
import { paginate } from './pagination';
import {
  AGENT_TOOL_NAMES,
  AGENT_WRITE_TOOL_NAMES,
  DEFAULT_LIST_LIMIT,
  FacadeToolError,
  MAX_LIST_LIMIT,
  type AgentToolName,
  type CommentDto,
  type FacadeContext,
  type GetInstructionsResult,
  type InstructionLayerDto,
  type TaskDto,
  type TaskSummaryDto,
} from './types';

/** Statuses an agent connection may ever set (HAM3-014: "Owner-only merged, shipped, and
 * cancelled transitions are excluded from agent writes"). Reads still report the complete enum. */
const AGENT_WRITABLE_STATUSES: readonly TaskStatus[] = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'done',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new FacadeToolError(
      'invalid_params',
      `'${key}' is required and must be a non-empty string.`,
    );
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new FacadeToolError('invalid_params', `'${key}' must be a string.`);
  }
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FacadeToolError('invalid_params', `'${key}' must be a number.`);
  }
  return value;
}

function clampLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(value)));
}

function requireRole(args: Record<string, unknown>): InstructionRole {
  const value = requireString(args, 'role');
  if (!(INSTRUCTION_ROLES as readonly string[]).includes(value)) {
    throw new FacadeToolError(
      'invalid_params',
      `'role' must be one of ${INSTRUCTION_ROLES.join(', ')}.`,
    );
  }
  return value as InstructionRole;
}

function optionalProvider(
  args: Record<string, unknown>,
  key = 'provider',
): ProviderFamily | undefined {
  const value = optionalString(args, key);
  if (value === undefined) return undefined;
  if (!(PROVIDER_FAMILIES as readonly string[]).includes(value)) {
    throw new FacadeToolError(
      'invalid_params',
      `'${key}' must be one of ${PROVIDER_FAMILIES.join(', ')}.`,
    );
  }
  return value as ProviderFamily;
}

function requireLayer(args: Record<string, unknown>): InstructionLayer {
  const value = requireString(args, 'layer');
  if (!(INSTRUCTION_LAYERS as readonly string[]).includes(value)) {
    throw new FacadeToolError(
      'invalid_params',
      `'layer' must be one of ${INSTRUCTION_LAYERS.join(', ')}.`,
    );
  }
  return value as InstructionLayer;
}

/** `provider` is required for the `provider` and `project_override` layers (both are provider-
 * keyed); optional for `shared_role`, which has none. Shared by `list_instruction_versions` and
 * `get_instruction_version` so both apply the identical scope rule. */
function requireProviderForLayer(
  args: Record<string, unknown>,
  layer: InstructionLayer,
): ProviderFamily | undefined {
  const provider = optionalProvider(args);
  if (layer !== 'shared_role' && provider === undefined) {
    throw new FacadeToolError(
      'invalid_params',
      "'provider' is required for the provider and project_override layers.",
    );
  }
  return provider;
}

/** Verifies `taskId` both exists and belongs to `ctx.projectId` — RLS already confines it to the
 * caller's own owner, but never to a specific project, so this is the facade's own boundary
 * against a wrong-project id leaking or mutating another project's task (HAM3-014: "wrong-project
 * ... record IDs cannot leak or mutate content"). Throws a `not_found` error otherwise, never
 * revealing whether the id exists under a different project. */
async function requireOwnedTask(
  services: TrackerServices,
  ctx: FacadeContext,
  taskId: string,
): Promise<Awaited<ReturnType<TrackerServices['repositories']['tasks']['list']>>[number]> {
  const tasks = await services.repositories.tasks.list(ctx.projectId, { includeArchived: true });
  const task = tasks.find((row) => row.id === taskId);
  if (!task) {
    throw new FacadeToolError('not_found', `No task '${taskId}' in this project.`);
  }
  return task;
}

function toTaskSummaryDto(row: {
  id: string;
  parent_task_id: string | null;
  title: string;
  status: string;
  priority: number;
  archived_at: string | null;
  revision: number;
}): TaskSummaryDto {
  return {
    id: row.id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    archivedAt: row.archived_at,
    revision: row.revision,
  };
}

function toTaskDto(row: {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  title: string;
  description: string;
  status: string;
  priority: number;
  due_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}): TaskDto {
  return {
    ...toTaskSummaryDto(row),
    projectId: row.project_id,
    description: row.description,
    dueAt: row.due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCommentDto(row: {
  id: string;
  task_id: string;
  body: string;
  created_at: string;
}): CommentDto {
  return { id: row.id, taskId: row.task_id, body: row.body, createdAt: row.created_at };
}

function permittedOperations(permission: FacadeContext['permission']): AgentToolName[] {
  if (permission === 'task_write') return [...AGENT_TOOL_NAMES];
  return AGENT_TOOL_NAMES.filter((name) => !AGENT_WRITE_TOOL_NAMES.includes(name));
}

// ---------------------------------------------------------------------------
// get_project_context
// ---------------------------------------------------------------------------

async function getProjectContext(
  services: TrackerServices,
  ctx: FacadeContext,
  args: Record<string, unknown>,
) {
  const taskId = optionalString(args, 'taskId');
  const [projects, tasks, assignments] = await Promise.all([
    services.repositories.projects.list({ includeArchived: true }),
    services.repositories.tasks.list(ctx.projectId, { includeArchived: false }),
    services.assignments.listForProject(ctx.projectId),
  ]);
  const project = projects.find((row) => row.id === ctx.projectId);
  if (!project) {
    throw new FacadeToolError('not_found', 'The bound project no longer exists.');
  }

  let taskContext: TaskDto | null = null;
  if (taskId !== undefined) {
    const task = await requireOwnedTask(services, ctx, taskId);
    taskContext = toTaskDto(task);
  }

  const byStatus: Record<string, number> = {};
  for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;

  return {
    project: { id: project.id, name: project.name, description: project.description },
    validTaskStatuses: TASK_STATUSES,
    agentWritableTaskStatuses: AGENT_WRITABLE_STATUSES,
    assignments: assignments.map((row) => ({ role: row.role, provider: row.provider })),
    permittedOperations: permittedOperations(ctx.permission),
    permission: ctx.permission,
    taskSummary: {
      total: tasks.length,
      byStatus,
      recent: tasks
        .slice()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 10)
        .map(toTaskSummaryDto),
    },
    taskContext,
  };
}

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

async function listTasks(
  services: TrackerServices,
  ctx: FacadeContext,
  args: Record<string, unknown>,
) {
  const includeArchived = args.includeArchived === true;
  const parentTaskId = optionalString(args, 'parentTaskId');
  const status = optionalString(args, 'status');
  const limit = clampLimit(optionalNumber(args, 'limit'));
  const cursor = optionalString(args, 'cursor');

  let tasks = await services.repositories.tasks.list(ctx.projectId, { includeArchived });
  if (parentTaskId !== undefined) {
    tasks = tasks.filter((task) => task.parent_task_id === parentTaskId);
  }
  if (status !== undefined) {
    tasks = tasks.filter((task) => task.status === status);
  }
  tasks = tasks.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));

  const { items, nextCursor } = paginate(tasks, cursor, limit);
  return { tasks: items.map(toTaskSummaryDto), nextCursor };
}

// ---------------------------------------------------------------------------
// get_task
// ---------------------------------------------------------------------------

async function getTask(
  services: TrackerServices,
  ctx: FacadeContext,
  args: Record<string, unknown>,
) {
  const taskId = requireString(args, 'taskId');
  const limit = clampLimit(optionalNumber(args, 'limit'));
  const cursor = optionalString(args, 'cursor');

  const task = await requireOwnedTask(services, ctx, taskId);
  const [allTasks, comments] = await Promise.all([
    services.repositories.tasks.list(ctx.projectId, { includeArchived: true }),
    services.repositories.memory.listComments(taskId),
  ]);
  const children = allTasks
    .filter((row) => row.parent_task_id === taskId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const parent = task.parent_task_id
    ? allTasks.find((row) => row.id === task.parent_task_id)
    : undefined;

  const childrenPage = paginate(children, cursor, limit);

  return {
    task: toTaskDto(task),
    parent: parent ? toTaskSummaryDto(parent) : null,
    children: {
      items: childrenPage.items.map(toTaskSummaryDto),
      nextCursor: childrenPage.nextCursor,
    },
    comments: comments.map(toCommentDto),
  };
}

// ---------------------------------------------------------------------------
// get_instructions
// ---------------------------------------------------------------------------

function layerVersionId(
  selected: {
    sharedRoleVersionId: string;
    providerVersionId: string;
    overrideVersionId: string | null;
  },
  layer: InstructionLayer,
): string | null {
  if (layer === 'shared_role') return selected.sharedRoleVersionId;
  if (layer === 'provider') return selected.providerVersionId;
  return selected.overrideVersionId;
}

function selectionFingerprint(selected: {
  sharedRoleVersionId: string;
  providerVersionId: string;
  overrideVersionId: string | null;
}): string {
  return `${selected.sharedRoleVersionId}:${selected.providerVersionId}:${selected.overrideVersionId ?? ''}`;
}

const GET_INSTRUCTIONS_MAX_ATTEMPTS = 3;

async function getInstructions(
  services: TrackerServices,
  ctx: FacadeContext,
  args: Record<string, unknown>,
): Promise<GetInstructionsResult> {
  const role = requireRole(args);
  const requestedProvider = optionalProvider(args);
  const taskId = optionalString(args, 'taskId');

  let taskContext: GetInstructionsResult['taskContext'] = null;
  if (taskId !== undefined) {
    const task = await requireOwnedTask(services, ctx, taskId);
    taskContext = { taskId: task.id, title: task.title, description: task.description };
  }

  const assignment = await services.assignments.getAssignment({ projectId: ctx.projectId, role });
  const assignedProvider = assignment?.provider ?? null;
  const provider = requestedProvider ?? assignedProvider;
  if (!provider) {
    throw new FacadeToolError(
      'missing_assignment',
      `No provider is assigned to role '${role}' in this project, and none was supplied.`,
    );
  }
  const assignmentSource: GetInstructionsResult['assignmentSource'] =
    requestedProvider === undefined ? 'assignment_derived' : 'explicit';
  const assignmentMismatch =
    requestedProvider !== undefined &&
    assignedProvider !== null &&
    assignedProvider !== requestedProvider
      ? { requestedProvider, assignedProvider }
      : null;

  for (let attempt = 0; attempt < GET_INSTRUCTIONS_MAX_ATTEMPTS; attempt += 1) {
    const before = await services.instructions.resolveActiveVersionIds({
      projectId: ctx.projectId,
      role,
      provider,
    });
    const ids = [
      before.sharedRoleVersionId,
      before.providerVersionId,
      before.overrideVersionId,
    ].filter((id): id is string => id !== null);
    const versions = await services.instructions.getVersionsByIds(ids);
    const byId = new Map(versions.map((version) => [version.id, version]));

    const after = await services.instructions.resolveActiveVersionIds({
      projectId: ctx.projectId,
      role,
      provider,
    });
    if (selectionFingerprint(before) !== selectionFingerprint(after)) {
      continue; // selection changed mid-read; retry against a consistent snapshot
    }

    const layerDescriptors: Array<{ layer: InstructionLayer; scoped: boolean }> = [
      { layer: 'shared_role', scoped: false },
      { layer: 'provider', scoped: false },
      { layer: 'project_override', scoped: true },
    ];
    const layers: InstructionLayerDto[] = [];
    let missingReference = false;
    for (const { layer, scoped } of layerDescriptors) {
      const versionId = layerVersionId(before, layer);
      if (versionId === null) {
        layers.push({
          layer,
          scopeProjectId: scoped ? ctx.projectId : null,
          templateId: null,
          versionId: null,
          versionNumber: null,
          source: 'absent',
          content: null,
          selected: false,
        });
        continue;
      }
      const version = byId.get(versionId);
      if (!version) {
        missingReference = true;
        break;
      }
      layers.push({
        layer,
        scopeProjectId: scoped ? ctx.projectId : null,
        templateId: version.templateId,
        versionId: version.id,
        versionNumber: version.version,
        source: version.ownerId === null ? 'base' : 'owner',
        content: version.content,
        selected: true,
      });
    }
    if (missingReference) {
      throw new FacadeToolError(
        'missing_reference',
        'A referenced instruction version could not be found. This indicates corrupted or ' +
          'concurrently-deleted selection state, not an empty instruction.',
      );
    }

    const contentByLayer = new Map(layers.map((layer) => [layer.layer, layer.content ?? '']));
    const effectiveContent = composeInstructions({
      sharedRole: contentByLayer.get('shared_role') ?? '',
      provider: contentByLayer.get('provider') ?? '',
      projectOverride: contentByLayer.get('project_override') ?? '',
      taskWorkOrder: '',
    });

    return {
      projectId: ctx.projectId,
      taskId: taskId ?? null,
      role,
      provider,
      assignmentSource,
      assignmentMismatch,
      layers,
      effectiveContent,
      selectedVersionIds: before,
      selectionFingerprint: selectionFingerprint(before),
      taskInstructionScope: 'not_supported',
      taskContext,
      fetchedAt: new Date().toISOString(),
      savedConfiguration: true,
    };
  }

  throw new FacadeToolError(
    'context_changed',
    'The instruction selection kept changing while reading it. Retry the call.',
  );
}

// ---------------------------------------------------------------------------
// list_instruction_versions / get_instruction_version
// ---------------------------------------------------------------------------

async function listInstructionVersions(
  services: TrackerServices,
  ctx: FacadeContext,
  args: Record<string, unknown>,
) {
  const role = requireRole(args);
  const layer = requireLayer(args);
  const provider = requireProviderForLayer(args, layer);
  const projectId = layer === 'project_override' ? ctx.projectId : null;
  const limit = clampLimit(optionalNumber(args, 'limit'));
  const cursor = optionalString(args, 'cursor');

  const active = await services.instructions.resolveActiveVersionIds({
    projectId: ctx.projectId,
    role,
    provider: provider ?? (PROVIDER_FAMILIES[0] as ProviderFamily),
  });
  const activeVersionId = layerVersionId(active, layer);

  const versions = await services.instructions.listOwnerVersions({
    role,
    provider: provider ?? null,
    layer,
    projectId,
  });
  const sorted = versions.slice().sort((a, b) => b.version - a.version);
  const { items, nextCursor } = paginate(sorted, cursor, limit);
  return {
    versions: items.map((version) => ({
      id: version.id,
      templateId: version.templateId,
      version: version.version,
      source: version.ownerId === null ? ('base' as const) : ('owner' as const),
      active: version.id === activeVersionId,
      restoredFromVersionId: version.restoredFromVersionId,
      createdAt: version.createdAt,
    })),
    nextCursor,
  };
}

/** Whether `template` — the version's own scope, never the caller's say-so — falls within what
 * `ctx`'s bound project and the caller's asserted `role`/`layer`/`provider` are actually allowed to
 * see: a legitimate seeded base or the owner's own global shared-role/provider template (no
 * project restriction — those apply across all of the owner's projects), or that project's own
 * override template. Anything else (another owner, another project's override, a template whose
 * real role/layer/provider disagrees with what the caller asserted) does not match. */
function instructionVersionInScope(
  template: InstructionTemplate,
  ctx: FacadeContext,
  role: InstructionRole,
  layer: InstructionLayer,
  provider: ProviderFamily | undefined,
): boolean {
  if (template.role !== role || template.layer !== layer) return false;
  if (layer === 'shared_role') {
    if (template.provider !== null) return false;
  } else if (template.provider !== provider) {
    return false;
  }
  if (layer === 'project_override') {
    if (template.projectId !== ctx.projectId) return false;
  } else if (template.projectId !== null) {
    return false;
  }
  if (!template.isBase && template.ownerId !== ctx.ownerId) return false;
  return true;
}

async function getInstructionVersion(
  services: TrackerServices,
  ctx: FacadeContext,
  args: Record<string, unknown>,
) {
  const versionId = requireString(args, 'versionId');
  const role = requireRole(args);
  const layer = requireLayer(args);
  const provider = requireProviderForLayer(args, layer);

  const notFound = () =>
    new FacadeToolError('not_found', `No instruction version '${versionId}' in that scope.`);

  let version: InstructionVersion;
  try {
    version = await services.instructions.getVersion(versionId);
  } catch {
    throw notFound();
  }

  let template: InstructionTemplate;
  try {
    template = await services.instructions.getTemplate(version.templateId);
  } catch {
    throw notFound();
  }

  // The version's own template scope is what is authorized, never the caller-supplied versionId
  // in isolation: this is what stops an agent bound to one project from reading another project's
  // override, or asserting a role/layer/provider the version does not actually belong to.
  if (!instructionVersionInScope(template, ctx, role, layer, provider)) {
    throw notFound();
  }

  return {
    id: version.id,
    templateId: version.templateId,
    version: version.version,
    content: version.content,
    source: version.ownerId === null ? ('base' as const) : ('owner' as const),
    restoredFromVersionId: version.restoredFromVersionId,
    createdAt: version.createdAt,
  };
}

// ---------------------------------------------------------------------------
// create_task / update_task / add_comment
// ---------------------------------------------------------------------------

function requireTaskWrite(ctx: FacadeContext): void {
  if (ctx.permission !== 'task_write') {
    throw new FacadeToolError('permission_denied', 'This connection has read-only access.');
  }
}

async function createTask(
  services: TrackerServices,
  ctx: FacadeContext,
  args: Record<string, unknown>,
) {
  requireTaskWrite(ctx);
  const title = requireString(args, 'title');
  const requestId = requireString(args, 'requestId');
  const description = optionalString(args, 'description');
  const parentTaskId = optionalString(args, 'parentTaskId');
  if (parentTaskId !== undefined) {
    await requireOwnedTask(services, ctx, parentTaskId);
  }

  try {
    const created = await services.repositories.tasks.create(
      {
        project_id: ctx.projectId,
        title,
        description: description ?? '',
        parent_task_id: parentTaskId ?? null,
      },
      requestId,
    );
    return { task: toTaskDto(created) };
  } catch (error) {
    throw mapWriteError(error);
  }
}

async function updateTask(
  services: TrackerServices,
  ctx: FacadeContext,
  args: Record<string, unknown>,
) {
  requireTaskWrite(ctx);
  const taskId = requireString(args, 'taskId');
  const expectedRevision = optionalNumber(args, 'expectedRevision');
  if (expectedRevision === undefined) {
    throw new FacadeToolError('invalid_params', "'expectedRevision' is required.");
  }
  const requestId = requireString(args, 'requestId');
  const title = optionalString(args, 'title');
  const description = optionalString(args, 'description');
  const status = optionalString(args, 'status');
  if (status !== undefined && !(AGENT_WRITABLE_STATUSES as readonly string[]).includes(status)) {
    throw new FacadeToolError(
      'invalid_status',
      `'status' must be one of ${AGENT_WRITABLE_STATUSES.join(', ')}. Owner-only statuses ` +
        '(merged, shipped, cancelled) cannot be set through this tool.',
    );
  }

  await requireOwnedTask(services, ctx, taskId);
  try {
    const updated = await services.repositories.tasks.update(
      taskId,
      { title, description, status: status as TaskStatus | undefined },
      expectedRevision,
      requestId,
    );
    return { task: toTaskDto(updated) };
  } catch (error) {
    if (error instanceof TaskRevisionConflictError) {
      const current = await requireOwnedTask(services, ctx, taskId);
      throw new FacadeToolError('revision_conflict', error.message, {
        currentTask: toTaskDto(current),
      });
    }
    throw mapWriteError(error);
  }
}

async function addComment(
  services: TrackerServices,
  ctx: FacadeContext,
  args: Record<string, unknown>,
) {
  requireTaskWrite(ctx);
  const taskId = requireString(args, 'taskId');
  const text = requireString(args, 'text');
  const requestId = requireString(args, 'requestId');
  await requireOwnedTask(services, ctx, taskId);
  try {
    const comment = await services.repositories.memory.addComment(
      { project_id: ctx.projectId, task_id: taskId, body: text },
      requestId,
    );
    return { comment: toCommentDto(comment) };
  } catch (error) {
    throw mapWriteError(error);
  }
}

function mapWriteError(error: unknown): FacadeToolError {
  if (error instanceof FacadeToolError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new FacadeToolError('write_failed', message);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const HANDLERS: Record<
  AgentToolName,
  (services: TrackerServices, ctx: FacadeContext, args: Record<string, unknown>) => Promise<unknown>
> = {
  get_project_context: getProjectContext,
  list_tasks: listTasks,
  get_task: getTask,
  get_instructions: getInstructions,
  list_instruction_versions: listInstructionVersions,
  get_instruction_version: getInstructionVersion,
  create_task: createTask,
  update_task: updateTask,
  add_comment: addComment,
};

/** The single entry point every facade request goes through. `ctx` must already reflect the
 * live, current owner session and the connection's own bound project/permission — this function
 * does not itself resolve identity, only enforces it (permission checks, project scoping). */
export async function callFacadeTool(
  services: TrackerServices,
  ctx: FacadeContext,
  tool: string,
  args: unknown,
): Promise<unknown> {
  if (!(AGENT_TOOL_NAMES as readonly string[]).includes(tool)) {
    throw new FacadeToolError('unknown_tool', `Unknown tool '${tool}'.`);
  }
  const handler = HANDLERS[tool as AgentToolName];
  const params = isRecord(args) ? args : {};
  return handler(services, ctx, params);
}

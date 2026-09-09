import type { InstructionLayer, InstructionRole, ProviderFamily } from '../instructions';

export type AgentAccessPermission = 'read_only' | 'task_write';

/** The full HAM3-014 tool contract, matching the Rust `agent_access::types::TOOL_NAMES` list. */
export const AGENT_TOOL_NAMES = [
  'get_project_context',
  'list_tasks',
  'get_task',
  'get_instructions',
  'list_instruction_versions',
  'get_instruction_version',
  'create_task',
  'update_task',
  'add_comment',
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export const AGENT_WRITE_TOOL_NAMES: readonly AgentToolName[] = [
  'create_task',
  'update_task',
  'add_comment',
];

/** A structured facade error surfaced to the agent host — mirrors the Rust `FacadeError` shape
 * (`{ code, message }`) so both layers speak the same error vocabulary end to end. */
export class FacadeToolError extends Error {
  readonly code: string;
  readonly data?: Record<string, unknown>;

  constructor(code: string, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'FacadeToolError';
    this.code = code;
    this.data = data;
  }
}

/** What every facade tool call is authorized against — resolved and validated once by
 * `facadeHandler` from the connection's own bound project/permission and the app's live owner
 * session, never from anything the pipe client claims. */
export interface FacadeContext {
  ownerId: string;
  projectId: string;
  permission: AgentAccessPermission;
}

export interface BoundedListArgs {
  cursor?: string;
  limit?: number;
}

export interface BoundedListResult<T> {
  items: T[];
  nextCursor: string | null;
}

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

export interface TaskSummaryDto {
  id: string;
  parentTaskId: string | null;
  title: string;
  status: string;
  priority: number;
  archivedAt: string | null;
  revision: number;
}

export interface TaskDto extends TaskSummaryDto {
  projectId: string;
  description: string;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommentDto {
  id: string;
  taskId: string;
  body: string;
  createdAt: string;
}

export interface InstructionLayerDto {
  layer: InstructionLayer;
  scopeProjectId: string | null;
  templateId: string | null;
  versionId: string | null;
  versionNumber: number | null;
  /** `'absent'` only ever applies to the `project_override` layer: no version is selected at all
   * for it, distinct from a selected version whose content happens to be the empty string. */
  source: 'base' | 'owner' | 'absent';
  content: string | null;
  selected: boolean;
}

export interface GetInstructionsResult {
  projectId: string;
  taskId: string | null;
  role: InstructionRole;
  provider: ProviderFamily;
  assignmentSource: 'explicit' | 'assignment_derived';
  assignmentMismatch: {
    requestedProvider: ProviderFamily;
    assignedProvider: ProviderFamily;
  } | null;
  layers: InstructionLayerDto[];
  effectiveContent: string;
  selectedVersionIds: {
    sharedRoleVersionId: string;
    providerVersionId: string;
    overrideVersionId: string | null;
  };
  selectionFingerprint: string;
  taskInstructionScope: 'not_supported';
  taskContext: { taskId: string; title: string; description: string } | null;
  fetchedAt: string;
  savedConfiguration: true;
}

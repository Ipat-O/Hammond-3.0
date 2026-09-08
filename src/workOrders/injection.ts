import type { FilesystemCommands } from '../api/contracts';
import type { WorkOrderStage } from './types';

/**
 * Optional work-order injection reuses the existing fs_guard-confined `FilesystemCommands`
 * primitives (`readTextFile`/`writeTextFile`/`pathExists`/`removePath`) — the same native safety
 * boundary the role-instruction harness adapters are built on (`src/harness/`). No new native
 * commands are needed: the target is one fixed relative filename (never owner-supplied, so there
 * is no arbitrary-filename input to guard against), and the managed-header/classify/inject/remove
 * shape below deliberately mirrors `src/harness/contracts.ts`'s `HarnessAdapter` so the same
 * unmanaged/foreign-file conflict handling applies, without reusing the harness domain's
 * project+role+provider header (which is a distinct concept — a work order is task-scoped, not
 * role/provider-scoped, and must never share a target file with the role instruction documents).
 */
export const WORK_ORDER_RELATIVE_PATH = 'HAMMOND-WORK-ORDER.md';
export const WORK_ORDER_HEADER_FORMAT_VERSION = 1;

const HEADER_START = '<!-- hammond:work-order\n';
const HEADER_END = '\n-->';

export interface WorkOrderHeaderFields {
  formatVersion: number;
  projectId: string;
  taskId: string;
  dispatchId: string;
  stage: WorkOrderStage;
  generatedAt: string;
}

/**
 * `ManagedForeign` is distinct from `ManagedValid`: both carry a structurally valid Hammond
 * work-order header, but a foreign one belongs to a different project and/or task than the
 * caller's own expected identity, and must never be silently overwritten (mirrors the harness
 * domain's Correction 1: recording identity in a header is not an ownership boundary unless
 * something actually compares it).
 */
export type WorkOrderClassification =
  | { kind: 'Missing' }
  | { kind: 'ManagedValid'; header: WorkOrderHeaderFields }
  | { kind: 'ManagedForeign'; header: WorkOrderHeaderFields }
  | { kind: 'ManagedMalformed' }
  | { kind: 'Unmanaged' };

export type WorkOrderInjectOutcome =
  | { kind: 'Written'; relativePath: string }
  | { kind: 'RequiresConfirmation'; relativePath: string; classification: WorkOrderClassification };

export type WorkOrderRemoveOutcome =
  | { kind: 'Removed'; relativePath: string }
  | { kind: 'NotFound'; relativePath: string }
  | { kind: 'Refused'; relativePath: string };

export function renderManagedWorkOrderDocument(
  header: WorkOrderHeaderFields,
  content: string,
): string {
  return (
    HEADER_START +
    `format_version: ${header.formatVersion}\n` +
    `project_id: ${header.projectId}\n` +
    `task_id: ${header.taskId}\n` +
    `dispatch_id: ${header.dispatchId}\n` +
    `stage: ${header.stage}\n` +
    `generated_at: ${header.generatedAt}` +
    HEADER_END +
    '\n\n' +
    content
  );
}

function isWorkOrderStage(value: string): value is WorkOrderStage {
  return value === 'worker' || value === 'correction' || value === 'audit';
}

/** Parses the managed header block. Returns `null` for a missing marker, an unparseable block, or an unrecognized `format_version` — never guessed at. */
export function parseManagedWorkOrderHeader(text: string): WorkOrderHeaderFields | null {
  if (!text.startsWith(HEADER_START)) return null;
  const endIndex = text.indexOf(HEADER_END);
  if (endIndex === -1) return null;
  const block = text.slice(HEADER_START.length, endIndex);
  const fields: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const separatorIndex = line.indexOf(': ');
    if (separatorIndex === -1) return null;
    fields[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 2);
  }
  const formatVersion = Number(fields.format_version);
  if (!Number.isInteger(formatVersion) || formatVersion !== WORK_ORDER_HEADER_FORMAT_VERSION)
    return null;
  if (
    !fields.project_id ||
    !fields.task_id ||
    !fields.dispatch_id ||
    !fields.stage ||
    !fields.generated_at
  ) {
    return null;
  }
  if (!isWorkOrderStage(fields.stage)) return null;
  return {
    formatVersion,
    projectId: fields.project_id,
    taskId: fields.task_id,
    dispatchId: fields.dispatch_id,
    stage: fields.stage,
    generatedAt: fields.generated_at,
  };
}

export function classifyWorkOrderContent(
  content: string | null,
  expected: { projectId: string; taskId: string },
): WorkOrderClassification {
  if (content === null) return { kind: 'Missing' };
  if (!content.startsWith(HEADER_START)) return { kind: 'Unmanaged' };
  const header = parseManagedWorkOrderHeader(content);
  if (!header) return { kind: 'ManagedMalformed' };
  if (header.projectId === expected.projectId && header.taskId === expected.taskId) {
    return { kind: 'ManagedValid', header };
  }
  return { kind: 'ManagedForeign', header };
}

export interface WorkOrderInjectionServiceDeps {
  filesystem: Pick<
    FilesystemCommands,
    'readTextFile' | 'writeTextFile' | 'pathExists' | 'removePath'
  >;
  /** Injectable for tests; defaults to `new Date().toISOString()`. */
  now?: () => string;
}

export interface WorkOrderInjectionTarget {
  root: string;
  projectId: string;
  taskId: string;
  dispatchId: string;
  stage: WorkOrderStage;
  content: string;
}

/**
 * Optional injection of a frozen dispatch packet into a local directory's single canonical
 * `HAMMOND-WORK-ORDER.md`. Injecting a new dispatch for the same task replaces the previous one
 * rather than accumulating duplicates (matched on project+task only, independent of stage or
 * dispatch id) — the same "switching selection replaces content" rule the role-instruction
 * harness uses. Every mutating call re-classifies the target immediately before writing, so a
 * caller must re-supply the current root/project/task at the moment of the actual write; this
 * service never trusts a classification computed earlier during a pending confirmation.
 */
export class WorkOrderInjectionService {
  private readonly filesystem: WorkOrderInjectionServiceDeps['filesystem'];
  private readonly now: () => string;

  constructor(deps: WorkOrderInjectionServiceDeps) {
    this.filesystem = deps.filesystem;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  targetPath(): string {
    return WORK_ORDER_RELATIVE_PATH;
  }

  async classify(
    root: string,
    projectId: string,
    taskId: string,
  ): Promise<WorkOrderClassification> {
    const exists = await this.filesystem.pathExists(root, WORK_ORDER_RELATIVE_PATH);
    if (!exists) return { kind: 'Missing' };
    const content = await this.filesystem.readTextFile(root, WORK_ORDER_RELATIVE_PATH);
    return classifyWorkOrderContent(content, { projectId, taskId });
  }

  /** The exact document a real inject would write right now, without touching the filesystem. */
  renderDocument(target: Omit<WorkOrderInjectionTarget, 'root'>): string {
    const header: WorkOrderHeaderFields = {
      formatVersion: WORK_ORDER_HEADER_FORMAT_VERSION,
      projectId: target.projectId,
      taskId: target.taskId,
      dispatchId: target.dispatchId,
      stage: target.stage,
      generatedAt: this.now(),
    };
    return renderManagedWorkOrderDocument(header, target.content);
  }

  async preview(
    target: WorkOrderInjectionTarget,
  ): Promise<{ classification: WorkOrderClassification; targetPath: string; document: string }> {
    const classification = await this.classify(target.root, target.projectId, target.taskId);
    return { classification, targetPath: this.targetPath(), document: this.renderDocument(target) };
  }

  async inject(
    target: WorkOrderInjectionTarget & { forceReplace?: boolean },
  ): Promise<WorkOrderInjectOutcome> {
    const classification = await this.classify(target.root, target.projectId, target.taskId);
    const needsConfirmation =
      classification.kind === 'Unmanaged' || classification.kind === 'ManagedForeign';
    if (needsConfirmation && !target.forceReplace) {
      return { kind: 'RequiresConfirmation', relativePath: this.targetPath(), classification };
    }
    const document = this.renderDocument(target);
    await this.filesystem.writeTextFile(target.root, this.targetPath(), document);
    return { kind: 'Written', relativePath: this.targetPath() };
  }

  async remove(params: {
    root: string;
    projectId: string;
    taskId: string;
  }): Promise<WorkOrderRemoveOutcome> {
    const classification = await this.classify(params.root, params.projectId, params.taskId);
    if (classification.kind === 'Missing')
      return { kind: 'NotFound', relativePath: this.targetPath() };
    if (classification.kind !== 'ManagedValid')
      return { kind: 'Refused', relativePath: this.targetPath() };
    await this.filesystem.removePath(params.root, this.targetPath());
    return { kind: 'Removed', relativePath: this.targetPath() };
  }
}

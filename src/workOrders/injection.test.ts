import { describe, expect, it } from 'vitest';

import {
  classifyWorkOrderContent,
  parseManagedWorkOrderHeader,
  renderManagedWorkOrderDocument,
  WorkOrderInjectionService,
  WORK_ORDER_RELATIVE_PATH,
  type WorkOrderHeaderFields,
} from './injection';
import { createFakeWorkOrderFilesystem } from './testFakes';

function header(overrides: Partial<WorkOrderHeaderFields> = {}): WorkOrderHeaderFields {
  return {
    formatVersion: 1,
    projectId: 'project-1',
    taskId: 'task-1',
    dispatchId: 'dispatch-1',
    stage: 'worker',
    generatedAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('renderManagedWorkOrderDocument / parseManagedWorkOrderHeader round trip', () => {
  it('parses back exactly what was rendered', () => {
    const document = renderManagedWorkOrderDocument(header(), 'packet body here');
    const parsed = parseManagedWorkOrderHeader(document);
    expect(parsed).toEqual(header());
    expect(document.endsWith('\n\npacket body here')).toBe(true);
  });

  it('returns null for content with no Hammond marker', () => {
    expect(parseManagedWorkOrderHeader('# Just a normal file\n\nSome content')).toBeNull();
  });

  it('returns null for an unrecognized format_version', () => {
    const document = renderManagedWorkOrderDocument(header({ formatVersion: 99 }), 'body');
    expect(parseManagedWorkOrderHeader(document)).toBeNull();
  });

  it('returns null for a truncated/malformed header block', () => {
    expect(parseManagedWorkOrderHeader('<!-- hammond:work-order\nformat_version: 1\n')).toBeNull();
  });
});

describe('classifyWorkOrderContent', () => {
  it('classifies Missing for null content', () => {
    expect(classifyWorkOrderContent(null, { projectId: 'p', taskId: 't' })).toEqual({
      kind: 'Missing',
    });
  });

  it('classifies Unmanaged for content with no Hammond marker', () => {
    expect(classifyWorkOrderContent('# Some other file', { projectId: 'p', taskId: 't' })).toEqual({
      kind: 'Unmanaged',
    });
  });

  it('classifies ManagedValid when the header matches the caller-expected project and task', () => {
    const document = renderManagedWorkOrderDocument(
      header({ projectId: 'p', taskId: 't' }),
      'body',
    );
    const result = classifyWorkOrderContent(document, { projectId: 'p', taskId: 't' });
    expect(result.kind).toBe('ManagedValid');
  });

  it('classifies ManagedForeign when the header belongs to a different project/task — never ManagedValid', () => {
    const document = renderManagedWorkOrderDocument(
      header({ projectId: 'other-project', taskId: 't' }),
      'body',
    );
    const result = classifyWorkOrderContent(document, { projectId: 'p', taskId: 't' });
    expect(result.kind).toBe('ManagedForeign');
  });

  it('classifies ManagedMalformed for a Hammond marker with an unparseable body', () => {
    const result = classifyWorkOrderContent('<!-- hammond:work-order\nnot: valid\n-->\n\nbody', {
      projectId: 'p',
      taskId: 't',
    });
    expect(result.kind).toBe('ManagedMalformed');
  });
});

describe('WorkOrderInjectionService', () => {
  const root = '/scratch/project';

  it('classify() is Missing when nothing exists at the target', async () => {
    const filesystem = createFakeWorkOrderFilesystem();
    const service = new WorkOrderInjectionService({ filesystem });
    expect(await service.classify(root, 'p', 't')).toEqual({ kind: 'Missing' });
  });

  it('inject() creates the file with the exact frozen content, wrapped in the managed header', async () => {
    const filesystem = createFakeWorkOrderFilesystem();
    const service = new WorkOrderInjectionService({
      filesystem,
      now: () => '2026-09-08T00:00:00.000Z',
    });
    const outcome = await service.inject({
      root,
      projectId: 'p',
      taskId: 't',
      dispatchId: 'd1',
      stage: 'worker',
      content: 'exact frozen packet text',
    });
    expect(outcome).toEqual({ kind: 'Written', relativePath: WORK_ORDER_RELATIVE_PATH });
    const written = filesystem.files.get(`${root} ${WORK_ORDER_RELATIVE_PATH}`);
    expect(written).toContain('exact frozen packet text');
    expect(written).toContain('project_id: p');
    expect(written).toContain('task_id: t');
    expect(written).toContain('dispatch_id: d1');
  });

  it('inject() on an existing ManagedValid target for the same project/task updates in place with no confirmation', async () => {
    const filesystem = createFakeWorkOrderFilesystem();
    const service = new WorkOrderInjectionService({ filesystem });
    await service.inject({
      root,
      projectId: 'p',
      taskId: 't',
      dispatchId: 'd1',
      stage: 'worker',
      content: 'v1',
    });
    const outcome = await service.inject({
      root,
      projectId: 'p',
      taskId: 't',
      dispatchId: 'd2',
      stage: 'correction',
      content: 'v2',
    });
    expect(outcome.kind).toBe('Written');
    const written = filesystem.files.get(`${root} ${WORK_ORDER_RELATIVE_PATH}`);
    expect(written).toContain('v2');
    expect(written).not.toContain('v1');
    // Replacing never accumulates a second file — one canonical target only.
    expect(filesystem.files.size).toBe(1);
  });

  it('inject() refuses an Unmanaged target without forceReplace, and writes nothing', async () => {
    const filesystem = createFakeWorkOrderFilesystem();
    filesystem.files.set(
      `${root} ${WORK_ORDER_RELATIVE_PATH}`,
      '# An owner file, not Hammond-managed',
    );
    const service = new WorkOrderInjectionService({ filesystem });
    const outcome = await service.inject({
      root,
      projectId: 'p',
      taskId: 't',
      dispatchId: 'd1',
      stage: 'worker',
      content: 'new content',
    });
    expect(outcome.kind).toBe('RequiresConfirmation');
    expect(filesystem.files.get(`${root} ${WORK_ORDER_RELATIVE_PATH}`)).toBe(
      '# An owner file, not Hammond-managed',
    );
  });

  it('inject() with forceReplace overwrites an Unmanaged target', async () => {
    const filesystem = createFakeWorkOrderFilesystem();
    filesystem.files.set(`${root} ${WORK_ORDER_RELATIVE_PATH}`, '# An owner file');
    const service = new WorkOrderInjectionService({ filesystem });
    const outcome = await service.inject({
      root,
      projectId: 'p',
      taskId: 't',
      dispatchId: 'd1',
      stage: 'worker',
      content: 'replaced',
      forceReplace: true,
    });
    expect(outcome.kind).toBe('Written');
    expect(filesystem.files.get(`${root} ${WORK_ORDER_RELATIVE_PATH}`)).toContain('replaced');
  });

  it('inject() refuses a ManagedForeign target (different project) without forceReplace', async () => {
    const filesystem = createFakeWorkOrderFilesystem();
    const service = new WorkOrderInjectionService({ filesystem });
    await service.inject({
      root,
      projectId: 'other-project',
      taskId: 't',
      dispatchId: 'd1',
      stage: 'worker',
      content: 'foreign',
    });
    const outcome = await service.inject({
      root,
      projectId: 'p',
      taskId: 't',
      dispatchId: 'd2',
      stage: 'worker',
      content: 'mine',
    });
    expect(outcome.kind).toBe('RequiresConfirmation');
    expect(filesystem.files.get(`${root} ${WORK_ORDER_RELATIVE_PATH}`)).toContain('foreign');
  });

  it('re-classifies at call time rather than trusting a stale preview — a target written between preview and inject is honored', async () => {
    const filesystem = createFakeWorkOrderFilesystem();
    const service = new WorkOrderInjectionService({ filesystem });
    const preview = await service.preview({
      root,
      projectId: 'p',
      taskId: 't',
      dispatchId: 'd1',
      stage: 'worker',
      content: 'v1',
    });
    expect(preview.classification.kind).toBe('Missing');

    // Something else wrote a foreign document to the target after the preview was computed.
    filesystem.files.set(
      `${root} ${WORK_ORDER_RELATIVE_PATH}`,
      renderManagedWorkOrderDocument(header({ projectId: 'other-project' }), 'foreign body'),
    );

    const outcome = await service.inject({
      root,
      projectId: 'p',
      taskId: 't',
      dispatchId: 'd1',
      stage: 'worker',
      content: 'v1',
    });
    expect(outcome.kind).toBe('RequiresConfirmation');
  });

  it('remove() deletes only a ManagedValid target for exactly this project/task', async () => {
    const filesystem = createFakeWorkOrderFilesystem();
    const service = new WorkOrderInjectionService({ filesystem });
    await service.inject({
      root,
      projectId: 'p',
      taskId: 't',
      dispatchId: 'd1',
      stage: 'worker',
      content: 'v1',
    });
    const outcome = await service.remove({ root, projectId: 'p', taskId: 't' });
    expect(outcome).toEqual({ kind: 'Removed', relativePath: WORK_ORDER_RELATIVE_PATH });
    expect(filesystem.files.has(`${root} ${WORK_ORDER_RELATIVE_PATH}`)).toBe(false);
  });

  it("remove() refuses an Unmanaged or foreign target rather than deleting someone else's file", async () => {
    const filesystem = createFakeWorkOrderFilesystem();
    filesystem.files.set(`${root} ${WORK_ORDER_RELATIVE_PATH}`, '# Not Hammond-managed');
    const service = new WorkOrderInjectionService({ filesystem });
    const outcome = await service.remove({ root, projectId: 'p', taskId: 't' });
    expect(outcome.kind).toBe('Refused');
    expect(filesystem.files.has(`${root} ${WORK_ORDER_RELATIVE_PATH}`)).toBe(true);
  });

  it('remove() is NotFound when nothing exists at the target', async () => {
    const filesystem = createFakeWorkOrderFilesystem();
    const service = new WorkOrderInjectionService({ filesystem });
    expect(await service.remove({ root, projectId: 'p', taskId: 't' })).toEqual({
      kind: 'NotFound',
      relativePath: WORK_ORDER_RELATIVE_PATH,
    });
  });
});

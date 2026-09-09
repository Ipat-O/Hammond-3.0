import { vi } from 'vitest';

import type { TrackerServices } from '../tracker/contracts';
import { callFacadeTool } from './facade';
import { registerAgentAccessFacadeHandler } from './facadeHandler';
import { nativeAgentAccess, type FacadeRequestPayload } from './nativeBridge';
import { subscribeAgentWriteNotifications } from './writeNotifications';

/**
 * HAM3-014 correction 2 (F2): `registerAgentAccessFacadeHandler` is the ONE place a completed
 * write becomes an `AgentWriteNotification` — see `writeNotifications.ts`'s own module doc and
 * `TrackerPage.test.tsx`'s "HAM3-014 F2" suite for the UI-side consumption of what this module
 * publishes. These tests isolate that one seam: `callFacadeTool` (already covered exhaustively by
 * `facade.test.ts`, including every write tool's exact result shape) is mocked here so this file
 * verifies only "does a successful result publish the right notification, does a failure publish
 * nothing" — never re-deriving the tool contract itself.
 */
vi.mock('./facade', () => ({ callFacadeTool: vi.fn() }));
vi.mock('./nativeBridge', () => ({
  nativeAgentAccess: {
    status: vi.fn(),
    respond: vi.fn().mockResolvedValue(true),
    onFacadeRequest: vi.fn(),
  },
}));

const mockedCallFacadeTool = vi.mocked(callFacadeTool);
const mockedNative = vi.mocked(nativeAgentAccess);

const OWNER_ID = 'owner-1';
const PROJECT_ID = 'project-1';

function connectionStatus() {
  return {
    profileId: 'profile-1',
    projectId: PROJECT_ID,
    projectName: 'Scratch project',
    permission: 'task_write' as const,
    generation: 1,
    createdAt: '2026-09-09T00:00:00.000Z',
    launchConfig: null,
  };
}

function fakeServices(): TrackerServices {
  return {
    auth: {
      getPersistedSession: vi
        .fn()
        .mockResolvedValue({ data: { session: { user: { id: OWNER_ID } } }, error: null }),
    },
  } as unknown as TrackerServices;
}

/** Registers the handler, captures the listener `onFacadeRequest` was given, dispatches one
 * request through it, and waits for the async `respond()` round-trip to settle. */
async function dispatch(payload: Omit<FacadeRequestPayload, 'correlationId' | 'generation'>) {
  let requestHandler: ((payload: FacadeRequestPayload) => void) | undefined;
  mockedNative.onFacadeRequest.mockImplementation((handler) => {
    requestHandler = handler;
    return Promise.resolve(vi.fn());
  });
  mockedNative.status.mockResolvedValue(connectionStatus());

  const unregister = registerAgentAccessFacadeHandler(fakeServices());
  await Promise.resolve();
  await Promise.resolve();
  requestHandler!({ correlationId: 'corr-1', generation: 1, ...payload });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  unregister();
}

describe('registerAgentAccessFacadeHandler — agent write notifications (HAM3-014 F2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes a notification carrying the created task id after a successful create_task', async () => {
    mockedCallFacadeTool.mockResolvedValue({ task: { id: 'task-1', parentTaskId: 'parent-1' } });
    const listener = vi.fn();
    const unsubscribe = subscribeAgentWriteNotifications(listener);

    await dispatch({
      projectId: PROJECT_ID,
      permission: 'task_write',
      tool: 'create_task',
      args: {},
    });

    expect(listener).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      tool: 'create_task',
      taskId: 'task-1',
      parentTaskId: 'parent-1',
    });
    unsubscribe();
  });

  it('publishes a notification carrying the updated task id after a successful update_task', async () => {
    mockedCallFacadeTool.mockResolvedValue({ task: { id: 'task-2' } });
    const listener = vi.fn();
    const unsubscribe = subscribeAgentWriteNotifications(listener);

    await dispatch({
      projectId: PROJECT_ID,
      permission: 'task_write',
      tool: 'update_task',
      args: {},
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'update_task', taskId: 'task-2' }),
    );
    unsubscribe();
  });

  it('publishes a notification carrying the owning task id after a successful add_comment', async () => {
    mockedCallFacadeTool.mockResolvedValue({ comment: { id: 'comment-1', taskId: 'task-3' } });
    const listener = vi.fn();
    const unsubscribe = subscribeAgentWriteNotifications(listener);

    await dispatch({
      projectId: PROJECT_ID,
      permission: 'task_write',
      tool: 'add_comment',
      args: {},
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'add_comment', taskId: 'task-3' }),
    );
    unsubscribe();
  });

  it('never publishes anything for a rejected write — a failed write does not announce success', async () => {
    mockedCallFacadeTool.mockRejectedValue(new Error('write_failed'));
    const listener = vi.fn();
    const unsubscribe = subscribeAgentWriteNotifications(listener);

    await dispatch({
      projectId: PROJECT_ID,
      permission: 'task_write',
      tool: 'create_task',
      args: {},
    });

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('never publishes anything for a read-only tool, even one that happens to resolve successfully', async () => {
    mockedCallFacadeTool.mockResolvedValue({ tasks: [], nextCursor: null });
    const listener = vi.fn();
    const unsubscribe = subscribeAgentWriteNotifications(listener);

    await dispatch({
      projectId: PROJECT_ID,
      permission: 'task_write',
      tool: 'list_tasks',
      args: {},
    });

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

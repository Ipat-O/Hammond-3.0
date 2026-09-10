import { answerAgentAccessRequest, type BridgeRequest } from './bridge';
import { createTestDeps } from './testFakes';

const invoke = (name: string, input: unknown): BridgeRequest => ({
  id: `req-${name}`,
  kind: 'invoke',
  name,
  input,
});

describe('answerAgentAccessRequest — sign-out timing (HAM3-015 Correction 1, F3)', () => {
  it('sign-out BEFORE dispatch: an ordinary unauthenticated error, the operation never runs', async () => {
    const { deps, tables } = createTestDeps();
    const response = await answerAgentAccessRequest(
      deps,
      invoke('projects.create', { name: 'P' }),
      () => null,
    );
    expect(response.error).toMatchObject({ code: 'unauthenticated' });
    expect(tables.projects ?? []).toHaveLength(0);
  });

  it('sign-out DURING a write that still commits: reported as success, never as "did not execute"', async () => {
    const { deps } = createTestDeps();
    let ownerId: string | null = 'owner-1';
    const realCreate = deps.projects.create.bind(deps.projects);
    let release!: () => void;
    deps.projects.create = ((input: unknown) => {
      // The session is torn down while this write is in flight...
      ownerId = null;
      return new Promise((resolve) => {
        release = () => resolve(realCreate(input as never));
      });
    }) as typeof deps.projects.create;

    const pending = answerAgentAccessRequest(
      deps,
      invoke('projects.create', { name: 'Committed' }),
      () => ownerId,
    );
    release(); // ...but it commits anyway
    const response = await pending;

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ name: 'Committed' });
  });

  it('sign-out DURING a write that then fails: unknown_outcome carrying the request id, not unauthenticated', async () => {
    const { deps } = createTestDeps();
    let ownerId: string | null = 'owner-1';
    deps.projects.create = (async () => {
      ownerId = null;
      throw new Error('supabase connection dropped');
    }) as typeof deps.projects.create;

    const response = await answerAgentAccessRequest(
      deps,
      invoke('projects.create', { name: 'P' }),
      () => ownerId,
    );
    expect(response.error?.code).toBe('unknown_outcome');
    expect(response.error?.message).toContain('req-projects.create');
    expect(response.error?.message).toMatch(/re-read the affected record/i);
  });

  it('a clean pre-write rejection during sign-out stays a definite validation_error', async () => {
    const { deps } = createTestDeps();
    let ownerId: string | null = 'owner-1';
    const response = await answerAgentAccessRequest(
      deps,
      invoke('projects.create', { name: '' }),
      () => {
        const value = ownerId;
        ownerId = null;
        return value;
      },
    );
    expect(response.error?.code).toBe('validation_error');
  });

  it('sign-out AFTER completion: the result already captured is returned as-is', async () => {
    const { deps } = createTestDeps();
    const created = (await answerAgentAccessRequest(
      deps,
      invoke('projects.create', { name: 'P' }),
      () => 'owner-1',
    )) as { result: { id: string } };

    let ownerId: string | null = 'owner-1';
    const read = await answerAgentAccessRequest(
      deps,
      invoke('projects.get', { projectId: created.result.id }),
      () => {
        const value = ownerId;
        ownerId = null;
        return value;
      },
    );
    expect(read.error).toBeUndefined();
    expect(read.result).toMatchObject({ id: created.result.id });
  });
});

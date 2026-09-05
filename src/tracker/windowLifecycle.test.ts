import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Faithful boundary for the production adapter: `getCurrentWindow()` returns a window-like object
// whose `onCloseRequested` is the REAL, installed `Window.prototype.onCloseRequested` (imported
// via `importOriginal`) — the exact "await handler(evt); if (!evt.isPreventDefault()) destroy()"
// logic described in the correction report. Only the native IPC boundary underneath it —
// `listen` (which resolves the close-requested subscription) and `destroy` — is faked, since
// there is no real Tauri bridge in a test/jsdom runtime.
const {
  destroySpy,
  unlistenSpy,
  getRegisteredHandler,
  setRegisteredHandler,
  getListenError,
  setListenError,
  getCurrentWindowError,
  setCurrentWindowError,
} = vi.hoisted(() => {
  let registeredHandler: ((event: { event: string; id: number }) => Promise<void>) | undefined;
  let listenError: unknown = null;
  let currentWindowError: unknown = null;
  return {
    destroySpy: vi.fn(async () => {}),
    unlistenSpy: vi.fn(),
    getRegisteredHandler: () => registeredHandler,
    setRegisteredHandler: (next: typeof registeredHandler) => {
      registeredHandler = next;
    },
    getListenError: () => listenError,
    setListenError: (error: unknown) => {
      listenError = error;
    },
    getCurrentWindowError: () => currentWindowError,
    setCurrentWindowError: (error: unknown) => {
      currentWindowError = error;
    },
  };
});

vi.mock('@tauri-apps/api/window', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tauri-apps/api/window')>();
  const fakeWindow = {
    async listen(
      _event: string,
      handler: (event: { event: string; id: number }) => Promise<void>,
    ) {
      const error = getListenError();
      if (error) throw error;
      setRegisteredHandler(handler);
      return unlistenSpy;
    },
    destroy: destroySpy,
    onCloseRequested: actual.Window.prototype.onCloseRequested,
  };
  return {
    ...actual,
    getCurrentWindow: () => {
      const error = getCurrentWindowError();
      if (error) throw error;
      return fakeWindow;
    },
  };
});

// Imported after the mock so the module under test resolves the mocked `@tauri-apps/api/window`.
const { createTauriWindowLifecycle } = await import('./windowLifecycle');

/**
 * Waits for the registration chain (dynamic `import()` -> `getCurrentWindow()` ->
 * `onCloseRequested()` -> `listen()`) to reach the point where a handler is captured, by polling
 * the actual observable outcome rather than sleeping a fixed duration. A fixed sleep either wastes
 * time when the chain settles quickly or, on a loaded CI/Windows/jsdom run, can elapse before the
 * chain (which crosses real async boundaries beyond plain microtasks) has actually finished —
 * this instead keeps checking until it has, up to a generous bound.
 */
async function waitForRegisteredHandler() {
  await vi.waitUntil(() => Boolean(getRegisteredHandler()), { timeout: 2000, interval: 5 });
}

/**
 * Drains pending microtasks. Everything between firing the close-requested event and the
 * production adapter blocking on the owner's decision promise is plain promise/async-await
 * chaining with no timers involved, so repeatedly yielding a microtask turn reaches that blocked
 * state deterministically, unlike a wall-clock sleep.
 */
async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

/**
 * For a registration path that never produces an observable success signal (e.g. "no Tauri
 * bridge here" is a deliberate silent no-op), repeatedly yield a real event-loop tick so a slow
 * run gets as many ticks as it actually needs to cross the registration chain's real async
 * boundaries, rather than gambling everything on whichever ticks happen to fit inside one
 * fixed-duration sleep.
 */
async function settleRegistrationChain() {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function fireCloseRequested() {
  const handler = getRegisteredHandler();
  if (!handler) throw new Error('no close-requested handler registered yet');
  await handler({ event: 'tauri://close-requested', id: 1 });
}

describe('createTauriWindowLifecycle (production Tauri adapter)', () => {
  beforeEach(() => {
    destroySpy.mockClear();
    unlistenSpy.mockClear();
    setRegisteredHandler(undefined);
    setListenError(null);
    setCurrentWindowError(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('awaits the complete close decision before Tauri may destroy the window, and Cancel leaves it open', async () => {
    const lifecycle = createTauriWindowLifecycle();
    let resolveDecision!: (allowed: boolean) => void;
    const decision = new Promise<boolean>((resolve) => {
      resolveDecision = resolve;
    });
    lifecycle.onCloseRequested(() => decision);
    await waitForRegisteredHandler();
    expect(getRegisteredHandler()).toBeDefined();

    let closeSettled = false;
    const closePromise = fireCloseRequested().then(() => {
      closeSettled = true;
    });
    await flushMicrotasks();
    // The owner has not decided yet (a still-open dialog): destroy must not have run.
    expect(destroySpy).not.toHaveBeenCalled();
    expect(closeSettled).toBe(false);

    resolveDecision(false); // Cancel
    await closePromise;
    expect(closeSettled).toBe(true);
    expect(destroySpy).not.toHaveBeenCalled();
  });

  it('closes exactly once when the decision resolves allowed (Save/Discard)', async () => {
    const lifecycle = createTauriWindowLifecycle();
    lifecycle.onCloseRequested(() => Promise.resolve(true));
    await waitForRegisteredHandler();

    await fireCloseRequested();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('treats a rejected decision as Cancel and never destroys the window', async () => {
    const lifecycle = createTauriWindowLifecycle();
    lifecycle.onCloseRequested(() => Promise.reject(new Error('decision failed')));
    await waitForRegisteredHandler();

    await fireCloseRequested();
    expect(destroySpy).not.toHaveBeenCalled();
  });

  it('a registration failure inside a real Tauri window is surfaced, not silently classified as "no bridge here"', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setListenError(new Error('bridge exploded'));

    const lifecycle = createTauriWindowLifecycle();
    lifecycle.onCloseRequested(() => Promise.resolve(true));
    await vi.waitUntil(() => consoleErrorSpy.mock.calls.length > 0, {
      timeout: 2000,
      interval: 5,
    });

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('no Tauri bridge in this runtime (e.g. a browser preview) is a silent no-op, not a registration failure', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setCurrentWindowError(new Error('window.__TAURI_INTERNALS__ is undefined'));

    const lifecycle = createTauriWindowLifecycle();
    const unsubscribe = lifecycle.onCloseRequested(() => Promise.resolve(true));
    await settleRegistrationChain();

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(destroySpy).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
    consoleErrorSpy.mockRestore();
  });

  it('unsubscribing after registration completes detaches the real Tauri listener', async () => {
    const lifecycle = createTauriWindowLifecycle();
    const unsubscribe = lifecycle.onCloseRequested(() => Promise.resolve(true));
    await waitForRegisteredHandler();
    expect(getRegisteredHandler()).toBeDefined();

    unsubscribe();
    expect(unlistenSpy).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing before registration completes still detaches once it resolves', async () => {
    const lifecycle = createTauriWindowLifecycle();
    const unsubscribe = lifecycle.onCloseRequested(() => Promise.resolve(true));
    unsubscribe(); // dispose immediately, before the async registration chain settles
    await vi.waitUntil(() => unlistenSpy.mock.calls.length > 0, { timeout: 2000, interval: 5 });

    expect(unlistenSpy).toHaveBeenCalledTimes(1);
  });
});

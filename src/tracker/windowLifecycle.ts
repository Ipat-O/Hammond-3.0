/**
 * Abstracts the "the owner is about to close the app window" moment so `TrackerPage` can guard it
 * against unsaved Instruction Studio edits without depending on Tauri's runtime bridge directly
 * (that bridge does not exist outside an actual Tauri webview — e.g. in tests).
 */
export interface WindowLifecycle {
  /**
   * Registers a handler invoked whenever the OS/window manager requests that the app window
   * close. The handler resolves `true` to allow the close to proceed, `false` to cancel it.
   * Returns an unsubscribe function.
   */
  onCloseRequested(handler: () => Promise<boolean>): () => void;
}

/**
 * Tauri v2's documented interception boundary for a window-close request
 * (`Window.onCloseRequested`): calling `event.preventDefault()` inside the callback cancels the
 * close, otherwise it proceeds. Tauri awaits that callback and only then checks whether
 * `preventDefault()` was called, so the callback registered below must itself await the complete
 * owner decision — see the inline note at the registration site.
 *
 * The Tauri module is loaded lazily. Failing to reach it at all (no `getCurrentWindow()` — a
 * plain browser preview, or a test) is swallowed: there is simply nothing to intercept in that
 * runtime, so app/window-close dirty protection does not apply. A failure registering the
 * listener with a *real* Tauri window is a different, genuine problem and is surfaced instead of
 * being folded into that same silent case.
 */
export function createTauriWindowLifecycle(): WindowLifecycle {
  return {
    onCloseRequested(handler) {
      let disposed = false;
      let unlisten: (() => void) | undefined;
      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow())
        .then(
          (appWindow) =>
            appWindow.onCloseRequested(async (event) => {
              // The installed Tauri `Window.onCloseRequested` does `await handler(evt)` and then
              // destroys the window unless `event.preventDefault()` was called during that await —
              // so this callback must itself await the COMPLETE owner decision before returning.
              // Returning early (e.g. a detached `.then()`) lets Tauri check `isPreventDefault()`
              // before a still-open dialog resolves, destroying the window regardless of what the
              // owner later chooses.
              let allowed: boolean;
              try {
                allowed = await handler();
              } catch {
                // A rejected/failed decision must not close the app — treat it the same as Cancel
                // rather than let the rejection propagate into Tauri's internal event dispatch.
                allowed = false;
              }
              if (!allowed) event.preventDefault();
            }),
          // Rejected here means `getCurrentWindow()` (or the import itself) failed — there is no
          // Tauri window-lifecycle bridge in this runtime (e.g. a browser preview or a test), so
          // there is nothing to intercept. This handler only ever sees THAT failure: an `.then`'s
          // rejection handler never catches a throw from its own sibling fulfillment handler
          // above, so a real registration failure below is never misclassified as this case.
          () => undefined,
        )
        .then((unlistenFn) => {
          if (disposed) unlistenFn?.();
          else unlisten = unlistenFn ?? undefined;
        })
        .catch((error: unknown) => {
          // Reaching here means `appWindow.onCloseRequested(...)` itself rejected — a genuine
          // failure registering the guard inside an actual Tauri webview, not "no bridge here".
          // Surface it truthfully instead of silently pretending nothing needs guarding.
          console.error('Failed to register the window-close guard.', error);
        });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
  };
}

/** Test double: exposes `fireCloseRequested` so a test can simulate the OS asking to close. */
export function createFakeWindowLifecycle(): WindowLifecycle & {
  fireCloseRequested(): Promise<boolean>;
} {
  let handler: (() => Promise<boolean>) | null = null;
  return {
    onCloseRequested(next) {
      handler = next;
      return () => {
        if (handler === next) handler = null;
      };
    },
    fireCloseRequested() {
      if (!handler) return Promise.resolve(true);
      return handler();
    },
  };
}

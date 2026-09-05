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
 * close, otherwise it proceeds. The Tauri module is loaded lazily and every failure is swallowed
 * so importing/using this module is always safe outside an actual Tauri webview — there is
 * simply nothing to intercept there (a plain browser preview, or a test), so app/window-close
 * dirty protection does not apply in that runtime.
 */
export function createTauriWindowLifecycle(): WindowLifecycle {
  return {
    onCloseRequested(handler) {
      let disposed = false;
      let unlisten: (() => void) | undefined;
      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow())
        .then((appWindow) =>
          appWindow.onCloseRequested((event) => {
            void handler().then((allowed) => {
              if (!allowed) event.preventDefault();
            });
          }),
        )
        .then((unlistenFn) => {
          if (disposed) unlistenFn();
          else unlisten = unlistenFn;
        })
        .catch(() => {
          // No Tauri window-lifecycle bridge in this runtime — nothing to intercept.
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

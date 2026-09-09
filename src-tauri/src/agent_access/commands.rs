//! The Tauri command surface for agent access: enable/disable/status/respond. This is the only
//! place production code constructs a real [`Dispatcher`] (frontend event + pending-table await)
//! and starts/stops the named-pipe listener — everything it calls into
//! (`core`, `pending`, `server::handle_connection`, `pipe_transport::run_listener`) is exercised
//! directly by unit tests elsewhere in this module tree without a running Tauri app.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::watch;

use super::core::AgentAccessCore;
use super::credential::generate_token;
use super::pending::{FacadeOutcome, InsertError, PendingRequests};
use super::pipe_transport::{pipe_name_for, run_listener};
use super::server::{Dispatcher, FacadeCallContext};
use super::store::{self, AgentAccessProfile};
use super::types::{
    FacadeError, FacadeRequestPayload, FacadeResponsePayload, Permission, MAX_PENDING_REQUESTS,
    REQUEST_TIMEOUT_SECS,
};

struct RunningListener {
    shutdown: watch::Sender<bool>,
    handle: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
pub struct AgentAccessManaged {
    core: Arc<AgentAccessCore>,
    pending: Arc<PendingRequests>,
    listener: std::sync::Mutex<Option<RunningListener>>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AgentAccessCommandError {
    Io(String),
    NotEnabled(String),
    Transport(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfoDto {
    pub profile_id: String,
    pub project_id: String,
    pub project_name: String,
    pub permission: Permission,
    pub generation: u64,
    pub created_at: String,
    pub launch_config: serde_json::Value,
}

fn to_dto(app: &AppHandle, profile: &AgentAccessProfile) -> ConnectionInfoDto {
    ConnectionInfoDto {
        profile_id: profile.profile_id.clone(),
        project_id: profile.project_id.clone(),
        project_name: profile.project_name.clone(),
        permission: profile.permission,
        generation: profile.generation,
        created_at: profile.created_at.clone(),
        launch_config: launch_config_for(app, &profile.profile_id),
    }
}

fn companion_binary_name() -> &'static str {
    if cfg!(windows) {
        "hammond-mcp-companion.exe"
    } else {
        "hammond-mcp-companion"
    }
}

/// Resolves where the installed companion binary actually lives. Prefers Tauri's own resource
/// resolver (`BaseDirectory::Resource`) — the documented, versioned API for locating a resource
/// `build.rs` staged via `tauri.conf.json`'s `externalBin` (see `build.rs`'s module doc), rather
/// than this file re-deriving Tauri's resource-directory rules itself. Falls back to "next to
/// Hammond's own executable" if the resolver errors (`tauri_utils::platform::resource_dir_from`
/// resolves `BaseDirectory::Resource` to exactly that directory on Windows today, so this
/// fallback agrees with the primary path whenever both are reachable), and finally to the bare
/// binary name so the owner can adjust the copied config themselves.
fn resolve_companion_command(app: &AppHandle) -> String {
    let name = companion_binary_name();
    let resolved = app
        .path()
        .resolve(name, tauri::path::BaseDirectory::Resource)
        .ok()
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        });
    build_companion_command(resolved.as_deref(), name)
}

fn build_companion_command(resolved: Option<&std::path::Path>, fallback_name: &str) -> String {
    resolved
        .and_then(|path| path.to_str())
        .map(str::to_owned)
        .unwrap_or_else(|| fallback_name.to_owned())
}

/// The copyable MCP host config snippet. Deliberately carries only the opaque `profile_id`,
/// never the connection secret (D-022: "Config contains an opaque profile identifier, not a
/// password/token or project content").
fn launch_config_for(app: &AppHandle, profile_id: &str) -> serde_json::Value {
    let command = resolve_companion_command(app);
    build_launch_config(&command, profile_id)
}

fn build_launch_config(command: &str, profile_id: &str) -> serde_json::Value {
    serde_json::json!({
        "mcpServers": {
            "hammond": {
                "command": command,
                "args": ["--profile", profile_id],
            }
        }
    })
}

fn profile_dir(app: &AppHandle) -> Result<PathBuf, AgentAccessCommandError> {
    app.path()
        .app_local_data_dir()
        .map_err(|error| AgentAccessCommandError::Io(format!("no local data directory: {error}")))
}

fn map_store_error(error: store::StoreError) -> AgentAccessCommandError {
    let store::StoreError::Io(message) = error;
    AgentAccessCommandError::Io(message)
}

fn build_dispatcher(app: AppHandle, pending: Arc<PendingRequests>) -> Dispatcher {
    Arc::new(move |ctx: FacadeCallContext| {
        let app = app.clone();
        let pending = pending.clone();
        Box::pin(async move {
            let correlation_id = generate_token(8);
            let receiver = match pending.try_insert(
                correlation_id.clone(),
                ctx.generation,
                MAX_PENDING_REQUESTS,
            ) {
                Ok(receiver) => receiver,
                Err(InsertError::TooManyPending) => {
                    return FacadeOutcome::Err(FacadeError::new(
                        "resource_exhausted",
                        "Too many agent requests are already in flight. Try again shortly.",
                    ));
                }
            };

            let payload = FacadeRequestPayload {
                correlation_id: correlation_id.clone(),
                generation: ctx.generation,
                project_id: ctx.project_id,
                permission: ctx.permission,
                tool: ctx.tool,
                args: ctx.args,
            };
            if let Err(emit_error) = app.emit("agent-facade-request", &payload) {
                pending.remove(&correlation_id);
                return FacadeOutcome::Err(FacadeError::new(
                    "internal_error",
                    format!("failed to relay the request into Hammond: {emit_error}"),
                ));
            }

            match tokio::time::timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS), receiver).await {
                Ok(Ok(outcome)) => outcome,
                Ok(Err(_recv_error)) => FacadeOutcome::Err(FacadeError::new(
                    "invalidated",
                    "This connection was invalidated before Hammond answered (revoked, signed out, or restarted).",
                )),
                Err(_elapsed) => {
                    pending.remove(&correlation_id);
                    FacadeOutcome::Err(FacadeError::new(
                        "host_unavailable",
                        "Hammond did not respond in time. Make sure Hammond is running, signed in, and Agent access is still enabled.",
                    ))
                }
            }
        })
    })
}

fn stop_listener(managed: &AgentAccessManaged) {
    if let Some(running) = managed
        .listener
        .lock()
        .expect("agent access listener lock poisoned")
        .take()
    {
        let _ = running.shutdown.send(true);
        running.handle.abort();
    }
}

/// Starts the named-pipe listener and blocks (this command runs synchronously, inline on
/// whatever native thread dispatches Tauri IPC — never assume it has an entered Tokio runtime;
/// see the module doc comment) until the listener has actually bound or definitively failed to.
///
/// Must use `tauri::async_runtime::spawn`, not a bare `tokio::spawn`: the latter calls
/// `tokio::runtime::Handle::current()` internally and panics if the calling thread never entered
/// a runtime context, which a synchronous Tauri command's thread never does on its own.
/// `tauri::async_runtime::spawn` enters the app's runtime handle first (see `tauri::async_runtime`
/// docs), which is exactly the supported way to spawn from here.
///
/// A caller that gets `Err` back has no running listener left behind: the spawned task's `ready`
/// signal fires before any listener is considered live, so a bind failure never leaves an
/// orphaned task or a stale `RunningListener` entry.
///
/// Deliberately takes an already-built [`Dispatcher`] rather than an `AppHandle` (the caller
/// builds one via [`build_dispatcher`]): the spawn-and-wait logic here is exactly the boundary
/// that crashed in production, and it needs nothing Tauri-app-specific to do its job — keeping
/// `AppHandle` out of this function's signature is what lets
/// `command_boundary_tests` exercise this exact code from a plain thread with no entered Tokio
/// runtime and no mock app/webview needed to do it.
fn start_listener(
    managed: &AgentAccessManaged,
    pipe_name: String,
    dispatcher: Dispatcher,
) -> Result<(), AgentAccessCommandError> {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let core = managed.core.clone();
    let handle = tauri::async_runtime::spawn(async move {
        if let Err(error) = run_listener(pipe_name, core, dispatcher, shutdown_rx, ready_tx).await {
            // A failure here happens only *after* a successful bind (the bind failure path
            // already reported itself through `ready` and returned before reaching this point).
            // Post-bind transport failures are not surfaced to the frontend today; `agent_access_status`
            // still reports the profile as enabled since they are a packaging/platform boundary
            // rather than an owner-actionable app state. See docs/AGENT_ACCESS.md "Verification status".
            eprintln!("hammond agent access: listener stopped: {error}");
        }
    });

    // Safe to block this thread on a plain channel recv here: this command never runs on a
    // Tokio worker thread that's driving other tasks (see the doc comment above), so there is
    // nothing else on this thread to starve.
    match ready_rx.blocking_recv() {
        Ok(Ok(())) => {
            *managed
                .listener
                .lock()
                .expect("agent access listener lock poisoned") = Some(RunningListener {
                shutdown: shutdown_tx,
                handle,
            });
            Ok(())
        }
        Ok(Err(message)) => {
            handle.abort();
            Err(AgentAccessCommandError::Transport(message))
        }
        Err(_recv_error) => {
            handle.abort();
            Err(AgentAccessCommandError::Transport(
                "The agent access listener stopped before it finished starting.".to_owned(),
            ))
        }
    }
}

#[tauri::command]
pub fn agent_access_enable(
    app: AppHandle,
    state: State<'_, AgentAccessManaged>,
    project_id: String,
    project_name: String,
    permission: Permission,
) -> Result<ConnectionInfoDto, AgentAccessCommandError> {
    stop_listener(&state);
    if let Some(previous) = state.core.current() {
        state.pending.invalidate_generation(previous.generation);
    }
    // Truthful status while enabling is in flight: nothing is enabled again until a listener is
    // actually confirmed live and the new profile is durably written below.
    state.core.set(None);

    let profile_id = generate_token(16);
    let secret = generate_token(32);
    let pipe_name = pipe_name_for(&profile_id);
    let profile = AgentAccessProfile {
        profile_id,
        secret,
        pipe_name: pipe_name.clone(),
        project_id,
        project_name,
        permission,
        generation: 1,
        created_at: current_timestamp(),
    };

    let dispatcher = build_dispatcher(app.clone(), state.pending.clone());
    start_listener(&state, pipe_name, dispatcher)?;

    let dir = match profile_dir(&app) {
        Ok(dir) => dir,
        Err(error) => {
            stop_listener(&state);
            return Err(error);
        }
    };
    if let Err(error) = store::write_profile(&dir, &profile) {
        stop_listener(&state);
        return Err(map_store_error(error));
    }
    state.core.set(Some(profile.clone()));

    Ok(to_dto(&app, &profile))
}

#[tauri::command]
pub fn agent_access_disable(
    app: AppHandle,
    state: State<'_, AgentAccessManaged>,
) -> Result<(), AgentAccessCommandError> {
    stop_listener(&state);
    if let Some(previous) = state.core.current() {
        state.pending.invalidate_generation(previous.generation);
    }
    state.core.set(None);
    let dir = profile_dir(&app)?;
    store::clear_profile(&dir).map_err(map_store_error)?;
    Ok(())
}

#[tauri::command]
pub fn agent_access_status(
    app: AppHandle,
    state: State<'_, AgentAccessManaged>,
) -> Option<ConnectionInfoDto> {
    state.core.current().as_ref().map(|profile| to_dto(&app, profile))
}

/// Mints a fresh generation (and, since a pipe connection is validated against the exact
/// generation captured at its own handshake, invalidates every currently-open connection) for
/// the same project/permission grant — used by "revoke connection" in the settings UI to force
/// every existing agent connection to re-authenticate without discarding the owner's chosen
/// project/permission.
#[tauri::command]
pub fn agent_access_revoke(
    app: AppHandle,
    state: State<'_, AgentAccessManaged>,
) -> Result<ConnectionInfoDto, AgentAccessCommandError> {
    let Some(previous_generation) = state.core.current().map(|p| p.generation) else {
        return Err(AgentAccessCommandError::NotEnabled(
            "Agent access is not currently enabled.".to_owned(),
        ));
    };
    state
        .core
        .bump_generation()
        .expect("checked non-None above");
    state.pending.invalidate_generation(previous_generation);
    let profile = state.core.current().expect("just set above");
    Ok(to_dto(&app, &profile))
}

#[tauri::command]
pub fn agent_access_respond(
    state: State<'_, AgentAccessManaged>,
    response: FacadeResponsePayload,
) -> bool {
    let outcome = if response.ok {
        FacadeOutcome::Ok(response.result.unwrap_or(serde_json::Value::Null))
    } else {
        FacadeOutcome::Err(
            response
                .error
                .unwrap_or_else(|| FacadeError::new("internal_error", "no error detail provided")),
        )
    };
    state
        .pending
        .resolve(&response.correlation_id, response.generation, outcome)
}

fn current_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    // A minimal RFC 3339 UTC formatter (no external time crate): precise enough for a
    // human-readable "connected since" display, not used for any comparison logic.
    humantime_rfc3339(now.as_secs())
}

fn humantime_rfc3339(unix_secs: u64) -> String {
    let days_since_epoch = unix_secs / 86_400;
    let time_of_day = unix_secs % 86_400;
    let (hours, minutes, seconds) = (
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60,
    );

    // Civil-from-days (Howard Hinnant's algorithm), proleptic Gregorian, valid for the full range
    // this app will ever see.
    let z = days_since_epoch as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_formats_a_known_unix_time_as_rfc3339() {
        // Cross-checked against `date -u -d @1788675799`.
        assert_eq!(humantime_rfc3339(1_788_675_799), "2026-09-06T06:23:19Z");
    }

    #[test]
    fn timestamp_handles_the_unix_epoch() {
        assert_eq!(humantime_rfc3339(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn launch_config_never_embeds_a_secret_and_is_keyed_by_profile_id() {
        let config = build_launch_config("/opt/hammond/hammond-mcp-companion", "profile-xyz");
        let serialized = config.to_string();
        assert!(serialized.contains("profile-xyz"));
        assert!(serialized.contains("hammond-mcp-companion"));
        assert!(!serialized.to_lowercase().contains("secret"));
    }

    #[test]
    fn launch_config_command_preserves_spaces_in_a_windows_install_path() {
        // A real install-directory shape: Windows installers commonly land under
        // `C:\Program Files\...`, and the copied command must round-trip through JSON exactly —
        // no truncation at the space, no shell-style escaping that would corrupt it.
        let command = r"C:\Program Files\Hammond\hammond-mcp-companion.exe";
        let config = build_launch_config(command, "profile-xyz");
        assert_eq!(
            config["mcpServers"]["hammond"]["command"],
            serde_json::Value::String(command.to_owned())
        );
    }

    #[test]
    fn companion_command_falls_back_to_the_bare_name_when_nothing_resolves() {
        assert_eq!(
            build_companion_command(None, "hammond-mcp-companion.exe"),
            "hammond-mcp-companion.exe"
        );
    }

    #[test]
    fn companion_command_prefers_a_resolved_path_with_spaces_over_the_bare_name() {
        let resolved = std::path::Path::new(r"C:\Program Files\Hammond\hammond-mcp-companion.exe");
        assert_eq!(
            build_companion_command(Some(resolved), "hammond-mcp-companion.exe"),
            r"C:\Program Files\Hammond\hammond-mcp-companion.exe"
        );
    }
}

/// HAM3-014 owner-crash regression: exercises the *actual* production spawn boundary
/// (`start_listener`, unmodified — not a reduced copy) from a plain `#[test]` thread that never
/// entered a Tokio runtime, exactly matching the real native call site: `agent_access_enable` is
/// a synchronous (`body_blocking`) `#[tauri::command]`, so Tauri dispatches it inline on whatever
/// native thread delivers IPC, which never has an entered Tokio runtime on its own.
///
/// Before the fix, `start_listener` called a bare `tokio::spawn`, which panics under exactly
/// this condition (`Handle::current()` finds nothing). On Windows that panic unwinds into the
/// WebView2/tao native callback boundary and aborts the process
/// (`__fastfail(FAST_FAIL_FATAL_APP_EXIT)`), which is exactly the WER signature the owner
/// reported (`EventType BEX64`, exception `c0000409`, exception data `7`). A plain
/// `#[tokio::test]` would hide this entirely, because the test body itself would already be
/// running inside an entered runtime — the opposite of the real native call site. These tests
/// call `start_listener` directly (rather than through the full Tauri IPC/command-macro layer)
/// because the production command signatures are hardcoded to the default `Wry` runtime, not
/// generic over `tauri::Runtime`, so they cannot be driven through `tauri::test`'s `MockRuntime`
/// without a broader signature change than this fix's scope; `start_listener` itself needed no
/// `AppHandle` at all once decoupled from `build_dispatcher`, which is exactly what makes this
/// direct, unmocked reproduction possible.
#[cfg(test)]
mod command_boundary_tests {
    use super::*;

    fn no_op_dispatcher() -> Dispatcher {
        Arc::new(|_ctx: FacadeCallContext| {
            Box::pin(async { FacadeOutcome::Err(FacadeError::new("unused", "unused")) })
        })
    }

    /// Reproduces the exact call-site condition that crashed the owner build: no Tokio runtime
    /// has ever been entered on this thread.
    fn assert_no_runtime_is_entered() {
        assert!(
            tokio::runtime::Handle::try_current().is_err(),
            "this test must run without an entered Tokio runtime to reproduce the real bug; \
             a #[tokio::test] here would silently hide the defect"
        );
    }

    #[test]
    fn starting_the_listener_from_a_thread_with_no_entered_tokio_runtime_does_not_panic() {
        assert_no_runtime_is_entered();
        let managed = AgentAccessManaged::default();

        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            start_listener(
                &managed,
                pipe_name_for("ham3-014-regression"),
                no_op_dispatcher(),
            )
        }));

        assert!(
            outcome.is_ok(),
            "start_listener panicked when called from a thread with no entered Tokio runtime — \
             this is the HAM3-014 native crash (a bare tokio::spawn call with no entered runtime \
             context)"
        );
    }

    /// This platform (`cfg(not(windows))`) has no named-pipe transport, so the bind inside
    /// `start_listener` always fails. That failure must come back as the existing structured
    /// `Transport` error — not a panic, and not a silent "succeeded" with no listener behind it —
    /// and must leave no `RunningListener` behind, proving there is no orphaned listener task to
    /// leak on a real (Windows) bind failure either.
    #[cfg(not(windows))]
    #[test]
    fn a_failed_bind_reports_a_structured_error_and_leaves_no_running_listener() {
        assert_no_runtime_is_entered();
        let managed = AgentAccessManaged::default();

        let result = start_listener(
            &managed,
            pipe_name_for("ham3-014-regression"),
            no_op_dispatcher(),
        );
        assert!(
            matches!(result, Err(AgentAccessCommandError::Transport(_))),
            "expected a structured Transport error from this platform's unsupported pipe \
             transport, got {result:?}"
        );
        assert!(
            managed
                .listener
                .lock()
                .expect("agent access listener lock poisoned")
                .is_none(),
            "a failed bind must not leave a RunningListener behind"
        );

        // Restart after a failure must behave identically — no deadlock, no leaked task, no
        // stale state carried over from the previous attempt.
        let second = start_listener(
            &managed,
            pipe_name_for("ham3-014-regression-2"),
            no_op_dispatcher(),
        );
        assert!(matches!(second, Err(AgentAccessCommandError::Transport(_))));
        assert!(managed
            .listener
            .lock()
            .expect("agent access listener lock poisoned")
            .is_none());
    }
}

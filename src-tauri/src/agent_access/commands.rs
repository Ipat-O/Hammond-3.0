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
    handle: tokio::task::JoinHandle<()>,
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

fn to_dto(profile: &AgentAccessProfile) -> ConnectionInfoDto {
    ConnectionInfoDto {
        profile_id: profile.profile_id.clone(),
        project_id: profile.project_id.clone(),
        project_name: profile.project_name.clone(),
        permission: profile.permission,
        generation: profile.generation,
        created_at: profile.created_at.clone(),
        launch_config: launch_config_for(&profile.profile_id),
    }
}

/// The copyable MCP host config snippet. `command` assumes the companion binary is installed as
/// a sibling of Hammond's own executable (wired by the packaging step — see
/// docs/AGENT_ACCESS.md "Packaging"); if that resolution fails for any reason this falls back to
/// the bare binary name and the owner is expected to adjust the path themselves. Deliberately
/// carries only the opaque `profile_id`, never the connection secret (D-022: "Config contains an
/// opaque profile identifier, not a password/token or project content").
fn launch_config_for(profile_id: &str) -> serde_json::Value {
    let companion_name = if cfg!(windows) {
        "hammond-mcp-companion.exe"
    } else {
        "hammond-mcp-companion"
    };
    let command = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|dir| dir.join(companion_name)))
        .and_then(|p| p.to_str().map(str::to_owned))
        .unwrap_or_else(|| companion_name.to_owned());

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

fn start_listener(app: &AppHandle, managed: &AgentAccessManaged, pipe_name: String) {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let dispatcher = build_dispatcher(app.clone(), managed.pending.clone());
    let core = managed.core.clone();
    let handle = tokio::spawn(async move {
        if let Err(error) = run_listener(pipe_name, core, dispatcher, shutdown_rx).await {
            // The listener stopping is not itself surfaced to the frontend today; `agent_access_status`
            // still reports the profile as enabled since native-transport failures (e.g. this
            // platform has no Windows named pipe support) are a packaging/platform boundary rather
            // than an owner-actionable app state. See docs/AGENT_ACCESS.md "Verification status".
            eprintln!("hammond agent access: listener stopped: {error}");
        }
    });
    *managed
        .listener
        .lock()
        .expect("agent access listener lock poisoned") = Some(RunningListener {
        shutdown: shutdown_tx,
        handle,
    });
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

    let dir = profile_dir(&app)?;
    store::write_profile(&dir, &profile).map_err(map_store_error)?;
    state.core.set(Some(profile.clone()));
    start_listener(&app, &state, pipe_name);

    Ok(to_dto(&profile))
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
pub fn agent_access_status(state: State<'_, AgentAccessManaged>) -> Option<ConnectionInfoDto> {
    state.core.current().as_ref().map(to_dto)
}

/// Mints a fresh generation (and, since a pipe connection is validated against the exact
/// generation captured at its own handshake, invalidates every currently-open connection) for
/// the same project/permission grant — used by "revoke connection" in the settings UI to force
/// every existing agent connection to re-authenticate without discarding the owner's chosen
/// project/permission.
#[tauri::command]
pub fn agent_access_revoke(
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
    Ok(to_dto(&profile))
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
        let config = launch_config_for("profile-xyz");
        let serialized = config.to_string();
        assert!(serialized.contains("profile-xyz"));
        assert!(serialized.contains("hammond-mcp-companion"));
        assert!(!serialized.to_lowercase().contains("secret"));
    }
}

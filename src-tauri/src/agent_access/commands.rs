//! Tauri commands the webview calls: answering a bridged request, reporting sign-in readiness,
//! and the token status/reveal/rotate/revoke flow surfaced in Settings.

use serde::Serialize;
use tauri::State;

use super::bridge::{drain_pending, respond, BridgeResponse};
use super::state::{AgentAccessState, Readiness};
use super::token::{self, AgentAccessStatus};

#[tauri::command]
pub fn agent_access_respond(
    state: State<'_, AgentAccessState>,
    id: String,
    response: BridgeResponse,
) {
    respond(&state, id, response);
}

/// Called on sign-out or workspace window teardown so any HTTP request still waiting on a
/// pending bridge answer fails fast with a clear reason instead of waiting out the full timeout.
#[tauri::command]
pub fn agent_access_disconnect(state: State<'_, AgentAccessState>, reason: String) {
    drain_pending(&state, &reason);
}

/// The webview calls this whenever its own auth state settles (loading → signed in / signed
/// out) or changes later (sign-out, session expiry). Rust never inspects the Supabase session
/// itself; this is the only source of truth it has for whether operations may execute. Signing
/// out also drains any request already in flight, since "sign-out must prevent new work and
/// queued unauthorized mutations" a request dispatched moments earlier must not complete an
/// unauthorized mutation after this call returns.
#[tauri::command]
pub fn agent_access_set_signed_in(state: State<'_, AgentAccessState>, signed_in: bool) {
    let next = if signed_in {
        Readiness::SignedIn
    } else {
        Readiness::SignedOut
    };
    *state
        .readiness
        .lock()
        .expect("agent access readiness lock poisoned") = next;
    if !signed_in {
        drain_pending(&state, "Hammond signed out before this request completed.");
    }
}

#[tauri::command]
pub fn agent_access_get_status(state: State<'_, AgentAccessState>) -> AgentAccessStatus {
    state
        .credentials
        .lock()
        .expect("agent access credentials lock poisoned")
        .status()
}

#[derive(Debug, Serialize)]
pub struct RevealedToken {
    pub token: String,
    pub port: u16,
}

/// Returns the raw bearer token — an explicit owner action from Settings only, never called
/// implicitly and never logged by any caller of it.
#[tauri::command]
pub fn agent_access_reveal_token(state: State<'_, AgentAccessState>) -> RevealedToken {
    let credentials = state
        .credentials
        .lock()
        .expect("agent access credentials lock poisoned");
    RevealedToken {
        token: credentials.token.clone(),
        port: credentials.port,
    }
}

#[tauri::command]
pub fn agent_access_rotate_token(
    app: tauri::AppHandle,
    state: State<'_, AgentAccessState>,
) -> Result<AgentAccessStatus, String> {
    let mut credentials = state
        .credentials
        .lock()
        .expect("agent access credentials lock poisoned");
    let next = token::rotate(&app, &credentials)?;
    *credentials = next.clone();
    Ok(next.status())
}

#[tauri::command]
pub fn agent_access_revoke_token(
    app: tauri::AppHandle,
    state: State<'_, AgentAccessState>,
) -> Result<AgentAccessStatus, String> {
    let mut credentials = state
        .credentials
        .lock()
        .expect("agent access credentials lock poisoned");
    let next = token::revoke(&app, &credentials)?;
    *credentials = next.clone();
    Ok(next.status())
}

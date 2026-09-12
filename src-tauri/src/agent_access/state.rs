//! The one piece of Tauri-managed state the local API is built from: the current credentials,
//! sign-in readiness, whether the webview bridge listener is attached, and the bridge's
//! pending-request map. A single `AgentAccessState` instance is created once at startup
//! (`server::bootstrap`) and shared by every HTTP request handler and every `agent_access_*`
//! command — never reconstructed per-request.

use std::sync::Mutex;

use serde::Serialize;

use super::bridge::PendingRequests;
use super::token::AgentAccessCredentials;

/// Whether the signed-in owner session the local API executes operations as is currently known.
/// Distinguishing `Starting` from `SignedOut` lets a client tell "give it a moment" apart from
/// "an owner needs to sign in" without Rust ever inspecting the Supabase session itself — the
/// webview is the only thing that knows that, and reports it via `agent_access_set_signed_in`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Readiness {
    Starting,
    SignedIn,
    SignedOut,
}

pub struct AgentAccessState {
    pub credentials: Mutex<AgentAccessCredentials>,
    pub readiness: Mutex<Readiness>,
    /// `true` only once the webview has registered its `agent-access://request` listener (and
    /// reset to `false` the moment that listener is torn down). A request is never forwarded to
    /// the webview unless this holds — otherwise a request arriving in the startup gap between
    /// "readiness published" and "listener registered" would be dispatched into nothing and time
    /// out as an unknown outcome even though it never ran. Owned entirely by the webview via
    /// `agent_access_set_listener_attached`.
    pub listener_attached: Mutex<bool>,
    pub pending: PendingRequests,
    /// Set when `server::bootstrap` could not bind/persist and the API is running in a safe
    /// disabled state. Surfaced to the owner via `agent_access_get_status`; never a panic.
    pub bootstrap_error: Option<String>,
}

impl AgentAccessState {
    pub fn new(credentials: AgentAccessCredentials) -> Self {
        Self {
            credentials: Mutex::new(credentials),
            readiness: Mutex::new(Readiness::Starting),
            listener_attached: Mutex::new(false),
            pending: PendingRequests::default(),
            bootstrap_error: None,
        }
    }

    /// A safe, permanently-disabled state installed when `server::bootstrap` fails, so every
    /// `agent_access_*` command still has managed state to read instead of panicking on
    /// unmanaged state. The empty token means `authorize` refuses every request outright.
    pub fn failed(error: impl Into<String>) -> Self {
        let mut state = Self::new(AgentAccessCredentials {
            version: 1,
            enabled: false,
            token: String::new(),
            port: 0,
            pid: std::process::id(),
            started_at: "1970-01-01T00:00:00Z".to_owned(),
        });
        state.bootstrap_error = Some(error.into());
        state
    }
}

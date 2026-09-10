//! The one piece of Tauri-managed state the local API is built from: the current credentials,
//! sign-in readiness, and the bridge's pending-request map. A single `AgentAccessState` instance
//! is created once at startup (`server::bootstrap`) and shared by every HTTP request handler and
//! every `agent_access_*` command — never reconstructed per-request.

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
    pub pending: PendingRequests,
}

impl AgentAccessState {
    pub fn new(credentials: AgentAccessCredentials) -> Self {
        Self {
            credentials: Mutex::new(credentials),
            readiness: Mutex::new(Readiness::Starting),
            pending: PendingRequests::default(),
        }
    }
}

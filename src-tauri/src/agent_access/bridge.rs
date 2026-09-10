//! Correlates one HTTP request (handled entirely in Rust) with its execution in the webview,
//! where the TypeScript operation registry actually runs. Rust never executes a Hammond domain
//! operation itself: `dispatch` emits an event the webview's own `agent-access://request`
//! listener picks up, and the only way an answer reaches back here is the webview calling the
//! `agent_access_respond` command below — which, like every Tauri command, can only be invoked
//! from script running inside this application's own webview, never from an external process.
//! That is what "trust responses only from the designated application webview" reduces to in
//! practice: there is no other caller of `agent_access_respond` for an external process to spoof.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use tokio::time::timeout;
use uuid::Uuid;

use super::state::AgentAccessState;

pub const REQUEST_EVENT: &str = "agent-access://request";
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BridgeRequestPayload {
    ListOperations,
    Invoke { name: String, input: Value },
}

#[derive(Debug, Clone, Serialize)]
pub struct BridgeRequest {
    pub id: String,
    #[serde(flatten)]
    pub payload: BridgeRequestPayload,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BridgeError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct BridgeResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BridgeError>,
}

#[derive(Default)]
pub struct PendingRequests(Mutex<HashMap<String, oneshot::Sender<BridgeResponse>>>);

pub enum BridgeOutcome {
    Response(BridgeResponse),
    /// The webview did not answer within `RESPONSE_TIMEOUT`. The underlying operation's outcome
    /// is genuinely unknown at this point (dispatch may already have reached the registry and
    /// even completed a mutation) — callers must surface this as an unknown-outcome error, never
    /// retry automatically, and never report it as a plain failure.
    TimedOut,
    /// The request was never handed to the webview at all (the `emit` failed because no window
    /// is attached). Nothing ran; this is safe for a caller to retry once Hammond is back.
    Disconnected,
}

/// A request that was already emitted to the webview but whose correlation was torn down before
/// an answer came back (sign-out drain, window unmount, shutdown). Its side effects — a mutation
/// in particular — may or may not have committed, exactly like a timeout: report it as an
/// unknown outcome carrying the request id, never as "did not execute", and never auto-retry.
fn unknown_outcome_response(reason: &str, id: &str) -> BridgeResponse {
    BridgeResponse {
        result: None,
        error: Some(BridgeError {
            code: "unknown_outcome".to_owned(),
            message: format!(
                "{reason} Request {id} had already been dispatched to the Hammond workspace \
                 window; its effect (including any mutation) may or may not have committed. Do \
                 not retry automatically — re-read the affected record to reconcile."
            ),
            details: None,
        }),
    }
}

/// Sends `payload` to the webview and waits for `agent_access_respond` to resolve it, bounded by
/// `RESPONSE_TIMEOUT`. Never retried automatically by this function or any caller of it.
pub async fn dispatch(
    app: &AppHandle,
    state: &AgentAccessState,
    payload: BridgeRequestPayload,
) -> BridgeOutcome {
    let id = Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = state
            .pending
            .0
            .lock()
            .expect("agent access bridge lock poisoned");
        pending.insert(id.clone(), tx);
    }

    let request = BridgeRequest {
        id: id.clone(),
        payload,
    };
    if app.emit(REQUEST_EVENT, &request).is_err() {
        state
            .pending
            .0
            .lock()
            .expect("agent access bridge lock poisoned")
            .remove(&id);
        return BridgeOutcome::Disconnected;
    }

    match timeout(RESPONSE_TIMEOUT, rx).await {
        Ok(Ok(response)) => BridgeOutcome::Response(response),
        Ok(Err(_)) => BridgeOutcome::Disconnected,
        Err(_) => {
            state
                .pending
                .0
                .lock()
                .expect("agent access bridge lock poisoned")
                .remove(&id);
            BridgeOutcome::TimedOut
        }
    }
}

/// Resolves one pending request. An `id` with no matching sender is a late or duplicate reply
/// (already timed out or already answered) and is dropped silently — the original HTTP caller
/// has already moved on and nothing here should surface an error for that.
pub fn respond(state: &AgentAccessState, id: String, response: BridgeResponse) {
    let sender = state
        .pending
        .0
        .lock()
        .expect("agent access bridge lock poisoned")
        .remove(&id);
    if let Some(sender) = sender {
        let _ = sender.send(response);
    }
}

/// Drains every still-pending request — used on sign-out, window close, and app shutdown — so an
/// in-flight HTTP call fails fast instead of waiting out the full timeout for an answer that will
/// now never come. Every drained entry was already emitted to the webview (`dispatch` only keeps
/// an entry pending after a successful `emit`), so each is reported as an unknown outcome, not as
/// "not executed": a mutation dispatched moments before sign-out can still have committed.
pub fn drain_pending(state: &AgentAccessState, reason: &str) {
    let mut pending = state
        .pending
        .0
        .lock()
        .expect("agent access bridge lock poisoned");
    for (id, sender) in pending.drain() {
        let _ = sender.send(unknown_outcome_response(reason, &id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_pending_resolves_every_waiter_as_an_unknown_outcome_carrying_its_request_id() {
        let state = AgentAccessState::new(super::super::token::AgentAccessCredentials {
            version: 1,
            enabled: true,
            token: "test-token".to_owned(),
            port: 0,
            pid: 0,
            started_at: "2026-01-01T00:00:00Z".to_owned(),
        });

        let (tx1, rx1) = oneshot::channel();
        let (tx2, rx2) = oneshot::channel();
        state.pending.0.lock().unwrap().insert("req-a".to_owned(), tx1);
        state.pending.0.lock().unwrap().insert("req-b".to_owned(), tx2);

        drain_pending(&state, "Hammond signed out before this request completed.");

        let a = rx1.blocking_recv().unwrap();
        let b = rx2.blocking_recv().unwrap();
        // A dispatched request that is drained is NOT reported as "did not execute" — a mutation
        // sent moments before sign-out may have committed. It is an unknown outcome, id included
        // so a caller can reconcile the specific request.
        assert_eq!(a.error.as_ref().unwrap().code, "unknown_outcome");
        assert_eq!(b.error.as_ref().unwrap().code, "unknown_outcome");
        assert!(a.error.as_ref().unwrap().message.contains("req-a"));
        assert!(b.error.as_ref().unwrap().message.contains("req-b"));
        assert!(a.error.as_ref().unwrap().message.contains("re-read"));
        assert!(state.pending.0.lock().unwrap().is_empty());
    }

    #[test]
    fn respond_to_an_unknown_id_does_not_panic() {
        let state = AgentAccessState::new(super::super::token::AgentAccessCredentials {
            version: 1,
            enabled: true,
            token: "test-token".to_owned(),
            port: 0,
            pid: 0,
            started_at: "2026-01-01T00:00:00Z".to_owned(),
        });
        respond(
            &state,
            "does-not-exist".to_owned(),
            BridgeResponse::default(),
        );
    }

    #[test]
    fn respond_delivers_the_response_to_exactly_the_matching_waiter() {
        let state = AgentAccessState::new(super::super::token::AgentAccessCredentials {
            version: 1,
            enabled: true,
            token: "test-token".to_owned(),
            port: 0,
            pid: 0,
            started_at: "2026-01-01T00:00:00Z".to_owned(),
        });
        let (tx, rx) = oneshot::channel();
        state.pending.0.lock().unwrap().insert("a".to_owned(), tx);

        respond(
            &state,
            "a".to_owned(),
            BridgeResponse {
                result: Some(Value::String("ok".to_owned())),
                error: None,
            },
        );

        let response = rx.blocking_recv().unwrap();
        assert_eq!(response.result, Some(Value::String("ok".to_owned())));
    }
}

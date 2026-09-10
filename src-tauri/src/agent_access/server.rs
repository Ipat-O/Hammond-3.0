//! The loopback HTTP surface for local agent access: `GET /v1/operations` and
//! `POST /v1/operations/{name}`. Bound to `127.0.0.1` on an OS-assigned ephemeral port only
//! (never a fixed port, so two Hammond launches — or a stale process still holding a port after
//! a crash — never collide or need anything killed). Every request is Host/Origin-validated and
//! bearer-token-authenticated here, before it is ever forwarded to the webview; this module holds
//! no Hammond domain logic of its own.

use std::time::Duration;

use axum::extract::{Path as AxumPath, State as AxumState};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json};
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;
use tower::limit::ConcurrencyLimitLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;

use super::bridge::{dispatch, BridgeOutcome, BridgeRequestPayload};
use super::state::{AgentAccessState, Readiness};
use super::token;

const MAX_BODY_BYTES: usize = 256 * 1024;
const MAX_CONCURRENT_REQUESTS: usize = 8;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct ServerContext {
    app: AppHandle,
    port: u16,
}

/// Binds the listener, loads/creates the persisted token for this port, installs
/// `AgentAccessState` as managed Tauri state, and spawns the serve loop. Called once from
/// `lib.rs`'s `.setup()`. Returns the bound port so callers (tests, logging) can see it, though
/// the authoritative copy any client should read is the credentials file `token::load_or_create`
/// just wrote.
pub async fn bootstrap(app: AppHandle) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("failed to bind local agent-access listener: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("failed to read bound local address: {error}"))?
        .port();

    let credentials = token::load_or_create(&app, port)?;
    app.manage(AgentAccessState::new(credentials));

    let context = ServerContext {
        app: app.clone(),
        port,
    };
    let router = build_router(context);

    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("agent-access HTTP server stopped unexpectedly: {error}");
        }
    });

    Ok(port)
}

fn build_router(context: ServerContext) -> Router {
    Router::new()
        .route("/v1/operations", get(list_operations))
        .route("/v1/operations/{name}", post(invoke_operation))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::GATEWAY_TIMEOUT,
            REQUEST_TIMEOUT,
        ))
        .layer(RequestBodyLimitLayer::new(MAX_BODY_BYTES))
        .layer(ConcurrencyLimitLayer::new(MAX_CONCURRENT_REQUESTS))
        .with_state(context)
}

fn error_body(code: &str, message: &str) -> Value {
    json!({ "error": { "code": code, "message": message } })
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Host/Origin/bearer-token checks, run identically for both routes before anything is forwarded
/// to the webview. Rejects on the first failing check so an invalid Host never even gets to learn
/// whether a token would have been accepted.
fn authorize(
    headers: &HeaderMap,
    port: u16,
    state: &AgentAccessState,
) -> Result<(), (StatusCode, Json<Value>)> {
    let host_ok = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(|host| host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}"))
        .unwrap_or(false);
    if !host_ok {
        return Err((
            StatusCode::FORBIDDEN,
            Json(error_body(
                "invalid_host",
                "Request Host header does not match this local Hammond instance.",
            )),
        ));
    }

    // This API serves local process-to-process clients (the MCP adapter, direct HTTP checks)
    // only, never a browser page — any `Origin` header at all marks a browser-context request,
    // which is refused outright rather than checked against an allowlist, so wildcard CORS is
    // never even a temptation here.
    if headers.get(header::ORIGIN).is_some() {
        return Err((
            StatusCode::FORBIDDEN,
            Json(error_body(
                "untrusted_origin",
                "Browser-originated requests are not accepted by this API.",
            )),
        ));
    }

    let credentials = state
        .credentials
        .lock()
        .expect("agent access credentials lock poisoned");
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let token_ok = provided
        .map(|token| constant_time_eq(token.as_bytes(), credentials.token.as_bytes()))
        .unwrap_or(false);
    if !token_ok {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(error_body(
                "invalid_token",
                "Missing or invalid bearer token.",
            )),
        ));
    }
    if !credentials.enabled {
        return Err((
            StatusCode::FORBIDDEN,
            Json(error_body(
                "token_revoked",
                "The local API token has been revoked. Rotate it in Hammond settings.",
            )),
        ));
    }
    drop(credentials);

    match *state
        .readiness
        .lock()
        .expect("agent access readiness lock poisoned")
    {
        Readiness::SignedIn => Ok(()),
        Readiness::Starting => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(error_body("starting", "Hammond is still starting up.")),
        )),
        Readiness::SignedOut => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(error_body(
                "signed_out",
                "Hammond is running but no owner is signed in.",
            )),
        )),
    }
}

/// Maps a registry error code (defined in `src/agentAccess/registry.ts`, transport-agnostic) to
/// an HTTP status. Unknown codes fall back to 500 rather than guessing.
fn status_for_error_code(code: &str) -> StatusCode {
    match code {
        "validation_error" | "bad_request" => StatusCode::BAD_REQUEST,
        "unauthenticated" | "signed_out" => StatusCode::UNAUTHORIZED,
        "forbidden" | "cross_owner" => StatusCode::FORBIDDEN,
        "not_found" | "unknown_operation" => StatusCode::NOT_FOUND,
        "conflict" | "stale_preview" | "requires_confirmation" => StatusCode::CONFLICT,
        "payload_too_large" => StatusCode::PAYLOAD_TOO_LARGE,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn list_operations(
    AxumState(ctx): AxumState<ServerContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let state = ctx.app.state::<AgentAccessState>();
    if let Err(response) = authorize(&headers, ctx.port, &state) {
        return response;
    }
    respond_from_bridge(&ctx, &state, BridgeRequestPayload::ListOperations).await
}

async fn invoke_operation(
    AxumState(ctx): AxumState<ServerContext>,
    AxumPath(name): AxumPath<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let state = ctx.app.state::<AgentAccessState>();
    if let Err(response) = authorize(&headers, ctx.port, &state) {
        return response;
    }

    let input: Value = if body.is_empty() {
        Value::Null
    } else {
        match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(error_body(
                        "bad_request",
                        &format!("Request body is not valid JSON: {error}"),
                    )),
                );
            }
        }
    };

    respond_from_bridge(&ctx, &state, BridgeRequestPayload::Invoke { name, input }).await
}

async fn respond_from_bridge(
    ctx: &ServerContext,
    state: &AgentAccessState,
    payload: BridgeRequestPayload,
) -> (StatusCode, Json<Value>) {
    match dispatch(&ctx.app, state, payload).await {
        BridgeOutcome::Response(response) => {
            if let Some(error) = response.error {
                let status = status_for_error_code(&error.code);
                (
                    status,
                    Json(
                        json!({ "error": { "code": error.code, "message": error.message, "details": error.details } }),
                    ),
                )
            } else {
                (StatusCode::OK, Json(json!({ "result": response.result })))
            }
        }
        BridgeOutcome::TimedOut => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(json!({
                "error": {
                    "code": "unknown_outcome",
                    "message": "The workspace window did not answer in time. The operation may or may not have completed; do not retry automatically. Recheck the affected record before retrying.",
                }
            })),
        ),
        BridgeOutcome::Disconnected => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": {
                    "code": "disconnected",
                    "message": "No Hammond workspace window is currently attached to answer this request.",
                }
            })),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_matches_only_identical_byte_strings() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"a"));
    }

    #[test]
    fn status_for_error_code_maps_known_codes_and_falls_back_for_unknown_ones() {
        assert_eq!(
            status_for_error_code("validation_error"),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(status_for_error_code("not_found"), StatusCode::NOT_FOUND);
        assert_eq!(status_for_error_code("conflict"), StatusCode::CONFLICT);
        assert_eq!(
            status_for_error_code("something_unmapped"),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}

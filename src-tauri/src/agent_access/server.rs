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
///
/// `AgentAccessState` is installed as managed state **whatever happens** — on failure a safe,
/// permanently-disabled `AgentAccessState::failed(...)` is installed instead — so the
/// `agent_access_*` commands the Settings panel calls always have state to read rather than
/// panicking on unmanaged state.
pub async fn bootstrap(app: AppHandle) -> Result<u16, String> {
    match try_bootstrap(&app).await {
        Ok(port) => Ok(port),
        Err(error) => {
            if app.try_state::<AgentAccessState>().is_none() {
                app.manage(AgentAccessState::failed(error.clone()));
            }
            Err(error)
        }
    }
}

async fn try_bootstrap(app: &AppHandle) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("failed to bind local agent-access listener: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("failed to read bound local address: {error}"))?
        .port();

    let credentials = token::load_or_create(app, port)?;
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

    // A request is never forwarded to the webview unless a listener is actually attached to
    // receive it. This closes the startup gap (readiness published a beat before the listener
    // registered) and the teardown gap (window unmounted but readiness still says SignedIn) —
    // in both, a forwarded request would otherwise dispatch into nothing and read back as an
    // unknown outcome even though it never ran.
    if !*state
        .listener_attached
        .lock()
        .expect("agent access listener flag lock poisoned")
    {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(error_body(
                "starting",
                "Hammond is running but its workspace window is not ready to serve requests yet.",
            )),
        ));
    }

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
        // A drained-while-dispatched request (sign-out/unmount) comes back through the bridge as
        // an `unknown_outcome` response — same meaning and same 504 as a bridge timeout.
        "unknown_outcome" => StatusCode::GATEWAY_TIMEOUT,
        "disconnected" => StatusCode::SERVICE_UNAVAILABLE,
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
        // A drained-while-dispatched request comes back as `unknown_outcome` and must map to the
        // same 504 as a bridge timeout, never to a 500.
        assert_eq!(
            status_for_error_code("unknown_outcome"),
            StatusCode::GATEWAY_TIMEOUT
        );
        assert_eq!(
            status_for_error_code("disconnected"),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            status_for_error_code("something_unmapped"),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    // --- Authorization boundary (HAM3-015 Correction 1, F7) -------------------------------------
    //
    // Round 1 changed the bearer check to accept any provided token and every existing
    // agent-access Rust test still passed, because nothing exercised `authorize` itself. These
    // do: each asserts the *gate*'s decision (status + error code) for one class of request, so
    // weakening token/Host/Origin/readiness validation fails a test here rather than shipping.

    const TEST_PORT: u16 = 51_234;
    const GOOD_TOKEN: &str = "d3adb33fd3adb33fd3adb33fd3adb33fd3adb33fd3adb33fd3adb33fd3adb33f0";

    fn credentials(token: &str, enabled: bool) -> token::AgentAccessCredentials {
        token::AgentAccessCredentials {
            version: 1,
            enabled,
            token: token.to_owned(),
            port: TEST_PORT,
            pid: 0,
            started_at: "2026-01-01T00:00:00Z".to_owned(),
        }
    }

    /// A fully-serviceable state: enabled token, listener attached, owner signed in.
    fn ready_state() -> AgentAccessState {
        let state = AgentAccessState::new(credentials(GOOD_TOKEN, true));
        *state.readiness.lock().unwrap() = Readiness::SignedIn;
        *state.listener_attached.lock().unwrap() = true;
        state
    }

    fn headers(host: Option<&str>, bearer: Option<&str>, origin: Option<&str>) -> HeaderMap {
        let mut map = HeaderMap::new();
        if let Some(host) = host {
            map.insert(header::HOST, host.parse().unwrap());
        }
        if let Some(bearer) = bearer {
            map.insert(
                header::AUTHORIZATION,
                format!("Bearer {bearer}").parse().unwrap(),
            );
        }
        if let Some(origin) = origin {
            map.insert(header::ORIGIN, origin.parse().unwrap());
        }
        map
    }

    fn good_headers() -> HeaderMap {
        headers(
            Some(&format!("127.0.0.1:{TEST_PORT}")),
            Some(GOOD_TOKEN),
            None,
        )
    }

    fn deny_code(result: Result<(), (StatusCode, Json<Value>)>) -> (StatusCode, String) {
        let (status, body) = result.unwrap_err();
        let code = body.0["error"]["code"].as_str().unwrap_or_default().to_owned();
        (status, code)
    }

    #[test]
    fn authorize_accepts_a_correct_host_token_and_no_origin_when_ready() {
        assert!(authorize(&good_headers(), TEST_PORT, &ready_state()).is_ok());
        // localhost is an accepted Host spelling too.
        let alt = headers(
            Some(&format!("localhost:{TEST_PORT}")),
            Some(GOOD_TOKEN),
            None,
        );
        assert!(authorize(&alt, TEST_PORT, &ready_state()).is_ok());
    }

    #[test]
    fn authorize_rejects_a_missing_token() {
        let h = headers(Some(&format!("127.0.0.1:{TEST_PORT}")), None, None);
        assert_eq!(
            deny_code(authorize(&h, TEST_PORT, &ready_state())),
            (StatusCode::UNAUTHORIZED, "invalid_token".to_owned())
        );
    }

    #[test]
    fn authorize_rejects_a_present_but_wrong_token() {
        // The specific regression: a wrong-but-present bearer must still be refused. A check
        // weakened to `provided.is_some()` would let this through and fail here.
        let h = headers(
            Some(&format!("127.0.0.1:{TEST_PORT}")),
            Some("not-the-real-token-not-the-real-token-not-the-real-token-0000000"),
            None,
        );
        assert_eq!(
            deny_code(authorize(&h, TEST_PORT, &ready_state())),
            (StatusCode::UNAUTHORIZED, "invalid_token".to_owned())
        );
    }

    #[test]
    fn authorize_rejects_a_wrong_host() {
        let h = headers(Some("evil.example.com"), Some(GOOD_TOKEN), None);
        assert_eq!(
            deny_code(authorize(&h, TEST_PORT, &ready_state())),
            (StatusCode::FORBIDDEN, "invalid_host".to_owned())
        );
        // A missing Host is refused the same way, before the token is even considered.
        let none = headers(None, Some(GOOD_TOKEN), None);
        assert_eq!(deny_code(authorize(&none, TEST_PORT, &ready_state())).0, StatusCode::FORBIDDEN);
    }

    #[test]
    fn authorize_rejects_any_origin_header_outright() {
        let h = headers(
            Some(&format!("127.0.0.1:{TEST_PORT}")),
            Some(GOOD_TOKEN),
            Some("http://localhost"),
        );
        assert_eq!(
            deny_code(authorize(&h, TEST_PORT, &ready_state())),
            (StatusCode::FORBIDDEN, "untrusted_origin".to_owned())
        );
    }

    #[test]
    fn authorize_rejects_a_revoked_token_even_when_the_value_is_correct() {
        let state = AgentAccessState::new(credentials(GOOD_TOKEN, false));
        *state.readiness.lock().unwrap() = Readiness::SignedIn;
        *state.listener_attached.lock().unwrap() = true;
        assert_eq!(
            deny_code(authorize(&good_headers(), TEST_PORT, &state)),
            (StatusCode::FORBIDDEN, "token_revoked".to_owned())
        );
    }

    #[test]
    fn authorize_reflects_a_rotated_token_on_the_very_next_request() {
        let state = ready_state();
        assert!(authorize(&good_headers(), TEST_PORT, &state).is_ok());
        // Rotation replaces the in-memory credentials (as `agent_access_rotate_token` does).
        *state.credentials.lock().unwrap() = credentials("a-freshly-rotated-token-value-0000000000000000000000000000000000", true);
        assert_eq!(
            deny_code(authorize(&good_headers(), TEST_PORT, &state)).0,
            StatusCode::UNAUTHORIZED
        );
    }

    #[test]
    fn authorize_reports_starting_then_signed_out_by_readiness() {
        let starting = AgentAccessState::new(credentials(GOOD_TOKEN, true));
        *starting.listener_attached.lock().unwrap() = true;
        assert_eq!(
            deny_code(authorize(&good_headers(), TEST_PORT, &starting)),
            (StatusCode::SERVICE_UNAVAILABLE, "starting".to_owned())
        );

        let signed_out = AgentAccessState::new(credentials(GOOD_TOKEN, true));
        *signed_out.readiness.lock().unwrap() = Readiness::SignedOut;
        *signed_out.listener_attached.lock().unwrap() = true;
        assert_eq!(
            deny_code(authorize(&good_headers(), TEST_PORT, &signed_out)),
            (StatusCode::SERVICE_UNAVAILABLE, "signed_out".to_owned())
        );
    }

    #[test]
    fn authorize_refuses_to_forward_while_no_listener_is_attached_even_if_signed_in() {
        // The startup/teardown gap (HAM3-015 audit Finding 5): readiness says SignedIn but the
        // webview listener is not attached — a forwarded request would dispatch into nothing.
        let state = AgentAccessState::new(credentials(GOOD_TOKEN, true));
        *state.readiness.lock().unwrap() = Readiness::SignedIn;
        // listener_attached left at its default `false`
        assert_eq!(
            deny_code(authorize(&good_headers(), TEST_PORT, &state)),
            (StatusCode::SERVICE_UNAVAILABLE, "starting".to_owned())
        );
    }

    #[test]
    fn failed_state_refuses_every_request_and_surfaces_the_bootstrap_error() {
        let state = AgentAccessState::failed("could not read credentials file");
        *state.readiness.lock().unwrap() = Readiness::SignedIn;
        *state.listener_attached.lock().unwrap() = true;
        // Empty token in the disabled state → nothing authenticates.
        assert_eq!(
            deny_code(authorize(&good_headers(), TEST_PORT, &state)).0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            state.bootstrap_error.as_deref(),
            Some("could not read credentials file")
        );
    }
}

//! Local API + MCP access (HAM3-015): a loopback HTTP surface, bound to `127.0.0.1` only, that
//! forwards authenticated requests to the one TypeScript operation registry running in the
//! webview. Rust never implements Hammond domain behavior a second time here — every module in
//! this tree is transport, authentication, and correlation only; see `src/agentAccess/registry.ts`
//! for the actual operations.
//!
//! - `token`: the persisted local bearer token + connection metadata (port/pid), owner-restricted
//!   on disk, with rotate/revoke support.
//! - `state`: the shared `AgentAccessState` (credentials, readiness, pending-request map) managed
//!   as Tauri app state.
//! - `bridge`: correlates one HTTP request with the webview's asynchronous answer to it.
//! - `server`: the axum HTTP server — binding, auth/Host/Origin checks, size/timeout/concurrency
//!   limits, and the two routes (`GET /v1/operations`, `POST /v1/operations/{name}`).
//! - `commands`: the Tauri commands the webview calls (`agent_access_respond`, status,
//!   rotate/revoke, sign-in state).

pub mod bridge;
pub mod commands;
pub mod server;
pub mod state;
pub mod token;

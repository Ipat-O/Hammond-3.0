//! HAM3-014 agent access protocol and state, shared between the `hammond-desktop` app (via
//! `src-tauri/src/agent_access`, which re-exports every module here and adds the Tauri command
//! surface in its own `commands` module) and the standalone `hammond-mcp-companion` binary
//! (`../companion`). Nothing in this crate depends on `tauri`, so the companion links only this
//! crate plus tokio — no webview/GTK/WebView2 runtime of its own. See
//! `/docs/AGENT_ACCESS.md` for the full architecture, tool contract, and disclosed verification
//! limitations.
//!
//! Module map:
//! - [`types`] / [`credential`] / [`framing`] — wire types, secrets, and frame I/O.
//! - [`store`] — persistence of the single active connection profile.
//! - [`core`] — the in-memory source of truth (`AgentAccessCore`) `server::handle_connection`
//!   validates every call against; independently testable.
//! - [`server`] — the transport-agnostic protocol: handshake, call loop, permission/generation
//!   checks. Exercised directly against `tokio::io::duplex()` in tests.
//! - [`pipe_transport`] — the real Windows named-pipe listener and client, `cfg(windows)`-gated.
//! - [`pending`] — the bounded table of calls relayed to the frontend and awaiting
//!   `agent_access_respond`.
//! - [`mcp`] — MCP JSON-RPC 2.0 types and the static `initialize`/`tools/list` payloads; used by
//!   the companion directly and by the app's tool contract tests.

pub mod core;
pub mod credential;
pub mod framing;
pub mod mcp;
pub mod pending;
pub mod pipe_transport;
pub mod server;
pub mod store;
pub mod types;

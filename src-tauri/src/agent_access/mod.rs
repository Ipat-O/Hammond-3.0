//! HAM3-014 agent access: a bundled MCP stdio companion (`src/bin/hammond_mcp_companion.rs`)
//! connects to this running, signed-in app over an authenticated Windows named pipe (D-022). See
//! `docs/AGENT_ACCESS.md` for the full architecture, tool contract, and disclosed verification
//! limitations (this crate cannot run or package a real Windows build).
//!
//! Module map:
//! - [`types`] / [`credential`] / [`framing`] — wire types, secrets, and frame I/O; no `tauri`
//!   dependency, shared with the companion binary.
//! - [`store`] — persistence of the single active connection profile.
//! - [`core`] — the in-memory source of truth (`AgentAccessCore`) `server::handle_connection`
//!   validates every call against; independently testable.
//! - [`server`] — the transport-agnostic protocol: handshake, call loop, permission/generation
//!   checks. Exercised directly against `tokio::io::duplex()` in tests.
//! - [`pipe_transport`] — the real Windows named-pipe listener, `cfg(windows)`-gated.
//! - [`pending`] — the bounded table of calls relayed to the frontend and awaiting
//!   `agent_access_respond`.
//! - [`commands`] — the Tauri command surface and the production `Dispatcher` that wires the
//!   pieces above to a running `AppHandle`.

pub mod commands;
pub mod core;
pub mod credential;
pub mod framing;
pub mod mcp;
pub mod pending;
pub mod pipe_transport;
pub mod server;
pub mod store;
pub mod types;

pub use commands::AgentAccessManaged;

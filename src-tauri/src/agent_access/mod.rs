//! HAM3-014 agent access: a bundled MCP stdio companion (`../../crates/companion`) connects to
//! this running, signed-in app over an authenticated Windows named pipe (D-022). See
//! `docs/AGENT_ACCESS.md` for the full architecture, tool contract, and disclosed verification
//! limitations (this crate cannot run or package a real Windows build).
//!
//! [`commands`] is the only module that lives here rather than in the shared
//! `hammond-agent-access` crate (`../../crates/agent-access`): it is the Tauri command surface
//! and the only piece of agent access that touches `tauri::AppHandle`/`State`. Every other
//! module — `core`, `credential`, `framing`, `mcp`, `pending`, `pipe_transport`, `server`,
//! `store` — is re-exported here unchanged from that shared crate, which the standalone
//! `hammond-mcp-companion` binary also depends on directly, so `commands.rs`'s existing
//! `super::core::...`-style imports keep working without a second copy of any of this logic.

pub mod commands;

pub use commands::AgentAccessManaged;
pub use hammond_agent_access::{core, credential, framing, mcp, pending, pipe_transport, server, store, types};

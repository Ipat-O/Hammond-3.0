//! Shared, transport-agnostic types for the agent-access facade: the permission model, the fixed
//! tool contract (HAM3-014), and the pipe-level envelope exchanged between the companion process
//! and the running app. Used by both the Tauri app binary and the standalone
//! `hammond-mcp-companion` binary, so this module must not depend on `tauri`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    ReadOnly,
    TaskWrite,
}

impl Permission {
    pub fn allows_write(self) -> bool {
        matches!(self, Permission::TaskWrite)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Permission::ReadOnly => "read_only",
            Permission::TaskWrite => "task_write",
        }
    }
}

/// The complete, fixed HAM3-014 tool contract. Order here is also the order `tools/list` reports
/// them in, so it is stable across releases.
pub const TOOL_NAMES: &[&str] = &[
    "get_project_context",
    "list_tasks",
    "get_task",
    "get_instructions",
    "list_instruction_versions",
    "get_instruction_version",
    "create_task",
    "update_task",
    "add_comment",
];

pub const WRITE_TOOL_NAMES: &[&str] = &["create_task", "update_task", "add_comment"];

pub fn is_known_tool(tool: &str) -> bool {
    TOOL_NAMES.contains(&tool)
}

pub fn tool_requires_write(tool: &str) -> bool {
    WRITE_TOOL_NAMES.contains(&tool)
}

/// A structured facade error. `code` is a stable machine-readable identifier (documented in
/// `docs/AGENT_ACCESS.md`); `message` is human-readable detail, never a raw driver/internal error.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FacadeError {
    pub code: String,
    pub message: String,
}

impl FacadeError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        FacadeError {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// One frame sent from the companion (pipe client) to the running app (pipe server).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    /// The first frame on every new pipe connection. `secret` proves the caller holds the
    /// app-issued credential for `profile_id`; it is never logged and never echoed back.
    Hello { profile_id: String, secret: String },
    /// A tool invocation. `id` is a caller-chosen correlation id, echoed back on the matching
    /// `ServerFrame::Result`.
    Call {
        id: String,
        tool: String,
        args: serde_json::Value,
    },
}

/// One frame sent from the running app (pipe server) to the companion (pipe client).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerFrame {
    HelloOk {
        generation: u64,
        project_id: String,
        project_name: String,
        permission: Permission,
    },
    HelloErr {
        error: FacadeError,
    },
    Result {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<FacadeError>,
    },
    /// Pushed unsolicited, then the server closes the connection: sign-out, revocation, an
    /// owner/project change, or app shutdown invalidated this connection's generation. The
    /// companion must surface a bounded actionable error to the MCP host and stop reusing the
    /// connection rather than silently retrying forever.
    Invalidated {
        reason: String,
    },
}

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
/// Bounded so a misbehaving or malicious client cannot exhaust the app's memory by opening many
/// calls without waiting for results.
pub const MAX_PENDING_REQUESTS: usize = 64;
pub const REQUEST_TIMEOUT_SECS: u64 = 20;

/// The event payload emitted to the frontend (`agent-facade-request`) for one call the pipe
/// server has already validated (known tool, permitted by the connection's read-only/task-write
/// grant, current generation). The frontend independently re-checks generation/auth before
/// executing — this is a relay, not an authorization decision.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacadeRequestPayload {
    pub correlation_id: String,
    pub generation: u64,
    pub project_id: String,
    pub permission: Permission,
    pub tool: String,
    pub args: serde_json::Value,
}

/// What the frontend posts back via the `agent_access_respond` command once it has executed (or
/// failed to execute) a relayed call.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FacadeResponsePayload {
    pub correlation_id: String,
    pub generation: u64,
    pub ok: bool,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<FacadeError>,
}

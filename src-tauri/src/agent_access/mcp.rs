//! Minimal MCP (Model Context Protocol) JSON-RPC 2.0 types and the pure, I/O-free pieces of the
//! companion's protocol handling: `initialize`, `tools/list`, and request/response envelopes.
//! `tools/call` itself needs the pipe round trip and lives in the companion binary, but the
//! static tool schema it advertises lives here so tests can assert on it without spinning up a
//! process. No `tauri` dependency — this is compiled into both the app and the companion binary.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const JSONRPC_VERSION: &str = "2.0";
/// The MCP protocol revision this companion implements and requests during `initialize`.
pub const PROTOCOL_VERSION: &str = "2024-11-05";

#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcRequest {
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;

pub fn success_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": JSONRPC_VERSION, "id": id, "result": result })
}

pub fn error_response(id: Value, error: JsonRpcError) -> Value {
    json!({ "jsonrpc": JSONRPC_VERSION, "id": id, "error": error })
}

pub fn initialize_result(requested_protocol_version: Option<&str>) -> Value {
    // Per the MCP handshake: echo the client's requested revision back when we can honor it
    // (we support exactly one revision today), otherwise report the one we actually implement so
    // the host can decide whether to proceed.
    let version = match requested_protocol_version {
        Some(requested) if requested == PROTOCOL_VERSION => requested,
        _ => PROTOCOL_VERSION,
    };
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": {
            "name": "hammond-agent-access",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": "Before acting on behalf of any role, call get_instructions for that \
    role (and, if you know it, provider) and follow its effective content. Instruction selections \
    can change between calls — re-fetch after a reported selection change rather than relying on a \
    cached copy from earlier in the conversation.",
    })
}

fn tool(name: &str, description: &str, input_schema: Value, read_only: bool) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
        "annotations": {
            "readOnlyHint": read_only,
            "destructiveHint": false,
            "idempotentHint": false,
            "openWorldHint": false,
        },
    })
}

/// The complete, fixed HAM3-014 tool list. Every tool is always advertised regardless of the
/// connection's read-only/task-write grant — enforcement happens at call time in the facade
/// (D-022: "authorization enforced in the facade regardless of annotations").
pub fn tools_list_result() -> Value {
    let tools = vec![
        tool(
            "get_project_context",
            "Bound project summary, valid task statuses, role/provider assignments, instruction \
scope descriptors, permitted operations, and a bounded task summary for the project this \
connection is bound to.",
            json!({
                "type": "object",
                "properties": {
                    "taskId": { "type": "string", "description": "Optional task id to include focused context for; must belong to the bound project." }
                },
                "additionalProperties": false,
            }),
            true,
        ),
        tool(
            "list_tasks",
            "Basic task retrieval with optional parent/status/archive filters and a cursor. Not \
full-text search.",
            json!({
                "type": "object",
                "properties": {
                    "parentTaskId": { "type": ["string", "null"] },
                    "status": { "type": "string" },
                    "includeArchived": { "type": "boolean" },
                    "cursor": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
                },
                "additionalProperties": false,
            }),
            true,
        ),
        tool(
            "get_task",
            "Persisted task fields, revision, parent context, and paginated children/comments \
for one task. Unsaved UI drafts are excluded.",
            json!({
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "cursor": { "type": "string" },
                },
                "required": ["taskId"],
                "additionalProperties": false,
            }),
            true,
        ),
        tool(
            "get_instructions",
            "Composed saved instructions for one role (and optionally provider), with every \
source layer, its provenance, and selection fingerprint.",
            json!({
                "type": "object",
                "properties": {
                    "role": { "type": "string", "enum": ["orchestrator", "worker", "auditor"] },
                    "provider": { "type": "string", "enum": ["codex", "claude_code", "kilo_code"] },
                    "taskId": { "type": "string" },
                },
                "required": ["role"],
                "additionalProperties": false,
            }),
            true,
        ),
        tool(
            "list_instruction_versions",
            "Authorized version history and active markers for one scoped instruction template.",
            json!({
                "type": "object",
                "properties": {
                    "role": { "type": "string", "enum": ["orchestrator", "worker", "auditor"] },
                    "provider": { "type": ["string", "null"], "enum": ["codex", "claude_code", "kilo_code", null] },
                    "layer": { "type": "string", "enum": ["shared_role", "provider", "project_override"] },
                    "cursor": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
                },
                "required": ["role", "layer"],
                "additionalProperties": false,
            }),
            true,
        ),
        tool(
            "get_instruction_version",
            "Immutable content and provenance for one scoped instruction version.",
            json!({
                "type": "object",
                "properties": { "versionId": { "type": "string" } },
                "required": ["versionId"],
                "additionalProperties": false,
            }),
            true,
        ),
        tool(
            "create_task",
            "Creates a task in the bound project, starting in backlog. Requires task-write \
access.",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "minLength": 1 },
                    "description": { "type": "string" },
                    "parentTaskId": { "type": "string" },
                    "requestId": { "type": "string", "description": "Caller-chosen idempotency key." },
                },
                "required": ["title", "requestId"],
                "additionalProperties": false,
            }),
            false,
        ),
        tool(
            "update_task",
            "Updates title/description/status on an existing ordinary-progress status \
(backlog/ready/in_progress/blocked/done). Requires task-write access and the task's current \
revision.",
            json!({
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "expectedRevision": { "type": "integer" },
                    "requestId": { "type": "string" },
                    "title": { "type": "string" },
                    "description": { "type": "string" },
                    "status": {
                        "type": "string",
                        "enum": ["backlog", "ready", "in_progress", "blocked", "done"],
                    },
                },
                "required": ["taskId", "expectedRevision", "requestId"],
                "additionalProperties": false,
            }),
            false,
        ),
        tool(
            "add_comment",
            "Appends one durable comment to a task. Requires task-write access.",
            json!({
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "text": { "type": "string", "minLength": 1 },
                    "requestId": { "type": "string" },
                },
                "required": ["taskId", "text", "requestId"],
                "additionalProperties": false,
            }),
            false,
        ),
    ];
    json!({ "tools": tools })
}

pub fn tool_result_content(value: &Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": value.to_string() }],
        "structuredContent": value,
        "isError": false,
    })
}

pub fn tool_error_content(code: &str, message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": format!("{code}: {message}") }],
        "structuredContent": { "code": code, "message": message },
        "isError": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_echoes_a_matching_requested_version() {
        let result = initialize_result(Some(PROTOCOL_VERSION));
        assert_eq!(result["protocolVersion"], PROTOCOL_VERSION);
    }

    #[test]
    fn initialize_falls_back_to_the_supported_version_for_an_unrecognized_request() {
        let result = initialize_result(Some("1999-01-01"));
        assert_eq!(result["protocolVersion"], PROTOCOL_VERSION);
    }

    #[test]
    fn tools_list_advertises_every_contract_tool_exactly_once() {
        let result = tools_list_result();
        let tools = result["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            vec![
                "get_project_context",
                "list_tasks",
                "get_task",
                "get_instructions",
                "list_instruction_versions",
                "get_instruction_version",
                "create_task",
                "update_task",
                "add_comment",
            ]
        );
    }

    #[test]
    fn write_tools_are_annotated_as_not_read_only_and_read_tools_as_read_only() {
        let result = tools_list_result();
        for tool in result["tools"].as_array().unwrap() {
            let name = tool["name"].as_str().unwrap();
            let read_only = tool["annotations"]["readOnlyHint"].as_bool().unwrap();
            let expected = !crate::agent_access::types::tool_requires_write(name);
            assert_eq!(
                read_only, expected,
                "tool {name} has the wrong readOnlyHint"
            );
        }
    }

    #[test]
    fn tool_result_content_embeds_structured_content_and_is_not_an_error() {
        let content = tool_result_content(&json!({"a": 1}));
        assert_eq!(content["isError"], false);
        assert_eq!(content["structuredContent"]["a"], 1);
    }

    #[test]
    fn tool_error_content_is_marked_as_an_error() {
        let content = tool_error_content("not_found", "no such task");
        assert_eq!(content["isError"], true);
    }
}

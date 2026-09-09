//! The bundled MCP stdio companion (D-022): a small, standalone process an agent host (Claude
//! Desktop, Codex, etc.) launches directly. It speaks MCP JSON-RPC 2.0 over stdio to the host and
//! relays `tools/call` over an authenticated Windows named pipe to the running, signed-in
//! Hammond app; `initialize` and `tools/list` are answered locally (see `hammond_agent_access::mcp`).
//!
//! This is its own Cargo package (a workspace member of `src-tauri`, not a `[[bin]]` inside the
//! `hammond-desktop` package) so it has no build script and no `tauri` dependency: it depends
//! only on the shared `hammond-agent-access` library crate (`../agent-access`), which also holds
//! everything `hammond-desktop`'s own `agent_access` module re-exports. Splitting it out this way
//! is what lets `hammond-desktop`'s build script build and stage this binary as a Tauri
//! `externalBin` sidecar before Tauri's own resource validation runs — see
//! `src-tauri/build.rs` and docs/AGENT_ACCESS.md "Packaging" for why that ordering matters and
//! "Verification status" for what has not been run against a real Windows named pipe.

use hammond_agent_access::{framing, mcp, types};
use tokio::io::BufReader;

const APP_IDENTIFIER: &str = "com.ipat-o.hammond";

fn local_data_dir() -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var("LOCALAPPDATA")
            .expect("LOCALAPPDATA must be set in a Windows user session");
        std::path::PathBuf::from(base).join(APP_IDENTIFIER)
    }
    #[cfg(not(windows))]
    {
        // No packaged production transport exists on this platform (see the module doc on
        // `agent_access::pipe_transport`); this path exists only so local development/tests of
        // the MCP-protocol-only surface (initialize/tools/list) have somewhere plausible to look
        // and fail predictably rather than panicking on a missing Windows-only env var.
        let base = std::env::var("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_owned()))
                    .join(".local/share")
            });
        base.join(APP_IDENTIFIER)
    }
}

fn profile_id_from_args() -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--profile" {
            return args.next();
        }
    }
    std::env::var("HAMMOND_AGENT_PROFILE").ok()
}

#[tokio::main]
async fn main() {
    let profile_id = match profile_id_from_args() {
        Some(id) => id,
        None => {
            eprintln!(
                "hammond-mcp-companion: missing --profile <id> (or HAMMOND_AGENT_PROFILE). \
Copy the launch configuration from Hammond's Agent access settings."
            );
            std::process::exit(2);
        }
    };

    if let Err(error) = run(profile_id).await {
        eprintln!("hammond-mcp-companion: fatal: {error}");
        std::process::exit(1);
    }
}

async fn run(profile_id: String) -> Result<(), String> {
    let mut stdin_reader = BufReader::new(tokio::io::stdin());
    let mut stdout = tokio::io::stdout();
    // `State` is a real struct on Windows and a unit struct on every other platform (see
    // `pipe_client` below); `Default::default()` is the one construction that works for both.
    #[allow(clippy::default_constructed_unit_structs)]
    let mut connection = pipe_client::State::default();

    loop {
        let frame = match framing::read_frame(&mut stdin_reader, types::MAX_FRAME_BYTES).await {
            Ok(bytes) => bytes,
            Err(_) => return Ok(()), // host closed stdin: exit cleanly, nothing left to serve.
        };
        let request: mcp::JsonRpcRequest = match serde_json::from_slice(&frame) {
            Ok(request) => request,
            Err(_) => continue, // No id to reply to (may not even be an object); drop and keep serving.
        };

        let Some(id) = request.id.clone() else {
            continue; // A notification (e.g. notifications/initialized): no response expected.
        };

        let response = match request.method.as_str() {
            "initialize" => {
                let requested = request
                    .params
                    .get("protocolVersion")
                    .and_then(|v| v.as_str());
                mcp::success_response(id, mcp::initialize_result(requested))
            }
            "tools/list" => mcp::success_response(id, mcp::tools_list_result()),
            "tools/call" => {
                handle_tools_call(&profile_id, &mut connection, id, request.params).await
            }
            "ping" => mcp::success_response(id, serde_json::json!({})),
            other => mcp::error_response(
                id,
                mcp::JsonRpcError {
                    code: mcp::METHOD_NOT_FOUND,
                    message: format!("unknown method '{other}'"),
                    data: None,
                },
            ),
        };

        let bytes = serde_json::to_vec(&response).expect("an MCP response always serializes");
        if framing::write_frame(&mut stdout, &bytes).await.is_err() {
            return Ok(());
        }
    }
}

async fn handle_tools_call(
    profile_id: &str,
    connection: &mut pipe_client::State,
    id: serde_json::Value,
    params: serde_json::Value,
) -> serde_json::Value {
    let Some(tool) = params
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
    else {
        return mcp::error_response(
            id,
            mcp::JsonRpcError {
                code: mcp::INVALID_PARAMS,
                message: "tools/call requires a 'name'".to_owned(),
                data: None,
            },
        );
    };
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    match pipe_client::call(connection, &local_data_dir(), profile_id, &tool, args).await {
        Ok(outcome) => mcp::success_response(id, outcome),
        Err(error) => mcp::success_response(id, mcp::tool_error_content("app_unavailable", &error)),
    }
}

/// Everything that actually reaches Hammond over the named pipe. The connection struct, the
/// handshake, and the call/response round trip are Windows-only by design (D-022); on any other
/// platform every call reports a clear, bounded `app_unavailable` error instead of failing to
/// compile a type that could never be exercised for real (see `agent_access::pipe_transport`'s
/// module doc for the same boundary on the server side).
#[cfg(windows)]
mod pipe_client {
    use hammond_agent_access::{credential, framing, pipe_transport, store, types};
    use tokio::io::{AsyncRead, AsyncWrite, BufReader, ReadHalf, WriteHalf};
    use tokio::net::windows::named_pipe::NamedPipeClient;

    #[derive(Default)]
    pub struct State {
        open: Option<(
            BufReader<ReadHalf<NamedPipeClient>>,
            WriteHalf<NamedPipeClient>,
        )>,
    }

    pub async fn call(
        state: &mut State,
        local_data_dir: &std::path::Path,
        profile_id: &str,
        tool: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        if state.open.is_none() {
            state.open = Some(connect_and_handshake(local_data_dir, profile_id).await?);
        }

        let call_id = credential::generate_token(8);
        let frame = types::ClientFrame::Call {
            id: call_id.clone(),
            tool: tool.to_owned(),
            args,
        };
        let result = send_and_await(state.open.as_mut().unwrap(), &frame, &call_id).await;
        if result.is_err() {
            // Any transport-level failure invalidates the cached connection so the next call
            // reconnects and re-handshakes rather than repeatedly failing on a dead pipe.
            state.open = None;
        }
        result
    }

    async fn connect_and_handshake(
        local_data_dir: &std::path::Path,
        profile_id: &str,
    ) -> Result<
        (
            BufReader<ReadHalf<NamedPipeClient>>,
            WriteHalf<NamedPipeClient>,
        ),
        String,
    > {
        let profile = store::read_profile(local_data_dir)
            .map_err(|error| format!("could not read Hammond's connection profile: {error:?}"))?
            .ok_or_else(|| {
                "Hammond has no active Agent access connection. Enable it in Hammond's Agent \
access settings, then reconnect."
                    .to_owned()
            })?;
        if profile.profile_id != profile_id {
            return Err(
                "This launch configuration is out of date: Hammond's Agent access connection has \
changed. Copy the current launch configuration from Hammond's Agent access settings."
                    .to_owned(),
            );
        }

        let client = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            pipe_transport::connect_client(&profile.pipe_name),
        )
        .await
        .map_err(|_| {
            "Timed out connecting to Hammond. Make sure Hammond is running and signed in."
                .to_owned()
        })?
        .map_err(|error| {
            format!(
                "Could not connect to Hammond ({error}). Make sure Hammond is running, signed \
in, and Agent access is enabled."
            )
        })?;

        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = BufReader::new(read_half);

        send_client_frame(
            &mut write_half,
            &types::ClientFrame::Hello {
                profile_id: profile.profile_id.clone(),
                secret: profile.secret.clone(),
            },
        )
        .await
        .map_err(|error| format!("failed to send the connection handshake: {error}"))?;

        let hello_bytes = framing::read_frame(&mut reader, types::MAX_FRAME_BYTES)
            .await
            .map_err(|error| format!("Hammond closed the connection during handshake: {error}"))?;
        let hello: types::ServerFrame = serde_json::from_slice(&hello_bytes)
            .map_err(|error| format!("Hammond sent an unreadable handshake response: {error}"))?;
        match hello {
            types::ServerFrame::HelloOk { .. } => Ok((reader, write_half)),
            types::ServerFrame::HelloErr { error } => {
                Err(format!("{}: {}", error.code, error.message))
            }
            other => Err(format!("unexpected handshake response: {other:?}")),
        }
    }

    async fn send_and_await(
        open: &mut (
            BufReader<ReadHalf<NamedPipeClient>>,
            WriteHalf<NamedPipeClient>,
        ),
        frame: &types::ClientFrame,
        expected_id: &str,
    ) -> Result<serde_json::Value, String> {
        let (reader, writer) = open;
        send_client_frame(writer, frame)
            .await
            .map_err(|error| format!("failed to send the request: {error}"))?;

        loop {
            let bytes = tokio::time::timeout(
                std::time::Duration::from_secs(types::REQUEST_TIMEOUT_SECS + 5),
                framing::read_frame(reader, types::MAX_FRAME_BYTES),
            )
            .await
            .map_err(|_| "Hammond did not respond in time.".to_owned())?
            .map_err(|error| format!("connection to Hammond was lost: {error}"))?;
            let server_frame: types::ServerFrame = serde_json::from_slice(&bytes)
                .map_err(|error| format!("received an unreadable response: {error}"))?;
            match server_frame {
                types::ServerFrame::Result { id, result, error } if id == expected_id => {
                    return match (result, error) {
                        (Some(value), None) => Ok(value),
                        (_, Some(error)) => Err(format!("{}: {}", error.code, error.message)),
                        (None, None) => Err("Hammond returned an empty result.".to_owned()),
                    };
                }
                types::ServerFrame::Invalidated { reason } => {
                    return Err(format!(
                        "This connection was invalidated ({reason}). Reconnect from Hammond's \
Agent access settings."
                    ));
                }
                // A response for a different (already-abandoned) call id: this companion never
                // pipelines more than one in-flight call per connection, so this should not
                // happen in practice; skip it defensively rather than misdelivering a result.
                _ => continue,
            }
        }
    }

    async fn send_client_frame<W: AsyncWrite + Unpin>(
        writer: &mut W,
        frame: &types::ClientFrame,
    ) -> Result<(), framing::FrameError> {
        let bytes = serde_json::to_vec(frame).expect("ClientFrame always serializes");
        framing::write_frame(writer, &bytes).await
    }

    #[allow(dead_code)]
    fn _assert_read_trait<T: AsyncRead>() {}
}

#[cfg(not(windows))]
mod pipe_client {
    #[derive(Default)]
    pub struct State;

    pub async fn call(
        _state: &mut State,
        _local_data_dir: &std::path::Path,
        _profile_id: &str,
        _tool: &str,
        _args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        Err(
            "This companion build has no Windows named-pipe support, which the packaged product \
requires (D-022)."
                .to_owned(),
        )
    }
}

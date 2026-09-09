//! Transport-agnostic connection handling: the handshake, the call loop, generation/permission
//! checks, and framing. [`handle_connection`] takes any `AsyncRead + AsyncWrite` stream, so it is
//! exercised directly against an in-memory `tokio::io::duplex()` pair in tests — the real Windows
//! named-pipe listener (`super::pipe_transport`, `cfg(windows)`) is a thin loop that accepts
//! connections and hands each one to this same function unchanged.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite, BufReader};

use super::core::AgentAccessCore;
use super::framing::{read_frame, write_frame, FrameError};
use super::pending::FacadeOutcome;
use super::types::{
    is_known_tool, tool_requires_write, ClientFrame, FacadeError, Permission, ServerFrame,
    MAX_FRAME_BYTES,
};

/// What a facade call needs from a validated, still-live connection in order to be dispatched to
/// the frontend. `owner`-identifying fields are deliberately absent: the frontend resolves the
/// caller's identity from its own live Supabase session, never from anything the pipe client
/// supplies (see docs/AGENT_ACCESS.md "Trust boundary").
#[derive(Debug, Clone)]
pub struct FacadeCallContext {
    pub generation: u64,
    pub project_id: String,
    pub permission: Permission,
    pub tool: String,
    pub args: serde_json::Value,
}

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// Relays one validated call to wherever it is actually executed (the frontend, via a Tauri
/// event + the pending-request table in production) and resolves with the outcome. Boxed as a
/// trait object so [`handle_connection`] stays independent of `tauri`/`AppHandle` and is directly
/// testable with a fake dispatcher.
pub type Dispatcher = Arc<dyn Fn(FacadeCallContext) -> BoxFuture<FacadeOutcome> + Send + Sync>;

fn facade_error_frame(id: String, code: &str, message: impl Into<String>) -> ServerFrame {
    ServerFrame::Result {
        id,
        result: None,
        error: Some(FacadeError::new(code, message)),
    }
}

/// Drives one accepted connection end to end: reads the `Hello` handshake, validates it against
/// the currently active profile in `core`, then loops reading `Call` frames until the peer
/// disconnects, the connection's generation is superseded, or a frame violates the protocol.
/// Never panics on malformed/adversarial input from the pipe client — every rejection path
/// writes a structured frame (or, for a superseded generation, `Invalidated`) and returns
/// normally.
pub async fn handle_connection<S>(stream: S, core: Arc<AgentAccessCore>, dispatcher: Dispatcher)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (read_half, mut write_half) = tokio::io::split(stream);
    let mut reader = BufReader::new(read_half);

    let hello_bytes = match read_frame(&mut reader, MAX_FRAME_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => return,
    };
    let hello: ClientFrame = match serde_json::from_slice(&hello_bytes) {
        Ok(frame) => frame,
        Err(_) => return,
    };
    let ClientFrame::Hello { profile_id, secret } = hello else {
        let _ = send(
            &mut write_half,
            ServerFrame::HelloErr {
                error: FacadeError::new("protocol_error", "expected a hello frame first"),
            },
        )
        .await;
        return;
    };

    let Some(profile) = core.current() else {
        let _ = send(
            &mut write_half,
            ServerFrame::HelloErr {
                error: FacadeError::new("disabled", "Agent access is not enabled in Hammond."),
            },
        )
        .await;
        return;
    };
    if profile.profile_id != profile_id
        || !super::credential::secrets_match(&profile.secret, &secret)
    {
        let _ = send(
            &mut write_half,
            ServerFrame::HelloErr {
                error: FacadeError::new(
                    "invalid_credential",
                    "This connection profile is no longer valid. Reconnect from Hammond's Agent access settings.",
                ),
            },
        )
        .await;
        return;
    }

    let generation = profile.generation;
    let bound_project_id = profile.project_id.clone();
    let permission = profile.permission;
    if send(
        &mut write_half,
        ServerFrame::HelloOk {
            generation,
            project_id: profile.project_id.clone(),
            project_name: profile.project_name.clone(),
            permission,
        },
    )
    .await
    .is_err()
    {
        return;
    }

    loop {
        let frame_bytes = match read_frame(&mut reader, MAX_FRAME_BYTES).await {
            Ok(bytes) => bytes,
            Err(FrameError::Closed) => return,
            Err(_) => return,
        };
        let frame: ClientFrame = match serde_json::from_slice(&frame_bytes) {
            Ok(frame) => frame,
            Err(_) => return,
        };
        let ClientFrame::Call { id, tool, args } = frame else {
            return;
        };

        // A generation bump (revoke, reconnect, sign-out, app-restart re-enable) since this
        // connection's own handshake means every further call on it is stale, even though the
        // pipe itself is still open — never silently keep answering as the old identity.
        let still_current = core
            .current()
            .is_some_and(|current| current.generation == generation);
        if !still_current {
            let _ = send(
                &mut write_half,
                ServerFrame::Invalidated {
                    reason: "revoked".to_owned(),
                },
            )
            .await;
            return;
        }

        if !is_known_tool(&tool) {
            if send(
                &mut write_half,
                facade_error_frame(id, "unknown_tool", format!("Unknown tool '{tool}'.")),
            )
            .await
            .is_err()
            {
                return;
            }
            continue;
        }

        if tool_requires_write(&tool) && !permission.allows_write() {
            if send(
                &mut write_half,
                facade_error_frame(
                    id,
                    "permission_denied",
                    "This connection has read-only access; task-write tools are disabled.",
                ),
            )
            .await
            .is_err()
            {
                return;
            }
            continue;
        }

        // The dispatcher (production: emit to the frontend + await `agent_access_respond`, with
        // its own bounded timeout and pending-table cleanup; tests: a fake) is solely responsible
        // for returning within a bounded time — this loop just awaits whatever it decides.
        let outcome = dispatcher(FacadeCallContext {
            generation,
            project_id: bound_project_id.clone(),
            permission,
            tool,
            args,
        })
        .await;

        let frame = match outcome {
            FacadeOutcome::Ok(value) => ServerFrame::Result {
                id,
                result: Some(value),
                error: None,
            },
            FacadeOutcome::Err(error) => ServerFrame::Result {
                id,
                result: None,
                error: Some(error),
            },
        };
        if send(&mut write_half, frame).await.is_err() {
            return;
        }
    }
}

async fn send<W: AsyncWrite + Unpin>(writer: &mut W, frame: ServerFrame) -> Result<(), FrameError> {
    let bytes = serde_json::to_vec(&frame).expect("ServerFrame always serializes");
    write_frame(writer, &bytes).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::AgentAccessProfile;
    use tokio::io::{duplex, AsyncWriteExt};

    fn profile(generation: u64, permission: Permission) -> AgentAccessProfile {
        AgentAccessProfile {
            profile_id: "profile-1".to_owned(),
            secret: "s3cr3t".to_owned(),
            pipe_name: r"\\.\pipe\hammond-test".to_owned(),
            project_id: "project-1".to_owned(),
            project_name: "Scratch".to_owned(),
            permission,
            generation,
            created_at: "2026-09-09T00:00:00Z".to_owned(),
        }
    }

    fn echo_dispatcher() -> Dispatcher {
        Arc::new(|ctx: FacadeCallContext| {
            Box::pin(
                async move { FacadeOutcome::Ok(serde_json::json!({ "echoedTool": ctx.tool })) },
            )
        })
    }

    async fn write_client_frame(client: &mut (impl AsyncWrite + Unpin), frame: &ClientFrame) {
        let bytes = serde_json::to_vec(frame).unwrap();
        client.write_all(&bytes).await.unwrap();
        client.write_all(b"\n").await.unwrap();
    }

    async fn read_server_frame(reader: &mut BufReader<impl AsyncRead + Unpin>) -> ServerFrame {
        let bytes = read_frame(reader, MAX_FRAME_BYTES).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn rejects_a_hello_with_the_wrong_secret() {
        let core = Arc::new(AgentAccessCore::default());
        core.set(Some(profile(1, Permission::ReadOnly)));
        let (client, server) = duplex(4096);
        let (client_read, mut client_write) = tokio::io::split(client);
        let handle = tokio::spawn(handle_connection(server, core, echo_dispatcher()));

        write_client_frame(
            &mut client_write,
            &ClientFrame::Hello {
                profile_id: "profile-1".to_owned(),
                secret: "wrong".to_owned(),
            },
        )
        .await;
        let mut reader = BufReader::new(client_read);
        let frame = read_server_frame(&mut reader).await;
        assert!(matches!(frame, ServerFrame::HelloErr { .. }));
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_a_hello_when_agent_access_is_disabled() {
        let core = Arc::new(AgentAccessCore::default());
        let (client, server) = duplex(4096);
        let (client_read, mut client_write) = tokio::io::split(client);
        let handle = tokio::spawn(handle_connection(server, core, echo_dispatcher()));

        write_client_frame(
            &mut client_write,
            &ClientFrame::Hello {
                profile_id: "profile-1".to_owned(),
                secret: "s3cr3t".to_owned(),
            },
        )
        .await;
        let mut reader = BufReader::new(client_read);
        let frame = read_server_frame(&mut reader).await;
        match frame {
            ServerFrame::HelloErr { error } => assert_eq!(error.code, "disabled"),
            other => panic!("expected HelloErr, got {other:?}"),
        }
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn a_valid_hello_is_accepted_and_a_call_is_dispatched() {
        let core = Arc::new(AgentAccessCore::default());
        core.set(Some(profile(1, Permission::TaskWrite)));
        let (client, server) = duplex(4096);
        let (client_read, mut client_write) = tokio::io::split(client);
        let handle = tokio::spawn(handle_connection(server, core, echo_dispatcher()));

        write_client_frame(
            &mut client_write,
            &ClientFrame::Hello {
                profile_id: "profile-1".to_owned(),
                secret: "s3cr3t".to_owned(),
            },
        )
        .await;
        let mut reader = BufReader::new(client_read);
        assert!(matches!(
            read_server_frame(&mut reader).await,
            ServerFrame::HelloOk { .. }
        ));

        write_client_frame(
            &mut client_write,
            &ClientFrame::Call {
                id: "call-1".to_owned(),
                tool: "get_project_context".to_owned(),
                args: serde_json::json!({}),
            },
        )
        .await;
        match read_server_frame(&mut reader).await {
            ServerFrame::Result { id, result, error } => {
                assert_eq!(id, "call-1");
                assert!(error.is_none());
                assert_eq!(result.unwrap()["echoedTool"], "get_project_context");
            }
            other => panic!("expected Result, got {other:?}"),
        }
        // `tokio::io::split`'s `WriteHalf::drop` does NOT signal closure to the peer while the
        // corresponding `ReadHalf` (held alive here by `reader`) is still around — both halves
        // share the underlying duplex stream and it only actually closes once every handle to it
        // is gone. An explicit `shutdown()` half-closes deterministically instead, exactly like
        // this test relies on to observe `handle_connection` return.
        client_write.shutdown().await.unwrap();
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_an_unknown_tool_without_contacting_the_dispatcher() {
        let core = Arc::new(AgentAccessCore::default());
        core.set(Some(profile(1, Permission::TaskWrite)));
        let dispatcher: Dispatcher = Arc::new(|_ctx| {
            Box::pin(async move { panic!("dispatcher must not be called for an unknown tool") })
        });
        let (client, server) = duplex(4096);
        let (client_read, mut client_write) = tokio::io::split(client);
        let handle = tokio::spawn(handle_connection(server, core, dispatcher));

        write_client_frame(
            &mut client_write,
            &ClientFrame::Hello {
                profile_id: "profile-1".to_owned(),
                secret: "s3cr3t".to_owned(),
            },
        )
        .await;
        let mut reader = BufReader::new(client_read);
        read_server_frame(&mut reader).await;

        write_client_frame(
            &mut client_write,
            &ClientFrame::Call {
                id: "call-1".to_owned(),
                tool: "delete_everything".to_owned(),
                args: serde_json::json!({}),
            },
        )
        .await;
        match read_server_frame(&mut reader).await {
            ServerFrame::Result {
                error: Some(error), ..
            } => assert_eq!(error.code, "unknown_tool"),
            other => panic!("expected an unknown_tool Result, got {other:?}"),
        }
        // `tokio::io::split`'s `WriteHalf::drop` does NOT signal closure to the peer while the
        // corresponding `ReadHalf` (held alive here by `reader`) is still around — both halves
        // share the underlying duplex stream and it only actually closes once every handle to it
        // is gone. An explicit `shutdown()` half-closes deterministically instead, exactly like
        // this test relies on to observe `handle_connection` return.
        client_write.shutdown().await.unwrap();
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_a_write_tool_on_a_read_only_connection_without_contacting_the_dispatcher() {
        let core = Arc::new(AgentAccessCore::default());
        core.set(Some(profile(1, Permission::ReadOnly)));
        let dispatcher: Dispatcher = Arc::new(|_ctx| {
            Box::pin(async move { panic!("dispatcher must not be called for a denied write") })
        });
        let (client, server) = duplex(4096);
        let (client_read, mut client_write) = tokio::io::split(client);
        let handle = tokio::spawn(handle_connection(server, core, dispatcher));

        write_client_frame(
            &mut client_write,
            &ClientFrame::Hello {
                profile_id: "profile-1".to_owned(),
                secret: "s3cr3t".to_owned(),
            },
        )
        .await;
        let mut reader = BufReader::new(client_read);
        read_server_frame(&mut reader).await;

        write_client_frame(
            &mut client_write,
            &ClientFrame::Call {
                id: "call-1".to_owned(),
                tool: "create_task".to_owned(),
                args: serde_json::json!({"title": "x"}),
            },
        )
        .await;
        match read_server_frame(&mut reader).await {
            ServerFrame::Result {
                error: Some(error), ..
            } => assert_eq!(error.code, "permission_denied"),
            other => panic!("expected a permission_denied Result, got {other:?}"),
        }
        // `tokio::io::split`'s `WriteHalf::drop` does NOT signal closure to the peer while the
        // corresponding `ReadHalf` (held alive here by `reader`) is still around — both halves
        // share the underlying duplex stream and it only actually closes once every handle to it
        // is gone. An explicit `shutdown()` half-closes deterministically instead, exactly like
        // this test relies on to observe `handle_connection` return.
        client_write.shutdown().await.unwrap();
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn a_generation_bump_after_handshake_invalidates_the_connection() {
        let core = Arc::new(AgentAccessCore::default());
        core.set(Some(profile(1, Permission::ReadOnly)));
        let (client, server) = duplex(4096);
        let (client_read, mut client_write) = tokio::io::split(client);
        let handle = tokio::spawn(handle_connection(server, core.clone(), echo_dispatcher()));

        write_client_frame(
            &mut client_write,
            &ClientFrame::Hello {
                profile_id: "profile-1".to_owned(),
                secret: "s3cr3t".to_owned(),
            },
        )
        .await;
        let mut reader = BufReader::new(client_read);
        read_server_frame(&mut reader).await;

        // Simulate a revoke: the owner re-enables agent access, minting a new generation, while
        // this connection is still open.
        core.set(Some(profile(2, Permission::ReadOnly)));

        write_client_frame(
            &mut client_write,
            &ClientFrame::Call {
                id: "call-1".to_owned(),
                tool: "get_project_context".to_owned(),
                args: serde_json::json!({}),
            },
        )
        .await;
        match read_server_frame(&mut reader).await {
            ServerFrame::Invalidated { reason } => assert_eq!(reason, "revoked"),
            other => panic!("expected Invalidated, got {other:?}"),
        }
        // `tokio::io::split`'s `WriteHalf::drop` does NOT signal closure to the peer while the
        // corresponding `ReadHalf` (held alive here by `reader`) is still around — both halves
        // share the underlying duplex stream and it only actually closes once every handle to it
        // is gone. An explicit `shutdown()` half-closes deterministically instead, exactly like
        // this test relies on to observe `handle_connection` return.
        client_write.shutdown().await.unwrap();
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn a_dispatcher_error_is_relayed_as_a_result_error() {
        let core = Arc::new(AgentAccessCore::default());
        core.set(Some(profile(1, Permission::ReadOnly)));
        let dispatcher: Dispatcher = Arc::new(|_ctx| {
            Box::pin(
                async move { FacadeOutcome::Err(FacadeError::new("not_found", "no such task")) },
            )
        });
        let (client, server) = duplex(4096);
        let (client_read, mut client_write) = tokio::io::split(client);
        let handle = tokio::spawn(handle_connection(server, core, dispatcher));

        write_client_frame(
            &mut client_write,
            &ClientFrame::Hello {
                profile_id: "profile-1".to_owned(),
                secret: "s3cr3t".to_owned(),
            },
        )
        .await;
        let mut reader = BufReader::new(client_read);
        read_server_frame(&mut reader).await;

        write_client_frame(
            &mut client_write,
            &ClientFrame::Call {
                id: "call-1".to_owned(),
                tool: "get_task".to_owned(),
                args: serde_json::json!({"taskId": "missing"}),
            },
        )
        .await;
        match read_server_frame(&mut reader).await {
            ServerFrame::Result {
                error: Some(error), ..
            } => assert_eq!(error.code, "not_found"),
            other => panic!("expected a not_found Result, got {other:?}"),
        }
        // `tokio::io::split`'s `WriteHalf::drop` does NOT signal closure to the peer while the
        // corresponding `ReadHalf` (held alive here by `reader`) is still around — both halves
        // share the underlying duplex stream and it only actually closes once every handle to it
        // is gone. An explicit `shutdown()` half-closes deterministically instead, exactly like
        // this test relies on to observe `handle_connection` return.
        client_write.shutdown().await.unwrap();
        handle.await.unwrap();
    }
}

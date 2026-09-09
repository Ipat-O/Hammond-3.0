//! The real OS transport: a Windows named pipe restricted to the current Windows account, per
//! D-022. Every accepted connection is handed unchanged to [`super::server::handle_connection`],
//! which is where all protocol logic (and its test coverage) lives — this module only owns
//! standing up the listener and enforcing its ACL.
//!
//! There is no non-Windows production transport: D-022 is a Windows named-pipe boundary by
//! design, and this repository has no way to run or package a Windows build to validate it (see
//! docs/AGENT_ACCESS.md "Verification status"). The `cfg(windows)` implementation below has been
//! checked to compile for the `x86_64-pc-windows-gnu` target from this Linux environment (a
//! genuine, if partial, substitute for a real Windows host) but has never run against a live
//! Windows named pipe.

pub fn pipe_name_for(profile_id: &str) -> String {
    format!(r"\\.\pipe\hammond-agent-{profile_id}")
}

#[cfg(windows)]
pub use windows_impl::{connect_client, run_listener, ListenerError};

#[cfg(not(windows))]
pub use unsupported::{connect_client, run_listener, ListenerError};

#[cfg(windows)]
mod windows_impl {
    use std::ffi::c_void;
    use std::io;
    use std::ptr;
    use std::sync::Arc;

    use tokio::net::windows::named_pipe::{
        ClientOptions, NamedPipeClient, NamedPipeServer, PipeMode, ServerOptions,
    };
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;

    use crate::agent_access::core::AgentAccessCore;
    use crate::agent_access::server::{handle_connection, Dispatcher};

    #[derive(Debug)]
    pub enum ListenerError {
        SecurityDescriptor(io::Error),
        Create(io::Error),
    }

    impl std::fmt::Display for ListenerError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                ListenerError::SecurityDescriptor(error) => {
                    write!(f, "failed to build the pipe's security descriptor: {error}")
                }
                ListenerError::Create(error) => {
                    write!(f, "failed to create the named pipe: {error}")
                }
            }
        }
    }

    /// Grants full control to the pipe's creator (OWNER) only, with a protected DACL (no ACEs
    /// inherited from the pipe object namespace) — the exact restriction D-022 requires ("current
    /// Windows account" only, nobody else on the machine, no inheritance surprises).
    const RESTRICTED_TO_OWNER_SDDL: &str = "D:P(A;;GA;;;OW)";

    struct OwnedSecurityDescriptor(*mut c_void);

    // The descriptor is heap memory owned exclusively by this wrapper until `Drop` frees it via
    // `LocalFree`; nothing else retains a pointer to it once wrapped, so moving it across the
    // await point in `create_first_instance` is sound.
    unsafe impl Send for OwnedSecurityDescriptor {}

    impl Drop for OwnedSecurityDescriptor {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
    }

    fn owner_restricted_security_descriptor() -> io::Result<OwnedSecurityDescriptor> {
        let sddl: Vec<u16> = RESTRICTED_TO_OWNER_SDDL
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut descriptor: *mut c_void = ptr::null_mut();
        // SAFETY: `sddl` is a valid, NUL-terminated wide string alive for the duration of the
        // call; `descriptor` is a valid out-pointer. On success the API allocates memory that
        // must be freed with `LocalFree`, which `OwnedSecurityDescriptor::drop` does.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1, // SDDL_REVISION_1
                &mut descriptor,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(OwnedSecurityDescriptor(descriptor))
    }

    fn create_first_instance(pipe_name: &str) -> Result<NamedPipeServer, ListenerError> {
        let descriptor =
            owner_restricted_security_descriptor().map_err(ListenerError::SecurityDescriptor)?;
        let mut attrs = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        // SAFETY: `attrs` is a valid, fully-initialized `SECURITY_ATTRIBUTES` whose
        // `lpSecurityDescriptor` stays valid for the duration of this call (`descriptor` is
        // dropped only after `create_with_security_attributes_raw` returns).
        let server = unsafe {
            ServerOptions::new()
                .first_pipe_instance(true)
                .pipe_mode(PipeMode::Byte)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(pipe_name, &mut attrs as *mut _ as *mut c_void)
        }
        .map_err(ListenerError::Create)?;
        Ok(server)
    }

    fn create_next_instance(pipe_name: &str) -> Result<NamedPipeServer, ListenerError> {
        // Subsequent instances of the same pipe name inherit the first instance's security
        // descriptor automatically; Windows does not require (or allow changing) it per instance.
        ServerOptions::new()
            .pipe_mode(PipeMode::Byte)
            .reject_remote_clients(true)
            .create(pipe_name)
            .map_err(ListenerError::Create)
    }

    /// Runs until `shutdown` fires. Every accepted client connection is spawned as its own task
    /// running [`handle_connection`] against the live `core`/`dispatcher`, so one slow or
    /// misbehaving client never blocks new connections or other in-flight ones.
    pub async fn run_listener(
        pipe_name: String,
        core: Arc<AgentAccessCore>,
        dispatcher: Dispatcher,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
    ) -> Result<(), ListenerError> {
        let mut server = create_first_instance(&pipe_name)?;
        loop {
            tokio::select! {
                connect_result = server.connect() => {
                    connect_result.map_err(ListenerError::Create)?;
                    let connected = server;
                    server = create_next_instance(&pipe_name)?;
                    let core = core.clone();
                    let dispatcher = dispatcher.clone();
                    tokio::spawn(async move {
                        handle_connection(connected, core, dispatcher).await;
                    });
                }
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        return Ok(());
                    }
                }
            }
        }
    }

    /// Used by the companion binary to reach the running app. Named pipe clients do not need any
    /// special ACL handling — access control lives entirely on the server side (the security
    /// descriptor `create_first_instance` attaches); `ERROR_ACCESS_DENIED` here just means the
    /// calling Windows account differs from the one that created the pipe.
    pub async fn connect_client(pipe_name: &str) -> io::Result<NamedPipeClient> {
        ClientOptions::new().open(pipe_name)
    }
}

#[cfg(not(windows))]
mod unsupported {
    use std::sync::Arc;

    use crate::agent_access::core::AgentAccessCore;
    use crate::agent_access::server::Dispatcher;

    #[derive(Debug)]
    pub struct ListenerError(pub String);

    impl std::fmt::Display for ListenerError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "{}", self.0)
        }
    }

    /// D-022's transport is a Windows named pipe by design (see the module doc comment); there is
    /// deliberately no non-Windows fallback listener in the packaged product. This stub exists
    /// only so the crate compiles on every platform its test suite runs on.
    pub async fn run_listener(
        _pipe_name: String,
        _core: Arc<AgentAccessCore>,
        _dispatcher: Dispatcher,
        _shutdown: tokio::sync::watch::Receiver<bool>,
    ) -> Result<(), ListenerError> {
        Err(ListenerError(
            "Agent access requires Windows named-pipe support, which this platform does not have."
                .to_owned(),
        ))
    }

    pub async fn connect_client(_pipe_name: &str) -> std::io::Result<std::convert::Infallible> {
        Err(std::io::Error::other(
            "Agent access requires Windows named-pipe support, which this platform does not have.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_name_embeds_the_profile_id() {
        assert_eq!(pipe_name_for("abc123"), r"\\.\pipe\hammond-agent-abc123");
    }
}

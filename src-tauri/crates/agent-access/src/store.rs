//! Persistence for the single active agent-access connection profile: a dedicated JSON file in
//! Hammond's local data directory, separate from `local_settings.rs`'s general-purpose store so
//! the credential inside it is never routed through the same read/write surface the frontend's
//! ordinary settings use. Only native code (this module, and the companion binary's own copy of
//! the read path) ever sees `secret`; it is never sent to the frontend.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::types::Permission;

pub const PROFILE_FILE_NAME: &str = "agent-access-profile.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentAccessProfile {
    pub profile_id: String,
    pub secret: String,
    pub pipe_name: String,
    pub project_id: String,
    pub project_name: String,
    pub permission: Permission,
    pub generation: u64,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum StoreError {
    Io(String),
}

fn profile_path(base_dir: &Path) -> PathBuf {
    base_dir.join(PROFILE_FILE_NAME)
}

pub fn read_profile(base_dir: &Path) -> Result<Option<AgentAccessProfile>, StoreError> {
    let path = profile_path(base_dir);
    match fs::read_to_string(&path) {
        Ok(contents) => {
            if contents.trim().is_empty() {
                return Ok(None);
            }
            serde_json::from_str(&contents)
                .map(Some)
                .map_err(|error| StoreError::Io(format!("profile file is corrupt: {error}")))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(StoreError::Io(format!("failed to read profile: {error}"))),
    }
}

pub fn write_profile(base_dir: &Path, profile: &AgentAccessProfile) -> Result<(), StoreError> {
    fs::create_dir_all(base_dir)
        .map_err(|error| StoreError::Io(format!("failed to prepare profile directory: {error}")))?;
    let path = profile_path(base_dir);
    let serialized = serde_json::to_string_pretty(profile)
        .map_err(|error| StoreError::Io(format!("failed to serialize profile: {error}")))?;
    fs::write(&path, serialized)
        .map_err(|error| StoreError::Io(format!("failed to write profile: {error}")))?;
    restrict_to_owner(&path);
    Ok(())
}

pub fn clear_profile(base_dir: &Path) -> Result<(), StoreError> {
    let path = profile_path(base_dir);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(StoreError::Io(format!("failed to remove profile: {error}"))),
    }
}

/// Best-effort defense in depth on top of the per-user AppData/XDG directory the file already
/// lives in: on Unix, drop group/other read access. See the `cfg(windows)` implementation below
/// for the Windows equivalent (HAM3-014 correction F6) — see docs/AGENT_ACCESS.md "Credential
/// protection" for what is and isn't verified about either.
#[cfg(unix)]
fn restrict_to_owner(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = fs::metadata(path) {
        let mut perms = metadata.permissions();
        perms.set_mode(0o600);
        let _ = fs::set_permissions(path, perms);
    }
}

/// HAM3-014 correction F6: an explicit, current-user-only DACL set directly on the profile file —
/// the same `ConvertStringSecurityDescriptorToSecurityDescriptorW` SDDL technique
/// `pipe_transport.rs` already uses for the named pipe itself (`D:P(A;;FA;;;OW)`: full access to
/// the file's OWNER only, `P`rotected so no ACE is inherited from the parent directory). This
/// replaces the prior round's reliance on the profile directory's *inherited* per-user AppData
/// ACL, which was never itself verified (see docs/AGENT_ACCESS.md "Credential protection") — an
/// inherited ACL depends on how that directory was created and by what, which this code does not
/// control, whereas this DACL is set unconditionally by this function on every write, regardless
/// of the directory's own permissions. Best-effort: a failure to convert or apply the descriptor
/// leaves the file exactly as `fs::write` above left it (still only reachable through whatever
/// protection the directory itself provides) rather than treating a hardening failure as a reason
/// to fail the write outright.
#[cfg(windows)]
fn restrict_to_owner(path: &Path) {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::{
        SetFileSecurityW, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    };

    const RESTRICTED_TO_OWNER_SDDL: &str = "D:P(A;;FA;;;OW)";

    let wide_path: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let sddl: Vec<u16> = RESTRICTED_TO_OWNER_SDDL
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    let mut descriptor: *mut c_void = ptr::null_mut();
    // SAFETY: `sddl` is a valid, NUL-terminated wide string alive for the duration of this call;
    // `descriptor` is a valid out-pointer. On success this allocates memory freed via `LocalFree`
    // below, mirroring `OwnedSecurityDescriptor::drop` in `pipe_transport.rs`.
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1, // SDDL_REVISION_1
            &mut descriptor,
            ptr::null_mut(),
        )
    };
    if converted == 0 || descriptor.is_null() {
        return;
    }
    // SAFETY: `wide_path` is a valid NUL-terminated wide string for the file just written;
    // `descriptor` was produced by the successful conversion immediately above and is freed right
    // after this call, so it stays valid for the entire `SetFileSecurityW` call.
    unsafe {
        SetFileSecurityW(
            wide_path.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        );
        LocalFree(descriptor);
    }
}

#[cfg(not(any(unix, windows)))]
fn restrict_to_owner(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_profile() -> AgentAccessProfile {
        AgentAccessProfile {
            profile_id: "profile-1".to_owned(),
            secret: "secret-value".to_owned(),
            pipe_name: r"\\.\pipe\hammond-agent-profile-1".to_owned(),
            project_id: "project-1".to_owned(),
            project_name: "Scratch project".to_owned(),
            permission: Permission::ReadOnly,
            generation: 1,
            created_at: "2026-09-09T00:00:00Z".to_owned(),
        }
    }

    #[test]
    fn missing_profile_reads_as_none_rather_than_erroring() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_profile(dir.path()).unwrap(), None);
    }

    #[test]
    fn round_trips_a_profile_through_write_read_clear() {
        let dir = tempfile::tempdir().unwrap();
        let profile = sample_profile();
        write_profile(dir.path(), &profile).unwrap();
        assert_eq!(read_profile(dir.path()).unwrap(), Some(profile));
        clear_profile(dir.path()).unwrap();
        assert_eq!(read_profile(dir.path()).unwrap(), None);
    }

    #[test]
    fn clearing_a_profile_that_never_existed_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        clear_profile(dir.path()).unwrap();
    }

    #[test]
    fn corrupt_profile_file_surfaces_a_structured_error() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path()).unwrap();
        fs::write(dir.path().join(PROFILE_FILE_NAME), "not json").unwrap();
        let error = read_profile(dir.path()).unwrap_err();
        assert!(matches!(error, StoreError::Io(_)));
    }

    #[test]
    fn writing_a_new_profile_overwrites_the_previous_one() {
        let dir = tempfile::tempdir().unwrap();
        let first = sample_profile();
        write_profile(dir.path(), &first).unwrap();
        let mut second = sample_profile();
        second.generation = 2;
        second.project_id = "project-2".to_owned();
        write_profile(dir.path(), &second).unwrap();
        assert_eq!(read_profile(dir.path()).unwrap(), Some(second));
    }
}

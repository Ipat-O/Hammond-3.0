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
/// lives in: on Unix, drop group/other read access. Windows relies on the profile directory's
/// inherited per-user NTFS ACL (the same protection `local_settings.rs` relies on); this file
/// carries no additional Windows-specific hardening beyond that today (see docs/AGENT_ACCESS.md
/// "Credential protection" for the disclosed limitation and DPAPI as a follow-up).
#[cfg(unix)]
fn restrict_to_owner(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = fs::metadata(path) {
        let mut perms = metadata.permissions();
        perms.set_mode(0o600);
        let _ = fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
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

//! The local API's persisted bearer token and connection metadata: one JSON file under the
//! app's local data directory, owner-restricted on disk, read at startup and rewritten on
//! rotate/revoke. The token is preserved across restarts (so an owner's MCP client config keeps
//! working from one launch to the next); `port`/`pid`/`startedAt` are rewritten every launch
//! since they are only valid for the current process. Never logged; never returned from a
//! status query — only `reveal` (an explicit owner action) returns the raw token.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const CREDENTIALS_FILE_NAME: &str = "agent-access-credentials.json";
const TOKEN_BYTE_LEN: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentAccessCredentials {
    pub version: u32,
    pub enabled: bool,
    pub token: String,
    pub port: u16,
    pub pid: u32,
    pub started_at: String,
}

/// Non-secret status surfaced to the UI: never the raw token, only enough to identify it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccessStatus {
    pub enabled: bool,
    pub port: u16,
    pub started_at: String,
    pub token_fingerprint: String,
}

impl AgentAccessCredentials {
    pub fn status(&self) -> AgentAccessStatus {
        AgentAccessStatus {
            enabled: self.enabled,
            port: self.port,
            started_at: self.started_at.clone(),
            token_fingerprint: fingerprint(&self.token),
        }
    }
}

fn generate_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTE_LEN];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The last few characters only — enough for an owner to recognize "yes, that's the token I
/// configured" without ever displaying (or letting a screenshot/log capture) the whole secret.
fn fingerprint(token: &str) -> String {
    let visible = token.len().min(6);
    format!("…{}", &token[token.len() - visible..])
}

fn credentials_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("no local app data directory: {error}"))?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to prepare app data directory: {error}"))?;
    Ok(dir.join(CREDENTIALS_FILE_NAME))
}

/// Best-effort on every platform: unix gets an explicit `0600`; on Windows the per-user
/// `%LOCALAPPDATA%` tree Tauri resolves `app_local_data_dir()` into is already ACL-restricted to
/// the current user account by the OS default, so no extra narrowing is attempted there — see
/// docs/AGENT_ACCESS.md for the exact statement of what this protects against.
fn restrict_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = fs::metadata(path) {
            let mut perms = metadata.permissions();
            perms.set_mode(0o600);
            let _ = fs::set_permissions(path, perms);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn write_credentials(path: &Path, credentials: &AgentAccessCredentials) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(credentials)
        .map_err(|error| format!("failed to serialize local API credentials: {error}"))?;
    fs::write(path, serialized)
        .map_err(|error| format!("failed to write local API credentials file: {error}"))?;
    restrict_permissions(path);
    Ok(())
}

fn read_credentials(path: &Path) -> Option<AgentAccessCredentials> {
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn now_iso8601() -> String {
    humantime::format_rfc3339_seconds(SystemTime::now()).to_string()
}

/// Loads the persisted token if one exists and is well-formed, otherwise mints a fresh one.
/// Always rewrites `port`/`pid`/`startedAt` to the current process's values.
pub fn load_or_create(app: &AppHandle, port: u16) -> Result<AgentAccessCredentials, String> {
    let path = credentials_path(app)?;
    let started_at = now_iso8601();
    let pid = std::process::id();

    let credentials = match read_credentials(&path) {
        Some(existing) if !existing.token.is_empty() => AgentAccessCredentials {
            version: 1,
            enabled: existing.enabled,
            token: existing.token,
            port,
            pid,
            started_at,
        },
        _ => AgentAccessCredentials {
            version: 1,
            enabled: true,
            token: generate_token(),
            port,
            pid,
            started_at,
        },
    };
    write_credentials(&path, &credentials)?;
    Ok(credentials)
}

/// Generates a new token and re-enables access if it had been revoked. The prior token stops
/// working immediately (the in-memory copy held by `AgentAccessState` is replaced by the caller).
pub fn rotate(
    app: &AppHandle,
    current: &AgentAccessCredentials,
) -> Result<AgentAccessCredentials, String> {
    let path = credentials_path(app)?;
    let next = AgentAccessCredentials {
        token: generate_token(),
        enabled: true,
        ..current.clone()
    };
    write_credentials(&path, &next)?;
    Ok(next)
}

/// Disables local API access without discarding the token value, so a subsequent rotate (rather
/// than a fresh first-time setup) is what re-enables it. Every request is refused while revoked,
/// regardless of the bearer value presented.
pub fn revoke(
    app: &AppHandle,
    current: &AgentAccessCredentials,
) -> Result<AgentAccessCredentials, String> {
    let path = credentials_path(app)?;
    let next = AgentAccessCredentials {
        enabled: false,
        ..current.clone()
    };
    write_credentials(&path, &next)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_tokens_are_sixty_four_hex_characters_and_pairwise_distinct() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), TOKEN_BYTE_LEN * 2);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn fingerprint_never_exposes_more_than_the_trailing_characters() {
        let token = generate_token();
        let print = fingerprint(&token);
        assert!(print.starts_with('…'));
        assert!(!print.contains(&token[..token.len() - 6]));
        assert_eq!(print.chars().count(), 7);
    }
}

//! Tauri commands for the small, confined filesystem surface: pick a directory, then read,
//! write, remove, check, or reveal a relative target inside it. Every command that touches
//! a path funnels through [`fs_guard::resolve_within_root`] so confinement cannot be
//! bypassed by an individual command forgetting to check.

use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::fs_guard::{resolve_within_root, FsGuardError};

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum FsCommandError {
    InvalidRoot(String),
    AbsoluteTarget(String),
    Traversal(String),
    Escape(String),
    NotFound(String),
    Io(String),
}

impl From<FsGuardError> for FsCommandError {
    fn from(error: FsGuardError) -> Self {
        match error {
            FsGuardError::InvalidRoot(message) => FsCommandError::InvalidRoot(message),
            FsGuardError::AbsoluteTarget(message) => FsCommandError::AbsoluteTarget(message),
            FsGuardError::Traversal(message) => FsCommandError::Traversal(message),
            FsGuardError::Escape(message) => FsCommandError::Escape(message),
            FsGuardError::Io(message) => FsCommandError::Io(message),
        }
    }
}

/// Opens the native folder picker. Resolves to `None` immediately when the owner cancels;
/// never leaves the caller waiting on an unresolved promise.
#[tauri::command]
pub async fn select_directory(app: AppHandle) -> Result<Option<String>, FsCommandError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    let folder = rx
        .await
        .map_err(|_| FsCommandError::Io("directory picker closed unexpectedly".to_owned()))?;
    Ok(folder.map(|path| path.to_string()))
}

#[tauri::command]
pub fn read_text_file(root: String, relative_path: String) -> Result<String, FsCommandError> {
    let resolved = resolve_within_root(&root, &relative_path)?;
    if !resolved.exists {
        return Err(FsCommandError::NotFound(format!(
            "{relative_path:?} does not exist"
        )));
    }
    fs::read_to_string(&resolved.path)
        .map_err(|error| FsCommandError::Io(format!("failed to read {relative_path:?}: {error}")))
}

#[tauri::command]
pub fn write_text_file(
    root: String,
    relative_path: String,
    contents: String,
) -> Result<(), FsCommandError> {
    let resolved = resolve_within_root(&root, &relative_path)?;
    if let Some(parent) = resolved.path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            FsCommandError::Io(format!("failed to prepare {relative_path:?}: {error}"))
        })?;
    }
    fs::write(&resolved.path, contents)
        .map_err(|error| FsCommandError::Io(format!("failed to write {relative_path:?}: {error}")))
}

/// Removes exactly the requested file or empty directory. This intentionally does not
/// recurse into a non-empty directory; recursive tree deletion is out of scope.
#[tauri::command]
pub fn remove_path(root: String, relative_path: String) -> Result<(), FsCommandError> {
    let resolved = resolve_within_root(&root, &relative_path)?;
    if !resolved.exists {
        return Err(FsCommandError::NotFound(format!(
            "{relative_path:?} does not exist"
        )));
    }
    let metadata = fs::symlink_metadata(&resolved.path).map_err(|error| {
        FsCommandError::Io(format!("failed to inspect {relative_path:?}: {error}"))
    })?;
    let removal = if metadata.is_dir() {
        fs::remove_dir(&resolved.path)
    } else {
        fs::remove_file(&resolved.path)
    };
    removal
        .map_err(|error| FsCommandError::Io(format!("failed to remove {relative_path:?}: {error}")))
}

/// Checking existence must stay usable for a directory-context reachability check even
/// after the root itself has been deleted or unmounted, so a missing root answers `false`
/// instead of surfacing an `InvalidRoot` error; a malformed target (absolute, traversal)
/// still errors.
#[tauri::command]
pub fn path_exists(root: String, relative_path: String) -> Result<bool, FsCommandError> {
    if !Path::new(&root).exists() {
        return Ok(false);
    }
    let resolved = resolve_within_root(&root, &relative_path)?;
    Ok(resolved.exists)
}

/// Reveals the confined path in the OS file manager (Explorer / Finder / the desktop
/// environment's file manager on Linux) via the opener plugin, so Hammond never shells out
/// to a platform-specific process itself.
#[tauri::command]
pub fn reveal_path(
    app: AppHandle,
    root: String,
    relative_path: String,
) -> Result<(), FsCommandError> {
    let resolved = resolve_within_root(&root, &relative_path)?;
    if !resolved.exists {
        return Err(FsCommandError::NotFound(format!(
            "{relative_path:?} does not exist"
        )));
    }
    reveal_confined_path(&app, &resolved.path)
}

fn reveal_confined_path(app: &AppHandle, path: &Path) -> Result<(), FsCommandError> {
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| FsCommandError::Io(format!("failed to reveal path: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn read_text_file_reports_not_found_instead_of_a_raw_io_error() {
        let root = tempfile::tempdir().unwrap();
        let error = read_text_file(
            root.path().to_str().unwrap().to_owned(),
            "missing.txt".to_owned(),
        )
        .unwrap_err();
        assert!(matches!(error, FsCommandError::NotFound(_)));
    }

    #[test]
    fn write_text_file_creates_missing_parent_directories_within_root() {
        let root = tempfile::tempdir().unwrap();
        write_text_file(
            root.path().to_str().unwrap().to_owned(),
            "nested/dir/notes.txt".to_owned(),
            "hello".to_owned(),
        )
        .expect("write succeeds");
        let written = fs::read_to_string(root.path().join("nested/dir/notes.txt")).unwrap();
        assert_eq!(written, "hello");
    }

    #[test]
    fn write_text_file_rejects_traversal_before_touching_disk() {
        let root = tempfile::tempdir().unwrap();
        let error = write_text_file(
            root.path().to_str().unwrap().to_owned(),
            "../escape.txt".to_owned(),
            "nope".to_owned(),
        )
        .unwrap_err();
        assert!(matches!(error, FsCommandError::Traversal(_)));
        assert!(!root.path().parent().unwrap().join("escape.txt").exists());
    }

    #[test]
    fn remove_path_deletes_only_the_requested_file() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), b"a").unwrap();
        fs::write(root.path().join("b.txt"), b"b").unwrap();
        remove_path(root.path().to_str().unwrap().to_owned(), "a.txt".to_owned())
            .expect("remove succeeds");
        assert!(!root.path().join("a.txt").exists());
        assert!(root.path().join("b.txt").exists());
    }

    #[test]
    fn remove_path_does_not_recurse_into_a_non_empty_directory() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("dir")).unwrap();
        fs::write(root.path().join("dir/child.txt"), b"child").unwrap();
        let error =
            remove_path(root.path().to_str().unwrap().to_owned(), "dir".to_owned()).unwrap_err();
        assert!(matches!(error, FsCommandError::Io(_)));
        assert!(root.path().join("dir/child.txt").exists());
    }

    #[test]
    fn path_exists_is_false_for_a_missing_relative_target_without_erroring() {
        let root = tempfile::tempdir().unwrap();
        let exists = path_exists(
            root.path().to_str().unwrap().to_owned(),
            "missing.txt".to_owned(),
        )
        .expect("existence checks do not error for missing targets");
        assert!(!exists);
    }

    #[test]
    fn path_exists_returns_false_when_the_root_itself_is_missing_instead_of_erroring() {
        let parent = tempfile::tempdir().unwrap();
        let missing_root = parent.path().join("moved-away");
        let exists = path_exists(missing_root.to_str().unwrap().to_owned(), String::new())
            .expect("a missing directory-context root reports unreachable, not an error");
        assert!(!exists);
    }

    #[test]
    fn path_exists_rejects_an_absolute_target_instead_of_answering_false() {
        let root = tempfile::tempdir().unwrap();
        let error = path_exists(
            root.path().to_str().unwrap().to_owned(),
            "/etc/hosts".to_owned(),
        )
        .unwrap_err();
        assert!(matches!(error, FsCommandError::AbsoluteTarget(_)));
    }
}

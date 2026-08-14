//! Confinement guard for filesystem operations scoped to an owner-selected root.
//!
//! Every filesystem command receives an authorized root plus a relative target. This
//! module is the single place that turns `(root, relative)` into a filesystem path that
//! is provably inside `root`, rejecting absolute targets, `..` traversal, and symlink or
//! reparse-point escapes. Callers must never bypass this module to touch the filesystem
//! directly with an owner-supplied relative path.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "message")]
pub enum FsGuardError {
    InvalidRoot(String),
    AbsoluteTarget(String),
    Traversal(String),
    Escape(String),
    Io(String),
}

impl std::fmt::Display for FsGuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FsGuardError::InvalidRoot(message)
            | FsGuardError::AbsoluteTarget(message)
            | FsGuardError::Traversal(message)
            | FsGuardError::Escape(message)
            | FsGuardError::Io(message) => write!(f, "{message}"),
        }
    }
}

/// Rejects a relative target outright if it is absolute or contains any component that
/// could escape the root before we ever touch the filesystem: `..`, a root prefix (`/`),
/// or a Windows drive/UNC prefix.
fn reject_unsafe_relative(relative: &str) -> Result<(), FsGuardError> {
    // `std::path::Path` only recognizes drive letters and UNC prefixes as absolute when
    // compiled for Windows. The owner's primary environment is Windows, but this guard
    // must reject a Windows-style absolute target regardless of which OS built the binary
    // running the check (tests on this repo run on Linux), so check the raw text first.
    if looks_like_windows_absolute_path(relative) {
        return Err(FsGuardError::AbsoluteTarget(format!(
            "target must be a relative path, got {relative:?}"
        )));
    }
    let candidate = Path::new(relative);
    if candidate.is_absolute() {
        return Err(FsGuardError::AbsoluteTarget(format!(
            "target must be a relative path, got {relative:?}"
        )));
    }
    for component in candidate.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err(FsGuardError::Traversal(format!(
                    "target must not contain '..', got {relative:?}"
                )));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(FsGuardError::AbsoluteTarget(format!(
                    "target must be a relative path, got {relative:?}"
                )));
            }
        }
    }
    Ok(())
}

/// Recognizes a Windows drive-letter (`C:\...`, `C:/...`) or UNC (`\\server\share`) prefix
/// purely by text, independent of the host OS the guard happens to be compiled for.
fn looks_like_windows_absolute_path(candidate: &str) -> bool {
    if candidate.starts_with("\\\\") {
        return true;
    }
    let bytes = candidate.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// Canonicalizes `root` itself. Every confinement check is relative to this canonical form
/// so that comparisons are symlink- and reparse-point-aware, not naive string prefixes.
fn canonical_root(root: &str) -> Result<PathBuf, FsGuardError> {
    if root.trim().is_empty() {
        return Err(FsGuardError::InvalidRoot("root must not be empty".into()));
    }
    let root_path = Path::new(root);
    if !root_path.is_absolute() {
        return Err(FsGuardError::InvalidRoot(format!(
            "root must be an absolute path, got {root:?}"
        )));
    }
    dunce::canonicalize(root_path).map_err(|error| {
        FsGuardError::InvalidRoot(format!("root {root:?} is not accessible: {error}"))
    })
}

/// Confirms `candidate` (already canonicalized) is inside `root` (already canonicalized).
/// `Path::starts_with` compares whole components, so a sibling directory that merely shares
/// a string prefix (e.g. root `/home/owner/proj` vs `/home/owner/proj-evil`) is correctly
/// rejected.
fn assert_within_root(root: &Path, candidate: &Path) -> Result<(), FsGuardError> {
    if candidate.starts_with(root) {
        Ok(())
    } else {
        Err(FsGuardError::Escape(format!(
            "resolved path {candidate:?} escapes root {root:?}"
        )))
    }
}

/// The outcome of resolving `(root, relative)`: the confined absolute path, and whether it
/// currently exists on disk.
#[derive(Debug)]
pub struct Resolved {
    pub path: PathBuf,
    pub exists: bool,
}

/// Resolves `relative` against `root`, guaranteeing the result is confined to `root`.
///
/// If the target exists, it is fully canonicalized (resolving any symlink or reparse
/// point) and must still land inside the canonical root. If the target does not exist,
/// the nearest existing ancestor is canonicalized and checked instead, then the missing
/// suffix (already proven free of `..` and absolute components) is reattached. This lets
/// callers create new files/directories while still rejecting an ancestor symlink that
/// would otherwise smuggle the write outside the root.
pub fn resolve_within_root(root: &str, relative: &str) -> Result<Resolved, FsGuardError> {
    reject_unsafe_relative(relative)?;
    let canonical_root = canonical_root(root)?;

    let joined = if relative.trim().is_empty() {
        canonical_root.clone()
    } else {
        canonical_root.join(relative)
    };

    if let Ok(canonical_target) = dunce::canonicalize(&joined) {
        assert_within_root(&canonical_root, &canonical_target)?;
        return Ok(Resolved {
            path: canonical_target,
            exists: true,
        });
    }

    // The target does not exist yet. Walk up to the nearest existing ancestor, canonicalize
    // that (resolving any symlink placed there), confirm it is confined, then rebuild the
    // full path from the canonical ancestor plus the still-missing suffix.
    let mut existing_ancestor = joined.clone();
    let mut missing_suffix: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if existing_ancestor.exists() {
            break;
        }
        let Some(name) = existing_ancestor.file_name() else {
            return Err(FsGuardError::InvalidRoot(
                "root is not accessible".to_owned(),
            ));
        };
        missing_suffix.push(name.to_owned());
        existing_ancestor = existing_ancestor
            .parent()
            .ok_or_else(|| FsGuardError::InvalidRoot("root is not accessible".to_owned()))?
            .to_path_buf();
    }

    let canonical_ancestor = dunce::canonicalize(&existing_ancestor)
        .map_err(|error| FsGuardError::Io(format!("failed to resolve {joined:?}: {error}")))?;
    assert_within_root(&canonical_root, &canonical_ancestor)?;

    let mut resolved = canonical_ancestor;
    for name in missing_suffix.into_iter().rev() {
        resolved.push(name);
    }

    Ok(Resolved {
        path: resolved,
        exists: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    fn temp_root() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp root")
    }

    #[test]
    fn resolves_a_legal_existing_file() {
        let root = temp_root();
        fs::write(root.path().join("notes.txt"), b"hello").unwrap();

        let resolved =
            resolve_within_root(root.path().to_str().unwrap(), "notes.txt").expect("resolves");
        assert!(resolved.exists);
        assert_eq!(
            dunce::canonicalize(&resolved.path).unwrap(),
            dunce::canonicalize(root.path().join("notes.txt")).unwrap()
        );
    }

    #[test]
    fn resolves_a_legal_nested_create_target() {
        let root = temp_root();
        fs::create_dir(root.path().join("nested")).unwrap();

        let resolved = resolve_within_root(root.path().to_str().unwrap(), "nested/new-file.txt")
            .expect("resolves");
        assert!(!resolved.exists);
        assert_eq!(resolved.path.file_name().unwrap(), "new-file.txt");
    }

    #[test]
    fn resolves_the_root_itself_for_an_empty_relative_path() {
        let root = temp_root();
        let resolved = resolve_within_root(root.path().to_str().unwrap(), "").expect("resolves");
        assert!(resolved.exists);
        assert_eq!(resolved.path, dunce::canonicalize(root.path()).unwrap());
    }

    #[test]
    fn rejects_an_absolute_unix_style_target() {
        let root = temp_root();
        let error = resolve_within_root(root.path().to_str().unwrap(), "/etc/passwd").unwrap_err();
        assert!(matches!(error, FsGuardError::AbsoluteTarget(_)));
    }

    #[test]
    fn rejects_a_windows_drive_prefixed_target() {
        let root = temp_root();
        let error =
            resolve_within_root(root.path().to_str().unwrap(), "C:\\Windows\\win.ini").unwrap_err();
        assert!(matches!(error, FsGuardError::AbsoluteTarget(_)));
    }

    #[test]
    fn rejects_a_windows_unc_prefixed_target() {
        let root = temp_root();
        let error = resolve_within_root(root.path().to_str().unwrap(), "\\\\server\\share\\file")
            .unwrap_err();
        assert!(matches!(error, FsGuardError::AbsoluteTarget(_)));
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        let root = temp_root();
        let error =
            resolve_within_root(root.path().to_str().unwrap(), "../outside.txt").unwrap_err();
        assert!(matches!(error, FsGuardError::Traversal(_)));
    }

    #[test]
    fn rejects_parent_dir_traversal_embedded_after_legal_components() {
        let root = temp_root();
        fs::create_dir(root.path().join("nested")).unwrap();
        let error = resolve_within_root(root.path().to_str().unwrap(), "nested/../../outside.txt")
            .unwrap_err();
        assert!(matches!(error, FsGuardError::Traversal(_)));
    }

    #[test]
    fn rejects_a_sibling_directory_that_only_shares_a_string_prefix() {
        // Root "<tmp>/root" and sibling "<tmp>/root-evil" share a string prefix; a naive
        // `String::starts_with` confinement check would wrongly accept a target resolved
        // through the sibling. `Path::starts_with` must not make that mistake.
        let parent = temp_root();
        let root = parent.path().join("root");
        let sibling = parent.path().join("root-evil");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&sibling).unwrap();
        fs::write(sibling.join("secret.txt"), b"nope").unwrap();

        let canonical_root = dunce::canonicalize(&root).unwrap();
        let canonical_sibling_file = dunce::canonicalize(sibling.join("secret.txt")).unwrap();
        assert!(
            canonical_sibling_file
                .to_string_lossy()
                .starts_with(&*canonical_root.to_string_lossy()),
            "test setup requires the naive string-prefix trap to be present"
        );
        assert!(!canonical_sibling_file.starts_with(&canonical_root));
    }

    #[test]
    #[cfg(unix)]
    fn rejects_a_symlink_that_resolves_outside_the_root() {
        let parent = temp_root();
        let root = parent.path().join("root");
        let outside = parent.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.txt"), b"nope").unwrap();
        symlink(&outside, root.join("escape-link")).unwrap();

        let error =
            resolve_within_root(root.to_str().unwrap(), "escape-link/secret.txt").unwrap_err();
        assert!(matches!(error, FsGuardError::Escape(_)));
    }

    #[test]
    #[cfg(unix)]
    fn rejects_a_symlinked_ancestor_for_a_not_yet_existing_create_target() {
        let parent = temp_root();
        let root = parent.path().join("root");
        let outside = parent.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        symlink(&outside, root.join("escape-link")).unwrap();

        let error =
            resolve_within_root(root.to_str().unwrap(), "escape-link/new-file.txt").unwrap_err();
        assert!(matches!(error, FsGuardError::Escape(_)));
    }

    #[test]
    #[cfg(unix)]
    fn accepts_a_symlink_that_resolves_back_inside_the_root() {
        let root = temp_root();
        fs::create_dir(root.path().join("real")).unwrap();
        fs::write(root.path().join("real/inside.txt"), b"fine").unwrap();
        symlink(root.path().join("real"), root.path().join("linked")).unwrap();

        let resolved = resolve_within_root(root.path().to_str().unwrap(), "linked/inside.txt")
            .expect("resolves because the symlink target is still inside root");
        assert!(resolved.exists);
    }

    #[test]
    fn rejects_a_root_that_does_not_exist() {
        let parent = temp_root();
        let missing_root = parent.path().join("does-not-exist");
        let error = resolve_within_root(missing_root.to_str().unwrap(), "file.txt").unwrap_err();
        assert!(matches!(error, FsGuardError::InvalidRoot(_)));
    }

    #[test]
    fn rejects_a_relative_root() {
        let error = resolve_within_root("relative/root", "file.txt").unwrap_err();
        assert!(matches!(error, FsGuardError::InvalidRoot(_)));
    }
}

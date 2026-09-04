//! Tauri commands for the harness-adapter surface: report a provider's documented target path,
//! classify what is currently there, write (create or update) a Hammond-managed document with an
//! atomic temp-sibling-plus-rename, remove a target only when it is verifiably Hammond-managed,
//! and optionally toggle a managed target's entry in `.git/info/exclude`. Every path-touching
//! command funnels through [`resolve_within_root`], exactly like `fs_commands`, so confinement
//! cannot be bypassed by a command forgetting to check — including for a target that does not
//! exist yet (an owner's first Inject).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::fs_commands::FsCommandError;
use crate::fs_guard::resolve_within_root;
use crate::harness::{
    classify, render_managed_document, Classification, ManagedHeaderFields, Provider,
};

#[tauri::command]
pub fn harness_target_path(provider: Provider) -> String {
    provider.target_relative_path().to_owned()
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
pub enum ClassificationDto {
    Missing,
    ManagedValid { header: ManagedHeaderFields },
    ManagedMalformed,
    Unmanaged,
}

impl From<Classification> for ClassificationDto {
    fn from(value: Classification) -> Self {
        match value {
            Classification::Missing => ClassificationDto::Missing,
            Classification::ManagedValid(header) => ClassificationDto::ManagedValid { header },
            Classification::ManagedMalformed => ClassificationDto::ManagedMalformed,
            Classification::Unmanaged => ClassificationDto::Unmanaged,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifyResult {
    pub relative_path: String,
    pub classification: ClassificationDto,
}

/// What is currently at a resolved target path. Distinguished from a plain `Option<String>` so a
/// directory occupying a provider's fixed target path (never true by construction, but not
/// impossible on disk) is handled explicitly rather than attempting to read it as text: a
/// directory can never carry a Hammond managed header, so it is treated the same as any other
/// content this adapter does not own.
enum ExistingTarget {
    Missing,
    Directory,
    File(String),
}

fn read_target(
    root: &str,
    relative_path: &str,
) -> Result<(PathBuf, ExistingTarget), FsCommandError> {
    let resolved = resolve_within_root(root, relative_path)?;
    if !resolved.exists {
        return Ok((resolved.path, ExistingTarget::Missing));
    }
    let metadata = fs::metadata(&resolved.path).map_err(|error| {
        FsCommandError::Io(format!("failed to inspect {relative_path:?}: {error}"))
    })?;
    if metadata.is_dir() {
        return Ok((resolved.path, ExistingTarget::Directory));
    }
    let content = fs::read_to_string(&resolved.path).map_err(|error| {
        FsCommandError::Io(format!("failed to read {relative_path:?}: {error}"))
    })?;
    Ok((resolved.path, ExistingTarget::File(content)))
}

fn classify_existing(existing: &ExistingTarget) -> Classification {
    match existing {
        ExistingTarget::Missing => Classification::Missing,
        ExistingTarget::Directory => Classification::Unmanaged,
        ExistingTarget::File(content) => classify(Some(content)),
    }
}

#[tauri::command]
pub fn harness_classify(
    root: String,
    provider: Provider,
) -> Result<ClassifyResult, FsCommandError> {
    let relative_path = provider.target_relative_path().to_owned();
    let (_, existing) = read_target(&root, &relative_path)?;
    Ok(ClassifyResult {
        relative_path,
        classification: classify_existing(&existing).into(),
    })
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum InjectOutcome {
    /// The document was written (created or updated).
    Written { relative_path: String },
    /// The target is Unmanaged and `force_replace` was not set; nothing was written. The owner
    /// must choose Import, Replace, or Cancel before this can proceed.
    RequiresConfirmation { relative_path: String },
}

fn unique_temp_sibling(target: &Path) -> PathBuf {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("hammond-managed");
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!("{file_name}.hammond-tmp-{nanos}-{sequence}"))
}

/// Writes `contents` to `target` via an ordinary temporary sibling in the same directory plus an
/// atomic rename. On any failure the exact temporary sibling (never anything broader) is removed
/// on a best-effort basis before the error is returned.
fn atomic_write(target: &Path, contents: &str) -> Result<(), FsCommandError> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            FsCommandError::Io(format!("failed to prepare target directory: {error}"))
        })?;
    }
    let temp_path = unique_temp_sibling(target);
    if let Err(error) = fs::write(&temp_path, contents) {
        let _ = fs::remove_file(&temp_path);
        return Err(FsCommandError::Io(format!(
            "failed to write temporary file: {error}"
        )));
    }
    if let Err(error) = fs::rename(&temp_path, target) {
        let _ = fs::remove_file(&temp_path);
        return Err(FsCommandError::Io(format!(
            "failed to replace target atomically: {error}"
        )));
    }
    Ok(())
}

/// Creates or updates the Hammond-managed document for `header.provider`. When the target
/// already exists and is Unmanaged, nothing is written unless `force_replace` is `true` — the
/// caller (owner, via Import/Replace/Cancel) must explicitly choose to proceed. A
/// `ManagedMalformed` target is always safely overwritten: the marker already identifies it as
/// Hammond's own (corrupted) content, never a third party's file.
#[tauri::command]
pub fn harness_inject(
    root: String,
    header: ManagedHeaderFields,
    composed_content: String,
    force_replace: bool,
) -> Result<InjectOutcome, FsCommandError> {
    let relative_path = header.provider.target_relative_path().to_owned();
    let (target_path, existing) = read_target(&root, &relative_path)?;

    let classification = classify_existing(&existing);
    if matches!(classification, Classification::Unmanaged) && !force_replace {
        return Ok(InjectOutcome::RequiresConfirmation { relative_path });
    }

    let document = render_managed_document(&header, &composed_content);
    atomic_write(&target_path, &document)?;
    Ok(InjectOutcome::Written { relative_path })
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum RemoveOutcome {
    Removed {
        relative_path: String,
    },
    NotFound {
        relative_path: String,
    },
    /// The target exists but its managed header does not currently validate (malformed or
    /// unmanaged), so nothing was removed. Matches "removal touches only a file whose managed
    /// header validates" — re-checked here against the file's *current* content, never trusting
    /// an earlier classification the caller may be holding.
    Refused {
        relative_path: String,
    },
}

#[tauri::command]
pub fn harness_remove(root: String, provider: Provider) -> Result<RemoveOutcome, FsCommandError> {
    let relative_path = provider.target_relative_path().to_owned();
    let (target_path, existing) = read_target(&root, &relative_path)?;
    if matches!(existing, ExistingTarget::Missing) {
        return Ok(RemoveOutcome::NotFound { relative_path });
    }
    if !matches!(
        classify_existing(&existing),
        Classification::ManagedValid(_)
    ) {
        return Ok(RemoveOutcome::Refused { relative_path });
    }
    fs::remove_file(&target_path).map_err(|error| {
        FsCommandError::Io(format!("failed to remove {relative_path:?}: {error}"))
    })?;
    Ok(RemoveOutcome::Removed { relative_path })
}

const GIT_EXCLUDE_RELATIVE_PATH: &str = ".git/info/exclude";

fn read_exclude_lines(path: &Path) -> Result<Vec<String>, FsCommandError> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(contents.lines().map(str::to_owned).collect()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(FsCommandError::Io(format!(
            "failed to read .git/info/exclude: {error}"
        ))),
    }
}

/// Adds or removes exactly `relative_path` as a line in `.git/info/exclude`, preserving every
/// other line and their order. `.git/info/exclude` is per-repository-checkout and never shared
/// through source control, unlike `.gitignore`, so this never touches a Git-tracked file.
#[tauri::command]
pub fn harness_set_git_exclude(
    root: String,
    relative_path: String,
    excluded: bool,
) -> Result<(), FsCommandError> {
    let resolved = resolve_within_root(&root, GIT_EXCLUDE_RELATIVE_PATH)?;
    let mut lines = read_exclude_lines(&resolved.path)?;
    let already_present = lines.iter().any(|line| line == &relative_path);

    if excluded && !already_present {
        lines.push(relative_path);
    } else if !excluded && already_present {
        lines.retain(|line| line != &relative_path);
    } else {
        return Ok(());
    }

    if let Some(parent) = resolved.path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| FsCommandError::Io(format!("failed to prepare .git/info: {error}")))?;
    }
    let mut contents = lines.join("\n");
    if !contents.is_empty() {
        contents.push('\n');
    }
    atomic_write(&resolved.path, &contents)
}

#[tauri::command]
pub fn harness_git_exclude_contains(
    root: String,
    relative_path: String,
) -> Result<bool, FsCommandError> {
    let resolved = resolve_within_root(&root, GIT_EXCLUDE_RELATIVE_PATH)?;
    let lines = read_exclude_lines(&resolved.path)?;
    Ok(lines.iter().any(|line| line == &relative_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::Role;
    use std::os::unix::fs::symlink;

    fn sample_header(provider: Provider) -> ManagedHeaderFields {
        ManagedHeaderFields {
            format_version: 1,
            project_id: "project-1".to_owned(),
            role: Role::Worker,
            provider,
            shared_role_version_id: "shared-v1".to_owned(),
            provider_version_id: "provider-v1".to_owned(),
            override_version_id: None,
            generated_at: "2026-09-04T16:00:00Z".to_owned(),
        }
    }

    // ---------------------------------------------------------------------
    // Target path mapping (all three providers)
    // ---------------------------------------------------------------------

    #[test]
    fn harness_target_path_reports_each_providers_exact_relative_path() {
        assert_eq!(harness_target_path(Provider::Codex), "AGENTS.md");
        assert_eq!(harness_target_path(Provider::ClaudeCode), "CLAUDE.md");
        assert_eq!(
            harness_target_path(Provider::KiloCode),
            ".kilocode/rules/hammond.md"
        );
    }

    // ---------------------------------------------------------------------
    // Classification
    // ---------------------------------------------------------------------

    #[test]
    fn classify_reports_missing_for_a_target_that_does_not_exist() {
        let root = tempfile::tempdir().unwrap();
        let result =
            harness_classify(root.path().to_str().unwrap().to_owned(), Provider::Codex).unwrap();
        assert_eq!(result.relative_path, "AGENTS.md");
        assert!(matches!(result.classification, ClassificationDto::Missing));
    }

    #[test]
    fn classify_reports_unmanaged_for_a_preexisting_owner_file() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("CLAUDE.md"), "# my own notes\n").unwrap();
        let result = harness_classify(
            root.path().to_str().unwrap().to_owned(),
            Provider::ClaudeCode,
        )
        .unwrap();
        assert!(matches!(
            result.classification,
            ClassificationDto::Unmanaged
        ));
    }

    #[test]
    fn classify_reports_managed_valid_after_a_real_inject() {
        let root = tempfile::tempdir().unwrap();
        let header = sample_header(Provider::ClaudeCode);
        harness_inject(
            root.path().to_str().unwrap().to_owned(),
            header.clone(),
            "composed content".to_owned(),
            false,
        )
        .unwrap();

        let result = harness_classify(
            root.path().to_str().unwrap().to_owned(),
            Provider::ClaudeCode,
        )
        .unwrap();
        match result.classification {
            ClassificationDto::ManagedValid { header: parsed } => assert_eq!(parsed, header),
            other => panic!("expected ManagedValid, got {other:?}"),
        }
    }

    // ---------------------------------------------------------------------
    // Inject / first write / update / unmanaged conflict / force replace
    // ---------------------------------------------------------------------

    #[test]
    fn inject_creates_a_nested_target_directory_that_does_not_exist_yet() {
        let root = tempfile::tempdir().unwrap();
        let outcome = harness_inject(
            root.path().to_str().unwrap().to_owned(),
            sample_header(Provider::KiloCode),
            "content".to_owned(),
            false,
        )
        .unwrap();
        assert!(matches!(outcome, InjectOutcome::Written { .. }));
        assert!(root.path().join(".kilocode/rules/hammond.md").exists());
    }

    #[test]
    fn inject_updates_an_existing_managed_document_in_place() {
        let root = tempfile::tempdir().unwrap();
        let root_str = root.path().to_str().unwrap().to_owned();
        harness_inject(
            root_str.clone(),
            sample_header(Provider::Codex),
            "v1".to_owned(),
            false,
        )
        .unwrap();
        harness_inject(
            root_str.clone(),
            sample_header(Provider::Codex),
            "v2".to_owned(),
            false,
        )
        .unwrap();

        let contents = fs::read_to_string(root.path().join("AGENTS.md")).unwrap();
        assert!(contents.ends_with("v2"));
        assert!(
            !contents.ends_with("v1"),
            "the stale v1 body must not still be present"
        );
    }

    #[test]
    fn inject_refuses_to_overwrite_an_unmanaged_target_without_force_replace() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("AGENTS.md"), "# owned by someone else\n").unwrap();
        let outcome = harness_inject(
            root.path().to_str().unwrap().to_owned(),
            sample_header(Provider::Codex),
            "content".to_owned(),
            false,
        )
        .unwrap();
        assert!(matches!(
            outcome,
            InjectOutcome::RequiresConfirmation { .. }
        ));
        let contents = fs::read_to_string(root.path().join("AGENTS.md")).unwrap();
        assert_eq!(contents, "# owned by someone else\n");
    }

    #[test]
    fn inject_replaces_an_unmanaged_target_when_force_replace_is_set() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("AGENTS.md"), "# owned by someone else\n").unwrap();
        let outcome = harness_inject(
            root.path().to_str().unwrap().to_owned(),
            sample_header(Provider::Codex),
            "content".to_owned(),
            true,
        )
        .unwrap();
        assert!(matches!(outcome, InjectOutcome::Written { .. }));
        let contents = fs::read_to_string(root.path().join("AGENTS.md")).unwrap();
        assert!(contents.starts_with("<!-- hammond:managed"));
    }

    #[test]
    fn inject_silently_repairs_a_malformed_managed_target_without_force_replace() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("AGENTS.md"),
            "<!-- hammond:managed\nformat_version: 999\n-->\n\nbroken",
        )
        .unwrap();
        let outcome = harness_inject(
            root.path().to_str().unwrap().to_owned(),
            sample_header(Provider::Codex),
            "fresh content".to_owned(),
            false,
        )
        .unwrap();
        assert!(matches!(outcome, InjectOutcome::Written { .. }));
    }

    #[test]
    fn no_temporary_sibling_is_left_behind_after_a_successful_inject() {
        let root = tempfile::tempdir().unwrap();
        harness_inject(
            root.path().to_str().unwrap().to_owned(),
            sample_header(Provider::Codex),
            "content".to_owned(),
            false,
        )
        .unwrap();
        let leftovers: Vec<_> = fs::read_dir(root.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains("hammond-tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "expected no leftover temp files, found {leftovers:?}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_failed_rename_cleans_up_exactly_the_temporary_sibling_it_created() {
        // Make the target path itself a directory, so the final rename() over it fails (renaming
        // a file onto an existing non-empty-incompatible directory errors on all platforms), and
        // confirm only our own temp file is removed, never anything broader.
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("AGENTS.md")).unwrap();
        fs::write(root.path().join("AGENTS.md/keep.txt"), b"keep me").unwrap();

        let error = harness_inject(
            root.path().to_str().unwrap().to_owned(),
            sample_header(Provider::Codex),
            "content".to_owned(),
            true,
        )
        .unwrap_err();
        assert!(matches!(error, FsCommandError::Io(_)));

        // The directory (and the file inside it) Hammond did not create must survive untouched.
        assert!(root.path().join("AGENTS.md/keep.txt").exists());
        let leftovers: Vec<_> = fs::read_dir(root.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains("hammond-tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "expected no leftover temp files, found {leftovers:?}"
        );
    }

    // ---------------------------------------------------------------------
    // Remove
    // ---------------------------------------------------------------------

    #[test]
    fn remove_deletes_a_managed_valid_target() {
        let root = tempfile::tempdir().unwrap();
        let root_str = root.path().to_str().unwrap().to_owned();
        harness_inject(
            root_str.clone(),
            sample_header(Provider::Codex),
            "content".to_owned(),
            false,
        )
        .unwrap();

        let outcome = harness_remove(root_str, Provider::Codex).unwrap();
        assert!(matches!(outcome, RemoveOutcome::Removed { .. }));
        assert!(!root.path().join("AGENTS.md").exists());
    }

    #[test]
    fn remove_reports_not_found_for_a_missing_target_without_erroring() {
        let root = tempfile::tempdir().unwrap();
        let outcome =
            harness_remove(root.path().to_str().unwrap().to_owned(), Provider::Codex).unwrap();
        assert!(matches!(outcome, RemoveOutcome::NotFound { .. }));
    }

    #[test]
    fn remove_refuses_an_unmanaged_target_and_leaves_it_untouched() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("AGENTS.md"), "# not hammond's\n").unwrap();
        let outcome =
            harness_remove(root.path().to_str().unwrap().to_owned(), Provider::Codex).unwrap();
        assert!(matches!(outcome, RemoveOutcome::Refused { .. }));
        assert_eq!(
            fs::read_to_string(root.path().join("AGENTS.md")).unwrap(),
            "# not hammond's\n"
        );
    }

    #[test]
    fn remove_refuses_a_malformed_managed_target_and_leaves_it_untouched() {
        let root = tempfile::tempdir().unwrap();
        let broken = "<!-- hammond:managed\nformat_version: 999\n-->\n\nbroken";
        fs::write(root.path().join("AGENTS.md"), broken).unwrap();
        let outcome =
            harness_remove(root.path().to_str().unwrap().to_owned(), Provider::Codex).unwrap();
        assert!(matches!(outcome, RemoveOutcome::Refused { .. }));
        assert_eq!(
            fs::read_to_string(root.path().join("AGENTS.md")).unwrap(),
            broken
        );
    }

    #[test]
    fn remove_never_deletes_a_directory() {
        // Defense in depth: even if a provider's target path were ever a directory on disk
        // (never true by construction of the three fixed targets, but proven here anyway), the
        // adapter must never remove it, unlike the generic fs_commands::remove_path surface.
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("AGENTS.md")).unwrap();
        let outcome =
            harness_remove(root.path().to_str().unwrap().to_owned(), Provider::Codex).unwrap();
        assert!(matches!(outcome, RemoveOutcome::Refused { .. }));
        assert!(root.path().join("AGENTS.md").is_dir());
    }

    // ---------------------------------------------------------------------
    // Confinement: traversal, absolute paths, symlink escapes
    // ---------------------------------------------------------------------

    #[test]
    fn classify_rejects_a_root_that_does_not_confine_a_traversal_attempt() {
        // harness_classify always resolves the provider's OWN fixed relative path (never an
        // owner-supplied one), so there is nothing to traverse with here; this instead proves the
        // guard still runs by rejecting an invalid (non-existent) root outright.
        let error = harness_classify("relative/root".to_owned(), Provider::Codex).unwrap_err();
        assert!(matches!(error, FsCommandError::InvalidRoot(_)));
    }

    #[test]
    #[cfg(unix)]
    fn inject_rejects_a_target_reached_through_a_symlink_that_escapes_root() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("root");
        let outside = parent.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        symlink(&outside, root.join(".kilocode")).unwrap();

        let error = harness_inject(
            root.to_str().unwrap().to_owned(),
            sample_header(Provider::KiloCode),
            "content".to_owned(),
            true,
        )
        .unwrap_err();
        assert!(matches!(error, FsCommandError::Escape(_)));
        assert!(!outside.join("rules/hammond.md").exists());
    }

    #[test]
    #[cfg(unix)]
    fn classify_rejects_an_existing_target_reached_through_a_symlink_that_escapes_root() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("root");
        let outside = parent.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("CLAUDE.md"), "secret").unwrap();
        symlink(outside.join("CLAUDE.md"), root.join("CLAUDE.md")).unwrap();

        let error =
            harness_classify(root.to_str().unwrap().to_owned(), Provider::ClaudeCode).unwrap_err();
        assert!(matches!(error, FsCommandError::Escape(_)));
    }

    #[test]
    #[cfg(unix)]
    fn remove_rejects_a_target_reached_through_a_symlink_that_escapes_root() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("root");
        let outside = parent.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("AGENTS.md"), "secret").unwrap();
        symlink(outside.join("AGENTS.md"), root.join("AGENTS.md")).unwrap();

        let error = harness_remove(root.to_str().unwrap().to_owned(), Provider::Codex).unwrap_err();
        assert!(matches!(error, FsCommandError::Escape(_)));
        assert!(outside.join("AGENTS.md").exists());
    }

    // ---------------------------------------------------------------------
    // .git/info/exclude
    // ---------------------------------------------------------------------

    #[test]
    fn git_exclude_add_then_remove_touches_only_the_exact_managed_path() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(".git/info")).unwrap();
        fs::write(
            root.path().join(".git/info/exclude"),
            "# git ls-files --others --exclude-from=.git/info/exclude\nunrelated-entry.txt\n",
        )
        .unwrap();
        let root_str = root.path().to_str().unwrap().to_owned();

        harness_set_git_exclude(root_str.clone(), "CLAUDE.md".to_owned(), true).unwrap();
        let contents = fs::read_to_string(root.path().join(".git/info/exclude")).unwrap();
        assert!(contents.contains("unrelated-entry.txt"));
        assert!(contents.contains("CLAUDE.md"));
        assert!(harness_git_exclude_contains(root_str.clone(), "CLAUDE.md".to_owned()).unwrap());

        harness_set_git_exclude(root_str.clone(), "CLAUDE.md".to_owned(), false).unwrap();
        let contents = fs::read_to_string(root.path().join(".git/info/exclude")).unwrap();
        assert!(contents.contains("unrelated-entry.txt"));
        assert!(!contents.contains("CLAUDE.md"));
        assert!(!harness_git_exclude_contains(root_str, "CLAUDE.md".to_owned()).unwrap());
    }

    #[test]
    fn git_exclude_creates_the_file_when_it_does_not_exist_yet() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(".git")).unwrap();
        let root_str = root.path().to_str().unwrap().to_owned();

        harness_set_git_exclude(root_str.clone(), "AGENTS.md".to_owned(), true).unwrap();
        assert!(harness_git_exclude_contains(root_str, "AGENTS.md".to_owned()).unwrap());
    }

    #[test]
    fn git_exclude_is_idempotent_and_does_not_duplicate_entries() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(".git")).unwrap();
        let root_str = root.path().to_str().unwrap().to_owned();

        harness_set_git_exclude(root_str.clone(), "AGENTS.md".to_owned(), true).unwrap();
        harness_set_git_exclude(root_str.clone(), "AGENTS.md".to_owned(), true).unwrap();
        let contents = fs::read_to_string(root.path().join(".git/info/exclude")).unwrap();
        assert_eq!(contents.matches("AGENTS.md").count(), 1);
    }
}

#[cfg(test)]
mod wire_shape_tests {
    use super::*;

    #[test]
    fn classification_dto_json_shape_uses_camel_case_header_fields() {
        let header = ManagedHeaderFields {
            format_version: 1,
            project_id: "p1".to_owned(),
            role: crate::harness::Role::Worker,
            provider: Provider::ClaudeCode,
            shared_role_version_id: "s1".to_owned(),
            provider_version_id: "pr1".to_owned(),
            override_version_id: None,
            generated_at: "2026-09-04T16:00:00Z".to_owned(),
        };
        let dto = ClassificationDto::ManagedValid { header };
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains("\"kind\":\"ManagedValid\""), "{json}");
        assert!(json.contains("\"formatVersion\":1"), "{json}");
        assert!(json.contains("\"projectId\":\"p1\""), "{json}");
        assert!(json.contains("\"sharedRoleVersionId\":\"s1\""), "{json}");
        assert!(json.contains("\"overrideVersionId\":null"), "{json}");
    }

    #[test]
    fn inject_outcome_json_shape_uses_camel_case_relative_path() {
        let json = serde_json::to_string(&InjectOutcome::Written {
            relative_path: "CLAUDE.md".to_owned(),
        })
        .unwrap();
        assert_eq!(json, r#"{"kind":"Written","relativePath":"CLAUDE.md"}"#);
    }

    #[test]
    fn remove_outcome_json_shape_uses_camel_case_relative_path() {
        let json = serde_json::to_string(&RemoveOutcome::Refused {
            relative_path: "AGENTS.md".to_owned(),
        })
        .unwrap();
        assert_eq!(json, r#"{"kind":"Refused","relativePath":"AGENTS.md"}"#);
    }

    #[test]
    fn classify_result_json_shape_uses_camel_case_relative_path() {
        let result = ClassifyResult {
            relative_path: "AGENTS.md".to_owned(),
            classification: ClassificationDto::Missing,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert_eq!(
            json,
            r#"{"relativePath":"AGENTS.md","classification":{"kind":"Missing"}}"#
        );
    }
}

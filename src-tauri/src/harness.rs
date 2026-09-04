//! Pure harness-adapter logic shared by the Codex, Claude Code, and Kilo Code project-scoped
//! instruction entry points: which relative path each provider owns, the Hammond managed-file
//! header format, and classifying existing file content as missing / managed-valid /
//! managed-malformed / unmanaged. No filesystem access happens in this module; see
//! `harness_commands` for the Tauri commands that combine this with `fs_guard` confinement and
//! actual reads/writes.
//!
//! Target paths (current official documentation, retrieved 2026-09-04):
//! - Codex: `AGENTS.md` at the repository root — the documented open-format project instruction
//!   entry point (https://github.com/openai/codex/blob/main/docs/agents_md.md, pointing to
//!   https://developers.openai.com/codex/guides/agents-md; corroborated by openai/codex's own
//!   root-level AGENTS.md and independent write-ups of the CLI's nearest-file lookup order).
//! - Claude Code: `CLAUDE.md` at the repository root — one of two documented equivalent
//!   "Project instructions" locations (https://code.claude.com/docs/en/memory); root `CLAUDE.md`
//!   is chosen as the least-surprising one because it is what `/init` generates and what most
//!   projects already use. The same page states plainly "Claude Code reads CLAUDE.md, not
//!   AGENTS.md", so this never collides with the Codex target above.
//! - Kilo Code: `.kilocode/rules/hammond.md` — the legacy `.kilocode/rules/*.md` directory is
//!   still documented as auto-loaded for backward compatibility and merged into the modern
//!   `instructions` config array
//!   (https://github.com/Kilo-Org/kilo/blob/dev/packages/opencode/src/kilocode/docs/rules-migration.md,
//!   https://kilo.ai/docs/customize/custom-rules). Kilo Code *also* auto-loads a root `AGENTS.md`
//!   with fixed priority that "cannot be individually disabled"
//!   (https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/customize/agents-md.md),
//!   which is exactly the Codex target above; using the rules directory instead of AGENTS.md for
//!   Kilo Code avoids two different providers ever owning the same on-disk file, and avoids
//!   needing to parse/edit `kilo.jsonc` just to register one more file.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

pub const MANAGED_HEADER_FORMAT_VERSION: u32 = 1;
const HEADER_OPEN: &str = "<!-- hammond:managed";
const HEADER_CLOSE: &str = "-->";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Codex,
    ClaudeCode,
    KiloCode,
}

impl Provider {
    /// The exact relative target path this provider's documented project-scoped instruction
    /// entry point resolves to, relative to the linked directory root. Never an absolute path.
    pub fn target_relative_path(self) -> &'static str {
        match self {
            Provider::Codex => "AGENTS.md",
            Provider::ClaudeCode => "CLAUDE.md",
            Provider::KiloCode => ".kilocode/rules/hammond.md",
        }
    }

    fn as_header_str(self) -> &'static str {
        match self {
            Provider::Codex => "codex",
            Provider::ClaudeCode => "claude_code",
            Provider::KiloCode => "kilo_code",
        }
    }

    fn from_header_str(value: &str) -> Option<Provider> {
        match value {
            "codex" => Some(Provider::Codex),
            "claude_code" => Some(Provider::ClaudeCode),
            "kilo_code" => Some(Provider::KiloCode),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Orchestrator,
    Worker,
    Auditor,
}

impl Role {
    fn as_header_str(self) -> &'static str {
        match self {
            Role::Orchestrator => "orchestrator",
            Role::Worker => "worker",
            Role::Auditor => "auditor",
        }
    }

    fn from_header_str(value: &str) -> Option<Role> {
        match value {
            "orchestrator" => Some(Role::Orchestrator),
            "worker" => Some(Role::Worker),
            "auditor" => Some(Role::Auditor),
            _ => None,
        }
    }
}

/// The non-secret metadata every Hammond-generated document begins with: enough to identify
/// format version, project, role, execution provider, and the exact instruction versions
/// composed into the document. Never carries an absolute local path or a credential.
///
/// `camelCase` on the wire (Tauri IPC / JSON) to match the idiomatic TypeScript domain shape in
/// `src/harness/types.ts`; this has no bearing on the on-disk managed-header text format, which
/// [`render_managed_document`] and [`parse_managed_header`] read and write by hand.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedHeaderFields {
    pub format_version: u32,
    pub project_id: String,
    pub role: Role,
    pub provider: Provider,
    pub shared_role_version_id: String,
    pub provider_version_id: String,
    pub override_version_id: Option<String>,
    pub generated_at: String,
}

/// Renders the full managed document: the header comment block, a blank line, then the composed
/// instruction content exactly as given. Pure string composition; never touches the filesystem.
pub fn render_managed_document(fields: &ManagedHeaderFields, composed_content: &str) -> String {
    let override_line = match &fields.override_version_id {
        Some(id) => id.as_str(),
        None => "null",
    };
    format!(
        "{open}\n\
         format_version: {format_version}\n\
         project_id: {project_id}\n\
         role: {role}\n\
         provider: {provider}\n\
         shared_role_version_id: {shared_role_version_id}\n\
         provider_version_id: {provider_version_id}\n\
         override_version_id: {override_version_id}\n\
         generated_at: {generated_at}\n\
         {close}\n\n\
         {content}",
        open = HEADER_OPEN,
        format_version = fields.format_version,
        project_id = fields.project_id,
        role = fields.role.as_header_str(),
        provider = fields.provider.as_header_str(),
        shared_role_version_id = fields.shared_role_version_id,
        provider_version_id = fields.provider_version_id,
        override_version_id = override_line,
        generated_at = fields.generated_at,
        close = HEADER_CLOSE,
        content = composed_content,
    )
}

/// Outcome of looking for a Hammond managed header at the start of file content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderLookup {
    /// No `<!-- hammond:managed` marker at the start of the (trimmed) content at all.
    NoMarker,
    /// The marker is present but the block could not be parsed into valid fields (missing
    /// closing marker, missing/unknown field, or an unrecognized `format_version`).
    Malformed,
    /// The marker is present and every field parsed into a valid, known value.
    Valid(ManagedHeaderFields),
}

/// Parses a Hammond managed header from the start of `content`, if one is present. Leading
/// whitespace before the marker is tolerated; nothing else about the surrounding content is
/// inspected here (see [`classify`] for the full missing/valid/malformed/unmanaged decision).
pub fn parse_managed_header(content: &str) -> HeaderLookup {
    let trimmed = content.trim_start();
    if !trimmed.starts_with(HEADER_OPEN) {
        return HeaderLookup::NoMarker;
    }
    let Some(close_index) = trimmed.find(HEADER_CLOSE) else {
        return HeaderLookup::Malformed;
    };
    let body = &trimmed[HEADER_OPEN.len()..close_index];

    let mut fields: HashMap<&str, String> = HashMap::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            return HeaderLookup::Malformed;
        };
        fields.insert(key.trim(), value.trim().to_owned());
    }

    let Some(format_version) = fields
        .get("format_version")
        .and_then(|v| v.parse::<u32>().ok())
    else {
        return HeaderLookup::Malformed;
    };
    if format_version != MANAGED_HEADER_FORMAT_VERSION {
        return HeaderLookup::Malformed;
    }
    let Some(project_id) = fields.get("project_id").filter(|v| !v.is_empty()) else {
        return HeaderLookup::Malformed;
    };
    let Some(role) = fields.get("role").and_then(|v| Role::from_header_str(v)) else {
        return HeaderLookup::Malformed;
    };
    let Some(provider) = fields
        .get("provider")
        .and_then(|v| Provider::from_header_str(v))
    else {
        return HeaderLookup::Malformed;
    };
    let Some(shared_role_version_id) = fields
        .get("shared_role_version_id")
        .filter(|v| !v.is_empty())
    else {
        return HeaderLookup::Malformed;
    };
    let Some(provider_version_id) = fields.get("provider_version_id").filter(|v| !v.is_empty())
    else {
        return HeaderLookup::Malformed;
    };
    let Some(override_raw) = fields.get("override_version_id") else {
        return HeaderLookup::Malformed;
    };
    let override_version_id = if override_raw == "null" {
        None
    } else if override_raw.is_empty() {
        return HeaderLookup::Malformed;
    } else {
        Some(override_raw.clone())
    };
    let Some(generated_at) = fields.get("generated_at").filter(|v| !v.is_empty()) else {
        return HeaderLookup::Malformed;
    };

    HeaderLookup::Valid(ManagedHeaderFields {
        format_version,
        project_id: project_id.clone(),
        role,
        provider,
        shared_role_version_id: shared_role_version_id.clone(),
        provider_version_id: provider_version_id.clone(),
        override_version_id,
        generated_at: generated_at.clone(),
    })
}

/// The exact (project, role, provider) identity an operation expects the *current* occupant of
/// its target to carry before treating it as this operation's own content. A valid Hammond
/// header that does not match becomes [`Classification::ManagedForeign`] rather than
/// [`Classification::ManagedValid`] — recording identity in the header is meaningless unless it
/// is actually compared against what the caller expects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedIdentity {
    pub project_id: String,
    pub role: Role,
    pub provider: Provider,
}

/// The five classifications every generated document's target must fall into, per HAM3-006's
/// managed-file ownership rules. `ManagedForeign` is distinct from `ManagedValid`: both carry a
/// structurally valid Hammond header, but a foreign one belongs to a different project and/or
/// role than the operation's own expected identity, and must never be silently overwritten or
/// removed the way a caller's own current document is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Classification {
    Missing,
    ManagedValid(ManagedHeaderFields),
    ManagedForeign(ManagedHeaderFields),
    ManagedMalformed,
    Unmanaged,
}

/// Classifies a target from its current content (or `None` if the target does not exist)
/// against the identity this operation expects to find there. A valid header is `ManagedValid`
/// only when its project, role, and provider all match `expected`; otherwise it is
/// `ManagedForeign`.
pub fn classify(content: Option<&str>, expected: &ExpectedIdentity) -> Classification {
    match content {
        None => Classification::Missing,
        Some(content) => match parse_managed_header(content) {
            HeaderLookup::NoMarker => Classification::Unmanaged,
            HeaderLookup::Malformed => Classification::ManagedMalformed,
            HeaderLookup::Valid(fields) => {
                if fields.project_id == expected.project_id
                    && fields.role == expected.role
                    && fields.provider == expected.provider
                {
                    Classification::ManagedValid(fields)
                } else {
                    Classification::ManagedForeign(fields)
                }
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_fields() -> ManagedHeaderFields {
        ManagedHeaderFields {
            format_version: MANAGED_HEADER_FORMAT_VERSION,
            project_id: "3f9a2b7e-1234-4abc-9def-abcdef123456".to_owned(),
            role: Role::Worker,
            provider: Provider::ClaudeCode,
            shared_role_version_id: "shared-v1".to_owned(),
            provider_version_id: "provider-v1".to_owned(),
            override_version_id: Some("override-v1".to_owned()),
            generated_at: "2026-09-04T16:00:00Z".to_owned(),
        }
    }

    /// The identity `sample_fields()` itself carries — classifying a document rendered from
    /// `sample_fields()` against this expectation is the "this is my own current document" case.
    fn matching_identity() -> ExpectedIdentity {
        let fields = sample_fields();
        ExpectedIdentity {
            project_id: fields.project_id,
            role: fields.role,
            provider: fields.provider,
        }
    }

    fn other_identity() -> ExpectedIdentity {
        ExpectedIdentity {
            project_id: "other-project".to_owned(),
            role: Role::Worker,
            provider: Provider::ClaudeCode,
        }
    }

    #[test]
    fn target_relative_path_matches_each_providers_documented_entry_point() {
        assert_eq!(Provider::Codex.target_relative_path(), "AGENTS.md");
        assert_eq!(Provider::ClaudeCode.target_relative_path(), "CLAUDE.md");
        assert_eq!(
            Provider::KiloCode.target_relative_path(),
            ".kilocode/rules/hammond.md"
        );
    }

    #[test]
    fn the_three_provider_targets_are_pairwise_distinct() {
        let paths = [
            Provider::Codex.target_relative_path(),
            Provider::ClaudeCode.target_relative_path(),
            Provider::KiloCode.target_relative_path(),
        ];
        assert_eq!(paths[0], paths[0]);
        assert_ne!(paths[0], paths[1]);
        assert_ne!(paths[0], paths[2]);
        assert_ne!(paths[1], paths[2]);
    }

    #[test]
    fn round_trips_a_rendered_document_back_into_the_same_header_fields() {
        let fields = sample_fields();
        let document = render_managed_document(&fields, "line one\nline two\n");

        assert!(document.starts_with(HEADER_OPEN));
        match classify(Some(&document), &matching_identity()) {
            Classification::ManagedValid(parsed) => assert_eq!(parsed, fields),
            other => panic!("expected ManagedValid, got {other:?}"),
        }
    }

    #[test]
    fn round_trips_a_null_override_version_id() {
        let mut fields = sample_fields();
        fields.override_version_id = None;
        let document = render_managed_document(&fields, "content");

        match classify(Some(&document), &matching_identity()) {
            Classification::ManagedValid(parsed) => assert_eq!(parsed.override_version_id, None),
            other => panic!("expected ManagedValid, got {other:?}"),
        }
    }

    #[test]
    fn classifies_a_missing_target_as_missing() {
        assert_eq!(
            classify(None, &matching_identity()),
            Classification::Missing
        );
    }

    #[test]
    fn classifies_content_with_no_marker_as_unmanaged() {
        assert_eq!(
            classify(
                Some("# My own instructions\n\nDo not touch."),
                &matching_identity()
            ),
            Classification::Unmanaged
        );
    }

    #[test]
    fn classifies_an_empty_file_as_unmanaged_not_missing() {
        assert_eq!(
            classify(Some(""), &matching_identity()),
            Classification::Unmanaged
        );
    }

    #[test]
    fn classifies_a_marker_with_no_closing_delimiter_as_malformed() {
        assert_eq!(
            classify(
                Some("<!-- hammond:managed\nformat_version: 1\nproject_id: abc"),
                &matching_identity()
            ),
            Classification::ManagedMalformed
        );
    }

    #[test]
    fn classifies_a_marker_missing_a_required_field_as_malformed() {
        let broken = "<!-- hammond:managed\nformat_version: 1\nproject_id: abc\n-->\n\ncontent";
        assert_eq!(
            classify(Some(broken), &matching_identity()),
            Classification::ManagedMalformed
        );
    }

    #[test]
    fn classifies_an_unrecognized_format_version_as_malformed_rather_than_guessing() {
        let fields = sample_fields();
        let document = render_managed_document(&fields, "content").replacen(
            "format_version: 1",
            "format_version: 999",
            1,
        );
        assert_eq!(
            classify(Some(&document), &matching_identity()),
            Classification::ManagedMalformed
        );
    }

    #[test]
    fn classifies_an_unrecognized_role_or_provider_value_as_malformed() {
        let fields = sample_fields();
        let document = render_managed_document(&fields, "content").replacen(
            "role: worker",
            "role: reviewer",
            1,
        );
        assert_eq!(
            classify(Some(&document), &matching_identity()),
            Classification::ManagedMalformed
        );

        let fields = sample_fields();
        let document = render_managed_document(&fields, "content").replacen(
            "provider: claude_code",
            "provider: cursor",
            1,
        );
        assert_eq!(
            classify(Some(&document), &matching_identity()),
            Classification::ManagedMalformed
        );
    }

    #[test]
    fn tolerates_leading_whitespace_before_the_marker() {
        let fields = sample_fields();
        let document = format!("\n\n  {}", render_managed_document(&fields, "content"));
        match classify(Some(&document), &matching_identity()) {
            Classification::ManagedValid(_) => {}
            other => panic!("expected ManagedValid, got {other:?}"),
        }
    }

    // ---------------------------------------------------------------------
    // Correction 1: managed identity is enforced, not merely recorded.
    // ---------------------------------------------------------------------

    #[test]
    fn classifies_a_valid_header_for_a_different_project_as_foreign_not_valid() {
        let fields = sample_fields();
        let document = render_managed_document(&fields, "content");

        match classify(Some(&document), &other_identity()) {
            Classification::ManagedForeign(parsed) => assert_eq!(parsed, fields),
            other => panic!("expected ManagedForeign, got {other:?}"),
        }
    }

    #[test]
    fn classifies_a_valid_header_for_a_different_role_as_foreign_not_valid() {
        let fields = sample_fields();
        let document = render_managed_document(&fields, "content");
        let mut expected = matching_identity();
        expected.role = Role::Orchestrator;

        match classify(Some(&document), &expected) {
            Classification::ManagedForeign(parsed) => assert_eq!(parsed, fields),
            other => panic!("expected ManagedForeign, got {other:?}"),
        }
    }

    #[test]
    fn classifies_a_valid_header_for_a_different_provider_as_foreign_not_valid() {
        let fields = sample_fields();
        let document = render_managed_document(&fields, "content");
        let mut expected = matching_identity();
        expected.provider = Provider::Codex;

        match classify(Some(&document), &expected) {
            Classification::ManagedForeign(parsed) => assert_eq!(parsed, fields),
            other => panic!("expected ManagedForeign, got {other:?}"),
        }
    }

    #[test]
    fn a_matching_identity_on_every_field_is_the_only_way_to_get_managed_valid() {
        let fields = sample_fields();
        let document = render_managed_document(&fields, "content");

        // Sanity: the exact same identity the document was rendered for is Valid...
        assert!(matches!(
            classify(Some(&document), &matching_identity()),
            Classification::ManagedValid(_)
        ));
        // ...but any single mismatched field alone demotes it to Foreign.
        assert!(matches!(
            classify(Some(&document), &other_identity()),
            Classification::ManagedForeign(_)
        ));
    }
}

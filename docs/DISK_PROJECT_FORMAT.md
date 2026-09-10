# Disk-only project memory — D-024

Status: CANCELLED by D-025. Historical proposal only; do not implement or dispatch. This contract supersedes the Supabase/native-MCP/Docker runtime architecture for HAM3-014. Hammond is a native visual editor for files inside a directory; agents use their existing filesystem tools. No MCP, Docker, backend login or network connection is required for normal operation.

## Source of truth and format

Use a `.hammond/` directory beneath the directory explicitly opened by the owner. It is portable project content, suitable for optional Git tracking, not a cache. Never implicitly initialize or overwrite an existing directory. Use UTF-8, deterministic formatting and a schema version; reject unsupported future versions without rewriting them.

Proposed version-1 layout, to finalize in the worker's committed schema documentation and fixtures:

- `project.json`: schema version, stable project ID, name and project metadata; no absolute machine paths or credentials.
- `tasks/<stable-id>.md`: one task per file, validated YAML front matter for ID, parent ID, status, ordering and other supported fields, Markdown body for description. IDs are immutable; filenames do not depend on titles. Preserve existing task fields and hierarchy semantics.
- `comments/<task-id>/<comment-id>.md`: individual stable comment records, front matter for timestamps/metadata and Markdown body. Independent files avoid rewriting another comment on append.
- `relations/<id>.json`: only relations already supported by the app or present in migrated data; no cancelled tracker expansion.
- `instructions/catalog.json`: stable template IDs, role/provider/project layer, seeded/owner provenance, selected active version references and composition-format version.
- `instructions/versions/<template-id>/<version-id>.md`: immutable saved instruction content. Store version identity/metadata explicitly. Editing through Hammond creates a new version; detect direct changes to an existing historical version and report history corruption rather than quietly relabeling it.
- `selections.json` and `assignments.json`: saved project instruction selection and harness/provider assignments using stable references. Scope and precedence must match the existing application. Saved effective composition is reproducible from these records, with exact source/version provenance. Task context is distinct from instructions.
- `README.md`: compact human/agent instructions for editing the format safely. Read-only schema definitions and valid examples ship with the application and format documentation.

Worker may refine file boundaries before coding to preserve actual existing fields, but must deliver an explicit complete schema and examples, not another authentication preflight. Shared-role/provider instructions needed by a project are stored within that project; no hidden dependency on a cloud or another directory. New projects receive bundled seeds. Cross-project automatic propagation is out of scope. Export includes every referenced shared/provider version and required history.

Local application settings contain recent directories, machine paths and navigation preferences only. A search index may be rebuildable; it must never be authoritative. Moving/copying a project preserves data and IDs. Separate worktrees are separate snapshots, not an automatic synchronization service. Detect ambiguous duplicate project IDs in recent-directory mappings without silently merging them. Git is optional; Hammond does not run Git or require a repository.

## Reads, writes and external changes

Read the directory on opening and reconcile on focus/resume. Watch file changes while open, debounce/coalesce events and rescan after watcher overflow, loss or reconnect. Watchers are hints, not durable event history. Ignore stale asynchronous reads after directory/selection changes. Validate restored IDs against current records.

Keep unsaved drafts separate from the confirmed disk snapshot. Use a content fingerprint from the file actually read, not a revision number agents are expected to increment. A changed fingerprint blocks stale saves and offers explicit reload/compare/reapply. Protect local drafts, task selection and pending creates during external updates. Malformed/partial files retain an explicitly stale last-valid display where useful, with a precise file/error location; never silently normalize invalid agent content or overwrite it on the next UI save.

Use same-directory temporary files and platform-appropriate atomic replacement for Hammond writes, with recoverable last-good data for destructive edits. Never claim that atomic rename prevents lost updates from arbitrary noncooperating writers. Define and document a cooperative lock/write protocol for Hammond-aware writers, and the residual race for arbitrary editors between fingerprint check and replacement; preserve recoverable content and detect divergence where possible. No hard protection can be promised against an agent with unrestricted filesystem access. Test two Hammond instances and external-editor scenarios.

Design operations so ordinary task edits and comment creation affect one record. For multi-file operations, especially subtree archive and instruction version-plus-selection changes, use a recoverable journal/staging protocol scoped to `.hammond/`; readers must not present incomplete transactions as committed. Recover after a process crash without discarding unrelated edits. Validate stable references, duplicate IDs, cycles, missing parents, archive semantics and permitted values. External files are data, never executable commands. Render Markdown safely; prevent path traversal and symlink/junction escapes in reads, writes, export and recovery. Owner-selected project root is the authority boundary.

Statuses remain editable through existing owner UI rules. Agent status guidance is a file convention, not an enforceable identity boundary: agents with filesystem access can edit files. Do not rebuild OAuth/grants or pretend to distinguish owner versus agent using editable metadata.

## Supabase transition and data preservation

Normal runtime must use the disk repository without Supabase environment variables, sessions or services. Replace repository adapters, not the existing useful task/instruction UI wholesale. Preserve native directory selection and managed harness injection.

Provide a separate explicit one-time export path for an existing authenticated Supabase owner. It is optional migration tooling, not an app startup dependency. Use supported owner-scoped reads; no service-role key or credential export. Implement against fixtures first. Do not read/export actual owner records until the owner starts the concrete migration flow.

Export to a new staging destination, never an existing project overwrite. Preserve IDs, timestamps, descriptions/comments, hierarchy/relations, archive/status values, instruction templates and versions/history, provenance, selections and assignments. Exclude credentials, cloud sessions and obsolete MCP grants. Enumerate legacy fields; preserve unsupported legitimate data in a documented lossless migration record rather than silently dropping it. Include reference validation, record counts and content hashes in a manifest. Verify by reloading the exported files through the disk adapter and comparing logical records and effective instruction output with the source snapshot. Detect source changes during multi-query export and retry/fail clearly; do not claim a consistent snapshot from unrelated paginated reads.

Promote the verified staging result only after a clear completion report. Failed/interrupted export leaves the source untouched and staged output identifiable. Keep Supabase data and configuration intact; no automatic hosted migration/deletion, cloud synchronization or production write-back. Existing directories can be adopted or a new disk project created without any migration or login.

## Acceptance and delivery slices

1. Publish format/schema fixtures and an environment-neutral repository interface; implement native safe reading/writing/validation and disk adapters. Demonstrate project/task/comment round trip and all instruction scopes without a network.
2. Wire existing task hierarchy, instruction studio, assignments and directory resume to disk. Implement authoritative startup/focus/watch reconciliation, draft conflicts and recovery.
3. Add optional verified export with fixture round-trip, source-change/error/interruption tests and an owner migration runbook. No actual hosted changes.
4. Remove mandatory Supabase startup/auth and obsolete agent-service product flows. Update installer/setup docs and provide fresh independent review plus native Windows owner smoke.

Required tests: no-network startup without Supabase config; agent edits while app closed visible after opening; edits while open refresh automatically; unsaved draft preserved; malformed file recovery; duplicate IDs/cycles; archives; concurrent saves; crash during multi-file operation; directory switch and copied/moved project; scoped effective instructions and historical versions; injection parity; export record/history/content parity. Fresh packaged Windows install opens and creates disk projects with no login. An agent demonstrates direct reads and task/comment file edits while Hammond is closed, then the app shows them correctly.

Non-scope: MCP/HTTP service, Docker, OAuth, remote collaboration, background cloud sync, database deletion, mandatory Git, general offline replication, provider launching, and cancelled HAM3-009/010/011 product features. Export is newly authorized migration scope, not revival of the cancelled tracker expansion.

# Agent access (HAM3-014)

Status: implemented per D-022's bundled stdio/named-pipe transport boundary. This document
describes the architecture, tool contract, and — explicitly — what has and has not been verified
on real Windows.

## What this is

Agent access lets a local MCP host (an agent you run — Claude Code, Codex, another MCP client)
read one Hammond project's context, tasks, and saved instructions, and optionally create tasks,
update ordinary task statuses, and add comments — while Hammond is running, signed in, and the
owner has explicitly enabled it for that project.

It is **not** a remote or headless service, a second login, or a browser-reachable server. Per
D-001/D-022, Hammond never runs an HTTP listener for this. The only transport is a Windows named
pipe, restricted to the current Windows account, between a small bundled companion process and the
running Hammond app.

```text
Agent host (Claude Code, Codex, ...)
  -> hammond-mcp-companion (stdio, MCP JSON-RPC 2.0)
    -> authenticated Windows named pipe (\\.\pipe\hammond-agent-<profile-id>)
      -> Hammond's native command facade (Rust, src-tauri/src/agent_access/)
        -> one Tauri event, relayed to the SAME frontend the UI itself uses
          -> src/agentAccess/facade.ts, over the owner's live Supabase session (RLS-scoped)
```

Two things worth being explicit about, since they are easy to get wrong by analogy with other
bridge architectures Hammond has previously removed:

- **Rust never gains a second database implementation.** The named-pipe server only relays a
  validated, permission-checked request description (tool name, arguments, the connection's bound
  project id and permission) to the frontend via a Tauri event, and waits for
  `agent_access_respond`. The frontend executes it with `TrackerServices` — the exact same
  `InstructionsService`, `AssignmentsService`, and repositories the UI uses, under the exact same
  owner session and RLS policies. There is no parallel prompt composer and no privileged database
  credential anywhere in this path.
- **The companion never sees the owner's Supabase session.** It only ever holds an opaque
  per-connection credential (a random token, not a password or JWT) and relays typed tool
  calls/results over the pipe. It cannot read or write Supabase directly.

## Trust boundary

- The pipe server validates the connecting client's opaque credential (constant-time compared)
  against the single active `AgentAccessProfile` before accepting any call, and rejects/ignores a
  call whose generation doesn't match the profile's current generation (see "Connections and
  generations" below).
- The frontend facade handler (`src/agentAccess/facadeHandler.ts`) independently re-checks the
  connection's generation and the current signed-in owner before executing anything — it does not
  trust the pipe server's own validation as sufficient on its own.
- Every tool that takes a task id or instruction version id re-validates that the id belongs to
  the connection's bound **project**, not just the caller's own owner (RLS already confines every
  query to the signed-in owner, but never to one specific project among that owner's several).
- The caller-supplied `provider` for `get_instructions` and similar chooses which instruction
  _content_ to read, never a write permission or an owner/project override — that always comes
  from the connection.

## Connections and generations

Enabling agent access for a project (`AgentAccessPanel` in Settings, or the equivalent Tauri
commands) mints one `AgentAccessProfile`: an opaque `profileId` and `secret`, a per-profile named
pipe name, the bound `projectId`/`projectName`/`permission`, and a `generation` starting at 1.

- **Revoke connection** bumps the generation without changing the project/permission choice or the
  pipe name. Every already-open pipe connection is invalidated (the next call on it gets an
  `invalidated` response and the connection is closed); every request already relayed to the
  frontend under the old generation is dropped rather than answered.
- **Disable** clears the profile entirely and stops the pipe listener.
- **Sign-out** and **app restart** both invalidate every live connection the same way — there is no
  profile to validate against once signed out, and a restart mints a fresh in-memory core with no
  profile until the owner re-enables it. The profile file persisted to disk is not re-loaded and
  treated as "still enabled" on app start today; the owner must explicitly re-enable agent access
  each time Hammond restarts. (A future version could re-load and re-validate the persisted
  profile on startup instead — deliberately not done here, to keep the first version's enable/
  disable state obviously in sync with what the settings panel shows.)

## Tool contract

All 9 tools are always advertised via `tools/list`; permission is enforced at call time, not by
hiding tools:

| Tool                        | Access | Notes                                                                                                                            |
| --------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `get_project_context`       | read   | Project summary, full task-status enum, role/provider assignments, permitted operations, bounded recent-task summary.            |
| `list_tasks`                | read   | Optional `parentTaskId`/`status`/`includeArchived` filters, cursor pagination.                                                   |
| `get_task`                  | read   | Persisted fields + revision, parent, paginated children, all comments.                                                           |
| `get_instructions`          | read   | See "Instruction scope" below.                                                                                                   |
| `list_instruction_versions` | read   | Authorized version history for one scoped template, cursor pagination, active-version marker.                                    |
| `get_instruction_version`   | read   | One immutable version's content and provenance.                                                                                  |
| `create_task`               | write  | Starts in `backlog`; optional `parentTaskId` (validated same-project, not archived).                                             |
| `update_task`               | write  | title/description/status only; requires `expectedRevision`. Owner-only statuses (`merged`, `shipped`, `cancelled`) are rejected. |
| `add_comment`               | write  | Appends one durable comment.                                                                                                     |

Every write tool takes a caller-chosen `requestId` and is durably deduplicated server-side (see
"Writes and concurrency"). `update_task` additionally requires `expectedRevision` — the revision
the caller last read — and fails with a `revision_conflict` error (carrying the current row) if
it's stale.

Reparenting, archiving, and deleting a task are **not** exposed as MCP tools in this version, even
though the underlying `tasks_update_checked` RPC can reparent (the desktop UI's own "Parent task"
field uses that capability) — the facade's `update_task` tool simply never sets that RPC's
`change_parent` flag.

## Instruction scope

`get_instructions` reuses `InstructionsService.resolveActiveVersionIds` and `composeInstructions`
exactly — the same functions Instruction Studio itself calls — so MCP and Studio can never
disagree about what "the effective saved content" is for a given project/role/provider/selection.

- **Role** is required; **provider** is optional — omitted, it resolves via
  `AssignmentsService.getAssignment` and the response's `assignmentSource` is
  `"assignment_derived"`. Supplied explicitly, `assignmentSource` is `"explicit"`, and if it
  differs from the project's actual assignment for that role, `assignmentMismatch` reports both
  values rather than silently substituting one for the other.
- **Layers** (`shared_role`, `provider`, `project_override`) are each reported with their template
  id, version id, version number, `source` (`"base"` | `"owner"` | `"absent"`), and content.
  `source: "absent"` applies only to `project_override` — no version is selected for it at all —
  and is distinct from a selected version whose content happens to be the empty string (`source:
"owner"`, `content: ""`).
- **Task context**, when a same-project `taskId` is supplied, comes back in a separate
  `taskContext` field with `taskInstructionScope: "not_supported"` — task text is never folded into
  `effectiveContent` or reported as a durable instruction layer, since no such scope exists today.
- **Selection races**: the three layer ids are re-resolved after fetching their content; if they
  changed mid-read, the call retries (bounded) and ultimately reports a `context_changed` error
  rather than ever mixing ids from one selection with content from another.
- A referenced version that cannot be found is a `missing_reference` error, never silently treated
  as empty content.

## Writes and persistence

`supabase/migrations/20260909070000_task_revision_and_agent_writes.sql` adds what both the desktop
UI and MCP writes now share:

- `tasks.revision`, an integer bumped by an unconditional `before update` trigger — every task
  update, through any path (a checked RPC or a plain `.update()`), advances it by exactly 1.
- `tasks_create_checked`, `tasks_update_checked`, `tasks_archive_subtree_checked`, and
  `comments_add_checked`: `SECURITY INVOKER` RPCs (same RLS/grants a direct client write already
  goes through) that add the expected-revision check (a stale value raises the standard "could not
  serialize" SQLSTATE `40001`) and durable request-id deduplication via `agent_request_log` — the
  same `(request_id, payload_hash)` replays the original result; the same id with a different
  payload is rejected (`22023`).
- A per-project advisory lock (`pg_advisory_xact_lock`, the same pattern
  `instructions_save_and_activate` already uses) serializes every hierarchy-affecting operation —
  `tasks_create_checked` when given a parent, `tasks_archive_subtree_checked`, and
  `tasks_update_checked` when reparenting. Whichever transaction acquires the lock first runs its
  entire check-then-mutate sequence to completion before the other even starts evaluating, so a UI
  archive of an ancestor and a concurrent agent create of a new child can never interleave into an
  active child left under an archived parent — verified with a real two-session Postgres race (see
  Verification status).

`TaskRepository.create/update/archive` and `ProjectMemoryRepository.addComment` route through
these RPCs. A stale `expectedRevision` surfaces to the frontend as `TaskRevisionConflictError`;
`TrackerPage`'s save/move/archive handlers catch it, refetch the current row (updating the save
coordinator's `confirmed` state so a follow-up attempt checks against the fresh revision), and
leave the owner's open draft completely untouched — "reload, then reapply" rather than an
automatic, silent retry.

## Setup

1. In Hammond, open a project, go to its **Agent access** panel (next to directory contexts), pick
   **read-only** or **read + task write**, and enable it.
2. Copy the launch configuration. `command` is resolved at the time you open the panel — via
   Tauri's own resource resolver (`BaseDirectory::Resource`, the documented API for locating a
   file `externalBin` staged into the installed app; see "Packaging" below), falling back to the
   directory next to Hammond's own executable if that ever errors — so it points at wherever this
   install actually placed the companion, not a guess. It contains only an opaque `profileId` —
   never the connection secret — as `args`:
   ```json
   {
     "mcpServers": {
       "hammond": {
         "command": "<resolved path>\\hammond-mcp-companion.exe",
         "args": ["--profile", "<profileId>"]
       }
     }
   }
   ```
3. Paste it into your MCP host's server configuration and connect. The host will see all 9 tools;
   write tools return `permission_denied` on a read-only connection.
4. **Give your agent host's system prompt one instruction:** _fetch `get_instructions` for your
   role before acting, and re-fetch it if a call reports a selection change._ Hammond composing
   correct instructions does not by itself make a model follow them — that has to be part of the
   host's own setup, the same way it already is for the file-injected `CLAUDE.md`/`AGENTS.md`
   adapters.

Revoking or disabling in the panel takes effect immediately; the companion surfaces this as a
clear `invalidated`/`app_unavailable` tool error rather than hanging or silently retrying forever.

## Errors

Every tool error is `{ code, message }`. Stable codes in use today: `invalid_params`,
`not_found`, `missing_assignment`, `missing_reference`, `context_changed`, `permission_denied`,
`invalid_status`, `revision_conflict` (carries `data.currentTask`), `unknown_tool`,
`resource_exhausted`, `host_unavailable`, `invalidated`, `signed_out`, `internal_error`,
`write_failed`.

## Verification status

Real, not simulated, evidence exists for:

- **Protocol/facade correctness** (Rust): 34 tests in `hammond-agent-access` (the shared crate —
  see "Packaging" below) exercise the handshake, permission/generation checks, and call loop
  directly against `tokio::io::duplex()` — no OS pipe, no mock objects standing in for real async
  I/O.
- **The `cfg(windows)` named-pipe code, including the SDDL security-descriptor FFI**, compiles
  clean for the `x86_64-pc-windows-gnu` target, cross-compiled from this Linux environment (a
  genuine, if partial, substitute for a Windows host) — this caught and fixed a real `HLOCAL` type
  mismatch before it could ever reach a Windows build. The same cross-compile also builds a real
  PE32+ `hammond-mcp-companion.exe` end to end through the packaging path below.
- **Facade logic** (TypeScript): 25 tests cover permission checks, cross-project scoping,
  pagination, every instruction-provenance combination (base/owner/absent, explicit vs.
  assignment-derived provider, mismatch reporting, selected-empty vs. absent override), and
  revision-conflict mapping.
- **Companion packaging is wired and verified, not just configured.** `hammond-mcp-companion` is
  its own Cargo package (`src-tauri/crates/companion`, workspace member, no `tauri` dependency),
  sharing protocol/state code with the app through `hammond-agent-access`
  (`src-tauri/crates/agent-access` — everything `commands.rs` doesn't own). `build.rs` builds and
  stages it into `binaries/hammond-mcp-companion-<target-triple>[.exe]` — the exact name
  `tauri.conf.json`'s `externalBin: ["binaries/hammond-mcp-companion"]` expects — into a
  target-dir separate from the outer build's own (a shared one deadlocks: the nested `cargo build`
  would block on a lock the outer build cannot release until `build.rs` returns) *before*
  `tauri_build::build()`'s own eager path validation runs, closing the ordering gap a prior round
  of this delivery hit and reverted. Evidence this actually works, not just that it's plausible:
  a real, from-clean `cargo check`/`cargo build`/`cargo clippy` (workspace and
  `x86_64-pc-windows-gnu` cross-target) succeed with no prior manual step and produce the
  correctly-named staged binary (confirmed a genuine PE32+ Windows executable, not just a
  same-named stub, for the cross target); an automated regression test
  (`src-tauri/tests/companion_sidecar_packaging.rs`) wipes the staged artifact, runs a real nested
  `cargo check`, and asserts it reappears; and the failure path was manually reproduced once (a
  deliberately broken companion source file made `cargo check` fail loudly at `build.rs:58` with
  exit code 101 and a clear message, then was restored and reverified clean) rather than assumed.
  `launch_config_for`'s copied command now resolves through Tauri's own `BaseDirectory::Resource`
  resolver instead of a hand-derived path, with unit tests pinning that a directory containing a
  space (a real Windows `Program Files` install path) round-trips through the JSON config exactly.
- **Database migration correctness and concurrency**: `supabase start` was attempted fresh in this
  round after actually getting the Docker daemon running in this sandbox (it does start; only the
  init script that would normally launch it at boot fails here). It still cannot complete, but on a
  *different* gate than previously found: the outbound proxy now permits the registry/CDN hosts it
  previously rejected outright, but Docker Hub's own anonymous-pull rate limit returns `429 Too
  Many Requests` for the Supabase images, and the signed CDN blob URLs it falls back to return
  `Forbidden` — both confirmed from `supabase start`'s own output, not assumed. `supabase gen
  types`/`db reset`/`test db --local` all depend on the same local stack and so share this gate.
  This is unchanged since the prior round: native PostgreSQL 16 + pgTAP with a hand-built shim
  reproducing Supabase's `auth.uid()`/`auth.role()`/RLS environment closely enough to apply all
  five real migrations unmodified — 20 pgTAP assertions
  (`supabase/tests/task_revision_and_agent_writes.test.sql`) plus a genuine two-`psql`-session race
  (one session holds the **project-scoped** hierarchy advisory lock — `pg_advisory_xact_lock` keyed
  on `project_id`, serializing every hierarchy-affecting write for that project, not just the one
  subtree — for 3 seconds mid-archive while the other concurrently attempts a create under the same
  parent; the second call measurably blocks for the remaining ~2.3 seconds, then correctly sees the
  parent as archived) — not just sequential assertions. The existing 4 pgTAP files (86 assertions)
  still pass unmodified against the new schema. `src/data/database.types.ts` is hand-extended to
  match the migration exactly, since `supabase gen types` also needs Docker; **this still needs a
  real `supabase gen types` run once Docker/Supabase CLI access is available**, to catch any drift
  between the hand-written types and what the CLI would actually generate. Postgres 17 (this
  project's configured version) vs. the 16 available via apt in this sandbox is also unverified as
  a source of behavioral difference, though nothing this migration uses (`plpgsql`, advisory locks,
  standard triggers, `jsonb`) is version-sensitive across 13–17.
- **Full existing test suites still pass**: 427 frontend tests (unchanged this round), 119 Rust
  tests across the workspace (84 in `hammond_lib`, 34 in `hammond-agent-access`, 1 packaging
  integration test — up from 115 total in the prior round, split across the new crate boundary),
  `cargo clippy`/`cargo fmt`/`eslint`/`prettier` clean, `npm run build` and
  `cargo build`/`cargo check` (native + Windows cross-target) all succeed.

**Not verified — explicitly pending a real Windows host, disclosed rather than assumed:**

- The named pipe has never accepted a real connection; the SDDL ACL has never been checked against
  an actual second Windows account being refused.
- The companion binary has never run for real, including its own named-pipe **client** connect
  path and its `LOCALAPPDATA`-based profile-file lookup.
- No packaged Windows build (installer or otherwise) has been produced or installed — `cargo
  tauri build`/`tauri build` itself (the step that would invoke NSIS/WiX and produce an
  installable `.exe`/`.msi`) has not been run in this environment, only the `cargo
  check`/`build`/`clippy` steps that share its build script. The companion sidecar's *inclusion*
  in that bundle is wired and verified per "Verification status" above; the installer step around
  it is not.
- `npm run companion:build` builds the companion standalone (`cargo build --release --package
  hammond-mcp-companion`) for manual local testing outside a full app build; it is not needed for
  packaging, which `build.rs` now does automatically.
- A real MCP host (Claude Desktop, Codex, etc.) has never connected to the packaged companion end
  to end. The MCP JSON-RPC message shapes (`initialize`, `tools/list`, `tools/call`) follow the
  2024-11-05 protocol revision and are unit-tested for their pure logic, but the actual stdio
  transport has not been exercised against a real host process.
- The owner smoke sequence in the original work order (enable read-only, connect a real host,
  compare against Studio, enable task-write, create a task, edit both sides for a real conflict,
  restart/reconnect, revoke) has not been run — it requires the Windows environment above.

## Non-scope (unchanged from the original plan)

Instruction editing/restoration/activation through MCP; task-instruction storage; work-order/report
forms; SHA approval automation; arbitrary filesystem or SQL access; harness injection; agent
launching; remote/cloud MCP; headless service; project deletion/creation; task
reparent/archive/delete tools; full activity/search/board/export expansion; multi-user
collaboration.

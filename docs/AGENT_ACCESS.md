# Agent access: local API and MCP (HAM3-015)

This is an owner-authorized exception to Hammond's usual "no filesystem/shell tools for agents"
posture (see `docs/MODULE_BOUNDARIES.md`): a loopback-only HTTP API and a bundled stdio MCP
adapter that let a signed-in owner's local coding-agent harness (Codex, Claude Code, Kilo Code, or
any MCP-compatible client) read and act on their own Hammond workspace — projects, tasks,
comments, instructions, assignments, local directory bindings, and harness documents — without
navigating the UI.

Both surfaces are transports over **one** allowlisted operation registry
(`src/agentAccess/registry.ts`). Neither implements Hammond domain behavior a second time: the
HTTP layer authenticates and forwards; the MCP adapter is a thin HTTP client.

## Contents

- [Architecture](#architecture)
- [Security model](#security-model)
- [HTTP contract](#http-contract)
- [Operation coverage](#operation-coverage)
- [Pagination](#pagination)
- [The prepare/inject contract](#the-prepareinject-contract)
- [Token setup, rotation, revocation](#token-setup-rotation-revocation)
- [Building and running the MCP adapter](#building-and-running-the-mcp-adapter)
- [Harness setup: Codex, Claude Code, Kilo Code](#harness-setup)
- [Harness instruction snippet](#harness-instruction-snippet)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)

## Architecture

```
 Codex / Claude Code / Kilo Code (or any MCP client)
            │ stdio (JSON-RPC / MCP)
            ▼
   mcp/dist/hammond-mcp(.mjs|.exe)      <- thin adapter, no domain logic
            │ HTTP (127.0.0.1 only, bearer token)
            ▼
   Rust: src-tauri/src/agent_access/*   <- auth, Host/Origin checks, size/timeout/concurrency limits
            │ Tauri event  "agent-access://request"  (correlated by request id)
            ▼
   Webview: src/agentAccess/bridge.ts   <- listens, dispatches into the registry
            │
            ▼
   src/agentAccess/registry.ts          <- the ONE typed, allowlisted operation catalog
            │
            ▼
   Existing services/repositories (InstructionsService, AssignmentsService,
   HarnessInjectionService, DirectoryContextManager, ProjectRepository, TaskRepository,
   ProjectMemoryRepository) — the exact same instances (or, for the three raw repositories,
   fresh instances over the one shared Supabase session) the UI already uses.
```

Rust never executes a Hammond domain operation itself. A `#[tauri::command]` (here,
`agent_access_respond`) can only be invoked from script running inside this application's own
webview — no external process can call it — so a response is trusted precisely because there is no
other caller who could have sent it.

`createDefaultServices()` (`src/services/appServices.ts`) is constructed once per app session and
shared by the UI and the agent-access dispatcher; `useAgentAccessBridge` (`src/agentAccess/bridge.ts`)
is mounted unconditionally at the top of `App` — independent of whether the Auth or Tracker screen
is showing — so the API is live the moment Hammond is running and signed in, with no click
required. The shared `DirectoryContextManager` instance (`getSharedDirectoryContextManager`,
keyed on the `directoryContext` services object's identity) is what keeps a local-context write
made through the API from racing a concurrent UI-driven one: both paths mutate the same
in-memory/on-disk state through the same manager, and every mutation notifies subscribers
synchronously, so the UI (via `useDirectoryContextState`) sees an API-driven change immediately.

## Security model

- The HTTP listener binds to `127.0.0.1` on an OS-assigned ephemeral port only — never a fixed
  port (so two launches, or a stale process after a crash, never collide or need anything killed)
  and never a LAN/public interface.
- Every request must carry `Authorization: Bearer <token>` matching the token in the local
  credentials file, compared in constant time. A missing/rotated/revoked token is refused before
  the request is ever forwarded to the webview or Supabase — auth happens per-request in Rust, not
  only once at MCP process startup.
- `Host` must match `127.0.0.1:<port>` or `localhost:<port>` exactly. Any `Origin` header at all
  (a browser-context request) is refused outright — this API has exactly one legitimate class of
  client (a local process making plain HTTP requests), so there is no allowlist to maintain and no
  wildcard CORS anywhere.
- Request bodies are capped at 256 KiB, concurrency at 8 in-flight requests, and every request at
  30 seconds server-side (`tower_http::timeout`), independent of the ~25s Rust↔webview bridge
  timeout underneath it.
- **A credential grants the same supported owner-level operations the signed-in owner already has
  through the UI. It is not a new, narrower authorization system** — there are no per-operation
  roles or scopes. Treat the token like a password.
- The credentials file (`agent-access-credentials.json`, under Hammond's app-local-data
  directory) is written with `0600` permissions on Unix; on Windows it inherits the per-user ACL
  already applied to `%LOCALAPPDATA%\<app>` by the OS. Neither the token nor a Supabase session
  ever appears in a repository config example or in any log/tool output this feature produces.
- Sign-out sets Rust's tracked readiness to `SignedOut` so **no new** request is forwarded, and
  drains every request the webview was still working on. A request that had **not** started yet
  (checked at receipt, before dispatch) is refused with an ordinary signed-out error — safe to
  treat as "did not run". A request **already dispatched** to the webview cannot be cancelled:
  its mutation may have committed. Those are drained as `unknown_outcome` (HTTP 504), carrying
  the request id, telling the caller to re-read the affected record rather than retry — never
  reported as "did not execute". A handler that finished before sign-out landed reports its real
  result.
- The webview reports both its sign-in state and whether its request listener is attached. Rust
  forwards a request only while a listener is attached, so a request arriving in the brief
  startup window (readiness published a beat before the listener registered) or after the window
  tears down gets a retryable `503 starting`, never a dispatch into nothing.
- If the local API cannot start at all (port bind or credential-file failure), Hammond installs a
  safe **disabled** state instead of leaving it uninitialized: every request is refused, the
  Settings panel shows the reason, and no native command can crash on unmanaged state.
- No arbitrary filesystem, shell, SQL, native-invoke, password, or auth-session tool is exposed.
  Directory access is limited to the same confined `fs_guard`-protected commands the UI already
  uses, addressed by explicit path, never a "run this shell command" primitive.

## HTTP contract

```
GET  /v1/operations                  -> { "result": { "operations": [ { name, description, inputSchema } ] } }
POST /v1/operations/{name}           <- JSON body = the operation's input
                                      -> 200 { "result": <output> }
                                      -> non-200 { "error": { "code", "message", "details"? } }
```

Status codes: `400` validation/bad JSON or a malformed continuation cursor, `401` invalid/missing
token, `403` wrong Host/Origin or a revoked token, `404` unknown operation or (for `not_found`) a
missing/foreign record, `409` conflict/stale-preview/requires-confirmation, `503`
starting/signed-out (including "window not ready to serve yet"), `504` `unknown_outcome` (the
bridge timed out **or** a sign-out/window-teardown drained an already-dispatched request — the
operation's effect is unknown; **never retried automatically**, and callers should recheck the
affected record rather than resend the same mutation).

Continuation cursors are opaque `"<created_at>::<id>"` markers; a cursor whose halves are not a
valid ISO-8601 timestamp and a UUID is rejected with `400 validation_error` before it reaches the
query layer.

Example (`curl`, once you have a token — see below):

```sh
TOKEN=<from the Settings panel>
PORT=<from the same panel, or the credentials file>
curl -s http://127.0.0.1:$PORT/v1/operations \
  -H "Authorization: Bearer $TOKEN"

curl -s http://127.0.0.1:$PORT/v1/operations/projects.list \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"limit": 20}'
```

## Operation coverage

Every operation below is available identically over HTTP and MCP (the MCP tool name is the same
string, e.g. `projects.list`). "UI action" is the closest existing Hammond UI capability; a
purely visual action (opening a panel, expanding a tree row) has no API entry by design.

| Area              | Operation                                      | UI equivalent                                                                                                                                                          |
| ----------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects          | `projects.list`                                | Home project list                                                                                                                                                      |
|                   | `projects.get`                                 | Selecting a project                                                                                                                                                    |
|                   | `projects.create`                              | "New project"                                                                                                                                                          |
|                   | `projects.update`                              | Edit project                                                                                                                                                           |
|                   | `projects.archive`                             | Archive project                                                                                                                                                        |
|                   | `projects.delete`                              | Delete project                                                                                                                                                         |
| Tasks             | `tasks.list`                                   | Workspace task tree                                                                                                                                                    |
|                   | `tasks.get`                                    | Selecting a task                                                                                                                                                       |
|                   | `tasks.create`                                 | "New task" (incl. nesting)                                                                                                                                             |
|                   | `tasks.update`                                 | Edit task / change status / re-parent / move project                                                                                                                   |
|                   | `tasks.archive`                                | Archive task (+ subtree)                                                                                                                                               |
|                   | `tasks.delete`                                 | Delete task                                                                                                                                                            |
| Comments          | `comments.listForTask`                         | Task comment thread                                                                                                                                                    |
|                   | `comments.get`                                 | (no direct UI equivalent — narrow read added for this feature)                                                                                                         |
|                   | `comments.add`                                 | Add comment                                                                                                                                                            |
|                   | `comments.listRecentForProject`                | Project "recent comments" feed                                                                                                                                         |
| Context           | `context.listRelations`                        | (relations are recorded but not yet browsable in the UI)                                                                                                               |
|                   | `context.addRelation`                          | (no direct UI action yet)                                                                                                                                              |
|                   | `context.listEvidenceForTask`                  | (narrow read added for this feature)                                                                                                                                   |
|                   | `context.addEvidence`                          | (evidence recording exists in the domain, not yet a dedicated UI action)                                                                                               |
|                   | `context.listActivity` / `listActivityForTask` | Project/task activity feed                                                                                                                                             |
|                   | `context.recordActivity`                       | (system-recorded today; exposed for agent-recorded progress notes)                                                                                                     |
|                   | `context.getProjectContext` / `getTaskContext` | Composite convenience reads (project/task + recent comments/evidence/activity/relations in one call) — new, since no single UI screen shows all of this at once either |
| Instructions      | `instructions.listVersions`                    | Instruction Studio history                                                                                                                                             |
|                   | `instructions.getEffective`                    | Instruction Studio effective preview                                                                                                                                   |
|                   | `instructions.getSelection`                    | Instruction Studio active-version display                                                                                                                              |
|                   | `instructions.prepare`                         | Instruction Studio "Save" (save + activate)                                                                                                                            |
|                   | `instructions.restore`                         | Instruction Studio "Restore"                                                                                                                                           |
|                   | `instructions.activateExisting`                | Instruction Studio "Activate this version"                                                                                                                             |
| Assignments       | `assignments.list` / `assignments.get`         | Assignment display                                                                                                                                                     |
|                   | `assignments.update`                           | Change orchestrator/worker/auditor provider                                                                                                                            |
| Local contexts    | `localContexts.list`                           | Directory Context panel list                                                                                                                                           |
|                   | `localContexts.link`                           | "Link directory" (path given explicitly, never from a picker)                                                                                                          |
|                   | `localContexts.replace`                        | "Fix path" recovery action                                                                                                                                             |
|                   | `localContexts.forget`                         | "Forget"                                                                                                                                                               |
|                   | `localContexts.setActive`                      | "Open"/"Change"                                                                                                                                                        |
|                   | `localContexts.resolvePath`                    | (internal resolution logic, exposed as a narrow read)                                                                                                                  |
| Harness documents | `harness.preview`                              | Instruction Studio injection preview / classification badge                                                                                                            |
|                   | `harness.inject`                               | "Inject"/"Update" button                                                                                                                                               |
|                   | `harness.remove`                               | "Remove" button                                                                                                                                                        |
|                   | `harness.import`                               | "Import & replace"                                                                                                                                                     |

Non-goals explicitly kept out (see the packet's Non-scope): no comment full-text search, no
structured agent-author columns, no automatic task-state transitions, no approvals/dispatch
subsystem, no raw SQL/admin access.

## Pagination

Every list-shaped operation (`*.list`, `*.listForTask`, `*.listRecentForProject`,
`context.listActivity`) returns `{ items, nextCursor }`. `nextCursor` is `null` once nothing more
remains; otherwise pass it back as the `cursor` input to continue. Ordering is deterministic —
`(created_at, id)` keyset, `id` breaking ties among rows sharing the exact same timestamp — so a
page boundary landing between two rows saved in the same instant never omits or repeats one
(exercised directly in `src/agentAccess/registry.test.ts`). `limit` defaults to 50, capped at 200.

`context.getProjectContext`/`getTaskContext` embed paginated sub-lists (comments, evidence,
activity) the same way — check each list's own `nextCursor` for truncation rather than assuming
the composite call returned everything.

## The prepare/inject contract

This is the owner's explicit interaction contract (unchanged from the packet, restated here for
the harness side):

1. The user asks for a role or instruction change.
2. The agent calls `instructions.prepare` (or `restore`/`activateExisting`). This **only** writes
   inside Hammond — no `AGENTS.md`/`CLAUDE.md`/`.kilocode` file is touched — and returns the exact
   saved version and its content/provenance. Over MCP, the tool result additionally carries a
   `nextAction` reminder string with the same instruction, since a model reading only the raw JSON
   result (not the tool's static description) still needs the nudge.
3. The agent asks the user, in the conversation: **"Inject now, or leave ready for later?"**
   Nothing in this API can ask that question for the harness — there is no MCP elicitation
   requirement here on purpose. **Silence, elapsed time, or "permission to prepare" is never
   permission to inject.** This is enforced by convention/harness instruction, not by a technical
   gate — the server-side guarantees are narrower and different (see next point).
4. If the user says later (or says nothing), the harness must not call `harness.inject`. Nothing
   changes on disk.
5. Only a separate, explicit request calls `harness.inject`. That call must carry the exact
   `expectedSharedRoleVersionId` / `expectedProviderVersionId` / `expectedOverrideVersionId` /
   `expectedClassificationKind` **and `expectedTargetDigest`** a **fresh** `harness.preview` call
   just returned. `harness.inject` re-previews internally and compares; a mismatch — the prepared
   instructions changed, **or the on-disk target changed in any way, including a hand edit to the
   body of a still-`ManagedValid` file that leaves its classification and versions untouched** —
   refuses the write and returns `stale_preview` with the fresh preview attached instead, never a
   silent overwrite of what changed. `forceReplace` is still required to replace an Unmanaged file
   or one belonging to a different project/role, exactly like the UI. `expectedTargetDigest` is a
   change-detection digest of the current file bytes (`null` for a Missing target), not a consent
   token — a client cannot fabricate agreement by supplying one.

What the server actually enforces: token access, that preparation and injection are two separate
operations (nothing in `instructions.prepare`'s code path can reach a harness file), and the
staleness recheck above (version ids, classification kind, **and target-byte digest**). What it
does **not** enforce: that a human actually answered the inject-now-or-later question — that
boolean, if an agent fabricates one, is not proof of consent.
The harness instruction snippet below exists to close that gap at the conversation layer, since
nothing server-side can.

None of this launches a harness process, transfers a task, switches a running conversation's
model, or rewrites a running conversation's system instructions. A newly-assigned provider (via
`assignments.update`) resolves its **own** selected instruction layers on its next preparation —
nothing here silently reuses the old provider's saved content or deletes its old harness file.

## Token setup, rotation, revocation

Open **Settings** (sidebar) in the running, signed-in Hammond app. The panel shows:

- Enabled/revoked status, the local port, and the token's last-few-characters fingerprint (never
  the full token) at rest.
- **Reveal token** — shows the raw token once, for copying into an MCP client config.
- **Rotate token** — generates a new token immediately; the previous one stops working at once.
  Existing MCP client configs need updating with the new value.
- **Revoke access** — disables the local API entirely (every request refused, regardless of
  token) without discarding the stored token value; a subsequent **Rotate** is what re-enables
  access (with a fresh token).

The token survives an app restart (so a working MCP config keeps working across relaunches); the
port does not (a fresh ephemeral port is chosen every launch) — always read the current port from
Settings or the credentials file rather than hard-coding one.

## Building and running the MCP adapter

The adapter lives in `mcp/` as its own package (separate `package.json`/lockfile from the main
app), so it can be built and distributed independently.

```sh
cd mcp
npm ci
npm run typecheck   # tsc --noEmit
npm test            # node:test — credentials, HTTP client retry/timeout semantics, and a real
                     # MCP SDK protocol integration test (spawns the built bundle, connects a
                     # real Client+StdioClientTransport, lists/calls tools against a genuine
                     # HTTP mock backend)
npm run build        # -> dist/hammond-mcp.mjs (general purpose) and dist/hammond-mcp.cjs (SEA input)
npm run package:sea   # -> dist/hammond-mcp(.exe) — a single, dependency-free native executable
                       #    via Node's Single Executable Application (SEA) feature + postject
npm run verify:sea     # spawns the packaged binary and runs the same real-protocol check against it
```

`package-sea.mjs` is cross-platform: it never shells out and never builds a command string —
every child process is `node <script>` spawned as the exact interpreter running it
(`process.execPath`, which is also the runtime embedded into the produced binary), with `postject`
resolved to its real package entry point rather than invoked via `npx` (a Windows `npx` is the
`npx.cmd` shim, which `execFileSync` cannot launch — the round-1 defect). It embeds whatever Node
is running it; **to update the embedded runtime later, re-run it with a newer Node**. On Windows
`postject` prints `warning: The signature seems corrupted!` — expected and harmless: injecting the
blob invalidates the copied `node.exe`'s Authenticode signature, which a locally-launched adapter
does not need.

### Windows release: one reproducible path

The packaged Windows desktop app bundles `mcp/dist/hammond-mcp.exe` next to its executable. That
bundle resource is declared in `src-tauri/tauri.bundle.windows.conf.json`, which is **not**
auto-merged (its name is deliberately not `tauri.windows.conf.json`) — so a fresh checkout runs
`cargo test` / `cargo clippy` / `tauri dev` / a plain `npm run tauri:build` with no hand-built
adapter binary. The release build applies it explicitly:

```sh
npm ci                       # repo root
npm --prefix mcp ci
npm run package:release      # builds+verifies the adapter, then: tauri build
                             #   --config src-tauri/tauri.bundle.windows.conf.json
```

`npm run package:release` (`scripts/package-release.mjs`) stops with a clear error if the adapter
executable was not produced, and `tauri build` itself fails loudly on the missing bundle resource
— a release can never silently ship without the adapter. The resulting MSI/NSIS installer places
`hammond-desktop.exe` and `hammond-mcp.exe` together in the install root (`C:\Program
Files\Hammond\` for the default MSI).

Whichever entry point you use, none of them depend on the repository's Vite dev server or require
a globally installed Node/TypeScript toolchain on the machine actually running the harness — the
packaged binary embeds its own runtime, and even the plain `dist/hammond-mcp.mjs` needs only a
plain `node` on `PATH`.

## Harness setup

All three configs point at an absolute path to the built adapter (`dist/hammond-mcp.mjs` run with
`node`, or the packaged `dist/hammond-mcp`/`hammond-mcp.exe` run directly) and pass no extra
arguments — the adapter reads its token/port from Hammond's own credentials file automatically,
using Tauri's standard per-platform app-local-data directory for identifier `com.ipat-o.hammond`.
No token is placed in these config files.

**Windows note:** always use an absolute path, and quote it if it contains spaces (e.g. under
`C:\Program Files\Hammond\`) — the JSON examples below already do this. Use `\\` for path
separators inside the JSON string.

### Codex (`~/.codex/config.toml` or project `.codex/config.toml`)

The Windows installer places the standalone adapter next to the app executable in the install
root — `C:\Program Files\Hammond\hammond-mcp.exe` for the default MSI (an all-users install); a
per-user or relocated install puts it under that install's own root instead. Point `command` at
that binary directly, with no arguments:

```toml
[mcp_servers.hammond]
command = "C:\\Program Files\\Hammond\\hammond-mcp.exe"
args = []
# Running from a source checkout instead of the installed app? Use node + the plain bundle:
# command = "node"
# args = ["C:\\path\\to\\hammond\\mcp\\dist\\hammond-mcp.mjs"]
```

### Claude Code (`.mcp.json` at the project root, or `claude mcp add`)

```json
{
  "mcpServers": {
    "hammond": {
      "command": "node",
      "args": ["/absolute/path/to/hammond/mcp/dist/hammond-mcp.mjs"]
    }
  }
}
```

Or via the CLI: `claude mcp add hammond -- node /absolute/path/to/mcp/dist/hammond-mcp.mjs`.

### Kilo Code (MCP settings, `mcp_settings.json` equivalent)

```json
{
  "mcpServers": {
    "hammond": {
      "command": "node",
      "args": ["/absolute/path/to/hammond/mcp/dist/hammond-mcp.mjs"],
      "disabled": false
    }
  }
}
```

Whichever harness you use: **verify it actually launches before trusting the full tool list** —
run `npm run start` inside `mcp/` (or invoke the packaged binary directly) with Hammond running
and signed in, confirm stderr prints `hammond-mcp: connected over stdio, ready.`, then let the
harness itself connect.

## Harness instruction snippet

Paste this (or the equivalent) into whichever role's instruction layer a harness reads on startup.
This is setup documentation for a human to install — **it is not injected automatically by
anything in this feature**.

> You have access to Hammond's local MCP tools for this project. At the start of a task, call
> `tasks.get`, `comments.listForTask`, `assignments.list`, and `instructions.getEffective` (for
> your own role/provider) to load the current task, its comments, role assignments, and effective
> instructions before doing anything else. Follow the role and instructions Hammond reports —
> do not assume defaults. As you make progress, record it with `context.recordActivity` and/or
> `comments.add` rather than only reporting it in chat. If you save or change instructions with
> `instructions.prepare`/`restore`/`activateExisting`, that never writes a harness file by itself
> — always ask the user next: "Inject now, or leave ready for later?" Only call `harness.inject`
> after they explicitly say to inject; never treat silence, elapsed time, or permission to prepare
> as permission to inject.

## Troubleshooting

| Symptom                                        | Meaning                                                                                                                                                                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hammond_not_running` / connection refused     | Hammond is not running, or has not launched far enough to bind the listener. Start Hammond.                                                                                                                                                   |
| HTTP `503` `starting`                          | Hammond is running but still initializing, or its workspace window is not yet (or no longer) ready to serve requests. Retry shortly.                                                                                                          |
| HTTP `503` `signed_out`                        | Hammond is running but no owner is signed in. Sign in, then retry.                                                                                                                                                                            |
| HTTP `401` `invalid_token`                     | The token is wrong or was rotated. Re-check Settings for the current value.                                                                                                                                                                   |
| HTTP `403` `token_revoked`                     | Access was explicitly revoked in Settings. Rotate to re-enable.                                                                                                                                                                               |
| HTTP `403` `invalid_host` / `untrusted_origin` | Something is not calling `127.0.0.1:<port>` directly (a proxy, a browser). Not supported.                                                                                                                                                     |
| HTTP `504` `unknown_outcome`                   | The bridge timed out, or a sign-out / window-teardown interrupted an already-dispatched request. It may or may not have completed. Do not resend — recheck the affected record (e.g. re-list tasks/comments) before deciding what to do next. |
| MCP tool call returns `isError: true`          | The adapter reached Hammond and got a clean error back (see the JSON `code`/`message` in the tool result) — this is Hammond-side, not an adapter crash.                                                                                       |

None of the above ever includes the token or a Supabase session value in its message.

## Known limitations

- **A live signed-in end-to-end operation through the real webview has not been run.** Reaching a
  signed-in state needs the owner's Supabase project; the verification here stops at the Rust HTTP
  layer's own decisions (`authorize` is unit-tested with real header maps) and the HTTP↔MCP path
  (a real, unmocked MCP SDK protocol test against a genuine HTTP backend,
  `mcp/src/integration.test.ts`). No automated test drives a real `AppHandle`-backed Tauri window
  end to end — that would need `tauri::test`'s mock runtime, a different `AppHandle<R>` type than
  the `AppHandle<Wry>` this code uses throughout. So the Rust HTTP layer's dispatch into a _real_
  webview, and the owner smoke checklist, remain for the owner to verify.
- `harness.preview`/`context.*` composite reads issue several sequential Supabase round trips
  internally; this is a straightforward extension of existing per-domain service calls, not a new
  N+1 concern introduced by pagination.
- Directory-context and harness operations were exercised against the existing in-memory test
  fakes for those domains (matching how the rest of the codebase already tests them), not against
  a real Tauri filesystem — the underlying native filesystem/harness commands themselves are
  unchanged by this feature.
- Directory-context and harness operations were exercised against the existing in-memory test
  fakes for those domains (matching how the rest of the codebase already tests them), not against
  a real Tauri filesystem — the underlying native filesystem/harness commands themselves are
  unchanged by this feature.

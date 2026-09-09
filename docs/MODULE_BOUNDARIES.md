# Hammond module boundaries

HAM3-001 establishes a desktop shell and contracts without implementing product workflows. The
boundaries below are intentional seams for the next foundation tasks.

## UI (`src/`)

React components own presentation and screen state. Components may consume typed API modules, but
they must not read files, persist settings, or construct Supabase requests directly. `App.tsx` is
currently a static shell so the desktop runtime can be observed without product behavior.

## Native filesystem commands (`src-tauri/` and `src/api/`)

Rust owns operating-system filesystem access and exposes a small Tauri command surface. The
frontend calls commands through `src/api/native.ts`; `src/api/contracts.ts` describes the future
filesystem contract. Directory selection, reading, writing, removal, existence checks, and reveal
behavior are deliberately not implemented in HAM3-001.

Native commands should:

- accept explicit, validated inputs;
- return serializable values or structured errors;
- avoid application state and background polling; and
- remain independently unit-testable on the Rust side.

## Supabase access (`src/data/`, future)

Supabase is the durable store for owner-scoped project memory, tasks, comments, templates, and
delivery evidence. It belongs behind data/repository modules, not in React components or native
filesystem commands. Supabase schema, authentication, and client setup are outside HAM3-001.

Absolute local paths must never be persisted to Supabase. A future data layer should exchange
project and task identifiers with the UI while local path bindings remain device-scoped.

## Local settings (`src/settings/`, future)

Local settings hold device-specific values such as absolute paths, permissions, directory bindings,
and the last-open UI state. They are separate from Supabase records and should be accessed through
the `LocalSettingsStore` contract. Settings are not a second synchronization or polling system.

## Dependency direction

```text
React UI
  -> typed frontend contracts
     -> Tauri command adapter -> Rust native commands -> operating system
     -> Supabase repository adapter -> Supabase
     -> local settings adapter -> device-local storage
```

The foundation does not add a browser server, bridge, provider launcher, Git integration, or
background worker. Vite exists only as the development/build input for the embedded Tauri webview;
the packaged app loads its built frontend directly.

## Agent access (`src/agentAccess/`, `src-tauri/src/agent_access/`, `src-tauri/crates/`) — HAM3-014

The one deliberate exception to "native commands stay pure request/response, no second data
layer": the named-pipe server relays a validated request description to the frontend via a Tauri
event and waits for a response, rather than answering it itself. Its protocol/state code (framing,
credentials, the in-memory connection core, the pending-request table, the named-pipe transport)
lives in `src-tauri/crates/agent-access`, a `tauri`-free library crate shared with the standalone
`hammond-mcp-companion` binary (`src-tauri/crates/companion`); `src-tauri/src/agent_access/`
re-exports all of it and adds only the `tauri::AppHandle`-touching command surface
(`commands.rs`). `src/agentAccess/facade.ts` is where a relayed call actually executes, over the
same `TrackerServices` (and therefore the same live Supabase session and RLS) every other screen
uses — it must never grow its own Supabase client, its own copy of `composeInstructions`, or any
other parallel implementation of logic that already lives in `src/instructions/`,
`src/assignments/`, or `src/data/`. See `docs/AGENT_ACCESS.md` for the full architecture and trust
boundary.

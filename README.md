# Hammond 3.0

Hammond 3.0 is a single-owner desktop project tracker and instruction manager.

It remembers projects, tasks, comments, versioned instruction templates, and exact-SHA delivery evidence in Supabase. It opens local directories directly and writes the selected Codex, Claude, or Kilo instructions into them. Agents perform Git and GitHub work using their own harnesses; Hammond presents and validates the returned workflow evidence.

## Desktop foundation

The application is a Tauri desktop shell with a React and TypeScript frontend. Vite is used for
the local development/build step; packaged Tauri builds load the generated frontend directly and
do not require a browser server.

```text
src/                       React shell and typed frontend command adapters
src-tauri/                 Rust/Tauri application shell and native command entry points
docs/MODULE_BOUNDARIES.md  UI, native, Supabase, and local-settings seams
```

Install dependencies and run the focused checks with:

```sh
npm install
npm run test
npm run typecheck
npm run lint
npm run format:check
npm run tauri:dev
```

See [module boundaries](./docs/MODULE_BOUNDARIES.md) before adding filesystem, Supabase, or local
settings behavior.

## Supabase project memory

Hammond reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from `.env.local`.
Copy `.env.example`, then use the hosted project's URL and publishable key. Never place a
service-role or secret key in the desktop app.

The Supabase client persists its owner session in the Tauri webview's local storage and refreshes
it automatically. This fits Hammond's client-only desktop runtime; there is no server or cookie
request cycle. Call `ownerAuth.setup` once, then `ownerAuth.getPersistedSession` on later launches.
Signing out explicitly removes the persisted session.

Local schema workflow:

```powershell
npm run supabase:start
npm run supabase:reset
npm run supabase:test
npm run supabase:types
```

Create future migrations with `npx supabase migration new <name>`. After changing migrations,
reset from clean, run the database tests, regenerate `src/data/database.types.ts`, and commit the
generated types. To apply migrations to the owner's hosted project, authenticate the CLI, link the
project, review with `npx supabase db push --dry-run`, then run `npx supabase db push`. CLI
authentication and database credentials remain device-local and must not be committed.

Owner human check:

1. Start Hammond with the hosted `.env.local`, call the one-time `ownerAuth.setup` flow, and create
   a seed project through `ProjectRepository`.
2. Close Hammond completely and reopen it.
3. Confirm `ownerAuth.getPersistedSession` returns the same owner and `ProjectRepository.list`
   returns the project without repeating setup.

## Canonical planning documents

- [Architecture](./docs/ARCHITECTURE.md)
- [Delivery workflow](./tracker/WORKFLOW.md)
- [Task board](./tracker/BOARD.md)
- [Machine-readable task index](./tracker/index.yaml)
- [Worker prompt template](./tracker/templates/WORKER_PROMPT.md)
- [Auditor prompt template](./tracker/templates/AUDITOR_PROMPT.md)

## Delivery authority

- Human owner: product authority and prompt dispatcher.
- GPT-5.6 Sol through OpenAI Codex Desktop: active orchestrator; plans, routes, records evidence, and decides readiness. The orchestrator does not implement feature code and never acts as worker or auditor on a task it orchestrates.
- Claude Sonnet through Claude Code: default implementation worker for future tasks.
- Luna through OpenAI: eligible implementation worker when the owner selects it.
- DeepSeek V4 Pro through Kilo Code: default independent auditor.

Per D-014, exact worker and auditor identities are bound in each work order. Sonnet is the default worker because it preserves provider-family separation from the OpenAI orchestrator; Luna remains eligible by owner override. No provider family audits its own implementation, and the orchestrator never fills an execution role.

- Git: authority for code, commits, issues, PRs, exact SHAs, and posted reports.
- Hammond: authority for project/task state, instruction versions, dispatch history, and evidence presentation.

All foundation tasks are created directly in `in_design`. There is no foundation backlog.

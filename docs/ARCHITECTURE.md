# Hammond 3.0 Architecture

Status: D-024 supersedes Supabase/MCP/Docker runtime plans. The authoritative target is [Disk-only project memory](./DISK_PROJECT_FORMAT.md): native UI over portable directory files, direct agent filesystem access, startup/watch reconciliation and verified one-time legacy export. Normal operation needs no login or service. Implementation is pending HAM3-014.

## Historical architecture — superseded runtime boundary

The following records the prior architecture and implemented feature vocabulary. Supabase storage, Docker/MCP access and related release requirements below are historical, not current implementation instructions. D-024 and the disk project contract take precedence.

## Product boundary

Hammond is a native desktop UI for:

1. opening a local repository, worktree, or ordinary project directory;
2. remembering the Hammond project and task context associated with it;
3. managing versioned orchestrator, worker, and auditor instruction templates;
4. injecting exactly one selected instruction document per supported agent harness;
5. managing nested tasks, comments, and owner-controlled task statuses.

Hammond is not a Git client, GitHub client, provider runtime, remote bridge, or distributed control plane.

```mermaid
flowchart LR
    Owner["Human owner"] --> App["Hammond desktop app"]
    App <--> Local["Local directory or worktree"]
    App <--> Settings["Local directory bindings"]
    App <--> DB["Hosted Supabase memory"]
    Agents --> MCP["Standalone Docker MCP service"]
    MCP <--> DB
    App --> Docs["Managed harness instructions"]
    Docs --> Agents["Codex / Claude / Kilo"]
    Agents --> Git["Git issues, branches, PRs and reports"]
    Git --> Evidence["External delivery records and review"]
```

## Technology direction

- Tauri desktop shell.
- React and TypeScript UI.
- Small native filesystem command surface: select, read, write, remove, inspect existence, and reveal directory.
- Supabase Postgres for durable project memory.
- Local application settings for absolute paths, operating-system permissions, directory bindings, and last-open UI state.
- No locally served browser application and no separately installed bridge.

## Core records

- Project
- Task
- Task relation
- Comment
- Activity event
- Instruction template
- Instruction version
- Project instruction selection
- Project/task reference
- Local directory binding
- Lightweight resume session

## Session meaning

A session is where the owner left off:

- project;
- open directory;
- selected task;
- role and provider family;
- selected instruction versions;
- last screen.

It has no draft/freeze/apply/activate lifecycle.

## Instruction model

Roles:

- orchestrator;
- worker;
- auditor.

Provider families:

- OpenAI through Codex;
- Anthropic through Claude Code;
- DeepSeek through Kilo Code.

Each role and provider template is versioned in Supabase. Project and optional task instructions are composed with them. The selected adapter writes one predictable harness entry-point file. Switching role, provider, or version replaces Hammond-managed content rather than creating duplicates.

If an unmanaged target file already exists, Hammond must never silently overwrite it. It asks the owner to import, replace, or cancel.

Stable project instructions may be Git-tracked. Personal active-role state is local by default. External repository work orders are an orchestration practice, not app-generated content.

## Git and branches

Hammond does not inspect or synchronize Git.

- Same directory, different checked-out branch: same local directory context.
- Separate Git worktree: separate directory context that can link to the same Hammond project.
- Agents create branches, commits, PRs, reviews, and Git comments through their own harnesses.
- Agent reports, exact-SHA approvals, and merge authorization remain in external delivery records. Hammond may hold ordinary reference links without deriving approval or readiness.

## Supabase boundary

Durable project memory supports projects, tasks, comments, instruction templates and versions, and instruction selections. Existing schema scaffolding does not make cancelled HAM3-009/010/011 capabilities release requirements.

Supabase does not store absolute local paths. Exposed tables use owner-scoped row-level policies. The desktop app uses a persistent owner identity; there is no multi-user administration or GitHub authentication.

## Removed systems

- D1 and Miniflare
- browser-only delivery
- bridge installation and pairing
- operation polling and claims
- leases, heartbeats, outboxes, and recovery queues
- apply tokens, manifests, and runtime injection protocol
- Git discovery, dirty state, ahead/behind, and remote verification
- GitHub authentication and synchronization
- routing tiers and session role assignment
- automatic agent launching and merging

## First-release boundary

The release is useful when the owner can open a directory, link a project, manage nested tasks and comments, edit and restore instruction versions, inject or replace the selected harness instructions, and resume later. HAM3-009/010/011 work-order, approval, and tracker expansion scopes are cancelled. HAM3-014 is planned before integrated release to add local agent reads of project/task context and scoped instructions, plus permitted task updates/comments. The standalone Docker service uses independent owner-authorized grants and works while the desktop is closed. Desktop startup, focus, reconnect and live invalidation fetch current hosted state with draft/conflict protection. Instruction edits and final delivery statuses remain owner-controlled. See the revised HAM3-014 contract; D-023 supersedes earlier native transport requirements.

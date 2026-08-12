# Hammond 3.0

Hammond 3.0 is a single-owner desktop project tracker and instruction manager.

It remembers projects, tasks, comments, versioned instruction templates, and exact-SHA delivery evidence in Supabase. It opens local directories directly and writes the selected Codex, Claude, or Kilo instructions into them. Agents perform Git and GitHub work using their own harnesses; Hammond presents and validates the returned workflow evidence.

## Canonical planning documents

- [Architecture](./docs/ARCHITECTURE.md)
- [Delivery workflow](./tracker/WORKFLOW.md)
- [Task board](./tracker/BOARD.md)
- [Machine-readable task index](./tracker/index.yaml)
- [Worker prompt template](./tracker/templates/WORKER_PROMPT.md)
- [Auditor prompt template](./tracker/templates/AUDITOR_PROMPT.md)

## Delivery authority

- Human owner: product authority and prompt dispatcher.
- Sol: active orchestrator; plans, routes, records evidence, and decides readiness. Sol does not implement feature code or audit its own orchestration.
- Claude Sonnet 5 through Claude Code: implementation worker or auditor as routed per task.
- DeepSeek V4 Pro through Kilo Code: implementation worker or auditor as routed per task.
- Git: authority for code, commits, issues, PRs, exact SHAs, and posted reports.
- Hammond: authority for project/task state, instruction versions, dispatch history, and evidence presentation.

All foundation tasks are created directly in `in_design`. There is no foundation backlog.

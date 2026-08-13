# Product Decisions

## D-001 — Desktop, not browser

Hammond is a native desktop application so directory selection and instruction writing are direct local actions. No bridge or localhost browser architecture is allowed.

## D-002 — Supabase is memory, not local control

Supabase stores project/task/template/evidence memory. Absolute paths and operating-system directory permissions remain local.

## D-003 — No Git or GitHub integration

Agents use their existing Codex, Claude, or Kilo harness access to perform Git work. Hammond accepts and presents their issue, PR, report, and SHA evidence.

## D-004 — Session means resume

A session stores only where the owner left off. There is no activation or role-transfer protocol.

## D-005 — Instructions replace rather than accumulate

Hammond owns one managed instruction entry point per selected harness/directory. A role/provider/version switch replaces managed content and does not generate duplicates.

## D-006 — Version history is durable

Every saved instruction edit creates a Supabase version. Historical dispatch packets remain readable even after templates change.

## D-007 — Exact-SHA governance remains

Worker delivery, cross-provider audit, stale approval after new commits, final validation, merge, and shipped observation remain the canonical workflow.

## D-008 — Sol orchestrates; Sonnet and Kilo execute

Superseded by D-010. Retained as the record of the arrangement in force before the orchestrator transfer.

Sol plans, routes, records, and assesses readiness without writing feature code. Sonnet and Kilo alternate as implementation worker and independent auditor.

## D-009 — Focused verification by default

Tasks run focused verification appropriate to the changed boundary. Full-suite execution is reserved for release/cross-cutting boundaries and is not repeated to compensate for uncertainty.

## D-010 — Opus orchestrates; Luna, Sonnet, and DeepSeek execute

Supersedes D-008.

The owner transferred the active orchestrator role from OpenAI / Codex Desktop / GPT-5.6 Sol to Anthropic / Claude Code / Claude Opus 5. The orchestrator plans, routes, records, and assesses readiness without writing feature code, and never acts as worker or auditor on a task it orchestrates.

Implementation rotates across three execution families: OpenAI / Luna, Claude Code / Claude Sonnet 5, and Kilo Code / DeepSeek V4 Pro. Each family works four of the twelve foundation tasks and audits four. No task is audited by its author's family.

The orchestrator shares a provider and tool with the Sonnet participant, differing only by model. Audit independence is therefore a property of the routing matrix, enforced per task, and must not be inferred from provider identity. Any future orchestrator transfer must re-check this constraint rather than assume it.

Execution identities are recorded at family level in the workflow and task index. The exact harness and model version are bound in each work order at dispatch time, alongside the exact start SHA, so a worker can verify itself against its packet.

## D-012 — Luna implements; DeepSeek audits

Supersedes the three-family rotation in D-010. The orchestrator identity in D-010 is unchanged.

Every task is implemented by OpenAI / Luna and independently audited by Kilo Code / DeepSeek V4 Pro. Claude Code / Claude Sonnet 5 is removed from the execution roster.

The Anthropic family therefore holds no execution role. It orchestrates only. This is stronger separation than the previous arrangement, where the orchestrator shared a provider and tool with an execution participant and independence had to be argued from the routing matrix rather than read off the roster.

The tradeoff this accepts, recorded so it is not rediscovered later: a single family now writes the entire codebase. Implementation diversity is gone, so any systematic weakness in the implementing family is present in every task, and the independent audit is the only check on it. That raises the stakes on the auditor's verdicts and on the requirement that audits reproduce verification independently rather than reading the worker's report. The HAM3-001 audit did exactly that and caught two real defects; that standard is now load-bearing rather than merely good practice.

The invariant that survives unchanged: no provider family audits its own implementation.

## D-011 — Sequential delivery

Supersedes the concurrent-dispatch allowance in the original workflow.

Exactly one task is dispatched at a time and must reach `merged` before the next is promoted to `ready_for_development`. Each work order therefore binds the current `dev` head at the moment it is issued. Concurrent dispatch, and the expected-file-ownership check it would require, is reintroduced only by explicit owner authorization.

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

## D-013 — Task hierarchy is presented as a main-pane outliner with focus

Recorded after the HAM3-004 human check, when the owner found parent and child relationships functional but thinly presented and asked for a foldable tree.

The sidebar holds projects only. The task tree lives in the main pane at full width.

Rationale: Hammond task rows carry status now and will carry head SHA, pull request, and evidence later. A narrow sidebar cannot show that, so a sidebar tree would force a click on every row to learn anything. Notion's sidebar works because its items are only page titles.

Scale is handled by focus, not by folding alone. Clicking a task makes it the temporary root with a breadcrumb back, so the whole tree is never rendered and both depth and volume stop mattering. Folding alone fails once there are many top-level tasks, because the user then scrolls through collapsed rows instead of expanded ones.

Supporting rules:

- Children default to collapsed, with a child count badge. The badge is what makes collapsing safe, since hidden work stays visible as a number.
- Nesting is capped at two levels, task and subtask. The schema permits unlimited depth through `parent_task_id`, so this is a product constraint rather than a database one. Deep trees in trackers are consistently regretted; they invite taxonomy building instead of work.
- List virtualization is deferred until a project exceeds a few hundred rows. At the current scale plain DOM is correct.

The owner asked for this at the nearest occasion. Its natural owner is HAM3-011, tracker depth, with focus and breadcrumb navigation possibly belonging to HAM3-008. Both sit behind dependencies, so delivering it sooner requires a dedicated task, which is an owner decision about the shape of the plan.

## D-011 — Sequential delivery

Supersedes the concurrent-dispatch allowance in the original workflow.

Exactly one task is dispatched at a time and must reach `merged` before the next is promoted to `ready_for_development`. Each work order therefore binds the current `dev` head at the moment it is issued. Concurrent dispatch, and the expected-file-ownership check it would require, is reintroduced only by explicit owner authorization.

## D-014 — Sol orchestrates; Sonnet defaults to implementation; DeepSeek defaults to audit

Supersedes D-010's orchestrator identity and D-012's fixed execution roster.

The owner transferred the active orchestrator role from Anthropic / Claude Code / Claude Opus 5 to OpenAI / Codex Desktop / GPT-5.6 Sol. The owner explicitly activated the transfer on 2026-08-13. The orchestrator retains the existing boundaries: it does not implement feature code, does not audit a task it orchestrates, and does not merge without owner authorization.

For future tasks, Anthropic / Claude Code / Claude Sonnet is the default implementation worker, OpenAI / Luna is an eligible owner-selected fallback, and Kilo Code / DeepSeek V4 Pro is the default independent auditor. Exact tool and model identities remain bound in each work order at dispatch.

Sonnet is the default because it restores provider-family separation between the OpenAI orchestrator, Anthropic implementation, and Kilo audit. If the owner selects Luna, orchestrator and worker share the OpenAI family; that is allowed only with an independently reproduced Kilo audit and an explicit record in the work order. No provider family may audit its own implementation, and the orchestrator may not fill either execution role. Historical tasks retain their actual delivery identities.

## D-015 — Task hierarchy permits arbitrary depth and uses explicit row semantics

Supersedes only D-013's two-level nesting rule. D-013's main-pane outliner, collapsed children, child counts, focus navigation, and virtualization deferral remain in force.

The owner rejected the artificial two-level cap during the HAM3-013 human check. Tasks may nest to arbitrary practical depth through the existing `parent_task_id`; application validation must prevent cycles but must not impose a fixed depth maximum. This is an application-only correction because the schema already supports the relationship and has no depth constraint.

When archived tasks are shown, archived rows must be unmistakable through an explicit textual indicator and distinct row treatment. Color alone is insufficient. Row controls also need a functional visual hierarchy: status is a state control, Focus is navigation, + child is constructive, and Archive is destructive. Their labels, contrast, hover, keyboard-focus, and disabled states must remain readable in the dark theme. This is a presentation change, not permission to redesign task persistence, add restore behavior, or introduce new task actions.

## D-016 — Task archive applies to the complete descendant subtree

Archiving a task archives the selected task and every transitive descendant. An active child must never reappear as a top-level orphan merely because its parent is hidden by the archived filter. Archiving a leaf affects only that leaf.

The subtree is resolved from the task hierarchy including already archived rows, and all affected rows are persisted through one filtered bulk update with a common archive timestamp. This avoids partial per-child completion and keeps the optimistic UI aligned with the repository result. The existing owner/project RLS boundary remains authoritative. No archive restore behavior, project-archive cascade, delete cascade, or schema migration is introduced by this decision.

# Hammond 3.0 Delivery Workflow

## Fixed identities

- Human owner: chooses product direction, manually transfers prompts, performs named human checks, and authorizes merge.
- Active orchestrator: Anthropic / Claude Code / Claude Opus 5.
- OpenAI participant: OpenAI / Luna.
- Anthropic participant: Claude Code / Claude Sonnet 5.
- Kilo participant: Kilo Code / DeepSeek V4 Pro.

The orchestrator does not write feature code and never acts as worker or auditor on a task it orchestrates. The three execution families rotate as worker and auditor. No provider family audits its own implementation.

The orchestrator and the Sonnet participant share a provider and tool, differing only by model. Audit independence is therefore enforced by the routing matrix per task, not inferred from provider identity.

Execution identities are recorded here at family level. The exact harness and model version are bound in each work order at dispatch time, alongside the exact start SHA.

## Task states

```text
in_design
-> ready_for_development
-> in_development
-> in_review
-> testing
-> merged
-> shipped
```

The foundation plan starts entirely in `in_design`; `backlog` and `scoping` are not used for these already-defined tasks.

State meanings:

- `in_design`: task scope and dependencies exist but have not passed dispatch review.
- `ready_for_development`: dependencies are merged and the orchestrator has prepared an exact-base work order.
- `in_development`: the named worker is implementing the task.
- `in_review`: a draft PR and exact worker head exist; a different provider family is auditing it.
- `testing`: current head has cross-family approval and is undergoing required exact-head validation or human QA.
- `merged`: exact approved head is integrated into `dev`.
- `shipped`: the capability is observed in the packaged desktop application.

## Per-task stages

### 1. Design control — orchestrator

The orchestrator confirms scope, dependencies, non-scope, expected files, acceptance criteria, focused verification, human checks, worker identity, and auditor identity. The task moves to `ready_for_development` only when dependencies are merged.

### 2. Worker dispatch — owner to assigned worker

The orchestrator fills the task's work-order template with repository path, remote, issue URL, base branch, work branch, exact start SHA, and verified facts. The human owner transfers it to the named worker.

### 3. Implementation — assigned worker

The worker creates the declared branch, implements only the stated scope, verifies the result proportionally, commits, pushes, opens a draft PR, and posts a structured top-level worker report. The worker returns the exact head SHA and links to the owner.

### 4. Evidence intake — orchestrator

The owner gives the report to the orchestrator, which checks identity, branch, task ID, links, head SHA, claims, limitations, and worktree cleanliness, records evidence, and prepares a review packet for a different provider family.

### 5. Independent audit — different provider family

The auditor reviews the exact head SHA, tests acceptance boundaries, distinguishes product defects from infrastructure failures, restores any mutations, posts a top-level audit report, and returns one of:

```text
AUDIT-VERDICT: APPROVE <reviewed-head-sha>
AUDIT-VERDICT: CHANGES <reviewed-head-sha>
```

### 6. Correction loop — original worker

`CHANGES` returns to the original worker with the exact audit report and head. The correction stays on the same branch and PR. Every new commit invalidates earlier approval. The auditing family re-audits the new exact head.

### 7. Exact-head validation — routed by the orchestrator

After approval, the orchestrator selects only the integration checks justified by task risk. The full suite is reserved for release boundaries or cross-cutting changes; focused tests are the default. One unexplained infrastructure failure is diagnosed before creating a product correction.

### 8. Readiness and merge — orchestrator plus owner

The orchestrator confirms the PR targets `dev`, is conflict-free, names the task, matches provenance, has current cross-family approval, satisfies acceptance criteria, and has completed human checks. The owner authorizes merge. Neither worker nor auditor merges its own work.

### 9. Shipped check — owner

`merged` becomes `shipped` only after the capability is observed in the packaged desktop app.

## Routing matrix

| Task | Worker | Auditor |
|---|---|---|
| HAM3-001 | OpenAI / Luna | Kilo Code / DeepSeek V4 Pro |
| HAM3-002 | Claude Code / Claude Sonnet 5 | OpenAI / Luna |
| HAM3-003 | Kilo Code / DeepSeek V4 Pro | Claude Code / Claude Sonnet 5 |
| HAM3-004 | OpenAI / Luna | Kilo Code / DeepSeek V4 Pro |
| HAM3-005 | Claude Code / Claude Sonnet 5 | OpenAI / Luna |
| HAM3-006 | Kilo Code / DeepSeek V4 Pro | Claude Code / Claude Sonnet 5 |
| HAM3-007 | OpenAI / Luna | Kilo Code / DeepSeek V4 Pro |
| HAM3-008 | Claude Code / Claude Sonnet 5 | OpenAI / Luna |
| HAM3-009 | Kilo Code / DeepSeek V4 Pro | Claude Code / Claude Sonnet 5 |
| HAM3-010 | OpenAI / Luna | Kilo Code / DeepSeek V4 Pro |
| HAM3-011 | Claude Code / Claude Sonnet 5 | OpenAI / Luna |
| HAM3-012 | Kilo Code / DeepSeek V4 Pro | Claude Code / Claude Sonnet 5 |

Each family works four tasks and audits four. No task is audited by its author's family. Routing may be changed by the owner before dispatch. The exact work order always overrides the planning default and must explicitly name every participant.

## Execution order

Tasks are delivered sequentially. Exactly one task is dispatched at a time, and it must reach `merged` before the next task is promoted to `ready_for_development`. Each task therefore starts from the current `dev` SHA at the moment its work order is issued.

Concurrent dispatch is not used. If the owner later authorizes it, overlapping expected file ownership must be checked before two tasks run together.

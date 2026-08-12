# Sol-Orchestrated Delivery Workflow

## Fixed identities

- Human owner: chooses product direction, manually transfers prompts, performs named human checks, and authorizes merge.
- Active orchestrator: OpenAI / Codex / GPT-5.6 Sol.
- Anthropic participant: Claude Code / Claude Sonnet 5.
- Kilo participant: Kilo Code / DeepSeek V4 Pro.

Sol does not write feature code. Sonnet and Kilo alternate as worker and auditor. No provider audits its own implementation.

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
- `ready_for_development`: dependencies are merged and Sol has prepared an exact-base work order.
- `in_development`: the named worker is implementing the task.
- `in_review`: a draft PR and exact worker head exist; the other provider is auditing it.
- `testing`: current head has cross-provider approval and is undergoing required exact-head validation or human QA.
- `merged`: exact approved head is integrated into `dev`.
- `shipped`: the capability is observed in the packaged desktop application.

## Per-task stages

### 1. Design control — Sol

Sol confirms scope, dependencies, non-scope, expected files, acceptance criteria, focused verification, human checks, worker identity, and auditor identity. Sol moves the task to `ready_for_development` only when dependencies are merged.

### 2. Worker dispatch — owner to assigned worker

Sol fills the task's work-order template with repository path, remote, issue URL, base branch, work branch, exact start SHA, and verified facts. The human owner transfers it to the named worker.

### 3. Implementation — Sonnet or Kilo

The worker creates the declared branch, implements only the stated scope, verifies the result proportionally, commits, pushes, opens a draft PR, and posts a structured top-level worker report. The worker returns the exact head SHA and links to the owner.

### 4. Evidence intake — Sol

The owner gives the report to Sol. Sol checks identity, branch, task ID, links, head SHA, claims, limitations, and worktree cleanliness. Sol records evidence and prepares a review packet for the other provider.

### 5. Independent audit — other provider

The auditor reviews the exact head SHA, tests acceptance boundaries, distinguishes product defects from infrastructure failures, restores any mutations, posts a top-level audit report, and returns one of:

```text
AUDIT-VERDICT: APPROVE <reviewed-head-sha>
AUDIT-VERDICT: CHANGES <reviewed-head-sha>
```

### 6. Correction loop — original worker

`CHANGES` returns to the original worker with the exact audit report and head. The correction stays on the same branch and PR. Every new commit invalidates earlier approval. The other provider re-audits the new exact head.

### 7. Exact-head validation — routed by Sol

After approval, Sol selects only the integration checks justified by task risk. The full suite is reserved for release boundaries or cross-cutting changes; focused tests are the default. One unexplained infrastructure failure is diagnosed before creating a product correction.

### 8. Readiness and merge — Sol plus owner

Sol confirms the PR targets `dev`, is conflict-free, names the task, matches provenance, has current cross-provider approval, satisfies acceptance criteria, and has completed human checks. The owner authorizes merge. Neither worker nor auditor merges its own work.

### 9. Shipped check — owner

`merged` becomes `shipped` only after the capability is observed in the packaged desktop app.

## Routing matrix

| Task | Worker | Auditor |
|---|---|---|
| HAM3-001 | Sonnet | Kilo |
| HAM3-002 | Kilo | Sonnet |
| HAM3-003 | Sonnet | Kilo |
| HAM3-004 | Kilo | Sonnet |
| HAM3-005 | Sonnet | Kilo |
| HAM3-006 | Kilo | Sonnet |
| HAM3-007 | Sonnet | Kilo |
| HAM3-008 | Kilo | Sonnet |
| HAM3-009 | Sonnet | Kilo |
| HAM3-010 | Kilo | Sonnet |
| HAM3-011 | Sonnet | Kilo |
| HAM3-012 | Kilo | Sonnet |

Routing may be changed by the owner before dispatch. The exact work order always overrides the planning default and must explicitly name every participant.

## Concurrency

Sol may dispatch tasks concurrently only when dependencies are met and expected file ownership does not overlap. Otherwise tasks are sequenced. A later task starts from the current `dev` SHA after earlier dependencies merge.

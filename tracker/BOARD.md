# Hammond 3.0 Foundation Board

Active orchestrator: OpenAI / Codex Desktop / GPT-5.6 Sol  
Initial condition: every task is `in_design`  
Dispatch rule: dependencies must be merged before a task becomes `ready_for_development`

## in_design

- [HAM3-012](./tasks/HAM3-012.md) — Integrated desktop release and human QA

## ready_for_development

- [HAM3-014](./tasks/HAM3-014.md) — Disk-only memory, direct agent file access, instruction scopes/history, external-edit reconciliation and verified legacy export; Sonnet packet prepared.

## in_development

None.

## in_review

None.

## testing

None.

## cancelled

- [HAM3-009](./tasks/HAM3-009.md) — Removed from product scope by owner; PR #11 closed unmerged.
- [HAM3-010](./tasks/HAM3-010.md) — In-app evidence and approval workflow removed from product scope by owner.
- [HAM3-011](./tasks/HAM3-011.md) — Tracker expansion cancelled by owner; LLM access is planned in HAM3-014.

## merged

- [HAM3-008](./tasks/HAM3-008.md) — Project home, directory switching, and resume
  Merge commit `379c2cfefb894a5cb94aadc4a9a78e9bde2024ed` · owner accepted prior smoke coverage; approved-head recheck waived
- [HAM3-007](./tasks/HAM3-007.md) — Instruction Studio UI
  Merge commit `85a012577d3384258b0c1d586a3a0ff08d70e863` · owner Windows Studio smoke passed
- [HAM3-006](./tasks/HAM3-006.md) — Harness adapters, agent assignment, and managed-file injection
  Merge commit `5533c5a6ddbcd8c8f518a9058de2b7b20b1520ee` · owner assignment and harness smoke passed
- [HAM3-005](./tasks/HAM3-005.md) — Versioned instruction template domain
  Merge commit `f47ead0c00532b582e94d50258d7d4990aff6ff1` · owner persistence smoke passed
- [HAM3-003](./tasks/HAM3-003.md) — Local directory contexts and bindings
  Merge commit `671278697d46a52061fff85283d16f5251f87da5` · owner Windows smoke test passed
- [HAM3-013](./tasks/HAM3-013.md) — Task hierarchy outliner
  Merge commit `d9826e7934758f6b270a19a5eebefed0afd48229` · owner archive check passed

## shipped

- [HAM3-001](./tasks/HAM3-001.md) — Desktop application foundation  
  Observed by the owner in the packaged release built from merged `dev` at `cca4e82b88b131a7f06f7511b6698ce372ba8d87`
- [HAM3-002](./tasks/HAM3-002.md) — Supabase project memory and owner access  
  Merge commit `20f6155d770f06062eab63bb0d8d0b89ec019270` · observed in the packaged release built from `6514d07`, once the HAM3-004 UI made the persistence layer visible
- [HAM3-004](./tasks/HAM3-004.md) — Core project and task tracker  
  Merge commit `1dc533f6ef01d9ba302bf48eb67b74e2be82ebd5` · observed in the packaged release built from `6514d07`

None.

## Dependency waves

1. HAM3-001
2. HAM3-002 and HAM3-003
3. HAM3-004 and HAM3-005
4. HAM3-006
5. HAM3-007 and HAM3-008 (HAM3-009/010 cancelled)
6. HAM3-011 cancelled
7. HAM3-014 (LLM access and instruction scopes)
8. HAM3-012 (integrated release after HAM3-014)

HAM3-013 was added after HAM3-004 and is already merged; its hierarchy outliner is a dependency of HAM3-014.

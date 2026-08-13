# Hammond 3.0 Foundation Board

Active orchestrator: Anthropic / Claude Code / Claude Opus 5  
Initial condition: every task is `in_design`  
Dispatch rule: dependencies must be merged before a task becomes `ready_for_development`

## in_design

- [HAM3-003](./tasks/HAM3-003.md) — Local directory contexts and bindings
- [HAM3-005](./tasks/HAM3-005.md) — Versioned instruction template domain
- [HAM3-006](./tasks/HAM3-006.md) — Harness adapters and managed-file injection
- [HAM3-007](./tasks/HAM3-007.md) — Instruction Studio UI
- [HAM3-008](./tasks/HAM3-008.md) — Project home, directory switching, and resume
- [HAM3-009](./tasks/HAM3-009.md) — Work-order generation and dispatch records
- [HAM3-010](./tasks/HAM3-010.md) — Exact-SHA evidence and approval workflow
- [HAM3-011](./tasks/HAM3-011.md) — Tracker depth, activity, search, and export
- [HAM3-012](./tasks/HAM3-012.md) — Integrated desktop release and human QA

## ready_for_development

None.

## in_development

None.

## in_review

- [HAM3-013](./tasks/HAM3-013.md) — Task hierarchy outliner  
  PR [#5](https://github.com/Ipat-O/Hammond-3.0/pull/5) · re-audit round 2 · reviewed head `6b7269ccce71d0d8069bc7706970a62817fda4d4` · auditor Kilo Code / DeepSeek V4 Pro

## testing

None.

## merged

None.

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
5. HAM3-007, HAM3-008, HAM3-009, and HAM3-010
6. HAM3-011
7. HAM3-012

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

Sol plans, routes, records, and assesses readiness without writing feature code. Sonnet and Kilo alternate as implementation worker and independent auditor.

## D-009 — Focused verification by default

Tasks run focused verification appropriate to the changed boundary. Full-suite execution is reserved for release/cross-cutting boundaries and is not repeated to compensate for uncertainty.

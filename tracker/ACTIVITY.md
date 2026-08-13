# Planning Activity

## Foundation plan created

- Product architecture rewritten for a native desktop application.
- Supabase selected for minimal durable project memory.
- Bridge, D1, Git synchronization, GitHub authentication, runtime tokens, and distributed operation machinery removed from scope.
- Twelve foundation tasks created directly in `in_design`.
- Sol recorded as active orchestrator.
- Sonnet and Kilo assigned alternating worker/auditor roles.
- Task-specific design work orders created with dispatch blocked until dependencies and exact Git coordinates exist.
- Worker, correction, and auditor prompt templates created.
- No task promoted, branch created, issue opened, implementation dispatched, or code written.

## 2026-08-12 — Orchestration intake started

- Sol reviewed the architecture, workflow, board, decisions, templates, all twelve task definitions, and all twelve design work orders.
- Dependency routing is internally consistent; HAM3-001 remains the only task eligible for first dispatch because it has no task dependency.
- Repository preflight at `C:\Users\owczy\Desktop\repos\Hammond 3.0` found no Git metadata, `dev` branch, remote, or exact start SHA.
- HAM3-001 remains `in_design`. Its work order now records the known local path and the exact Git bootstrap blocker.
- No task was promoted, no implementation agent was dispatched, and no delivery evidence was created.

## 2026-08-12 — Local Git baseline established

- The owner authorized repository bootstrap.
- Sol initialized the local repository with `dev` as the delivery branch.
- Generated work orders were kept local through `.git/info/exclude`, consistent with the approved instruction model.
- The approved planning documents were committed as the repository baseline.
- Remote creation remains pending; HAM3-001 stays `in_design` until a pushable remote is configured and the final dispatch SHA is verified.

## 2026-08-12 — HAM3-001 cleared for development

- Created the public GitHub repository `Ipat-O/Hammond-3.0` with `dev` as its default branch.
- Pushed the local planning baseline and verified the exact remote `dev` head.
- Created GitHub issue #1 for HAM3-001: `https://github.com/Ipat-O/Hammond-3.0/issues/1`.
- Completed design control by recording expected implementation boundaries and focused verification.
- Promoted HAM3-001 from `in_design` to `ready_for_development`; all dependent tasks remain `in_design`.
- Dispatch remains a manual owner transfer to Claude Code / Claude Sonnet 5. No implementation has started yet.

## 2026-08-12 — Orchestrator transfer and routing revision

- The owner transferred the active orchestrator role from OpenAI / Codex Desktop / GPT-5.6 Sol to Anthropic / Claude Code / Claude Opus 5.
- The incoming orchestrator initially returned `BLOCKED`: the transfer packet specified the Claude Opus family, but the session was running Claude Sonnet 5, which is also a designated worker and auditor identity. The owner switched the model to Claude Opus 5, clearing the mismatch, and the transfer was accepted.
- Canonical orchestrator identity updated across the README, workflow, board, task index, all twelve task files, and the worker, auditor, and correction templates. Historical activity entries were left unchanged.
- The owner replaced the Sonnet worker assignment with OpenAI / Luna and directed a full re-plan of the routing matrix across three execution families.
- Routing rebuilt: OpenAI / Luna, Claude Code / Claude Sonnet 5, and Kilo Code / DeepSeek V4 Pro each work four tasks and audit four. All twelve rows were checked so that no task is audited by its author's family.
- Recorded D-010, superseding D-008, and D-011, establishing sequential delivery and superseding the concurrent-dispatch allowance.
- Luna's exact harness and model version were not supplied and were not invented. Routing is recorded at family level; exact identity is bound per work order at dispatch.
- No task state changed. HAM3-001 remains `ready_for_development`. No implementation branch, pull request, dispatch, or audit evidence exists.

## 2026-08-12 — HAM3-001 dispatched, delivered, and accepted into review

- The HAM3-001 work order was issued against exact `dev` head `beb106a335a4943c5b3f3f0298da86054b66e90a` with the worker's exact tool and model left unfilled.
- The worker correctly refused to execute on an unverifiable identity and returned its own: OpenAI / Codex Desktop / GPT-5. The packet was completed with those values and re-issued. "Luna" is retained as the planning alias for this execution family; the exact identity is bound per work order.
- Worker delivered on branch `openai/HAM3-001-desktop-foundation`, head `e482dd1d46d73eca2c10e1a35d186f88acc80434`, draft PR https://github.com/Ipat-O/Hammond-3.0/pull/2.
- Evidence intake verified by the orchestrator against the repository rather than accepted from the report: head SHA exists and matches the pushed branch; the packet base SHA is a true ancestor of the head; the branch carries exactly one commit; the PR is a draft targeting `dev`, is mergeable, and names the task; the worktree is clean; `tracker/` was not modified.
- Product-boundary check passed: `tauri.conf.json` uses `devUrl` for development only and `frontendDist` for packaged builds, so the packaged application requires no browser server. No bridge or polling architecture was introduced. D-001 is satisfied.
- The worker's reported limitation was independently confirmed: `cargo` and `rustc` are absent from the worker machine. The worker reported the blocker rather than substituting a browser-only build, as the packet required. This is an infrastructure failure, not a product defect.
- Consequently the entire native half of HAM3-001 is unverified: no Rust compile, clippy, `cargo test`, or `tauri build` has ever run. Rust unit tests exist in `src-tauri/src/` but have never been executed. No `Cargo.lock` is committed, which blocks reproducible native builds.
- Acceptance criterion "a clean checkout can install, test, build, and open a desktop window" is therefore not yet demonstrated, and the human check remains outstanding.
- HAM3-001 moved from `ready_for_development` to `in_review`. The audit packet is bound to exact head `e482dd1d46d73eca2c10e1a35d186f88acc80434` and requires the auditor to attempt the Rust toolchain and report explicitly if it is also unavailable.
- Incidental: the worker's formatting pass corrected a markdown defect the preceding governance commit introduced in `README.md`.

## 2026-08-12 — HAM3-001 audited; CHANGES at e482dd1

- Kilo Code / DeepSeek V4 Pro audited exact head `e482dd1d46d73eca2c10e1a35d186f88acc80434` in a temporary worktree and returned `AUDIT-VERDICT: CHANGES`. Report: https://github.com/Ipat-O/Hammond-3.0/pull/2#issuecomment-5271914672
- The auditor confirmed the structural evidence independently: head SHA matches, one commit, PR draft and mergeable, `tracker/` untouched, scope clean. It restored its worktree.
- One required finding: `.prettierrc.json` declares no `endOfLine`, so Prettier applies its `lf` default and `npm run format:check` fails on every file of a clean checkout on the owner's `core.autocrlf=true` Windows machine. The auditor demonstrated exit 1 on a CRLF checkout and exit 0 on an LF checkout at the same head, isolating the cause to the missing policy rather than the committed bytes. The orchestrator independently confirmed `core.autocrlf=true`, the absent `endOfLine` key, and the absence of any `.gitattributes`. This breaks the acceptance criterion that a clean checkout can install, test, and build.
- Advisory findings recorded and deliberately excluded from Correction 1: `csp: null` accepted for the foundation slice and deferred to HAM3-002; frontend coverage is a single smoke test, which satisfies the "test entry points" requirement as written; `Cargo.lock` absent, which cannot be generated without a toolchain.
- `rust_toolchain_available: false` for the auditor as well. The native half of HAM3-001 is now unverified across both the implementing and the auditing family. `tauri:build` failed at `cargo metadata` for the auditor exactly as the worker reported, corroborating the worker's limitation from an independent environment.
- Consequence recorded for the owner: HAM3-001 cannot honestly satisfy "open a desktop window" or its human check until a Rust toolchain exists somewhere in the loop. This is an infrastructure gap, not a product defect, and no participant has been charged with it.
- HAM3-001 moved from `in_review` to `in_development` for Correction 1, routed to the original worker on the same branch and PR. Any new commit invalidates the prior review and requires a Kilo re-audit of the new exact head.

## 2026-08-12 — Rust toolchain installed; Correction 1 delivered; Correction 2 routed

- The owner authorized installing a Rust toolchain to clear the infrastructure gap. The orchestrator installed `rustup` 1.29.0 with `cargo`/`rustc` 1.97.1 on `stable-x86_64-pc-windows-msvc`.
- `cargo` alone proved insufficient: the MSVC linker was absent and a throwaway crate failed with `error: linker 'link.exe' not found`. Visual Studio 2022 Build Tools with the `VCTools` workload was installed to supply it, and linking was then proven by compiling and running a throwaway crate outside the repository rather than by trusting an installer exit code.
- The orchestrator did not compile anything inside the repository, preserving the worker's compile as the genuine first build of `src-tauri/`.
- Correction 1 delivered at head `e7f3abfa88b5032b479c443e6b9d97b31a5a0cfb`. Report: https://github.com/Ipat-O/Hammond-3.0/pull/2#issuecomment-5276576511
- Verified by the orchestrator: `endOfLine: "auto"` present; `Cargo.lock` committed at 4494 lines; `tracker/` untouched; previous head a true ancestor; five files changed. The `bundle.icon` entry and two `src-tauri/icons/` files were accepted as a genuine prerequisite of bundling, though the worker did not declare them in its report.
- The native half of HAM3-001 compiled for the first time in the project's history. `cargo fmt`, `clippy`, and `cargo test` pass. A release executable and an MSI were produced. NSIS packaging failed on an external download disconnect, an infrastructure failure charged to no participant.
- The required finding is not fully resolved. `npm run format:check` still exits 1, reproduced independently by the orchestrator. Two files fail: untracked `.kilo/agent-manager.json`, which would not exist in a clean checkout and is out of scope, and tracked `tracker/WORKFLOW.md`, which would. The acceptance criterion that a clean checkout can install, test, and build therefore remains unmet.
- Root cause attributed to the orchestrator, not the worker: `tracker/WORKFLOW.md` was written by the orchestrator in the governance commit and is not Prettier-clean, while `.prettierignore` does not exclude `tracker/`. The worker is forbidden from editing `tracker/` and could not have fixed the file.
- Correction 2 routed to the same worker with a single required change, adding `tracker/` to `.prettierignore`, on the reasoning that `tracker/` holds orchestrator-owned planning documents rather than application source and should not be governed by the application's formatter. This also prevents recurrence whenever the orchestrator writes a tracker document. A single NSIS retry is requested, with instructions to report and stop rather than narrow `bundle.targets`, which belongs to HAM3-012.
- HAM3-001 remains `in_development`. No audit has yet reviewed head `e7f3abf`; the prior `CHANGES` verdict was bound to `e482dd1` and does not carry forward.

## 2026-08-12 — Correction 2 delivered; HAM3-001 returned to review at 0eec339

- Correction 2 delivered at head `0eec339c586fc65685d0de531c64315cb716a563`, a single one-line commit adding `tracker/` to `.prettierignore`. Report: https://github.com/Ipat-O/Hammond-3.0/pull/2#issuecomment-5276822984
- Verified by the orchestrator: the head matches the pushed branch, both earlier heads are true ancestors, the diff is exactly one line, and `tracker/` was not modified.
- The formatting criterion is now satisfied. `npm run format:check` exits 1 with a single warning for `.kilo/agent-manager.json`, which has never been committed and is absent from a clean checkout. `tracker/WORKFLOW.md` no longer fails. Confirmed by reproducing the check and by verifying `.kilo/` has no history in the repository.
- Build artifacts confirmed present on disk: `src-tauri/target/release/hammond-desktop.exe` at 8.6 MB and `src-tauri/target/release/bundle/msi/Hammond_0.1.0_x64_en-US.msi` at 2.8 MB.
- One outstanding item carried into the re-audit: `npm run tauri:build` exits 1. The frontend, release executable, and MSI succeed, then the NSIS step fails downloading `nsis_tauri_utils.dll` with `io: Peer disconnected`. This failed on two separate attempts. The worker complied with the instruction not to narrow `bundle.targets`, since packaging surface is an owner decision belonging to HAM3-012.
- A transient working-tree artifact was observed and resolved: `src-tauri/Cargo.toml` appeared modified with a zero-line diff, caused purely by `core.autocrlf` line-ending normalization rather than any content change.
- The Rust toolchain installed earlier is available to the auditor, which runs on the same machine. The re-audit packet therefore requires independent reproduction of the native verification, since the worker is currently the only party ever to have compiled this code.
- HAM3-001 moved from `in_development` to `in_review`, bound to exact head `0eec339c586fc65685d0de531c64315cb716a563`. The auditor is asked to classify the NSIS failure as a product defect, an infrastructure limitation, or a merge blocker, and is explicitly told not to soften the finding to reach an approval.

## 2026-08-12 — HAM3-001 human check passed

- The owner ran the release executable built from head `0eec339c586fc65685d0de531c64315cb716a563` and observed the Hammond shell, satisfying the named human check recorded in the task definition.
- This is the first time the Hammond 3.0 desktop application has been observed running. It confirms the acceptance criterion that the packaged application opens a desktop window without a browser server.
- The human check does not by itself advance the task. HAM3-001 remains `in_review` pending a cross-family audit verdict bound to the same exact head, followed by owner-authorized merge.
- `shipped` remains distinct from `merged` and will be recorded only after the capability is observed in the packaged application following merge.

## 2026-08-12 — HAM3-001 approved at 0eec339; ready for owner-authorized merge

- Kilo Code / DeepSeek V4 Pro returned `AUDIT-VERDICT: APPROVE 0eec339c586fc65685d0de531c64315cb716a563`. Report: https://github.com/Ipat-O/Hammond-3.0/pull/2#issuecomment-5277248106
- The auditor had a Rust toolchain this round and reproduced the native verification independently from a clean detached worktree: `cargo fmt` 0, `clippy` 0 with zero warnings on a full from-scratch compile, `cargo test` 2/2, `vitest` 1/1, lint 0, typecheck 0, `prettier --check` 0. The code is no longer verified by only the party that wrote it.
- The NSIS failure was classified an infrastructure limitation and then resolved on its own: the auditor reproduced the failure on one attempt and got `tauri:build` exit 0 on an independent retry, producing both MSI and NSIS bundles. No repository configuration contributes to it. The item recorded as outstanding at correction 2 is closed.
- Both prior advisory deferrals were re-accepted by the auditor: `csp: null` to HAM3-002, and single-smoke-test frontend coverage as satisfying the "test entry points" requirement.
- Orchestrator readiness check completed: the branch head still equals the approved SHA so the approval is current; the PR targets `dev`, names the task, and carries matching provenance; a local merge dry-run against `dev` at `d74c2578a9d679a9172b8ef1742a6fb8c11cb455` produced no conflicts across 29 application files and would not disturb the tracker records on `dev`.
- Stage 7 exact-head validation is treated as satisfied by the auditor's from-scratch run rather than repeated. Per D-009, focused verification is the default and a full suite is not re-executed to compensate for uncertainty when an independent party has already executed it at the exact head.
- HAM3-001 moved from `in_review` to `testing`. It awaits two owner actions that the orchestrator will not take unilaterally: marking PR #2 ready for review, and authorizing the merge. Neither worker nor auditor merges its own work.

## 2026-08-12 — HAM3-001 merged

- The owner authorized the merge. PR #2 was marked ready and merged into `dev` as merge commit `757c58d7b67cdacb0bf442b43d4a68d6a9bdc8c8`.
- A merge commit was used rather than a squash, deliberately. Squashing would have rewritten the three worker commits into a new SHA that no audit ever reviewed, breaking the chain between the approved head and what landed. Verified after the fact: `0eec339c586fc65685d0de531c64315cb716a563` is an ancestor of `dev`, and `e482dd1`, `e7f3abf`, and `0eec339` all remain individually addressable in history.
- The branch head was re-checked immediately before merging and still equalled the approved SHA, so no commit arrived between approval and merge.
- HAM3-001 is the first Hammond 3.0 task to complete the full governance cycle: design control, exact-base dispatch, delivery, cross-family audit, two corrections, re-audit, independent exact-head validation, human check, and owner-authorized merge.
- Delivery record: worker OpenAI / Codex Desktop / GPT-5; auditor Kilo Code / DeepSeek V4 Pro; orchestrator Anthropic / Claude Code / Claude Opus 5. No participant audited or merged its own work.
- HAM3-001 is `merged`, not `shipped`. `shipped` requires the owner to observe the capability in the packaged application built from merged `dev`. The earlier human check was performed against the pre-merge branch build and is deliberately not carried forward to satisfy this.
- HAM3-002 and HAM3-003 are now unblocked by dependency. Under D-011 exactly one is promoted at a time; neither has been promoted, and no work order has been prepared.

## 2026-08-12 — HAM3-002 promoted to ready_for_development

- The owner selected HAM3-002 as the next sequential task. HAM3-003 remains `in_design`.
- Design control completed. Sol's original design packet routed this task to Kilo as worker with Sonnet auditing; that is superseded by D-010. The regenerated work order routes Claude Code / Claude Sonnet 5 as worker and OpenAI / Codex Desktop / GPT-5 as auditor, preserving cross-family audit.
- The worker for this task shares a provider and tool with the orchestrator and differs only by model. The packet states explicitly that independence rests on the routing matrix and that the audit belongs to the OpenAI family, per D-010.
- Work order bound to exact `dev` head `c35c4dc647d3a9a75db0b444ff74f9deaafe9d66`, branch `anthropic/HAM3-002-supabase-memory`.
- Environment preflight performed before dispatch rather than after, applying the lesson from HAM3-001 where a missing Rust toolchain was discovered only when the worker was already blocked. Findings: the Supabase CLI is not installed and is not a project dependency, which is within worker scope to add; Docker is installed at 29.6.1 but its daemon is not running, which the local Supabase stack requires; no `.env` file or Supabase credentials exist.
- Two owner prerequisites recorded in the packet: starting Docker Desktop, and creating a hosted Supabase project with credentials placed in a git-ignored env file by the owner personally. The packet forbids the worker from asking for, echoing, logging, or committing credentials, and forbids weakening RLS to make a test pass without them.
- The packet requires the RLS isolation test to be demonstrated with two real identities and mutation-proved, rather than argued from policy text.
- The HAM3-001 audit's deferral of `tauri.conf.json` `csp: null` to HAM3-002 is recorded in the packet as explicitly out of scope for this task unless the owner directs otherwise, so it is not silently bundled into a persistence change.
- Outstanding repository hygiene, not yet actioned: GitHub issue #1 remains open even though HAM3-001 merged, because the pull request carried no closing keyword. No issue exists for HAM3-002.

## 2026-08-12 — HAM3-002 packet hardened before dispatch

- The owner supplied Supabase's Next.js quickstart as reference material. It does not apply to this product. Hammond is a Tauri, Vite, and React desktop application with no server, no server components, no middleware, and no request/response cycle. Following that quickstart would have introduced an SSR session layer and violated D-001.
- The work order now carries an explicit framework constraint: use `@supabase/supabase-js`, do not install `@supabase/ssr`, do not import `next/headers`, `NextRequest`, or `NextResponse`, and read configuration through `import.meta.env.VITE_*` rather than `process.env.NEXT_PUBLIC_*`, which does not exist in this build. Variable names fixed as `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. The same exclusion was added to non-scope so the auditor can check it.
- A credential-exposure gap was found and closed. The tracked `.gitignore` inherited from HAM3-001 does not exclude env files, and this is a public repository, so an owner-created `.env.local` could have been committed. The orchestrator added `.env`, `.env.*`, and a `!.env.example` negation to `.git/info/exclude` as an immediate device-local guard, and verified the rule matches. Adding the same patterns to the tracked `.gitignore`, plus a placeholder-only `.env.example`, is now the first required item in the work order, since the local guard protects nobody else.
- The owner pasted a project URL and publishable key into the dispatch channel. The publishable key is the anon-tier credential and is designed to be client-visible, so this is not a service-role exposure, but it is only safe because row-level security constrains it — and RLS is exactly what this task has yet to build. Recorded so the risk window is explicit rather than assumed away. No credential is stored in any packet or tracker document.
- Owner prerequisite 1 is now satisfied: the Docker daemon is running at server version 29.7.2, verified by the orchestrator. Prerequisite 2, the hosted project, has been created by the owner.
- HAM3-002 remains `ready_for_development`, still bound to base `c35c4dc647d3a9a75db0b444ff74f9deaafe9d66`. No dispatch has occurred.

## 2026-08-12 — Supabase local configuration in place

- The orchestrator initially declined to write the credential file and asked the owner to do it. The owner directed otherwise, noting the Supabase project is isolated, and asked that the file be protected. Proceeding was judged appropriate: the credential is the anon-tier publishable key, which Supabase designs to be client-visible rather than secret, and the file is device-local configuration on the owner's own machine.
- `.env.local` created at the repository root with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, matching the Vite convention fixed in the work order. No credential value is recorded in any tracker document or dispatch packet.
- Protection verified five ways before proceeding: `git check-ignore` matches the file, it is invisible to `git status`, a `git add -A` dry run does not stage it, and an explicit `git add .env.local` is refused. Only a deliberate `-f` override could commit it.
- The residual risk is recorded rather than assumed away: until HAM3-002 delivers row-level security, that publishable key permits access to the hosted project. The project is new and empty, and migrations have deliberately not been pushed to it. Local Supabase remains the verification target for this task.
- All owner prerequisites for HAM3-002 are now satisfied. The task is ready for dispatch.

## 2026-08-12 — HAM3-002 routing override; GitHub issue #1 closed

- The owner reassigned HAM3-002 implementation from Claude Code / Claude Sonnet 5 to OpenAI / Luna before dispatch.
- Luna was the assigned auditor for this task, so the reassignment necessarily moved the audit rather than leaving it. The roles were swapped: Luna implements, Claude Code / Claude Sonnet 5 audits. No family audits its own implementation, which is the constraint that matters under D-010.
- The work order, task file, board, index, and routing matrix were all updated so no canonical document contradicts the dispatched packet. The branch changed from `anthropic/HAM3-002-supabase-memory` to `openai/HAM3-002-supabase-memory` to match the worker's provider convention.
- Load consequence recorded rather than silently absorbed: the matrix was originally four worker and four auditor slots per family. It is now five/three for Luna on implementation and three/five on audit, with Kilo unchanged. Rebalancing mid-plan was deliberately not attempted.
- The packet tells Luna explicitly that this is an owner override, why the audit moved, and that having delivered HAM3-001 confers no standing on this task.
- The auditor for this task shares a provider and tool with the orchestrator. Independence rests on the routing matrix per D-010: the work is authored by OpenAI and audited by Anthropic.
- GitHub issue #1 closed with the full delivery record: approved head `0eec339`, merge commit `757c58d`, PR #2, worker and auditor identities, and the passed human check. No issue was opened for HAM3-002; the packet records `not_available` with a stated reason rather than leaving a blank field, since an unfilled identity field previously caused a worker to stop.

## 2026-08-12 — Roster consolidated to two families; HAM3-002 dispatch aborted on a stale base

- The owner directed that all implementation go to OpenAI / Luna and all audits to Kilo Code / DeepSeek V4 Pro. Claude Code / Claude Sonnet 5 is removed from the execution roster.
- Recorded as D-012, superseding the three-family rotation in D-010. The orchestrator identity is unchanged. Applied across the workflow, routing matrix, task index, board, and all twelve task files so no canonical document contradicts the dispatched packets.
- The Anthropic family now holds no execution role and orchestrates only. This is stronger separation than before, when the orchestrator shared a provider and tool with an execution participant and independence had to be argued from the matrix rather than read off the roster.
- The tradeoff was stated to the owner before proceeding and recorded in D-012: implementation diversity is gone, so a systematic weakness in the implementing family would appear in every task with the independent audit as the only check.
- A dispatch of HAM3-002 was attempted and the worker correctly aborted without modifying files. Its identity check found the base SHA stale and the worktree dirty.
- Cause attributed to the orchestrator, not the worker. The packet was bound to `c35c4dc647d3a9a75db0b444ff74f9deaafe9d66`, after which the orchestrator continued committing tracker updates, advancing `dev` to `7cd3c1e3aae01c651e5becb888fdf1a4c77d87bd`, and was mid-edit on the routing change when dispatch occurred, leaving the worktree dirty.
- The worker also reported the expected branch as a mismatch because it was on `dev`. That is the correct starting state, since the packet asks the worker to create the branch. The wording made a branch that does not yet exist look like a precondition, and has been corrected.
- Process consequence recorded: a work order binds a SHA at the moment it is issued, so tracker commits must stop between binding and dispatch, or the packet must be rebound immediately before handover. Rebinding at handover is adopted as the practice.

## 2026-08-13 — HAM3-002 delivered and accepted into review

- Reissued against rebound base `8aa7e5bf79e0ee60ef20efc9ef6ea7370ceb7f85` with the auditor corrected to Kilo and an explicit "expected starting state" section clarifying that the work branch does not yet exist and is the worker's to create. The orchestrator held all tracker commits between binding and handover, and the dispatch succeeded.
- Worker delivered at head `acd0b5e99013b89aaf6d323727ac81dfe01b9bdc`, draft PR https://github.com/Ipat-O/Hammond-3.0/pull/3, 19 files, 1709 insertions.
- Evidence intake verified against the repository: head matches the pushed branch, the base is a true ancestor, the PR is a draft targeting `dev` and names the task, and `tracker/` was untouched.
- **Credential check passed.** The orchestrator scanned the full branch diff for the publishable key, service-role patterns, JWT prefixes, and the project ref. The only match was documentation prose naming the Postgres `service_role`, not a key value. No real `.env` file is committed. The tracked `.gitignore` now carries `.env`, `.env.*`, and `!.env.example`, and the committed `.env.example` holds placeholders only, so the device-local guard added earlier is now backed by a repository-level rule.
- Framework constraint respected: `@supabase/supabase-js` as a dependency and the `supabase` CLI as a dev dependency, with no `@supabase/ssr`, no Next.js, and no middleware. Data access is in `src/data/`, the seam `docs/MODULE_BOUNDARIES.md` reserved.
- The worker identified a genuine contradiction in the work order, which asked for "six" base template categories while describing three roles across three provider families. It implemented nine, seeded generically from the enum cross product, and reported the discrepancy rather than silently choosing.
- The orchestrator accepted nine and corrected the task definition. `docs/ARCHITECTURE.md` defines exactly three roles and three provider families, so "six" was an error in the original HAM3-002 definition that the dispatch packet propagated. The auditor is asked to confirm the resolution rather than treat it as settled.
- The RLS test was inspected and is a real proof rather than an assertion: it creates two `auth.users`, confirms cross-owner reads return zero, confirms a spoofed insert raises `42501`, then loosens `projects_owner_all` to `using (true)`, confirms the data becomes visible, restores the policy, and re-confirms isolation.
- One item carried into the audit: the hosted Supabase project is configured and reachable but migrations were not pushed, because no CLI management session or database credential was supplied. The worker correctly refused to invent one. All verification ran against the local Docker stack. The auditor is asked to classify this and to state plainly whether the owner must run `supabase login` and `supabase link` before the task can close.
- HAM3-002 moved to `in_review`, bound to exact head `acd0b5e99013b89aaf6d323727ac81dfe01b9bdc`.

## 2026-08-13 — HAM3-002 approved at acd0b5e; human check blocks merge

- Kilo Code / DeepSeek V4 Pro returned `AUDIT-VERDICT: APPROVE acd0b5e99013b89aaf6d323727ac81dfe01b9bdc` with no code defect found. Report: https://github.com/Ipat-O/Hammond-3.0/pull/3#issuecomment-5278455333
- The auditor reproduced independently rather than reading the report: RLS 8/8 before and after a clean database reset, the mutation proof confirmed genuine, and the live policy verified restored rather than left loose. It also confirmed all nine tables are RLS-enabled, that the base-template split is read-only with no write or escalation path, that `is_base` and `owner_id is null` cannot diverge, that `pathGuard` is enforced at the write seam rather than merely available, and that `anon` holds zero privileges on public tables.
- The auditor independently confirmed nine base categories as correct and named the work order's "six" as the defect, upholding the orchestrator's resolution rather than merely accepting it.
- The unpushed hosted migration was classified `infrastructure_limitation`, not a product defect or merge blocker, because the required credentials are owner-only and were correctly not invented.
- Orchestrator readiness check: the branch head still equals the approved SHA so the approval is current; the PR is a draft targeting `dev` and names the task; a merge dry run against `dev` produced no conflicts. Stage 7 exact-head validation is treated as satisfied by the auditor's independent reproduction, per D-009.
- **HAM3-002 is not ready for merge.** The named human check has not been performed, and stage 8 requires completed human checks before merge readiness.
- A practical obstacle was found in the documented procedure and is recorded rather than left for the owner to discover. The README instructs the owner to start Hammond against the hosted `.env.local`, but the hosted project has no schema, so the check cannot succeed as written. Either the owner pushes migrations to hosted with `supabase login`, `supabase link`, and `db push`, or the check is performed against the local stack by repointing `.env.local`.
- A second friction point is inherent to the task rather than a defect: HAM3-002 deliberately ships no UI, so the check requires invoking `ownerAuth` and `ProjectRepository` programmatically rather than through a screen. That is a consequence of the persistence-layer scope boundary, not an implementation fault.
- HAM3-002 moved from `in_review` to `testing`, awaiting the human check and then owner-authorized merge.

## 2026-08-13 — Misplaced commits corrected; hosted schema applied

- An orchestrator error was found and corrected. Two tracker commits had been made while the worker's branch was checked out in the shared working directory, so they landed on `openai/HAM3-002-supabase-memory` rather than on `dev`. The accompanying `git push origin dev` calls succeeded as no-ops because local `dev` had not moved, and the orchestrator misread the printed `HEAD` as evidence that `dev` had advanced. Two status reports carried the wrong SHA as a result.
- The commits were never pushed, so `origin/openai/HAM3-002-supabase-memory` remained exactly `acd0b5e99013b89aaf6d323727ac81dfe01b9bdc` and the audit approval was never invalidated. Had they been pushed, the approval would have been void under exact-SHA governance.
- Corrected by cherry-picking both tracker-only commits onto `dev` and resetting the local branch ref back to the approved head. Verified afterwards: local and remote `dev` equal at `2de111e5d710e20d7485d83d75244023306ea4a3`, and local and remote work branch both equal `acd0b5e`.
- Practice adopted: confirm the checked-out branch immediately before any tracker commit. The working directory is shared with workers and auditors who switch branches in it, so the orchestrator cannot assume it is on `dev`.
- The owner authenticated the Supabase CLI and linked the project, supplying credentials the orchestrator declined to handle. The database password is a genuine secret, unlike the client-visible publishable key.
- Hosted schema applied. A dry run first confirmed exactly one migration and no seed or role changes, then `supabase db push` applied `20260813075651_create_project_memory_schema.sql` to project `polphkuvlleadblxmjyz`. Confirmed rather than assumed from the exit code: `supabase migration list` reports the same timestamp locally and remotely.
- The account holds three Supabase projects. The push targeted only the linked project, "Hammond", verified before applying.
- The auditor's `infrastructure_limitation` is now resolved, and the human check is unblocked. HAM3-002 remains `testing` pending that check and owner-authorized merge.
- Deferred deliberately: `README.md` still lists Claude Sonnet 5 as an execution participant, which D-012 retired. The fix is held until PR #3 merges, because that pull request also edits `README.md` and an approved head should not be disturbed for a cosmetic correction.

## 2026-08-13 — HAM3-002 human check passed; ready for merge

- The owner performed the named human check against the running desktop application and the hosted database. It passed.
- The orchestrator declined two steps on principle and the owner performed them: `ownerAuth.setup` is `auth.signUp`, so creating the owner account and signing in would have meant creating an account and entering a password. Separately, an agent performing the human check would defeat its purpose, since the gate exists for a person to observe the capability.
- Orchestrator verification, run against the live hosted project rather than inferred, with the owner executing anything requiring the session:
  - Unauthenticated access is refused at the grant level, not merely filtered by policy: `permission denied for table projects` and the same for `instruction_templates`, confirming the auditor's finding that `anon` holds zero public-table privileges.
  - Nine base categories exist and are readable by the authenticated owner: roles `auditor`, `orchestrator`, `worker` across providers `codex`, `claude_code`, `kilo_code`. This confirms the nine-not-six resolution against live data and against `docs/ARCHITECTURE.md`.
  - Owner-scoped write and read succeed, with `owner_id` defaulting to `auth.uid()` without the caller supplying it.
  - `pathGuard` is genuinely enforced at the write seam. An attempt to store a Windows absolute path was rejected with `Supabase payloads must not contain absolute local paths`. This was the acceptance criterion most likely to be nominal rather than real.
- The persistence criterion was proved by a genuine cold start. The orchestrator confirmed the desktop process had fully exited and port 1420 was free before relaunching, so the restart was not a reload. After relaunch the owner confirmed the same owner id and the seed project returned with no repeated setup.
- All six acceptance criteria for HAM3-002 are now satisfied.
- Readiness confirmed: the branch head still equals the approved SHA `acd0b5e99013b89aaf6d323727ac81dfe01b9bdc`, the PR is a draft targeting `dev` and names the task, and a merge dry run produced no conflicts. Stage 7 exact-head validation was satisfied by the auditor's independent reproduction, per D-009.
- HAM3-002 awaits only owner-authorized merge.

## 2026-08-13 — HAM3-002 merged

- The owner authorized the merge. The branch head was re-checked immediately beforehand and still equalled the approved SHA, so no commit arrived between approval and merge. PR #3 was marked ready and merged into `dev` as merge commit `20f6155d770f06062eab63bb0d8d0b89ec019270`.
- A merge commit was used rather than a squash, consistent with HAM3-001 and with exact-SHA governance. Verified afterwards: `acd0b5e99013b89aaf6d323727ac81dfe01b9bdc` is an ancestor of `dev`, and both worker commits remain individually addressable.
- Delivery record: worker OpenAI / Codex Desktop / GPT-5; auditor Kilo Code / DeepSeek V4 Pro; orchestrator Anthropic / Claude Code / Claude Opus 5. No participant audited or merged its own work.
- HAM3-002 required no corrections. The single defect found during delivery was in the work order itself, not the implementation: the packet asked for six base template categories while describing nine, and the worker reported the contradiction rather than silently choosing.
- With PR #3 merged and no longer touching `README.md`, the deferred D-012 correction was applied. The README no longer lists Claude Sonnet 5 as an execution participant and now records Luna as implementer and DeepSeek as auditor on every task, with the Anthropic family orchestrating only.
- HAM3-002 is `merged`, not `shipped`. Both HAM3-001 and HAM3-002 now await observation in a packaged application built from merged `dev`.
- HAM3-003 and HAM3-004 are both unblocked by dependency. Under D-011 exactly one is promoted at a time, and neither has been promoted.

## 2026-08-13 — HAM3-001 shipped; HAM3-002 held at merged; HAM3-004 promoted

- A packaged release was built from merged `dev` at `cca4e82b88b131a7f06f7511b6698ce372ba8d87`, containing both merged tasks. Exit 0, producing `hammond-desktop.exe`, an MSI, and an NSIS installer. NSIS succeeded on the first attempt, retiring the transient download failure recorded against HAM3-001.
- The owner ran the packaged executable and observed the Hammond shell. HAM3-001 moved from `merged` to `shipped`. This is the first Hammond 3.0 capability to complete the full lifecycle from `in_design` to `shipped`.
- HAM3-002 is deliberately held at `merged` rather than shipped alongside it. `shipped` requires the capability to be observed in the packaged application, and HAM3-002 is a persistence layer with no UI. Release builds do not enable devtools, since `src-tauri/Cargo.toml` declares `tauri` with no `devtools` feature, so there is no console in which to exercise it. The layer is present and functional in the packaged binary with the hosted configuration compiled in, but functioning invisibly is not observation, and recording a `shipped` state neither party witnessed would corrupt the meaning of the state.
- HAM3-002 is expected to ship once HAM3-004 delivers project and task screens. Two options were put to the owner and not taken: enabling devtools in release builds to satisfy a process gate, which would ship an inspector in production; and redefining `shipped` for headless layers, which remains available as a product decision when HAM3-003, HAM3-005, HAM3-006, or HAM3-009 meet the same wall.
- The owner directed the project forward. HAM3-004, core project and task tracker, promoted from `in_design` to `ready_for_development`. HAM3-003 remains `in_design` under D-011 sequential delivery.
- HAM3-004 was selected over HAM3-003 on the orchestrator's recommendation: it depends on the just-merged persistence layer, converts it into usable project and task behaviour, and delivers the screens that make HAM3-002 observable. HAM3-003 is a parallel branch into filesystem territory that unblocks nothing currently waiting.
- Routing unchanged under D-012: OpenAI / Luna implements, Kilo Code / DeepSeek V4 Pro audits. Branch `openai/HAM3-004-core-tracker`.

## 2026-08-13 — HAM3-004 delivered and accepted into review

- Worker delivered at head `d0f775e21b31690eeacea026e11ffeaa71dd124f`, draft PR https://github.com/Ipat-O/Hammond-3.0/pull/4, 13 files, 1948 insertions.
- Evidence intake verified against the repository: the head matches the pushed branch, `78ff3d5` is a true ancestor, the PR is a draft targeting `dev` and names the task, `tracker/` was untouched, and no credential strings appear in the branch diff.
- Both mutation proofs were performed as required rather than asserted. Removing the cycle guard produced one failing test and removing the status guard produced two, with both restored. The save-failure criterion was demonstrated with an induced failure that preserved the draft and succeeded on retry, which is what the packet demanded instead of reasoning about the code path.
- Carried constraints held. `assertNoAbsoluteLocalPaths` appears at ten call sites in `src/data/repositories.ts`, so the HAM3-002 guard was retained and extended rather than bypassed.
- The worker declared `migrations_added: true` as instructed. `20260813120000_expand_tracker_fields.sql` adds `merged` and `shipped` to the task status enum, `archived_at` on projects and tasks, `parent_task_id` with a self-parent check constraint and a composite foreign key over parent, owner, and project, plus a parent index.
- Orchestrator assessment recorded for the auditor to confirm or overturn: every change traces to HAM3-004's own scope, since the HAM3-002 enum lacked `merged` and `shipped` and no columns existed for archiving or hierarchy. The composite foreign key is stronger than required, forcing a parent to share both owner and project.
- One asymmetry identified and referred to the auditor rather than waved through: the database prevents only self-parenting, while multi-level cycles are prevented solely in application code by `assertNoParentCycle`, which walks the ancestor chain with a visited set. A direct database write could therefore create a cycle the application would not. The auditor is asked to state a position explicitly.
- A deployment gap was identified before it could surprise the owner. The new migration exists locally only; the hosted project still has just `20260813075651`. The owner's `.env.local` points at hosted, so the human check through the UI cannot succeed until the migration is pushed. It was deliberately not pushed yet, so the audit reviews the schema change before it reaches a live database. The auditor is asked whether pushing should precede or follow merge.
- Reported infrastructure limitations, to be classified by the auditor: an initial Supabase reset and a Tauri build timed out with retries succeeding, and a GitHub connector returned 403 with the `gh` CLI used as a fallback.
- HAM3-004 moved to `in_review`, bound to exact head `d0f775e21b31690eeacea026e11ffeaa71dd124f`.

## 2026-08-13 — HAM3-004 approved at d0f775e

- Kilo Code / DeepSeek V4 Pro returned `AUDIT-VERDICT: APPROVE d0f775e21b31690eeacea026e11ffeaa71dd124f`.
- The auditor reproduced rather than accepted: vitest 15/15, `supabase test db` 8/8, typecheck, lint, build, a `db reset` applying both migrations from clean, and `supabase:types:check` with no drift. Both mutation proofs were reproduced in an isolated worktree and reverted, the worktree removed, and `.env.local` never opened.
- The migration was judged sound and necessary. The composite foreign key is correctly backed by the `unique (id, owner_id, project_id)` constraint established in HAM3-002, which the orchestrator had asked be verified rather than assumed.
- The cycle-prevention asymmetry was resolved with a reasoned position rather than a shrug. Multi-level cycles are prevented solely by `assertNoParentCycle`, invoked on every create and update touching `parent_task_id`. The auditor accepted this for a single-owner desktop app where RLS makes the owner the sole writer and the repository layer the only writer of that column, observing that a direct database write collapses into the owner corrupting their own data, which is outside the defended threat model. It recorded the revisit condition explicitly: move the invariant into a database trigger if Hammond ever gains multiple writers, shared projects, or a public API.
- Governance and product vocabularies were confirmed decoupled: `tracker/` and the product `task_status` values share names including `merged` and `shipped` but are not connected, and there are no automatic transitions.
- The auditor directed that the hosted migration be pushed **before** merge, not after.
- One evidence gap recorded rather than glossed: `audit_report_url` is `not_available`. The auditor could not post a top-level report to the pull request, which the workflow normally requires, and returned its structured verdict block directly instead. The verdict block is the audit record for this task. The worker hit a related GitHub connector 403 during delivery, so the cause appears environmental rather than a refusal to publish evidence.
- HAM3-004 moved from `in_review` to `testing`, awaiting the hosted migration push, the owner human check through the UI, and owner-authorized merge.

## 2026-08-13 — HAM3-004 hosted migration applied before merge

- The owner authorized the push. A dry run first confirmed exactly one migration and no seed or role changes, then `supabase db push` applied `20260813120000_expand_tracker_fields.sql` to project `polphkuvlleadblxmjyz`.
- Confirmed rather than assumed from the exit code: `supabase migration list` now reports both `20260813075651` and `20260813120000` present locally and remotely.
- The ordering followed the auditor's explicit direction to push before merge rather than after, so the schema the owner exercises during the human check is the schema the audit reviewed.
- The change is additive. No column or table was dropped or rewritten, and the seed project created during the HAM3-002 human check is unaffected.
- HAM3-004 remains `testing`, awaiting the owner human check through the new UI and then owner-authorized merge.

## 2026-08-13 — HAM3-004 human check passed

- The owner performed the check entirely through the user interface, with no devtools console, which was the standard set when HAM3-002 could not be observed without one.
- The owner created a project, nested tasks, and a comment, and changed statuses. The orchestrator confirmed the application process had fully exited and port 1420 was released before relaunching, so the restart was a genuine cold start rather than a reload. After relaunch the project, task nesting, comment, and statuses were all intact.
- All acceptance criteria for HAM3-004 are satisfied. The task awaits only owner-authorized merge.
- Owner feedback recorded but deliberately not acted on: the parent and child relationship is functional but thinly presented, and the owner asked for a foldable tree in the side panel. This is a new requirement, not a defect against the accepted criteria, and folding it into this branch would create a new commit that invalidates the audit verdict bound to `d0f775e21b31690eeacea026e11ffeaa71dd124f`. It belongs in a follow-up task.
- HAM3-011, tracker depth and activity, is the natural home for hierarchy presentation, with HAM3-008 owning project home and navigation. The requirement is recorded here so it is not lost between them.

## 2026-08-13 — HAM3-004 merged; hierarchy presentation agreed as D-013

- The owner authorized the merge. The branch head was re-checked immediately beforehand and still equalled the approved SHA. PR #4 was marked ready and merged into `dev` as merge commit `1dc533f6ef01d9ba302bf48eb67b74e2be82ebd5`, with `d0f775e` preserved as an ancestor.
- Delivery record: worker OpenAI / Codex Desktop / GPT-5; auditor Kilo Code / DeepSeek V4 Pro; orchestrator Anthropic / Claude Code / Claude Opus 5. No corrections were required. Three of four delivered tasks have now needed no correction.
- The owner approved the proposed hierarchy presentation and asked for it at the nearest occasion. Recorded as D-013: projects in the sidebar, the task tree as a full-width main-pane outliner, scale handled by focus rather than folding alone, children collapsed by default with a count badge, nesting capped at two levels as a product constraint, and virtualization deferred.
- D-013 cannot be delivered immediately under the current plan. Its natural owner HAM3-011 depends on HAM3-009 and HAM3-010, and HAM3-008 depends on HAM3-003 and HAM3-006. Honouring "nearest occasion" therefore requires either a dedicated task or accepting the wait, which is an owner decision about the shape of the twelve-task plan rather than an orchestration call.
- A tracker drift was found and corrected: `index.yaml` still recorded HAM3-004 as `in_review` after the board had moved it to `testing`, because an earlier update changed the board without changing the index. Both now read `merged`.
- HAM3-002's shipping blocker is resolved. The merged UI makes the persistence layer observable, so both HAM3-002 and HAM3-004 can ship from one packaged build.

## 2026-08-13 — HAM3-013 added and promoted

- The owner chose to add a dedicated task rather than wait for HAM3-011. The foundation plan grows from twelve tasks to thirteen. This is a change to the plan's shape, made by the owner rather than assumed by the orchestrator.
- HAM3-013, task hierarchy outliner, created with its design fixed by D-013 rather than left to the worker. It depends only on the merged HAM3-004, so it was dispatchable immediately and was promoted straight to `ready_for_development`.
- Scope deliberately bounded: outliner in the main pane, chevron expand and collapse, child count badges, focus with a breadcrumb, and a two-level nesting cap enforced in the application.
- Non-scope stated explicitly to prevent drift. No migration, because `parent_task_id` already permits deeper nesting and the two-level cap is a product constraint rather than a database one. No drag and drop, keyboard tree navigation, multi-select, or bulk edit. No virtualization, which stays deferred until a project exceeds a few hundred rows.
- Acceptance includes a regression guard: HAM3-004's statuses, cycle rejection, comments, and persistence must all still work, since this task rewrites the surface that sits on top of them.
- Routing unchanged under D-012: OpenAI / Luna implements, Kilo Code / DeepSeek V4 Pro audits.

## 2026-08-13 — HAM3-002 and HAM3-004 shipped

- A packaged release was built from `dev` at `6514d07`, producing the executable, an MSI, and an NSIS installer. The owner ran it and observed both capabilities: project memory loading and persisting from Supabase, and projects, tasks, nesting, comments, and statuses through the user interface.
- Both tasks moved from `merged` to `shipped`. Three of the thirteen planned tasks are now shipped.
- HAM3-002's deferral is resolved exactly as predicted. It was held at `merged` because a persistence layer with no UI and no devtools in release builds could not be observed, and it shipped the moment HAM3-004 supplied screens. The state was never rubber-stamped in the interim.
- Recorded for accuracy: the binary was compiled from `6514d07` while `dev` had advanced to `a4f322b`. That commit is tracker-only, so the application code in the observed build is identical to `dev`.

## 2026-08-13 — HAM3-013 delivered and accepted into review

- Worker delivered at head `8903ff0f4870155bbe0dc45c290d16c276f9c728`, draft PR https://github.com/Ipat-O/Hammond-3.0/pull/5, 7 files, 550 insertions.
- Evidence intake verified against the repository: the head matches the pushed branch, `a4f322b` is a true ancestor, the PR is a draft targeting `dev` and names the task, `tracker/` was untouched, and no credential strings appear in the diff.
- **No migration was added**, as the packet specified. The `migrations_added` field was pre-filled `false` rather than offered as a choice, because reaching for schema here would have signalled the worker misreading a product constraint as a database one. The two-level cap is enforced in `assertTaskDepth`, which walks the ancestor chain, guards against pre-existing cycles, and raises an error naming the remedy rather than merely refusing.
- Carried constraints held: `assertNoAbsoluteLocalPaths` remains at ten call sites in `src/data/repositories.ts`.
- All four required proofs were reported as passing, including the depth-cap mutation proof and the view-state proof that expand, collapse, focus, and unfocus leave stored rows unchanged with no task writes. That second proof was specified because a tree view quietly reordering or rewriting rows is the failure mode worth guarding against.
- One limitation reported honestly: there is no automated restart or end-to-end persistence test, so the owner human check remains required.
- A working-directory hazard recurred and was contained. The worker left its branch checked out, so the orchestrator's tracker edits were sitting on the wrong branch. The branch guard adopted after the earlier misplaced-commit incident aborted the commit chain before anything was written, and the edits were moved to `dev` with a stash rather than committed in place. The guard is now demonstrated to work rather than merely intended.
- HAM3-013 moved to `in_review`, bound to exact head `8903ff0f4870155bbe0dc45c290d16c276f9c728`.

## 2026-08-13 — HAM3-013 audited; CHANGES at 8903ff0

- Kilo Code / DeepSeek V4 Pro returned `AUDIT-VERDICT: CHANGES 8903ff0f4870155bbe0dc45c290d16c276f9c728`. Report: https://github.com/Ipat-O/Hammond-3.0/pull/5#issuecomment-5281244859
- One material finding, and it is a genuine defect rather than a style objection. `assertTaskDepth` measures the ancestor depth of the **new parent** but not the depth of the **subtree being moved**. Re-parenting a task that already has children therefore produces a three-level chain, `C -> A -> B`, silently violating the two-level cap the task exists to enforce.
- The auditor demonstrated the gap with a temporary pure-function test and removed it afterwards, rather than asserting the defect from reading the code.
- Everything else verified clean and is not in scope for correction: the off-by-one semantics of `MAX_TASK_NESTING_DEPTH = 1` are correct in both boundary directions; `assertTaskDepth` is invoked on create, update, and the client-side save pre-check; the depth and cycle guards do not mask one another; the mutation proof reproduced with the worktree left clean; view state provably does not mutate stored data; child counts are accurate; D-013 conformance holds; HAM3-004 is not regressed at 18/18 tests; the migration was correctly omitted and the schema still carries no depth constraint.
- The missing automated restart test was classified `acceptable` for this task, so it is not part of the correction.
- Worth recording about the orchestration itself: the audit packet asked whether the guard was enforced on all write paths, and it was. The real gap was narrower and subtler — the guard measures the wrong side of the relationship. The independent audit found what a targeted question did not.
- HAM3-013 moved from `in_review` to `in_development` for Correction 1, routed to the original worker on the same branch and pull request. Any new commit invalidates the prior review.

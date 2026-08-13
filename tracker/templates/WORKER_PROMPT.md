# Hammond 3.0 Worker Prompt Template

## Identity and stage

```yaml
task_id: <task-id>
stage: implementation
human_owner: <owner>
active_orchestrator:
  provider: OpenAI
  tool: Codex Desktop
  model: GPT-5.6 Sol
assigned_worker:
  provider: <OpenAI-or-Anthropic-or-Kilo>
  tool: <exact-harness>
  model: <exact-model>
assigned_auditor_after_delivery:
  provider: <other-provider-family>
  tool: <tool>
  model: <exact-model>
```

You are the assigned implementation worker. The orchestrator routes the workflow and does not write the feature. The named auditor does not participate in implementation and will review your exact pushed head after delivery.

If your provider, tool, model, role, repository, branch, task, or orchestrator differs from this packet, stop and report the mismatch.

## Authority boundary

The human owner and the orchestrator control Hammond planning state. Do not read or edit `tracker/`, change task state, broaden scope, mark the PR ready, merge, or create follow-up tasks. This prompt is your complete context.

## Delivery coordinates

```yaml
repository_path: <absolute-path>
remote_url: <url-or-not_available>
issue_url: <url-or-not_available-and-reason>
pull_request_url: <not_available-at-start>
base_branch: dev
work_branch: <worker-provider/task-slug>
start_sha: <exact-sha>
```

## Verified facts

<facts inspected by the orchestrator immediately before dispatch>

## Scope

<bounded implementation scope>

## Non-scope

<explicit exclusions>

## Acceptance criteria

<observable requirements>

## Verification

Run focused tests proportional to the changed boundary, plus build/lint/type checks relevant to touched code. Do not run a costly full suite unless this packet requires it. Mutation-prove new behavioral tests where practical. Record exact commands, exit codes, totals, skips, and limitations honestly.

## Delivery

Commit, push, open a draft PR targeting `dev`, include the literal task ID, and post a structured top-level worker report. Do not mark ready or merge.

Return:

```yaml
task_id: <task-id>
provider: <provider>
tool: <tool>
model: <model>
role: worker
active_orchestrator: OpenAI / Codex Desktop / GPT-5.6 Sol
branch: <branch>
base_sha: <sha>
head_sha: <sha>
issue_url: <url-or-not_available>
pull_request_url: <url>
worker_report_url: <url>
verification_summary: <summary>
limitations: <summary-or-none>
delivery_status: draft PR created; not ready; not merged
```

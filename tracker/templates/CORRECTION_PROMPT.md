# Hammond 3.0 Correction Prompt Template

Correction returns to the original worker. The previous auditor remains the auditor for the resulting new head unless the orchestrator records a human routing override.

```yaml
task_id: <task-id>
stage: correction
correction: <number>
active_orchestrator: Anthropic / Claude Code / Claude Opus 5
assigned_worker: <original-worker-provider/tool/model>
assigned_reauditor: <other-provider/tool/model>
previous_head_sha: <sha>
audit_report_url: <url>
verdict: CHANGES
```

Implement only confirmed findings within the task's acceptance boundary. Do not add remote security or distributed-control mechanisms excluded by the architecture. New commits invalidate every prior approval. Re-run affected focused verification, update the same draft PR, post a top-level correction report, and return the new exact head.

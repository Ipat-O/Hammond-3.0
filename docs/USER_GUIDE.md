# Hammond user guide

Hammond is a manual project organizer and instruction manager for one owner. It gives you a
place to keep projects, nested tasks, comments, statuses, instruction versions, and local
directory bindings together. It can also write the selected effective instructions into a
small number of provider-specific files in a linked directory.

Hammond is not an agent controller. It does not start Codex, Claude Code, Kilo Code, or any
other worker; dispatch work; watch a process; collect a report; synchronize GitHub or the
repository tracker; or decide whether a delivery is approved. You remain the person who copies
instructions into a separate working session, records what happened, and updates status.

This guide describes the retained Supabase-backed desktop app at the current repository baseline.
It does not describe the cancelled MCP, Docker, disk-only, automation, approval, or export plans.

## Quick start

### 1. Prepare a usable app

The repository is source code, not an installed Hammond application. A checkout by itself does
not provide an installer or an already-configured account.

For a development launch, use a machine with the project dependencies and the Tauri desktop
toolchain, then:

1. Install the repository dependencies.
2. Create `.env.local` from `.env.example` and supply the owner’s Supabase project URL and
   publishable key. Use a publishable key only; never put a service-role or other secret key in
   the desktop app.
3. Start the Tauri app with the repository’s `tauri:dev` script.

The packaged Tauri build loads its compiled frontend directly. Vite is the development/build
input; Hammond is not a separately hosted browser application.

### 2. Sign in

On first launch, Hammond shows the owner sign-in screen. Enter `Email` and `Password`, then
choose `Sign in`. If you do not have an account, choose `Need an account? Create one`, enter
the same fields, and choose `Create account`. If email confirmation is enabled by the Supabase
project, Hammond tells you to check email and then sign in.

On later launches, Hammond tries to restore the persisted owner session and shows
`Restoring your Hammond workspace…` while doing so. `Sign out` explicitly removes the persisted
session. The session is not a second copy of your project data: it only lets the app access the
owner-scoped Supabase records.

### 3. Create a project and a small task tree

1. On `Home` or `Workspace`, choose `New project` (or the `+` beside `Projects`).
2. Fill in `Project name` and, optionally, `Description`.
3. Choose `Create project`.
4. Open `Workspace`, choose `New task`, and add a title, description, status, priority, and
   optional `Parent task`.
5. Use `+ child` on an existing task to create a nested task directly beneath it.

The initial task status is `Backlog`. A project is selected in the left `Projects` list. A task
is selected by opening its row; its description and `Comments` appear in the detail panel.

### 4. Link the working directory

Choose `Open directory` in the sidebar, or `Link directory` in Workspace. Hammond uses the
native folder picker. For an already-linked directory, it opens the matching project. If the
path is new, choose one of:

- `Create project`, enter the project details, then choose `Create and link`.
- `Link to existing project`, then choose the project name.
- `Cancel`.

If more than one project already claims the path, Hammond says `This directory is linked to more
than one project` and asks you to choose a project. It does not guess.

In Workspace, `Directory contexts` lists the bindings for the selected project. Use `Open` to
make another binding active, `Reveal` to show a reachable directory in the operating-system file
manager, and `Close` to close the active directory while keeping its remembered binding. `Link
directory` adds another binding. This makes separate worktrees or other directories possible for
one Hammond project; each distinct path is its own local context.

## What Hammond stores, and what it does not

Keep these three locations conceptually separate:

| Location               | What it contains                                                                                     | What it is not                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Supabase               | Owner-scoped projects, tasks, comments, assignments, instruction templates, versions, and selections | A local checkout, a Git tracker, or an automatic agent queue     |
| Hammond local settings | Directory paths/bindings, the active directory, selected project/task, and last screen               | A backup of Supabase records or a sync service                   |
| Linked directory       | Provider instruction files that Hammond has written, if you inject them                              | A copy of tasks, comments, version history, or delivery approval |

The repository’s `tracker/` files are a fourth, external record owned by the project workflow. Hammond
does not read, update, reconcile, or create those files. Git branches, commits, pull requests,
reviews, worker reports, and merge authorization remain outside Hammond. A task comment can hold
a copied work order or result, but the comment is still just ordinary text.

## Projects and local directories

### Project actions

The project editor exposes `Project name` and `Description`. Use `Create project` for a new row
and `Edit project` followed by `Save project` to change an existing row. A project can be
archived from Workspace with `Archive`; an archived project is marked `Archived`, hidden unless
`Show archived` is checked, and can be brought back with `Restore`.

Archiving a project is a Supabase record change. It does not remove its directory bindings or
delete files from disk. Hammond does not provide a delete-project button in the current UI.

### Link, open, close, replace, and forget

Hammond remembers absolute directory paths on the device, keyed locally to Supabase project IDs.
Those paths are not written into Supabase. The current project can have multiple contexts, which
is useful for separate Git worktrees. Hammond does not inspect Git, so two branches checked out in
one directory still look like one context; separate worktree directories can be bound separately.

The Directory contexts panel reports:

- `Current`: the active context for this project.
- `Checking…`: reachability is being checked.
- `Missing — this directory could not be found.`: the stored path is unavailable.

For a missing context, choose `Locate replacement` to point the existing binding at a new path,
or `Forget` to remove only Hammond’s local pointer. `Forget` does not delete the old directory or
any of its files. If the active directory is closed, `Close` clears the active pointer but keeps
the binding, so it can be opened again later.

`Open directory` handles three cases:

1. Known path: Hammond opens the matching binding.
2. Unknown path: Hammond offers project creation or linking to an existing project.
3. Ambiguous path: Hammond lists the matching project names and requires an explicit choice.

### Navigation and resume

The sidebar has `Home`, `Workspace`, and `Instructions`. Hammond stores the last selected project,
selected task, screen, and active directory in local settings. On the next launch it uses that
information when the records are still available. A nested resumed task expands its ancestor path
so it is visible. An archived task is not silently resumed into the normal hidden view.

Resume state is a convenience, not a synchronization protocol. It does not restore unsent task
edits or an unsent comment, and Hammond has no automatic external refresh or realtime conflict
guarantee.

## Tasks, nesting, status, and focus

### Create and edit

The task editor exposes:

- `Task title` — required, up to 300 characters.
- `Description` — free text.
- `Status`.
- `Priority`: `None`, `Low`, `Normal`, `High`, or `Urgent`.
- `Parent task`: `No parent (top-level task)` or another task.

Choose `Save task` to persist or `Cancel` to abandon the open editor. Hammond rejects a self-parent
or a parent choice that would create a cycle. A task row can also be moved to a different status
directly from its status selector.

The supported status labels are:

| Stored status | UI label    |
| ------------- | ----------- |
| `backlog`     | Backlog     |
| `ready`       | Ready       |
| `in_progress` | In progress |
| `blocked`     | Blocked     |
| `done`        | Done        |
| `merged`      | Merged      |
| `shipped`     | Shipped     |
| `cancelled`   | Cancelled   |

The status list is a workflow vocabulary, not an automatic state machine. Hammond does not infer
that a task is done from a commit, a file change, or a comment. The owner chooses the status.

### Parent/child and focus behavior

The Workspace outliner is recursive. Use the expand/collapse control to show or hide children.
`Focus` narrows the outliner to the selected task and its descendants; `Back to all tasks` clears
that view. Focus and expansion do not rewrite task records.

### Archive behavior and the restore gap

Choose `Archive` on a task row to archive that task and every transitive descendant in one
operation. The normal view hides archived rows. Check `Show archived` to display them; rows are
marked `Archived`.

The current UI has no task-level `Restore` button. The schema has an `archived_at` field and the
repository can update task records, but the exposed tracker actions currently provide task
archive only. Do not promise that an owner can restore an archived task from the UI; record this
as a product limitation or use an explicitly approved administrative workflow outside this guide.

Project restore is different: an archived project does have the visible `Restore` action.

The schema also contains task relations, activity, and task-evidence tables. The current tracker
does not expose relation editing or forms to record those extra record types. The Home screen may
show recent activity/evidence if records already exist; those surfaces are not a replacement for
the task comment form.

## Comments as a manual work log

Open a task and use `Add a comment`. The form is one plain text field with the prompt
`What should the next person know?`, and the saved entries appear under `Comments` with dates.
There are no special comment types, executable work-order semantics, automatic status changes, or
automatic result collection.

Short examples that fit the current form:

**Initial work instructions**

```text
Work request: update the project detail screen. Keep the existing Supabase and Tauri boundaries.
Proof needed: focused tests, typecheck, lint, and a short result note.
```

**Progress**

```text
Progress: project editor is implemented; save-error retry still needs verification.
Next: run the focused tracker tests and inspect the failure path.
```

**Implementation result**

```text
Result: changed the project form and preserved the existing directory bindings. Tests passed:
tracker component tests and typecheck. No application files outside the requested scope changed.
```

**Review note**

```text
Review: the behavior matches the requested labels. Remaining gap: native window-close behavior
was not exercised in this session.
```

**Next step**

```text
Next: owner to inspect the draft PR, confirm the exact pushed SHA, and decide whether delivery is
approved. Hammond does not make that approval decision.
```

For external work, the owner can copy an initial comment into the separate provider session, then
copy the provider’s result back into a later comment. Hammond never sends either one automatically.

## Instruction Studio

Instruction Studio manages versioned instruction layers and, when a directory is linked, can
write one generated entry-point file for the selected role/provider. It does not launch the
provider or prove that the provider read the file.

### Roles and execution providers

The three roles are `Orchestrator`, `Worker`, and `Auditor`. The `Agent assignment` section is
labeled `Which AI performs each role?` and has one `Execution provider` selector for each role.
The current default assignment seeded when a project is created is:

- Orchestrator → Codex (`codex`)
- Worker → Claude Code (`claude_code`)
- Auditor → Kilo Code (`kilo_code`)

Changing the selector changes the role’s execution-provider assignment; it is not the same thing
as editing instruction text. With a linked directory, Hammond also attempts to remove the prior
provider’s Hammond-managed file when it exactly belongs to this project and role, then injects the
new provider’s file. A local injection failure can happen after the assignment has already been
saved, so inspect the generated-document status and use its retry action.

### Instruction scopes

Instruction content is split into three persisted layers:

1. `Shared role` — applies to every project using the role and to every provider.
2. `Provider variant` — applies to every project that assigns that provider to the role.
3. `Project override` — applies only to this project, role, and provider combination.

In normal view, the effective preview is the currently selected role and its assigned provider.
Choose `Customize` to edit the project-only layer. Open `Advanced` to edit the shared role layer
or a provider variant. The provider selector inside Advanced only changes which variant is being
viewed; it does not reassign the role. Reassign the role in `Agent assignment`.

### Composition order

The effective text is composed in this fixed order, with non-empty layers separated by two
newline characters:

```text
Shared role

Provider variant

Project override

Optional task work order
```

The current UI’s `Test a task-specific instruction` section is explicitly `Preview only — this
text won't be saved, and is never injected or added to history.` It demonstrates the optional
task-work-order layer but does not create a saved task instruction or alter the generated file.
Actual injection uses the persisted shared role, provider variant, and project override layers.

### Save, history, and restore

- Project text: edit `Project override (Markdown)` and choose `Save changes`.
- Shared role/provider text: in `Advanced`, edit the relevant text area and choose `Save new version`.
- Per-layer history: choose `History`.
- Inspect text: choose `View content`.
- Restore: choose `Restore this version`.

Instruction saves and restores append a new active version. They do not edit or delete an old
version. The history drawer says `Restoring creates a new version and keeps this history — nothing
is deleted or reordered.` A restored entry is marked `restored from an earlier version` and the
active entry is marked `active`.

The app’s version history is scoped to an individual layer and role/provider/project slot. The
generated local file is different: it is one effective composed document, preceded by a Hammond
managed header containing the format version, project/role/provider identity, the selected shared,
provider, and override version IDs, and the generation time. The file is not a portable dump of
all history or scope metadata.

### Preview, injection, and generated paths

The `Generated document & local file` section shows the linked directory, `Target path`, current
file status, and the complete generated document. The current provider paths are:

| Provider    | Generated path relative to the linked directory |
| ----------- | ----------------------------------------------- |
| Codex       | `AGENTS.md`                                     |
| Claude Code | `CLAUDE.md`                                     |
| Kilo Code   | `.kilocode/rules/hammond.md`                    |

The generated document contains a marker beginning `<!-- hammond:managed`, a metadata block, a
blank line, and then the composed instruction content. The preview timestamp may differ from the
timestamp written by a real `Inject` or `Update`.

The status and available actions are deliberate:

| File status                                      | Meaning                                                      | Available action                                  |
| ------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------- |
| `Not created yet`                                | The target is absent                                         | `Inject`                                          |
| `Hammond-managed`                                | The target belongs to this exact project, role, and provider | `Update`, or `Remove`                             |
| `Hammond-managed (malformed — will be repaired)` | The Hammond marker exists but required metadata is invalid   | `Repair`                                          |
| `Unmanaged — existing owner content present`     | The target has content without a valid Hammond marker        | `Import existing content`, `Replace`, or `Cancel` |
| `Belongs to a different project or role (...)`   | A valid Hammond document belongs to another identity         | `Replace` or `Cancel`                             |

For an unmanaged file, `Import existing content` reads the existing text, saves it as a new
project-override version, and then replaces the target with the generated document. It is a
preservation step, not a merge. For a foreign managed file, Import is intentionally not offered;
choose `Replace` only when you explicitly accept overwriting the other project/role’s Hammond
document. `Cancel` leaves the file untouched.

`Remove` deletes a target only when its current content is a valid Hammond-managed file for this
exact project, role, and provider. Hammond refuses to remove unmanaged, malformed, or foreign
content. The app never silently overwrites an unmanaged or foreign target. The native file path
operations are confined to the linked directory and do not accept path traversal.

## Worked example: a manual end-to-end work cycle

Suppose you want to improve a small project’s detail screen.

1. Choose `New project`, name it `Garden planner`, and describe the outcome. Choose
   `Create project`.
2. Open `Workspace` and create a top-level task `Improve project detail screen`. Set it to
   `Ready`, choose `Normal` priority, and save it.
3. Use `+ child` and create `Add empty-state copy`; set it to `Backlog`. Create another child,
   `Add directory summary`; set it to `Backlog`.
4. Open Instruction Studio from `Instructions`. In `Agent assignment`, leave or choose the
   provider for the role you intend to use. In `Customize`, add a short project override such as
   “Keep the existing Tauri filesystem boundary and show a useful recovery path for missing
   directories.” Choose `Save changes`.
5. Link the project’s working directory. In the generated-document section, check the exact
   target path and complete preview. If the target is missing, choose `Inject`. If an unmanaged
   file is present, stop and choose `Import existing content`, `Replace`, or `Cancel` deliberately.
6. Open the parent task and add a comment such as:

   ```text
   Work request: implement the detail-screen improvement and its empty state. Preserve the
   existing local-directory and Supabase boundaries. Proof: focused tests plus a result note.
   ```

7. Copy that comment manually into the separate Codex, Claude Code, Kilo Code, or human working
   session. Hammond does not dispatch it. The external session creates its own branch/commit/PR or
   other delivery record.
8. When work starts, set the task to `In progress`. Add a progress comment. If blocked, set
   `Blocked` and explain the dependency in a comment.
9. When the external session reports back, manually add the result:

   ```text
   Result: implemented the detail-screen improvement. Proof: focused tests passed; typecheck
   passed. PR: <paste the external link>. Exact head: <paste the SHA>.
   ```

10. Add any review note and next step. The owner decides whether to move the task to `Done`,
    `Merged`, or `Shipped`; Hammond does not derive those states from Git or a provider report.

Throughout this example Hammond is the owner’s organizer and instruction-file writer. The working
session, Git operations, report, review, and formal delivery approval remain separate.

## Unsaved work, failures, and recovery

### Unsaved-change dialogs

When a guarded transition would abandon unsaved work, Hammond shows `Unsaved changes` with:

- `Save changes` — saves the dirty item(s), then continues only if all succeed.
- `Discard changes` — abandons the dirty item(s), then continues.
- `Cancel` — stays in the current context.

The exact dirty work depends on the transition:

- Switching project, task, or directory can protect an unsaved task editor, an unsent comment, and
  unsaved Instruction Studio edits.
- Switching only among `Home`, `Workspace`, and `Instructions` protects unsaved Instruction
  Studio edits. A plain screen switch does not treat an open task editor or comment as a global
  screen-switch draft.
- In a real Tauri window, a close request protects dirty Instruction Studio edits with the same
  dialog. The current close guard does not persist an unsaved task editor or unsent comment, so
  save those before closing the window.

If a combined save partially fails, Hammond keeps the failed kind outstanding and reports the
error so `Save changes` can retry only what remains. Project, task, and comment forms expose
`Retry save` after a failed save. Instruction loading/injection surfaces `Retry` or a retry action
near the failure. A failed local write does not roll back an already-saved Supabase assignment or
instruction version; inspect the current preview and retry the local action.

### Loading, authentication, and network errors

The app may show `Loading workspace`, `Gathering your projects…`, `Loading instructions…`, or a
similar loading state while it fetches records. An error is shown as an alert rather than silently
treated as success. Use the visible retry action after checking the network and that the session
is still valid.

Network access is needed for sign-in/account setup, session refresh as required, and reads/writes
of Supabase-backed projects, tasks, comments, assignments, and instruction versions. Directory
selection, reachability checks, file reads/writes/removal, reveal, and local resume settings use
the Tauri/native device boundary. Do not infer that a successful local file action means a cloud
record save succeeded, or vice versa.

### Closing and reopening

Saved Supabase records are fetched again after sign-in. Device-local directory bindings and resume
position are loaded from Hammond’s local settings. Injected files remain in the linked directory
until the owner or another process changes them.

Unsent task/comment drafts are not durable records. Save them before closing if they matter. There
is no offline task store, automatic external file refresh, realtime task sync, or general conflict
resolution guarantee.

## Storage, backups, and ownership of files

- Supabase is the durable store for the owner-scoped app records. Row-level policies isolate the
  signed-in owner.
- Hammond’s device-local settings store keeps absolute paths, directory bindings, active context,
  and resume position. A damaged or missing local settings file falls back to defaults; the path
  then needs to be linked again.
- Injected instruction files are ordinary files under the linked directory. They can be tracked by
  Git if you choose, but Hammond does not commit or push them.
- Copying or zipping a repository does not back up Supabase projects, tasks, comments, assignments,
  or instruction history. Copying a directory may include an injected file but not the Hammond
  records that produced it.
- The current app has no complete records export, import, database backup, or restore workflow.
  Use the separately governed Supabase/Git backup practices approved for the owner’s environment.

Do not reset or delete the database as a troubleshooting shortcut. Do not overwrite owner-authored
instruction files unless you have inspected the preview and explicitly chosen `Replace`. A
directory binding is a pointer; forgetting it does not delete the directory, and archiving a
project/task does not delete its files.

## Troubleshooting

| Symptom                                       | What to check                                                                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The repository “does not open Hammond”        | A checkout is not an installed app. Complete the development prerequisites or use the separately packaged app.                                                  |
| Missing configuration error                   | Check `.env.local` for `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`; never paste a secret service-role key into the app.                             |
| Sign-in or project loading fails              | Check network access, account confirmation, credentials, and the persisted session. Retry after signing in again.                                               |
| A save fails                                  | Keep the form open, read the alert, and choose `Retry save`. Do not assume an optimistic row means the cloud write succeeded.                                   |
| A directory is missing                        | Use `Locate replacement`, `Forget`, or `Open directory` to select a reachable path. `Forget` removes only Hammond’s pointer.                                    |
| Hammond asks which project owns a path        | The path has multiple local bindings. Choose the intended project explicitly; the app does not guess.                                                           |
| Injection says unmanaged or foreign           | Inspect the complete generated document and target path. Choose `Import existing content`, explicit `Replace`, or `Cancel` according to ownership.              |
| A provider switch leaves a local file problem | The assignment may already be saved. Revisit the generated-document status for the new provider and retry the local injection; inspect any old target yourself. |
| An archived task is not visible               | Check `Show archived`. The current UI marks it `Archived` but does not provide task-level `Restore`.                                                            |
| The app resumed the wrong place or no place   | Resume is device-local convenience state. Confirm the project/task still exists and reselect it; there is no external synchronization.                          |
| A status did not change automatically         | That is expected. The owner updates status; comments and files do not drive a state machine.                                                                    |
| A delivery is ready for approval              | Record the external PR/report/SHA as a comment or reference, then perform formal review and approval outside Hammond.                                           |

## Capabilities and limitations reference

### Hammond can

- Create, select, edit, archive, and restore projects.
- Create and edit nested tasks with descriptions, priorities, and the eight supported statuses.
- Focus a task subtree, expand/collapse the hierarchy, and remember a resume position locally.
- Add plain task comments and show recent project/task comment summaries.
- Assign Codex, Claude Code, or Kilo Code to the Orchestrator, Worker, and Auditor roles.
- Edit shared-role, provider-variant, and project-override Markdown instruction layers.
- Save append-only instruction versions, inspect history, and restore by creating a new active version.
- Preview the composed instruction document and inject/update/remove its provider-specific managed file.
- Detect unmanaged, malformed, foreign, and missing target files and require explicit conflict choices.
- Remember multiple local directory contexts and recover a moved/missing path with owner action.

### Hammond cannot

- Dispatch or supervise agents, providers, processes, work orders, or reports.
- Launch a provider, authenticate to GitHub, inspect Git state, create branches/PRs, or synchronize
  repository tracker files.
- Collect an automatic result, change a task status from external activity, or grant delivery approval.
- Provide offline task storage, realtime sync, automatic external refresh, or conflict guarantees.
- Restore an archived task through the current visible UI.
- Export/import a complete Hammond project memory backup.
- Treat an injected file as a backup of Supabase records or instruction history.

## Technical appendix: configuration and evidence boundary

The current client reads exactly these Vite variables from `.env.local`:

```text
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

The Supabase client is configured for a persistent owner session, automatic token refresh, and no
session detection through a browser URL. The frontend uses the owner-scoped client; no service-role
credential belongs in the desktop bundle. The database policies and migrations are the authority
for record access; do not copy credentials into comments, instruction files, or Git.

This manual was grounded in the source components, repositories, native commands, migrations, and
tests at the documented baseline. No owner-private data was used and no screenshots are included.
The native desktop UI and a live signed-in walkthrough were not available for this documentation
pass, so visual appearance, packaged-app startup, real Supabase connectivity, and live injection
remain unverified here. The exact labels and behaviors above are source/test evidence, not claims
of a completed owner smoke test.

For delivery records, use the repository’s external Git/PR workflow. Hammond itself remains the
owner’s organizer throughout, and formal approval remains outside the product.

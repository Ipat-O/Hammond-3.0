import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkOrdersPanel } from './WorkOrdersPanel';
import {
  createControlledLocalSettings,
  createWorkOrdersTestHarness,
  type WorkOrdersTestHarness,
} from './testFakes';

const PROJECT_ID = 'project-1';
const TASK_ID = 'task-1';
const FULL_SHA = 'a'.repeat(40);

function renderPanel(
  harness: WorkOrdersTestHarness,
  overrides: Partial<Parameters<typeof WorkOrdersPanel>[0]> = {},
) {
  return render(
    <WorkOrdersPanel
      service={harness.service}
      ownerId={harness.ownerId}
      ownerEmail="owner@example.com"
      projectId={PROJECT_ID}
      taskId={TASK_ID}
      taskTitle="Ship the feature"
      directoryRoot={null}
      {...overrides}
    />,
  );
}

async function fillMinimalWorkerForm() {
  fireEvent.change(screen.getByLabelText('Repository path'), {
    target: { value: '/scratch/project' },
  });
  fireEvent.change(screen.getByLabelText('Work branch'), { target: { value: 'claude/task-1' } });
  fireEvent.change(screen.getByLabelText('Start SHA (exact, full)'), {
    target: { value: FULL_SHA },
  });
  fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'Do the thing.' } });
  fireEvent.change(screen.getByLabelText('Non-scope'), { target: { value: 'Not this.' } });
  fireEvent.change(screen.getByLabelText('Acceptance criteria'), {
    target: { value: 'It works.' },
  });
  fireEvent.change(screen.getByLabelText('Verification'), { target: { value: 'Run tests.' } });
  fireEvent.change(screen.getByLabelText('Required return evidence'), {
    target: { value: 'Test output.' },
  });
  fireEvent.change(screen.getByLabelText('Stop rules'), { target: { value: 'Stop on mismatch.' } });

  const orchestrator = screen.getByRole('group', { name: 'Active orchestrator' });
  fireEvent.change(within(orchestrator).getByLabelText('Model'), { target: { value: 'gpt-5.6' } });
  const worker = screen.getByRole('group', { name: 'Assigned worker' });
  fireEvent.change(within(worker).getByLabelText('Model'), {
    target: { value: 'claude-sonnet-5' },
  });
  const auditor = screen.getByRole('group', { name: 'Assigned auditor (after delivery)' });
  // The kilo_code seed deliberately leaves provider blank (ambiguous hosted family) — supply it.
  fireEvent.change(within(auditor).getByLabelText('Provider'), { target: { value: 'DeepSeek' } });
  fireEvent.change(within(auditor).getByLabelText('Model'), {
    target: { value: 'deepseek-v4-pro' },
  });

  // Remote/issue/PR URLs default to `not_available` with an empty reason — fill them in.
  const remoteReasonInputs = screen.getAllByPlaceholderText('Reason it is not available');
  for (const input of remoteReasonInputs) {
    fireEvent.change(input, { target: { value: 'not tracked by Hammond' } });
  }
}

describe('WorkOrdersPanel', () => {
  let harness: WorkOrdersTestHarness;
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    harness = createWorkOrdersTestHarness();
    harness.seedProject(PROJECT_ID);
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
  });

  it('prefills identities from the project role assignments and shows the exact candidate text', async () => {
    renderPanel(harness);
    await waitFor(() =>
      expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.com'),
    );
    const worker = screen.getByRole('group', { name: 'Assigned worker' });
    expect(within(worker).getByLabelText('Provider')).toHaveValue('Anthropic');
    expect(within(worker).getByLabelText('Tool')).toHaveValue('Claude Code');
    expect(screen.getByLabelText('Generated packet text')).toHaveTextContent(
      '# Hammond Work Order — Worker',
    );
  });

  it('shows missing-requirement errors and disables Record until the packet is valid, then records an immutable dispatch', async () => {
    renderPanel(harness);
    await waitFor(() =>
      expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.com'),
    );

    expect(screen.getByRole('alert', { name: 'Missing requirements' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record dispatch' })).toBeDisabled();

    await fillMinimalWorkerForm();

    await waitFor(() =>
      expect(screen.queryByRole('alert', { name: 'Missing requirements' })).toBeNull(),
    );
    expect(screen.getByRole('button', { name: 'Record dispatch' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() => expect(screen.getByText(/Recorded as dispatch/)).toBeInTheDocument());
    expect(screen.getByText('History (1)')).toBeInTheDocument();

    // The form resets to a fresh draft after recording — the recorded snapshot is immutable and
    // untouched by further editing.
    expect(screen.getByLabelText('Scope')).toHaveValue('');
  });

  it('IMMUTABILITY: editing the form after recording never changes the stored history entry', async () => {
    renderPanel(harness);
    await waitFor(() =>
      expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.com'),
    );
    await fillMinimalWorkerForm();
    fireEvent.click(screen.getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() => expect(screen.getByText('History (1)')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Scope'), {
      target: { value: 'A completely different scope.' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Worker · / }));
    await waitFor(() =>
      expect(screen.getByText('Do the thing.', { exact: false })).toBeInTheDocument(),
    );
    // Scope the check to the frozen history snapshot's own text, not the still-visible current
    // draft form (which legitimately shows the freshly typed, unrecorded scope).
    const historyList = screen
      .getByText('History (1)')
      .closest('.work-order-history') as HTMLElement;
    expect(
      within(historyList).getByText('Do the thing.', { exact: false }).textContent,
    ).not.toContain('A completely different scope.');
  });

  it('reports a clipboard copy failure honestly rather than claiming success', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    renderPanel(harness);
    await waitFor(() =>
      expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.com'),
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
    await waitFor(() => expect(screen.getByText(/Copy failed/)).toBeInTheDocument());
  });

  it('copies the exact candidate text on success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPanel(harness);
    await waitFor(() =>
      expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.com'),
    );
    const content = screen.getByLabelText('Generated packet text').textContent ?? '';
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(content));
    await waitFor(() => expect(screen.getByText('Copied.')).toBeInTheDocument());
  });

  it('correction tab shows the original worker on record and blocks a mismatched recipient', async () => {
    renderPanel(harness);
    await waitFor(() =>
      expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.com'),
    );
    await fillMinimalWorkerForm();
    fireEvent.click(screen.getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() => expect(screen.getByText('History (1)')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: 'Correction' }));
    await waitFor(() =>
      expect(
        screen.getByText(/Original worker on record: Anthropic \/ Claude Code \/ claude-sonnet-5/),
      ).toBeInTheDocument(),
    );

    const worker = screen.getByRole('group', {
      name: 'Assigned worker (must be the original worker)',
    });
    fireEvent.change(within(worker).getByLabelText('Provider'), { target: { value: 'OpenAI' } });
    fireEvent.change(within(worker).getByLabelText('Tool'), { target: { value: 'Codex' } });
    fireEvent.change(within(worker).getByLabelText('Model'), { target: { value: 'gpt-5.6' } });

    await waitFor(() =>
      expect(
        screen.getByText(
          'A correction must return to the original worker — this identity does not match the prior dispatch.',
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Record dispatch' })).toBeDisabled();
  });

  it('audit tab requires a real PR URL and an independent-family auditor', async () => {
    renderPanel(harness);
    await waitFor(() =>
      expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.com'),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Audit' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Pull request URL (required, real link)')).toBeInTheDocument(),
    );

    const auditor = screen.getByRole('group', { name: 'Assigned auditor (different family)' });
    // Seeded default auditor provider is blank for kilo_code (ambiguous family) — set it to the
    // SAME family as the author worker to trigger the independence error.
    const author = screen.getByRole('group', { name: 'Author worker' });
    fireEvent.change(within(author).getByLabelText('Provider'), { target: { value: 'Anthropic' } });
    fireEvent.change(within(auditor).getByLabelText('Provider'), {
      target: { value: 'Anthropic' },
    });

    await waitFor(() =>
      expect(
        screen.getByText(
          'The assigned auditor must be a different provider family than the author worker.',
        ),
      ).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText('Pull request URL (required, real link)'), {
      target: { value: 'not-a-url' },
    });
    expect(screen.getByRole('button', { name: 'Record dispatch' })).toBeDisabled();
  });

  it('offers injection only when a directory is open, and honors the unmanaged-conflict confirmation', async () => {
    const { rerender } = renderPanel(harness, { directoryRoot: null });
    await waitFor(() =>
      expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.com'),
    );
    await fillMinimalWorkerForm();
    fireEvent.click(screen.getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() => expect(screen.getByText('History (1)')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Worker · / }));

    fireEvent.click(screen.getByRole('button', { name: 'Inject this packet' }));
    await waitFor(() => expect(screen.getByText(/No directory is open/)).toBeInTheDocument());

    rerender(
      <WorkOrdersPanel
        service={harness.service}
        ownerId={harness.ownerId}
        ownerEmail="owner@example.com"
        projectId={PROJECT_ID}
        taskId={TASK_ID}
        taskTitle="Ship the feature"
        directoryRoot="/scratch/project"
      />,
    );
    harness.filesystem.files.set(
      '/scratch/project HAMMOND-WORK-ORDER.md',
      '# An owner file, not Hammond-managed',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Inject this packet' }));
    await waitFor(() =>
      expect(screen.getByText(/already holds different content/)).toBeInTheDocument(),
    );
    expect(harness.filesystem.files.get('/scratch/project HAMMOND-WORK-ORDER.md')).toBe(
      '# An owner file, not Hammond-managed',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() =>
      expect(screen.getByText(/Written to HAMMOND-WORK-ORDER.md/)).toBeInTheDocument(),
    );
    expect(harness.filesystem.files.get('/scratch/project HAMMOND-WORK-ORDER.md')).toContain(
      'Do the thing.',
    );
  });

  it('MUTATION PROOF — stale-root write prevention: closing the directory while a replace confirmation is pending cancels the write rather than writing the old root', async () => {
    const { rerender } = renderPanel(harness, { directoryRoot: '/scratch/project' });
    await waitFor(() =>
      expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.com'),
    );
    await fillMinimalWorkerForm();
    fireEvent.click(screen.getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() => expect(screen.getByText('History (1)')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Worker · / }));

    harness.filesystem.files.set(
      '/scratch/project HAMMOND-WORK-ORDER.md',
      '# An owner file, not Hammond-managed',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inject this packet' }));
    await waitFor(() =>
      expect(screen.getByText(/already holds different content/)).toBeInTheDocument(),
    );

    // The owner closes the directory while the confirmation is still showing — the root the
    // pending confirmation was computed against no longer applies.
    rerender(
      <WorkOrdersPanel
        service={harness.service}
        ownerId={harness.ownerId}
        ownerEmail="owner@example.com"
        projectId={PROJECT_ID}
        taskId={TASK_ID}
        taskTitle="Ship the feature"
        directoryRoot={null}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(screen.getByText(/No directory is open/)).toBeInTheDocument());

    // Nothing was written to the stale root — the original unmanaged content is untouched, byte
    // for byte, and no write was attempted against it after the close.
    expect(harness.filesystem.files.get('/scratch/project HAMMOND-WORK-ORDER.md')).toBe(
      '# An owner file, not Hammond-managed',
    );
  });

  it('attaches a returned report to a dispatch and flags an identity mismatch honestly', async () => {
    renderPanel(harness);
    await waitFor(() =>
      expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.com'),
    );
    await fillMinimalWorkerForm();
    fireEvent.click(screen.getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() => expect(screen.getByText('History (1)')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Worker · / }));

    fireEvent.click(screen.getByRole('button', { name: 'Attach returned report' }));
    fireEvent.change(screen.getByLabelText('Raw returned text'), {
      target: { value: 'Worker report: all green.' },
    });
    fireEvent.change(screen.getByLabelText('Returned provider'), { target: { value: 'OpenAI' } });
    fireEvent.change(screen.getByLabelText('Returned tool'), { target: { value: 'Codex' } });
    fireEvent.change(screen.getByLabelText('Returned model'), { target: { value: 'gpt-5.6' } });
    fireEvent.change(screen.getByLabelText('Provenance'), {
      target: { value: 'Pasted from PR comment' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Attach report' }));
    await waitFor(() => expect(screen.getByText('Worker report: all green.')).toBeInTheDocument());
    expect(
      screen.getByText('Returned identity differs from the dispatched identity.'),
    ).toBeInTheDocument();
  });

  it('persists an in-progress draft across a stage switch and back, so navigation never loses typed work', async () => {
    renderPanel(harness);
    await waitFor(() =>
      expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.com'),
    );
    fireEvent.change(screen.getByLabelText('Scope'), {
      target: { value: 'Draft scope, not yet recorded.' },
    });
    await waitFor(() =>
      expect(
        harness.localSettings.read('hammond.workOrders.draft.owner-1.project-1.task-1.worker'),
      ).resolves.not.toBeNull(),
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Correction' }));
    await waitFor(() => expect(screen.getByLabelText('Correction number')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Worker' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Scope')).toHaveValue('Draft scope, not yet recorded.'),
    );
  });
});

describe('WorkOrdersPanel partial-write recovery (HAM3-009 Correction 1)', () => {
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
  });

  it('MUTATION PROOF (recovery, dispatch): Record fails when the index write fails after the document is saved, and an identical re-click repairs it into exactly one history entry', async () => {
    const settings = createControlledLocalSettings();
    settings.failWritesMatching((key) => key === 'hammond.workOrders.index.owner-1', { count: 1 });
    const harness = createWorkOrdersTestHarness('owner-1', { localSettings: settings });
    harness.seedProject(PROJECT_ID);

    renderPanel(harness);
    await waitFor(() =>
      expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.com'),
    );
    await fillMinimalWorkerForm();

    fireEvent.click(screen.getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() =>
      expect(
        screen.getByText(/was saved but could not be recorded in the history index/),
      ).toBeInTheDocument(),
    );
    // The failure is truthful: the panel never claims a record it can't yet find in history, even
    // though the document itself was durably saved underneath.
    expect(screen.getByText('History (0)')).toBeInTheDocument();

    // Click again with the exact same (unedited) content — this must repair the index rather than
    // stay stuck, and must not create a second entry.
    fireEvent.click(screen.getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() => expect(screen.getByText(/Recorded as dispatch/)).toBeInTheDocument());
    expect(screen.getByText('History (1)')).toBeInTheDocument();
  });

  it('MUTATION PROOF (recovery, dispatch): editing the packet after a partial failure first recovers the original attempt into history, then records the edited content as a second, distinct entry — no lost history, no duplicate', async () => {
    const settings = createControlledLocalSettings();
    settings.failWritesMatching((key) => key === 'hammond.workOrders.index.owner-1', { count: 1 });
    const harness = createWorkOrdersTestHarness('owner-1', { localSettings: settings });
    harness.seedProject(PROJECT_ID);

    renderPanel(harness);
    await waitFor(() =>
      expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.com'),
    );
    await fillMinimalWorkerForm();

    fireEvent.click(screen.getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() => expect(screen.getByText('History (0)')).toBeInTheDocument());

    // The owner edits the packet rather than resubmitting unchanged. Under the residual defect
    // this correction closes, the original accepted document stayed invisible forever; now it is
    // recovered as its own history entry before the edited content is recorded separately.
    fireEvent.change(screen.getByLabelText('Scope'), {
      target: { value: 'A revised scope after the partial failure.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record dispatch' }));

    await waitFor(() => expect(screen.getByText(/Recorded as dispatch/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/Also recovered an earlier/)).toBeInTheDocument());
    expect(screen.getByText('History (2)')).toBeInTheDocument();

    const historyList = screen
      .getByText('History (2)')
      .closest('.work-order-history') as HTMLElement;
    const entries = within(historyList).getAllByRole('button', { name: /Worker · / });
    expect(entries).toHaveLength(2);

    // Only one entry's detail is expanded at a time — check each in turn. Newest first: index 0 is
    // the just-recorded edited content, index 1 is the recovered original.
    fireEvent.click(entries[0]);
    expect(
      within(historyList).getByText('A revised scope after the partial failure.', {
        exact: false,
      }),
    ).toBeInTheDocument();

    fireEvent.click(entries[0]); // collapse
    fireEvent.click(entries[1]); // expand the recovered original
    expect(within(historyList).getByText('Do the thing.', { exact: false })).toBeInTheDocument();
  });

  it('MUTATION PROOF (recovery, report): editing the returned-report text after a partial failure first recovers the original report, then attaches the edited text as a second, distinct report — no lost report, no duplicate', async () => {
    const settings = createControlledLocalSettings();
    settings.failWritesMatching((key) => key === 'hammond.workOrders.reportIndex.owner-1', {
      count: 1,
    });
    const harness = createWorkOrdersTestHarness('owner-1', { localSettings: settings });
    harness.seedProject(PROJECT_ID);

    renderPanel(harness);
    await waitFor(() =>
      expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.com'),
    );
    await fillMinimalWorkerForm();
    fireEvent.click(screen.getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() => expect(screen.getByText('History (1)')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Worker · / }));

    fireEvent.click(screen.getByRole('button', { name: 'Attach returned report' }));
    fireEvent.change(screen.getByLabelText('Raw returned text'), {
      target: { value: 'First attempt at the returned report text.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Attach report' }));
    await waitFor(() =>
      expect(
        screen.getByText(/was saved but could not be recorded in the report index/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('Returned reports (0)')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Raw returned text'), {
      target: { value: 'Edited returned report text after the partial failure.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Attach report' }));

    await waitFor(() =>
      expect(
        screen.getByText('Edited returned report text after the partial failure.'),
      ).toBeInTheDocument(),
    );
    // Both the recovered original attempt and the edited text are present under the same
    // dispatch — the residual defect this correction closes left the original permanently
    // invisible instead.
    expect(screen.getByText('First attempt at the returned report text.')).toBeInTheDocument();
    expect(screen.getByText(/Also recovered an earlier/)).toBeInTheDocument();
    expect(screen.getByText('Returned reports (2)')).toBeInTheDocument();
  });
});

describe('WorkOrdersPanel durable partial-write recovery across navigation and remount (HAM3-009 Correction 2)', () => {
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
  });

  /** Counts raw dispatch documents ever written for an owner, straight from the backing store —
   * not the visible history count. A recovery that silently orphans the original and writes an
   * identical-content duplicate under a fresh id would still show "History (1)" (the orphan stays
   * invisible either way), so this is the assertion that actually proves *id reuse* happened. */
  function dispatchDocumentCount(settings: ReturnType<typeof createControlledLocalSettings>) {
    return Array.from(settings.store.keys()).filter((key) =>
      key.startsWith('hammond.workOrders.dispatch.owner-1.'),
    ).length;
  }

  it('MUTATION PROOF (stage-switch navigation): a partial dispatch failure survives a Worker → Correction → Worker stage switch — the pending id is not held only in a component ref, so an identical resubmit still recovers into exactly one history entry', async () => {
    const settings = createControlledLocalSettings();
    settings.failWritesMatching((key) => key === 'hammond.workOrders.index.owner-1', { count: 1 });
    const harness = createWorkOrdersTestHarness('owner-1', { localSettings: settings });
    harness.seedProject(PROJECT_ID);

    renderPanel(harness);
    await waitFor(() =>
      expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.com'),
    );
    await fillMinimalWorkerForm();
    fireEvent.click(screen.getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() =>
      expect(
        screen.getByText(/was saved but could not be recorded in the history index/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('History (0)')).toBeInTheDocument();

    // Navigate away and back — this used to drop the only handle recovery had (an in-memory ref).
    fireEvent.click(screen.getByRole('tab', { name: 'Correction' }));
    await waitFor(() => expect(screen.getByLabelText('Correction number')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Worker' }));
    await waitFor(() => expect(screen.getByLabelText('Scope')).toHaveValue('Do the thing.'));

    // An unedited resubmit must repair the existing document, not mint a hidden duplicate.
    fireEvent.click(screen.getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() => expect(screen.getByText(/Recorded as dispatch/)).toBeInTheDocument());
    expect(screen.getByText('History (1)')).toBeInTheDocument();
    // The stronger proof: exactly one dispatch document was ever written — a repair that silently
    // orphaned the original and wrote an identical duplicate under a fresh id would still show
    // "History (1)" (the orphan stays invisible either way) but would fail this count.
    expect(dispatchDocumentCount(settings)).toBe(1);
  });

  it("MUTATION PROOF (unmount/remount — simulated app restart): a partial dispatch failure recovers through a freshly mounted panel instance, proving recovery is not held in this component instance's memory", async () => {
    const settings = createControlledLocalSettings();
    settings.failWritesMatching((key) => key === 'hammond.workOrders.index.owner-1', { count: 1 });
    const harness = createWorkOrdersTestHarness('owner-1', { localSettings: settings });
    harness.seedProject(PROJECT_ID);

    const first = renderPanel(harness);
    await waitFor(() =>
      expect(screen.getByLabelText('Human owner')).toHaveValue('owner@example.com'),
    );
    await fillMinimalWorkerForm();
    fireEvent.click(screen.getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() => expect(screen.getByText('History (0)')).toBeInTheDocument());

    // Destroy the component entirely — every ref/state this instance held is gone.
    first.unmount();

    // A brand-new panel instance, wired to the same service/store, discovers the pending attempt
    // purely from durable state (the auto-persisted draft repopulates the form; the store recovers
    // the id) — nothing survived in React memory across the unmount.
    renderPanel(harness);
    await waitFor(() => expect(screen.getByLabelText('Scope')).toHaveValue('Do the thing.'));
    fireEvent.click(screen.getByRole('button', { name: 'Record dispatch' }));
    await waitFor(() => expect(screen.getByText(/Recorded as dispatch/)).toBeInTheDocument());
    expect(screen.getByText('History (1)')).toBeInTheDocument();
    expect(dispatchDocumentCount(settings)).toBe(1);
  });
});

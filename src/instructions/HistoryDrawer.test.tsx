import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import { HistoryDrawer } from './HistoryDrawer';
import type { InstructionVersion } from './types';

function version(overrides: Partial<InstructionVersion> = {}): InstructionVersion {
  return {
    id: 'v1',
    templateId: 'tmpl-1',
    ownerId: 'owner-1',
    version: 1,
    content: 'original content',
    restoredFromVersionId: null,
    createdAt: '2026-09-04T16:00:00Z',
    ...overrides,
  };
}

describe('HistoryDrawer', () => {
  it('labels the active version and offers a single Restore this version action, disabled for the active entry', () => {
    const history = [
      version({ id: 'v2', version: 2, content: 'newer' }),
      version({ id: 'v1', version: 1 }),
    ];
    render(
      <HistoryDrawer
        label="Worker — Project override"
        history={history}
        activeVersionId="v2"
        busy={false}
        error={null}
        onRestore={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('dialog', { name: 'Worker — Project override history' }),
    ).toBeInTheDocument();
    const activeRow = screen.getByText(/v2/).closest('li') as HTMLElement;
    expect(activeRow.textContent).toContain('active');
    const restoreButtons = screen.getAllByRole('button', { name: /Restore this version/ });
    expect(restoreButtons[0]).toBeDisabled(); // v2 is active
    expect(restoreButtons[1]).not.toBeDisabled(); // v1 is not
    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument();
  });

  it('shows restore provenance for a restored version', () => {
    const history = [version({ id: 'v3', version: 3, restoredFromVersionId: 'v1' })];
    render(
      <HistoryDrawer
        label="Worker — Project override"
        history={history}
        activeVersionId="v3"
        busy={false}
        error={null}
        onRestore={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/restored from an earlier version/)).toBeInTheDocument();
  });

  it('toggles raw content inspection per version', () => {
    render(
      <HistoryDrawer
        label="Worker — Project override"
        history={[version({ content: 'the raw text' })]}
        activeVersionId={null}
        busy={false}
        error={null}
        onRestore={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText('the raw text')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View content' }));
    expect(screen.getByText('the raw text')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide content' }));
    expect(screen.queryByText('the raw text')).not.toBeInTheDocument();
  });

  it('calls onRestore with the chosen version id', () => {
    const onRestore = vi.fn();
    render(
      <HistoryDrawer
        label="Worker — Project override"
        history={[version({ id: 'v1' })]}
        activeVersionId={null}
        busy={false}
        error={null}
        onRestore={onRestore}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
    expect(onRestore).toHaveBeenCalledWith('v1');
  });

  it('closes on Escape and on clicking the backdrop, and focuses the dialog on open', () => {
    const onClose = vi.fn();
    render(
      <HistoryDrawer
        label="Worker — Project override"
        history={[]}
        activeVersionId={null}
        busy={false}
        error={null}
        onRestore={vi.fn()}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps Tab focus inside the dialog', () => {
    render(
      <HistoryDrawer
        label="Worker — Project override"
        history={[version()]}
        activeVersionId={null}
        busy={false}
        error={null}
        onRestore={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog');
    const focusable = dialog.querySelectorAll('button');
    const last = focusable[focusable.length - 1] as HTMLElement;
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(focusable[0]);
  });

  it('returns focus to the triggering element on close', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button onClick={() => setOpen(true)}>Open history</button>
          {open && (
            <HistoryDrawer
              label="Worker — Project override"
              history={[]}
              activeVersionId={null}
              busy={false}
              error={null}
              onRestore={vi.fn()}
              onClose={() => setOpen(false)}
            />
          )}
        </div>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open history' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(trigger).toHaveFocus();
  });

  it('shows an error banner and the empty-history message when relevant', () => {
    render(
      <HistoryDrawer
        label="Worker — Project override"
        history={[]}
        activeVersionId={null}
        busy={false}
        error="Failed to restore"
        onRestore={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to restore');
    expect(screen.getByText('No versions yet — using base content.')).toBeInTheDocument();
  });
});

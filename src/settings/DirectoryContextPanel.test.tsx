import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { DirectoryContextPanel } from './DirectoryContextPanel';
import { DirectoryContextManager } from './directoryContextManager';
import { createDefaultLocalSettingsState, type LocalSettingsStateV1 } from './state';
import { createFakeFilesystem, createFakeLocalSettings } from './testFakes';

const projectId = 'project-1';

function renderPanel(manager: DirectoryContextManager, initialState: LocalSettingsStateV1) {
  function Harness() {
    const [state, setState] = useState(initialState);
    return (
      <DirectoryContextPanel
        manager={manager}
        state={state}
        onStateChange={setState}
        projectId={projectId}
      />
    );
  }
  return render(<Harness />);
}

function buildManager() {
  const filesystem = createFakeFilesystem();
  const settings = createFakeLocalSettings();
  const manager = new DirectoryContextManager({ filesystem, settings });
  return { filesystem, settings, manager };
}

describe('DirectoryContextPanel', () => {
  it('links a picked directory and shows it as the current path', async () => {
    const { filesystem, manager } = buildManager();
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue('/home/owner/repo');
    filesystem.existingRoots.add('/home/owner/repo');

    renderPanel(manager, createDefaultLocalSettingsState());
    expect(screen.getByText('No directory is open for this project yet.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Link directory' }));

    await waitFor(() =>
      expect(
        screen.getByText('/home/owner/repo', { selector: '.directory-context-path' }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText((_, node) => node?.textContent === 'Current path: /home/owner/repo'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link directory' })).not.toBeDisabled();
  });

  it('settles the picker to a no-op when the owner cancels, without leaving a pending state', async () => {
    const { filesystem, manager } = buildManager();
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    renderPanel(manager, createDefaultLocalSettingsState());
    fireEvent.click(screen.getByRole('button', { name: 'Link directory' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Link directory' })).not.toBeDisabled(),
    );
    expect(screen.getByText('No directory is open for this project yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('switches the active context between two directories bound to the same project', async () => {
    const { filesystem, manager } = buildManager();
    filesystem.existingRoots.add('/home/owner/a');
    filesystem.existingRoots.add('/home/owner/b');
    let state = createDefaultLocalSettingsState();
    state = (await manager.linkDirectory(state, projectId, '/home/owner/a')).state;
    state = (await manager.linkDirectory(state, projectId, '/home/owner/b')).state;

    renderPanel(manager, state);
    await waitFor(() => expect(screen.getAllByText('Current')).toHaveLength(1));
    expect(
      screen.getByText((_, node) => node?.textContent === 'Current path: /home/owner/b'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open a' }));

    await waitFor(() =>
      expect(
        screen.getByText((_, node) => node?.textContent === 'Current path: /home/owner/a'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Open b' })).toBeInTheDocument();
  });

  it('closes (unlinks) a context without deleting the directory', async () => {
    const { filesystem, manager } = buildManager();
    filesystem.existingRoots.add('/home/owner/repo');
    const linked = await manager.linkDirectory(
      createDefaultLocalSettingsState(),
      projectId,
      '/home/owner/repo',
    );

    renderPanel(manager, linked.state);
    await waitFor(() => expect(screen.getByText('Current')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: `Close ${linked.context.label}` }));

    await waitFor(() =>
      expect(screen.getByText('No directory is open for this project yet.')).toBeInTheDocument(),
    );
    expect(filesystem.removePath).not.toHaveBeenCalled();
  });

  it('shows recovery actions for a missing directory instead of Open/Reveal', async () => {
    const { manager } = buildManager();
    // Deliberately not added to existingRoots, so the fake filesystem reports it unreachable.
    const linked = await manager.linkDirectory(
      createDefaultLocalSettingsState(),
      projectId,
      '/home/owner/moved-away',
    );

    renderPanel(manager, linked.state);

    await waitFor(() =>
      expect(screen.getByText('Missing — this directory could not be found.')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Locate replacement' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: `Open ${linked.context.label}` }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: `Unlink ${linked.context.label}` }),
    ).toBeInTheDocument();
  });

  it('locating a replacement updates the binding path and clears the missing state', async () => {
    const { filesystem, manager } = buildManager();
    const linked = await manager.linkDirectory(
      createDefaultLocalSettingsState(),
      projectId,
      '/home/owner/moved-away',
    );

    renderPanel(manager, linked.state);
    await waitFor(() =>
      expect(screen.getByText('Missing — this directory could not be found.')).toBeInTheDocument(),
    );

    filesystem.existingRoots.add('/home/owner/new-location');
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(
      '/home/owner/new-location',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Locate replacement' }));

    await waitFor(() =>
      expect(
        screen.getByText('/home/owner/new-location', { selector: '.directory-context-path' }),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.queryByText('Missing — this directory could not be found.'),
      ).not.toBeInTheDocument(),
    );
    // The binding's identity and project association are untouched by a replacement:
    // exactly one item still renders, now pointed at the new path.
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    const item = screen
      .getByText('/home/owner/new-location', { selector: '.directory-context-path' })
      .closest('.directory-context-item') as HTMLElement;
    expect(within(item).getByRole('button', { name: 'Reveal new-location' })).toBeInTheDocument();
  });
});

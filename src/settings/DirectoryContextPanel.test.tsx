import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { DirectoryContextPanel } from './DirectoryContextPanel';
import { DirectoryContextManager } from './directoryContextManager';
import { createDefaultLocalSettingsState, type LocalSettingsStateV2 } from './state';
import { createFakeFilesystem, createFakeLocalSettings } from './testFakes';

const projectId = 'project-1';

function renderPanel(
  manager: DirectoryContextManager,
  initialState: LocalSettingsStateV2,
  beforeChange?: (action: () => void) => void,
) {
  function Harness() {
    const [state, setState] = useState(initialState);
    return (
      <DirectoryContextPanel
        manager={manager}
        state={state}
        onStateChange={setState}
        projectId={projectId}
        beforeChange={beforeChange}
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

  it('routes a new link through the beforeChange guard before it takes effect', async () => {
    const { filesystem, manager } = buildManager();
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue('/home/owner/repo');
    filesystem.existingRoots.add('/home/owner/repo');
    const beforeChange = vi.fn((action: () => void) => action());

    renderPanel(manager, createDefaultLocalSettingsState(), beforeChange);
    fireEvent.click(screen.getByRole('button', { name: 'Link directory' }));

    await waitFor(() =>
      expect(
        screen.getByText('/home/owner/repo', { selector: '.directory-context-path' }),
      ).toBeInTheDocument(),
    );
    expect(beforeChange).toHaveBeenCalledTimes(1);
  });

  it('a beforeChange guard that never calls the action blocks the link from taking effect', async () => {
    const { filesystem, manager } = buildManager();
    (filesystem.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValue('/home/owner/repo');
    filesystem.existingRoots.add('/home/owner/repo');
    const beforeChange = vi.fn();

    renderPanel(manager, createDefaultLocalSettingsState(), beforeChange);
    fireEvent.click(screen.getByRole('button', { name: 'Link directory' }));

    await waitFor(() => expect(beforeChange).toHaveBeenCalledTimes(1));
    expect(screen.getByText('No directory is open for this project yet.')).toBeInTheDocument();
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

  it('closes the active context without deleting the directory or forgetting the binding', async () => {
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
    // The binding survives the Close: it still renders, now as an inactive, reopenable context.
    expect(
      screen.getByText('/home/owner/repo', { selector: '.directory-context-path' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: `Open ${linked.context.label}` }),
    ).toBeInTheDocument();
  });

  it('routes Close through the beforeChange guard before it takes effect', async () => {
    const { filesystem, manager } = buildManager();
    filesystem.existingRoots.add('/home/owner/repo');
    const linked = await manager.linkDirectory(
      createDefaultLocalSettingsState(),
      projectId,
      '/home/owner/repo',
    );
    const beforeChange = vi.fn();

    renderPanel(manager, linked.state, beforeChange);
    await waitFor(() => expect(screen.getByText('Current')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: `Close ${linked.context.label}` }));

    expect(beforeChange).toHaveBeenCalledTimes(1);
    // The guard never invoked the action, so nothing actually closed.
    expect(screen.getByText('Current')).toBeInTheDocument();
  });

  it('forgetting an inactive binding removes it, leaving the active one untouched', async () => {
    const { filesystem, manager } = buildManager();
    filesystem.existingRoots.add('/home/owner/a');
    filesystem.existingRoots.add('/home/owner/b');
    let state = createDefaultLocalSettingsState();
    const first = await manager.linkDirectory(state, projectId, '/home/owner/a');
    state = first.state;
    state = (await manager.linkDirectory(state, projectId, '/home/owner/b')).state;

    renderPanel(manager, state);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open a' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: `Forget ${first.context.label}` }));

    await waitFor(() =>
      expect(
        screen.queryByText('/home/owner/a', { selector: '.directory-context-path' }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText((_, node) => node?.textContent === 'Current path: /home/owner/b'),
    ).toBeInTheDocument();
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
      screen.getByRole('button', { name: `Forget ${linked.context.label}` }),
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

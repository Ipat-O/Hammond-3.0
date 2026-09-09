import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';

import { AgentAccessPanel } from './AgentAccessPanel';
import { nativeAgentAccess } from './nativeBridge';

vi.mock('./nativeBridge', () => ({
  nativeAgentAccess: {
    status: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    revoke: vi.fn(),
  },
}));

const mockedNative = vi.mocked(nativeAgentAccess);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

function connection(overrides: Partial<Awaited<ReturnType<typeof nativeAgentAccess.status>>> = {}) {
  return {
    profileId: 'profile-1',
    projectId: 'project-1',
    projectName: 'Scratch project',
    permission: 'read_only' as const,
    generation: 1,
    createdAt: '2026-09-09T00:00:00.000Z',
    launchConfig: { mcpServers: { hammond: { command: 'hammond-mcp-companion', args: [] } } },
    ...overrides,
  };
}

describe('AgentAccessPanel', () => {
  it('shows an unavailable message when the native runtime is not reachable', async () => {
    mockedNative.status.mockRejectedValue(new Error('no native runtime'));
    render(<AgentAccessPanel projectId="project-1" projectName="Scratch project" />);
    expect(
      await screen.findByText(/requires the installed Hammond desktop app/),
    ).toBeInTheDocument();
  });

  it('offers to enable when nothing is currently connected', async () => {
    mockedNative.status.mockResolvedValue(null);
    render(<AgentAccessPanel projectId="project-1" projectName="Scratch project" />);
    expect(
      await screen.findByRole('button', { name: 'Enable agent access for this project' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Read-only/)).toBeChecked();
  });

  it('enables with the selected permission and shows the connected state', async () => {
    mockedNative.status.mockResolvedValue(null);
    mockedNative.enable.mockResolvedValue(connection({ permission: 'task_write' }));
    render(<AgentAccessPanel projectId="project-1" projectName="Scratch project" />);
    await screen.findByRole('button', { name: 'Enable agent access for this project' });

    fireEvent.click(screen.getByLabelText(/Read \+ task write/));
    fireEvent.click(screen.getByRole('button', { name: 'Enable agent access for this project' }));

    await waitFor(() =>
      expect(mockedNative.enable).toHaveBeenCalledWith(
        'project-1',
        'Scratch project',
        'task_write',
      ),
    );
    expect(await screen.findByText(/read \+ task write/)).toBeInTheDocument();
  });

  it('shows a switch-project warning when enabled for a different project', async () => {
    mockedNative.status.mockResolvedValue(
      connection({ projectId: 'other-project', projectName: 'Other project' }),
    );
    render(<AgentAccessPanel projectId="project-1" projectName="Scratch project" />);
    expect(
      await screen.findByText(/currently enabled for a different project/i),
    ).toBeInTheDocument();
  });

  it('copies the launch configuration to the clipboard', async () => {
    mockedNative.status.mockResolvedValue(connection());
    render(<AgentAccessPanel projectId="project-1" projectName="Scratch project" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy launch configuration' }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        JSON.stringify(connection().launchConfig, null, 2),
      ),
    );
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('revoke re-fetches a fresh connection without disabling', async () => {
    mockedNative.status.mockResolvedValue(connection({ generation: 1 }));
    mockedNative.revoke.mockResolvedValue(connection({ generation: 2 }));
    render(<AgentAccessPanel projectId="project-1" projectName="Scratch project" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke connection' }));
    await waitFor(() => expect(mockedNative.revoke).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Enabled for/)).toBeInTheDocument();
  });

  it('disable clears the connected state back to the offer-to-enable view', async () => {
    mockedNative.status.mockResolvedValue(connection());
    mockedNative.disable.mockResolvedValue(undefined);
    render(<AgentAccessPanel projectId="project-1" projectName="Scratch project" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(mockedNative.disable).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole('button', { name: 'Enable agent access for this project' }),
    ).toBeInTheDocument();
  });

  it('surfaces an action error without losing the current state', async () => {
    mockedNative.status.mockResolvedValue(null);
    mockedNative.enable.mockRejectedValue(new Error('pipe busy'));
    render(<AgentAccessPanel projectId="project-1" projectName="Scratch project" />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Enable agent access for this project' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('pipe busy');
  });
});

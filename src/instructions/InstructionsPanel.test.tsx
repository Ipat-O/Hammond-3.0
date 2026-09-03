import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { InstructionsPanel } from './InstructionsPanel';
import { InstructionsService } from './service';
import { createFakeInstructionRepository } from './testFakes';

const projects = [{ id: 'project-1', name: 'Hammond project' }];

function renderPanel() {
  const repo = createFakeInstructionRepository();
  const service = new InstructionsService(repo);
  render(<InstructionsPanel service={service} projects={projects} />);
  return { repo, service };
}

describe('InstructionsPanel', () => {
  it('lets the owner choose project, role, and provider, and starts from empty base content', async () => {
    renderPanel();

    expect(await screen.findByLabelText('Provider content')).toHaveValue('');
    expect(screen.getByLabelText('Project')).toHaveValue('project-1');
    expect(screen.getByLabelText('Role')).toHaveValue('worker');
    expect(screen.getByLabelText('Provider')).toHaveValue('claude_code');
  });

  it('saves a new version, shows it as active in history, and reflects it in the composed preview', async () => {
    renderPanel();
    const textarea = await screen.findByLabelText('Provider content');
    const providerCard = textarea.closest('article') as HTMLElement;
    const providerHistory = within(providerCard).getByRole('list', { name: 'Provider history' });

    fireEvent.change(textarea, { target: { value: 'be precise and cite files' } });
    fireEvent.click(within(providerCard).getByRole('button', { name: 'Save new version' }));

    await waitFor(() => expect(within(providerHistory).getByText(/v1/)).toBeInTheDocument());
    expect(within(providerHistory).getByText(/active/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('Composed preview')).toHaveTextContent(
        'be precise and cite files',
      ),
    );
  });

  it('editing and saving again appends version 2 while keeping version 1 in history', async () => {
    renderPanel();
    const textarea = await screen.findByLabelText('Provider content');
    const providerCard = textarea.closest('article') as HTMLElement;
    const providerHistory = within(providerCard).getByRole('list', { name: 'Provider history' });
    const saveButton = () => within(providerCard).getByRole('button', { name: 'Save new version' });

    fireEvent.change(textarea, { target: { value: 'draft one' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(within(providerHistory).getByText(/v1/)).toBeInTheDocument());

    fireEvent.change(textarea, { target: { value: 'draft two' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(within(providerHistory).getByText(/v2/)).toBeInTheDocument());
    expect(within(providerHistory).getByText(/v1/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('Composed preview')).toHaveTextContent('draft two'),
    );
  });

  it('restoring an earlier version creates a new traceable version and activates it', async () => {
    renderPanel();
    const textarea = await screen.findByLabelText('Provider content');
    const providerCard = textarea.closest('article') as HTMLElement;
    const providerHistory = within(providerCard).getByRole('list', { name: 'Provider history' });
    const saveButton = () => within(providerCard).getByRole('button', { name: 'Save new version' });

    fireEvent.change(textarea, { target: { value: 'original content' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(within(providerHistory).getByText(/v1/)).toBeInTheDocument());

    fireEvent.change(textarea, { target: { value: 'changed content' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(within(providerHistory).getByText(/v2/)).toBeInTheDocument());

    const v1Row = within(providerHistory).getByText(/v1/).closest('li') as HTMLElement;
    fireEvent.click(within(v1Row).getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(within(providerHistory).getByText(/v3/)).toBeInTheDocument());
    expect(
      within(providerHistory).getByText(/restored from an earlier version/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('Composed preview')).toHaveTextContent('original content'),
    );
  });

  it("keeps a second provider's history and content independent from the first", async () => {
    renderPanel();
    const providerSelect = screen.getByLabelText('Provider');
    const textarea = await screen.findByLabelText('Provider content');
    const providerCard = textarea.closest('article') as HTMLElement;
    const providerHistory = within(providerCard).getByRole('list', { name: 'Provider history' });

    fireEvent.change(textarea, { target: { value: 'claude specific content' } });
    fireEvent.click(within(providerCard).getByRole('button', { name: 'Save new version' }));
    await waitFor(() => expect(within(providerHistory).getByText(/v1/)).toBeInTheDocument());

    fireEvent.change(providerSelect, { target: { value: 'codex' } });

    await waitFor(() => expect(screen.getByLabelText('Provider content')).toHaveValue(''));
    // The grid remounts on a provider switch, so re-query rather than reuse the old (now detached) node.
    const codexCard = screen.getByLabelText('Provider content').closest('article') as HTMLElement;
    const codexHistory = within(codexCard).getByRole('list', { name: 'Provider history' });
    expect(
      within(codexHistory).getByText('No owner versions yet — using base content.'),
    ).toBeInTheDocument();
  });

  it('shows optional task work-order text last in the preview, and clearing it leaves history untouched', async () => {
    const { repo } = renderPanel();
    const textarea = await screen.findByLabelText('Provider content');
    const providerCard = textarea.closest('article') as HTMLElement;
    const providerHistory = within(providerCard).getByRole('list', { name: 'Provider history' });

    fireEvent.change(textarea, { target: { value: 'provider content' } });
    fireEvent.click(within(providerCard).getByRole('button', { name: 'Save new version' }));
    await waitFor(() => expect(within(providerHistory).getByText(/v1/)).toBeInTheDocument());

    const workOrder = screen.getByLabelText('Task work order');
    fireEvent.change(workOrder, { target: { value: 'finish the login flow' } });

    await waitFor(() =>
      expect(screen.getByLabelText('Composed preview')).toHaveTextContent(
        'provider content finish the login flow',
      ),
    );

    const versionCountWithWorkOrder = repo.store.versions.size;
    fireEvent.change(workOrder, { target: { value: '' } });

    await waitFor(() =>
      expect(screen.getByLabelText('Composed preview')).not.toHaveTextContent(
        'finish the login flow',
      ),
    );
    expect(repo.store.versions.size).toBe(versionCountWithWorkOrder);
  });

  it('surfaces a failed preview refresh instead of hiding it, keeps the last known-good preview, and recovers on retry (Correction 1)', async () => {
    const { service } = renderPanel();
    const textarea = await screen.findByLabelText('Provider content');
    const providerCard = textarea.closest('article') as HTMLElement;

    fireEvent.change(textarea, { target: { value: 'provider content' } });
    fireEvent.click(within(providerCard).getByRole('button', { name: 'Save new version' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Composed preview')).toHaveTextContent('provider content'),
    );

    const originalComposePreview = service.composePreview.bind(service);
    let shouldFail = true;
    service.composePreview = (async (...args: Parameters<typeof originalComposePreview>) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('network dropped');
      }
      return originalComposePreview(...args);
    }) as typeof service.composePreview;

    fireEvent.change(screen.getByLabelText('Task work order'), {
      target: { value: 'finish the login flow' },
    });

    await screen.findByText(/Preview failed to refresh: network dropped/);
    // The old, still-valid preview stays on screen - it is not replaced with an empty string.
    expect(screen.getByLabelText('Composed preview')).toHaveTextContent('provider content');
    expect(screen.getByLabelText('Composed preview')).not.toHaveTextContent(
      'finish the login flow',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(screen.queryByText(/Preview failed to refresh/)).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Composed preview')).toHaveTextContent(
      'provider content finish the login flow',
    );
  });
});

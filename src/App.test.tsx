import { render, screen } from '@testing-library/react';

import App from './App';

describe('Hammond shell', () => {
  it('renders the foundation workspace and module boundaries', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Good morning, owner.' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Clear boundaries, ready to extend.' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Local workspace')).toBeInTheDocument();
    expect(screen.getByText('Project memory')).toBeInTheDocument();
    expect(screen.getByText('Local settings')).toBeInTheDocument();
  });
});

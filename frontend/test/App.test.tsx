import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

afterEach(() => localStorage.clear());

const settings = { comfyHost: 'http://c', ollamaHost: 'http://o', piperHost: 'tcp://p:1' };

function makeApi() {
  return { getConfig: vi.fn(async () => settings), patchConfig: vi.fn(async () => settings) };
}

describe('App shell', () => {
  it('shows the sidebar and the pipeline placeholder', () => {
    render(<App api={makeApi()} />);
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent('Pipeline');
  });

  it('opens and closes the settings modal from the sidebar', async () => {
    const user = userEvent.setup();
    render(<App api={makeApi()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Ajustes/ }));
    await screen.findByDisplayValue(settings.comfyHost);
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Ajustes/ })).toHaveFocus();
  });
});

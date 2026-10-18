import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { Settings } from '../src/api/types';
import { SettingsModal } from '../src/components/SettingsModal';
import { I18nProvider } from '../src/i18n';

const initial: Settings = {
  comfyHost: 'http://comfy:8188',
  ollamaHost: 'http://ollama:11434',
  piperHost: 'tcp://piper:10200',
  ollamaModel: '',
};

function makeApi(overrides: Partial<{ getConfig: () => Promise<Settings>; patchConfig: (p: Partial<Settings>) => Promise<Settings>; listModels: () => Promise<string[]> }> = {}) {
  return {
    getConfig: vi.fn(overrides.getConfig ?? (async () => initial)),
    patchConfig: vi.fn(overrides.patchConfig ?? (async (p: Partial<Settings>) => ({ ...initial, ...p }))),
    listModels: vi.fn(overrides.listModels ?? (async () => [] as string[])),
  };
}

function Harness({ api }: { api: ReturnType<typeof makeApi> }) {
  const [open, setOpen] = useState(false);
  return (
    <I18nProvider>
      <button onClick={() => setOpen(true)}>opener</button>
      {open && <SettingsModal api={api} onClose={() => setOpen(false)} />}
    </I18nProvider>
  );
}

async function openModal(api = makeApi()) {
  const user = userEvent.setup();
  render(<Harness api={api} />);
  await user.click(screen.getByRole('button', { name: 'opener' }));
  await screen.findByDisplayValue(initial.comfyHost);
  return { api, user };
}

describe('SettingsModal', () => {
  it('is an accessible modal dialog labelled by its title', async () => {
    await openModal();
    const dialog = screen.getByRole('dialog', { name: 'Ajustes' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('loads the current values into labelled inputs', async () => {
    const { api } = await openModal();
    expect(api.getConfig).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('URL de ComfyUI')).toHaveValue(initial.comfyHost);
    expect(screen.getByLabelText('URL de Ollama')).toHaveValue(initial.ollamaHost);
    expect(screen.getByLabelText(/Piper/)).toHaveValue(initial.piperHost);
  });

  it('disables Save while the form is unchanged and enables it after an edit', async () => {
    const { user } = await openModal();
    const save = screen.getByRole('button', { name: 'Guardar' });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText('URL de Ollama'), '0');
    expect(save).toBeEnabled();
    await user.keyboard('{Backspace}');
    expect(save).toBeDisabled();
  });

  it('sends only the changed fields and closes on success', async () => {
    const { api, user } = await openModal();
    const input = screen.getByLabelText('URL de Ollama');
    await user.clear(input);
    await user.type(input, 'http://other:11434');
    await user.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(api.patchConfig).toHaveBeenCalledWith({ ollamaHost: 'http://other:11434' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows a saving state while the request is pending', async () => {
    let resolve!: (s: Settings) => void;
    const api = makeApi({ patchConfig: () => new Promise<Settings>((r) => (resolve = r)) });
    const { user } = await openModal(api);
    await user.type(screen.getByLabelText('URL de Ollama'), '1');
    await user.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(screen.getByRole('button', { name: 'Guardando…' })).toBeDisabled();
    resolve(initial);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the backend error inline and stays open', async () => {
    const api = makeApi({
      patchConfig: async () => {
        throw new ApiError(400, 'comfyHost must be an http or https URL');
      },
    });
    const { user } = await openModal(api);
    await user.type(screen.getByLabelText('URL de ComfyUI'), 'x');
    await user.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('comfyHost must be an http or https URL');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeEnabled();
  });

  it('shows a load error when the config cannot be fetched', async () => {
    const api = makeApi({
      getConfig: async () => {
        throw new ApiError(500, 'db down');
      },
    });
    const user = userEvent.setup();
    render(<Harness api={api} />);
    await user.click(screen.getByRole('button', { name: 'opener' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('db down');
  });

  it('closes on Escape and on Cancel', async () => {
    const { user } = await openModal();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'opener' }));
    await screen.findByDisplayValue(initial.comfyHost);
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves focus into the dialog on open and returns it to the opener on close', async () => {
    const { user } = await openModal();
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'opener' })).toHaveFocus();
  });
});

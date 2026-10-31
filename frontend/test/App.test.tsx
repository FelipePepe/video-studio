import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { Job } from '../src/api/types';
import { makeFakeApi } from './helpers/fakeApi';

function resetLocation() {
  window.history.replaceState(null, '', '/');
}

afterEach(() => {
  localStorage.clear();
  resetLocation();
});

const settings = { comfyHost: 'http://c', ollamaHost: 'http://o', piperHost: 'tcp://p:1', ollamaModel: '' };

function makeApi() {
  return { getConfig: vi.fn(async () => settings), patchConfig: vi.fn(async () => settings), listModels: vi.fn(async () => []) };
}

const doneJob: Job = {
  id: 'j1',
  draftId: 'd1',
  status: 'done',
  stage: 'mux',
  progress: 1,
  error: null,
  outputPath: null,
  options: null,
  createdAt: '2026-10-17T10:00:00.000Z',
  updatedAt: '2026-10-17T10:05:00.000Z',
  startedAt: null,
  finishedAt: null,
  warnings: [],
};

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

  it('shows the jobs view at #trabajos and switches back via the sidebar links', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '#trabajos');
    const api = {
      ...makeApi(),
      listJobs: vi.fn(async () => [doneJob]),
      cancelJob: vi.fn(async () => ({ cancelled: true })),
    };
    render(<App api={api} />);
    expect(screen.getByRole('heading', { name: 'Trabajos' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Trabajos' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Pipeline' })).not.toHaveAttribute('aria-current');
    await screen.findByText('Hecha');
    expect(api.listJobs).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('link', { name: 'Pipeline' }));
    expect(screen.getByRole('heading', { name: 'Pipeline', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pipeline' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('Hecha')).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Trabajos' }));
    expect(screen.getByRole('heading', { name: 'Trabajos' })).toBeInTheDocument();
    expect(api.listJobs).toHaveBeenCalledTimes(2);
  });

  describe('pipeline state across tabs', () => {
    const fullApi = () => {
      const fake = makeFakeApi();
      return { fake, api: { ...makeApi(), ...fake.api, listJobs: vi.fn(async () => [doneJob]) } };
    };

    it('keeps the draft under review when switching to Trabajos and back', async () => {
      const user = userEvent.setup();
      const { fake, api } = fullApi();
      render(<App api={api} />);
      await user.type(screen.getByLabelText('URL del artículo'), 'https://x.test/a');
      await user.click(screen.getByRole('button', { name: 'Generar' }));
      await screen.findByRole('button', { name: 'Aprobar y generar' });

      await user.click(screen.getByRole('link', { name: 'Trabajos' }));
      expect(screen.queryByRole('button', { name: 'Aprobar y generar' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('link', { name: 'Pipeline' }));

      expect(await screen.findByRole('button', { name: 'Aprobar y generar' })).toBeInTheDocument();
      expect(fake.api.createDraft).toHaveBeenCalledTimes(1);
    });

    it('opens a job from Trabajos in the Pipeline tab and shows its video when done', async () => {
      const user = userEvent.setup();
      window.history.replaceState(null, '', '#trabajos');
      const { fake, api } = fullApi();
      const { container } = render(<App api={api} />);
      await screen.findByText('Hecha');
      await user.click(screen.getByRole('button', { name: 'Abrir en pipeline' }));

      await waitFor(() => expect(fake.api.watchJob).toHaveBeenCalledWith('j1', expect.anything()));
      expect(window.location.hash).toBe('#pipeline');
      expect(screen.getByRole('heading', { name: 'Pipeline', level: 1 })).toBeInTheDocument();
      act(() => fake.watch.emit({ type: 'done', outputUrl: '/api/jobs/j1/output' }));
      await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', '/api/jobs/j1/output'));
    });

    it('keeps what was typed in the form and the running render across tabs', async () => {
      const user = userEvent.setup();
      const { fake, api } = fullApi();
      render(<App api={api} />);
      await user.type(screen.getByLabelText('URL del artículo'), 'https://x.test/typed');
      await user.click(screen.getByRole('link', { name: 'Trabajos' }));
      await user.click(screen.getByRole('link', { name: 'Pipeline' }));
      expect(screen.getByLabelText('URL del artículo')).toHaveValue('https://x.test/typed');

      await user.click(screen.getByRole('button', { name: 'Generar' }));
      await user.click(await screen.findByRole('button', { name: 'Aprobar y generar' }));
      await waitFor(() => expect(fake.api.approveDraft).toHaveBeenCalled());
      await user.click(screen.getByRole('link', { name: 'Trabajos' }));
      await user.click(screen.getByRole('link', { name: 'Pipeline' }));
      expect(fake.signal?.aborted).toBe(false);
    });
  });
});

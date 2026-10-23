import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobsPage } from '../src/components/JobsPage';
import type { Job, JobEvent } from '../src/api/types';
import { I18nProvider } from '../src/i18n';

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1',
  draftId: 'd1',
  status: 'running',
  stage: 'tts',
  progress: 0.4,
  error: null,
  outputPath: null,
  options: null,
  createdAt: '2026-10-17T10:00:00.000Z',
  updatedAt: '2026-10-17T10:05:00.000Z',
  startedAt: '2026-10-17T10:01:00.000Z',
  finishedAt: null,
  ...over,
});

function makeApi(jobs: Job[]) {
  const approveDraft = vi.fn(async (_id: string, options?: { onEvent?: (e: JobEvent) => void }) => {
    // Emulate the server contract: first SSE event is `queued` with the jobId.
    options?.onEvent?.({ type: 'stage', stage: 'queued', jobId: 'jr1', progress: 0, at: new Date().toISOString() } as JobEvent);
    return undefined;
  });
  const byId = new Map(jobs.map((j) => [j.id, j]));
  return {
    listJobs: vi.fn(async () => jobs),
    getJob: vi.fn(async (id: string) => {
      const j = byId.get(id);
      if (!j) throw new Error('Job not found');
      return j;
    }),
    cancelJob: vi.fn(async () => ({ cancelled: true })),
    approveDraft,
  };
}

const renderJobs = (api: ReturnType<typeof makeApi>) => render(
    <I18nProvider>
      <JobsPage api={api} />
    </I18nProvider>,
  );

describe('JobsPage retry', () => {
  it('offers a retry on a failed job and relaunches it through the draft', async () => {
    const api = makeApi([job({ id: 'jf', draftId: 'd9', status: 'failed', stage: 'images', progress: 0.3, error: 'ComfyUI OOM' })]);
    renderJobs(api);
    const row = (await screen.findByText('Fallido')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Reintentar trabajo' }));
    expect(api.approveDraft).toHaveBeenCalledWith('d9', expect.objectContaining({ onEvent: expect.any(Function) }));
  });

  it('offers a retry on a cancelled job', async () => {
    const api = makeApi([job({ id: 'jc', draftId: 'd8', status: 'cancelled', stage: 'tts', progress: 0.1 })]);
    renderJobs(api);
    const row = (await screen.findByText('Cancelada')).closest('li')!;
    expect(within(row).getByRole('button', { name: 'Reintentar trabajo' })).toBeInTheDocument();
  });

  it('never offers a retry on done, queued or running jobs', async () => {
    const api = makeApi([
      job({ id: 'jd', status: 'done', progress: 1 }),
      job({ id: 'jqa', status: 'queued', progress: 0 }),
      job({ id: 'jr', status: 'running', progress: 0.5 }),
    ]);
    renderJobs(api);
    await screen.findByText('Hecha');
    expect(screen.queryByRole('button', { name: 'Reintentar trabajo' })).not.toBeInTheDocument();
  });
});

describe('JobsPage retry options and error handling (F8/F9)', () => {
  it('passes the failed job options (music, volume, subtitles, vertical) to the retry approval (F8)', async () => {
    const opts = { music: '/lib/a.mp3', musicVolume: 0.25, subtitles: false, vertical: true };
    const failed = job({ id: 'jf', draftId: 'd9', status: 'failed', stage: 'images', options: opts });
    const api = makeApi([failed]);
    renderJobs(api);
    const row = (await screen.findByText('Fallido')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Reintentar trabajo' }));
    expect(api.getJob).toHaveBeenCalledWith('jf');
    expect(api.approveDraft).toHaveBeenCalledWith('d9', expect.objectContaining({ body: opts }));
  });

  it('retries without a body when the job has no options (F8)', async () => {
    const api = makeApi([job({ id: 'jn', draftId: 'd7', status: 'failed' })]);
    renderJobs(api);
    const row = (await screen.findByText('Fallido')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Reintentar trabajo' }));
    expect(api.approveDraft).toHaveBeenCalledWith('d7', expect.objectContaining({ body: undefined }));
  });

  it('survives a rejected retry: shows the error and the button is usable again (F8)', async () => {
    const api = makeApi([job({ id: 'fe', draftId: 'd5', status: 'failed' })]);
    vi.spyOn(api, 'approveDraft').mockRejectedValue(new Error('409 conflict'));
    renderJobs(api);
    const row = (await screen.findByText('Fallido')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Reintentar trabajo' }));
    expect(await screen.findByText('No se pudo relanzar')).toBeInTheDocument();
    const btn = within(row).getByRole('button', { name: 'Reintentar trabajo' });
    expect(btn).toBeEnabled();
  });

  it('reports a cancel failure instead of an unhandled rejection and stays usable (F9)', async () => {
    const api = makeApi([job()]);
    vi.spyOn(api, 'cancelJob').mockRejectedValue(new Error('409 too late to cancel'));
    renderJobs(api);
    const btn = await screen.findByRole('button', { name: 'Cancelar' });
    await userEvent.click(btn);
    expect(await screen.findByText('No se pudo cancelar.')).toBeInTheDocument();
    await waitFor(() => expect(api.listJobs).toHaveBeenCalledTimes(2));
    // the row is still active — cancel stays enabled, not stuck on 'Cancelando…'
    expect(btn).toBeEnabled();
    expect(btn).toHaveTextContent('Cancelar');
  });
});


afterEach(() => {
  vi.useRealTimers();
});

describe('JobsPage', () => {
  it('renders jobs with status, stage, progress and creation date', async () => {
    const api = makeApi([job(), job({ id: 'j2', status: 'done', stage: 'mux', progress: 1 })]);
    renderJobs(api);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Trabajos');
    await screen.findByText('En curso');
    expect(screen.getByText('tts')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByText('Hecha')).toBeInTheDocument();
    expect(document.body.textContent).toContain('2026');
  });

  it('shows an empty state when there are no jobs', async () => {
    renderJobs(makeApi([]));
    expect(await screen.findByText('No hay trabajos todavía.')).toBeInTheDocument();
  });

  it('shows an error with a retry action when the list fails, and recovers', async () => {
    const user = userEvent.setup();
    const results: unknown[] = [new Error('boom'), [job({ status: 'done' })]];
    const api = makeApi([]);
    api.listJobs = vi.fn(async () => {
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next as Job[];
    });
    renderJobs(api);
    expect(await screen.findByText('No se pudieron cargar los trabajos.')).toBeInTheDocument();
    expect(api.listJobs).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Hecha')).toBeInTheDocument();
    expect(api.listJobs).toHaveBeenCalledTimes(2);
  });

  it('cancels an active job and refreshes the list', async () => {
    const user = userEvent.setup();
    const api = makeApi([job()]);
    renderJobs(api);
    const btn = await screen.findByRole('button', { name: 'Cancelar' });
    await user.click(btn);
    await waitFor(() => expect(api.cancelJob).toHaveBeenCalledWith('j1'));
    await waitFor(() => expect(api.listJobs).toHaveBeenCalledTimes(2));
  });

  it('links the video and cover of a done job, and nothing for an active one', async () => {
    const api = makeApi([
      job({ id: 'done1', status: 'done', progress: 1 }),
      job({ id: 'run1' }),
    ]);
    renderJobs(api);
    await screen.findByText('Hecha');
    expect(screen.getByRole('link', { name: 'Ver video' })).toHaveAttribute('href', '/api/jobs/done1/output');
    expect(screen.getByRole('link', { name: 'Portada' })).toHaveAttribute('href', '/api/jobs/done1/output?variant=cover');
    // active rows must not expose output links
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[1].querySelector('a[href*="output"]')).toBeNull();
    // no cancel affordance on the done row, one on the active row
    expect(within(rows[0]).queryByRole('button', { name: 'Cancelar' })).toBeNull();
    expect(within(rows[1]).getByRole('button', { name: 'Cancelar' })).toBeInTheDocument();
  });

  it('shows the failure reason on failed jobs', async () => {
    renderJobs(makeApi([job({ id: 'f1', status: 'failed', error: 'ffmpeg missing' })]));
    expect(await screen.findByText('Fallido')).toBeInTheDocument();
    expect(screen.getByText('ffmpeg missing')).toBeInTheDocument();
  });

  it('filters rows with the status chips', async () => {
    const user = userEvent.setup();
    const api = makeApi([
      job({ id: 'j-a', status: 'running' }),
      job({ id: 'j-b', status: 'done', progress: 1 }),
      job({ id: 'j-c', status: 'failed', error: 'x' }),
    ]);
    renderJobs(api);
    await screen.findByText('Fallido');
    await user.click(screen.getByRole('button', { name: 'Fallidas' }));
    expect(screen.getByRole('listitem').textContent).toContain('x');
    expect(screen.queryByText('Hecha')).toBeNull();
    expect(screen.queryByText('En curso')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Activas' }));
    expect(screen.getByRole('listitem').textContent).toContain('j-a');
    expect(screen.queryByText('Fallido')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Todas' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('auto-refreshes while any job is active, and stays quiet when none are', async () => {
    vi.useFakeTimers();
    const api = makeApi([job({ id: 'a', status: 'running' }), job({ id: 'b', status: 'done', progress: 1 })]);
    const { unmount } = renderJobs(api);
    expect(api.listJobs).toHaveBeenCalledTimes(1);
    // Flush the first response so the polling interval gets scheduled, then let it fire once.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(api.listJobs).toHaveBeenCalledTimes(2);
    unmount();

    const quiet = makeApi([job({ status: 'done', progress: 1 })]);
    const u2 = renderJobs(quiet);
    expect(quiet.listJobs).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(quiet.listJobs).toHaveBeenCalledTimes(1);
    u2.unmount();
  });

  it('shows the refresh action and reloads on demand', async () => {
    const user = userEvent.setup();
    const api = makeApi([]);
    renderJobs(api);
    await screen.findByText('No hay trabajos todavía.');
    expect(api.listJobs).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(api.listJobs).toHaveBeenCalledTimes(2);
  });
});

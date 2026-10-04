import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import { PipelinePage } from '../src/components/PipelinePage';
import { I18nProvider } from '../src/i18n';
import { makeFakeApi } from './helpers/fakeApi';

function setup() {
  const fake = makeFakeApi();
  const view = render(
    <I18nProvider>
      <PipelinePage api={fake.api} />
    </I18nProvider>,
  );
  return { fake, view, user: userEvent.setup() };
}

async function generate(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('URL del artículo'), 'https://x.test/a');
  await user.click(screen.getByRole('button', { name: 'Generar' }));
  await screen.findByRole('button', { name: 'Aprobar y generar' });
}

describe('PipelinePage', () => {
  it('shows the form and the guide card while idle', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Generar' })).toBeInTheDocument();
    expect(screen.getByText('Cómo funciona')).toBeInTheDocument();
    expect(screen.getByText('El vídeo aparecerá aquí')).toBeInTheDocument();
  });

  it('shows a draft error and keeps the form values', async () => {
    const { fake, user } = setup();
    fake.api.createDraft.mockRejectedValueOnce(new ApiError(400, 'Invalid URL'));
    await user.type(screen.getByLabelText('URL del artículo'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Generar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid URL');
    expect(screen.getByLabelText('URL del artículo')).toHaveValue('nope');
  });

  it('goes to review with the scene count, then Back returns to the form', async () => {
    const { fake, user } = setup();
    await generate(user);
    expect(fake.api.createDraft).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://x.test/a' }));
    expect(screen.getByText(/Escenas/)).toHaveTextContent('2');
    expect(screen.queryByRole('button', { name: 'Generar' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Volver' }));
    expect(screen.getByRole('button', { name: 'Generar' })).toBeInTheDocument();
  });

  it('approve -> stages advance -> video appears', async () => {
    const { fake, view, user } = setup();
    await generate(user);
    await user.click(screen.getByRole('button', { name: 'Aprobar y generar' }));
    expect(fake.api.approveDraft).toHaveBeenCalledWith('d1', expect.anything());
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument();

    act(() => fake.emit({ type: 'stage', stage: 'images', progress: 0.4, message: undefined }));
    const items = within(screen.getByRole('list', { name: 'Etapas' })).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-state'))).toEqual(['done', 'active', 'pending', 'pending']);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    act(() => fake.emit({ type: 'progress', stage: 'transitions', progress: 0.7, message: 'Scene 2: hard cut' }));
    expect(screen.getByText('Scene 2: hard cut')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(fake.api.cancelJob).toHaveBeenCalledWith('j1');

    act(() => fake.emit({ type: 'done' }));
    expect(view.container.querySelector('video')).toHaveAttribute('src', '/api/jobs/j1/output');
    expect(screen.getByRole('link', { name: 'Descargar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument();
  });

  it('failure shows the error and Retry approves again', async () => {
    const { fake, view, user } = setup();
    await generate(user);
    await user.click(screen.getByRole('button', { name: 'Aprobar y generar' }));
    act(() => fake.emit({ type: 'stage', stage: 'images', progress: 0.3 }));
    act(() => fake.emit({ type: 'error', message: 'ComfyUI exploded' }));
    expect(screen.getByRole('alert')).toHaveTextContent('ComfyUI exploded');
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(fake.api.approveDraft).toHaveBeenCalledTimes(2);
    act(() => fake.emit({ type: 'done', outputUrl: '/api/jobs/j2/output' }));
    expect(view.container.querySelector('video')).toHaveAttribute('src', '/api/jobs/j2/output');
  });
});

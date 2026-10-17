import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PipelineForm } from '../src/components/PipelineForm';

function setup(props: Partial<React.ComponentProps<typeof PipelineForm>> = {}) {
  const onSubmit = vi.fn();
  render(<PipelineForm drafting={false} error={null} onSubmit={onSubmit} {...props} />);
  return { onSubmit, user: userEvent.setup() };
}

describe('PipelineForm', () => {
  it('defaults to URL source, es language, male/female voices, mix off', () => {
    setup();
    expect(screen.getByRole('button', { name: 'URL' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('URL del artículo')).toBeInTheDocument();
    expect(screen.getByLabelText('Idioma')).toHaveValue('es');
    expect(screen.getByLabelText('Voz A')).toHaveValue('male');
    expect(screen.getByLabelText('Voz B')).toHaveValue('female');
    expect(screen.getByRole('button', { name: '⇄ Mezclar' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('disables submit while empty and enables it with content', async () => {
    const { user } = setup();
    const submit = screen.getByRole('button', { name: 'Generar' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('URL del artículo'), '   ');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('URL del artículo'), 'https://x.test/a');
    expect(submit).toBeEnabled();
  });

  it('sends only the trimmed url with the options', async () => {
    const { onSubmit, user } = setup();
    await user.type(screen.getByLabelText('URL del artículo'), '  https://x.test/a  ');
    await user.selectOptions(screen.getByLabelText('Idioma'), 'en');
    await user.selectOptions(screen.getByLabelText('Voz A'), 'female');
    await user.click(screen.getByRole('button', { name: 'Generar' }));
    expect(onSubmit).toHaveBeenCalledWith({
      url: 'https://x.test/a',
      language: 'en',
      voiceA: 'female',
      voiceB: 'female',
      mix: false,
    });
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty('text');
  });

  it('switches to text source and sends only trimmed text', async () => {
    const { onSubmit, user } = setup();
    await user.type(screen.getByLabelText('URL del artículo'), 'https://ignored.test');
    await user.click(screen.getByRole('button', { name: 'Texto' }));
    expect(screen.getByRole('button', { name: 'Texto' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('URL del artículo')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generar' })).toBeDisabled();
    await user.type(screen.getByLabelText('Texto del artículo'), '  Hola mundo  ');
    await user.click(screen.getByRole('button', { name: 'Generar' }));
    const payload = onSubmit.mock.calls[0]![0];
    expect(payload.text).toBe('Hola mundo');
    expect(payload).not.toHaveProperty('url');
  });

  it('mix toggle flips aria-pressed and sets mix in the payload', async () => {
    const { onSubmit, user } = setup();
    const mix = screen.getByRole('button', { name: '⇄ Mezclar' });
    await user.click(mix);
    expect(mix).toHaveAttribute('aria-pressed', 'true');
    await user.type(screen.getByLabelText('URL del artículo'), 'u');
    await user.click(screen.getByRole('button', { name: 'Generar' }));
    expect(onSubmit.mock.calls[0]![0].mix).toBe(true);
    await user.click(mix);
    expect(mix).toHaveAttribute('aria-pressed', 'false');
  });

  it('while drafting disables submit and shows the drafting label', () => {
    setup({ drafting: true });
    expect(screen.getByRole('button', { name: /Generando/ })).toBeDisabled();
  });

  it('shows the error in an alert', () => {
    setup({ error: 'Ollama is down' });
    expect(screen.getByRole('alert')).toHaveTextContent('Ollama is down');
  });
});

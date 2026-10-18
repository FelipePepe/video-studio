import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReviewPanel } from '../src/components/ReviewPanel';
import { I18nProvider } from '../src/i18n';
import type { MusicLibrary, VoiceOption } from '../src/api/types';
import type { ApiClient } from '../src/api/client';
import { draft } from './helpers/fakeApi';

const library: MusicLibrary = {
  musicDir: '/music',
  files: [
    { name: 'ambient.mp3', path: '/music/ambient.mp3', size: 1, mtime: 'x' },
    { name: 'piano.ogg', path: '/music/piano.ogg', size: 2, mtime: 'x' },
  ],
};

const roster: VoiceOption[] = [
  { name: 'es_ES-davefx-medium' },
  { name: 'es_ES-sharvard-medium', speaker: 1 },
];

type PanelApi = Pick<ApiClient, 'listMusic' | 'listVoices'>;

function makeApi(lib: MusicLibrary | null = null, voices: VoiceOption[] = []): PanelApi {
  return {
    listMusic: vi.fn(async () => lib),
    listVoices: vi.fn(async () => voices),
  };
}

function setup(api: PanelApi = makeApi()) {
  const props = {
    draft,
    api,
    error: null,
    onSave: vi.fn(async () => true),
    onApprove: vi.fn(),
    onBack: vi.fn(),
  };
  render(
    <I18nProvider>
      <ReviewPanel {...props} />
    </I18nProvider>,
  );
  return { props, user: userEvent.setup() };
}

describe('ReviewPanel render options', () => {
  it('shows the options block with defaults: music off, subtitles on, vertical off', () => {
    setup();
    expect(screen.getByRole('switch', { name: /Música de fondo/i })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: /Subtítulos/i })).toBeChecked();
    expect(screen.getByRole('switch', { name: /Vertical/i })).not.toBeChecked();
  });

  it('applies with all defaults and approves with no body', async () => {
    const { props, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Aprobar y generar' }));
    expect(props.onApprove).toHaveBeenCalledWith(undefined);
  });

  it('music on with library: select a track and send its path with the current volume', async () => {
    const { props, user } = setup(makeApi(library));
    await user.click(screen.getByRole('switch', { name: /Música de fondo/i }));
    await user.selectOptions(screen.getByLabelText('Canción'), 'piano.ogg');
    await user.click(screen.getByRole('button', { name: 'Aprobar y generar' }));
    expect(props.onApprove).toHaveBeenCalledWith({ music: '/music/piano.ogg', musicVolume: 0.25 });
  });

  it('music on with custom path: send the typed path', async () => {
    const { props, user } = setup(makeApi());
    await user.click(screen.getByRole('switch', { name: /Música de fondo/i }));
    await user.type(screen.getByLabelText('Ruta del archivo'), '/home/felipe/Music/x.mp3');
    await user.click(screen.getByRole('button', { name: 'Aprobar y generar' }));
    expect(props.onApprove).toHaveBeenCalledWith({ music: '/home/felipe/Music/x.mp3', musicVolume: 0.25 });
  });

  it('subtitles off: approve body carries subtitles:false only', async () => {
    const { props, user } = setup();
    await user.click(screen.getByRole('switch', { name: /Subtítulos/i }));
    await user.click(screen.getByRole('button', { name: 'Aprobar y generar' }));
    expect(props.onApprove).toHaveBeenCalledWith({ subtitles: false });
  });

  it('vertical on: approve body carries vertical:true', async () => {
    const { props, user } = setup();
    await user.click(screen.getByRole('switch', { name: /Vertical/i }));
    await user.click(screen.getByRole('button', { name: 'Aprobar y generar' }));
    expect(props.onApprove).toHaveBeenCalledWith({ vertical: true });
  });

  it('all on: one combined approve body', async () => {
    const { props, user } = setup(makeApi(library, roster));
    await user.click(screen.getByRole('switch', { name: /Música de fondo/i }));
    await user.selectOptions(screen.getByLabelText('Canción'), 'ambient.mp3');
    await user.click(screen.getByRole('switch', { name: /Subtítulos/i }));
    await user.click(screen.getByRole('switch', { name: /Vertical/i }));
    await user.click(screen.getByRole('button', { name: 'Aprobar y generar' }));
    expect(props.onApprove).toHaveBeenCalledWith({ music: '/music/ambient.mp3', musicVolume: 0.25, subtitles: false, vertical: true });
  });

  it('segment editor voice options come from the Piper roster', async () => {
    setup(makeApi(null, roster));
    expect((await screen.findAllByText('es_ES-davefx-medium')).length).toBeGreaterThanOrEqual(1);
  });

  it('segment editor falls back to male/female when there is no roster', async () => {
    setup(makeApi());
    expect((await screen.findAllByText('Masculina')).length).toBeGreaterThanOrEqual(1);
    expect((await screen.findAllByText('Femenina')).length).toBeGreaterThanOrEqual(1);
  });
});

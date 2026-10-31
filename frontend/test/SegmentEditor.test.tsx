import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Scene } from '../src/api/types';
import { SegmentEditor } from '../src/components/SegmentEditor';
import { I18nProvider } from '../src/i18n';

const scene = (n: number, over: Partial<Scene> = {}): Scene => ({
  scene: n,
  title: `Title ${n}`,
  narration: `Narration ${n}`,
  visualPrompt: `Visual ${n}`,
  voice: n % 2 ? 'male' : 'female',
  ...over,
});

function Harness({ initial, spy, speakerVoices }: { initial: Scene[]; spy?: (s: Scene[]) => void; speakerVoices?: { A: string; B: string } }) {
  const [scenes, setScenes] = useState(initial);
  return (
    <SegmentEditor
      scenes={scenes}
      onChange={(next) => {
        spy?.(next);
        setScenes(next);
      }}
      speakerVoices={speakerVoices}
    />
  );
}

const speakerVoices = { A: 'es_ES-anita', B: 'es_ES-pepe' };

function setup(initial: Scene[] = [scene(1), scene(2), scene(3)], speakerVoicesProp?: { A: string; B: string }) {
  const spy = vi.fn();
  render(
    <I18nProvider>
      <Harness initial={initial} spy={spy} speakerVoices={speakerVoicesProp} />
    </I18nProvider>,
  );
  return { spy, user: userEvent.setup() };
}

const card = (n: number) => screen.getByRole('listitem', { name: `Escena ${n}` });
const titles = () => screen.getAllByLabelText('Título').map((e) => (e as HTMLInputElement).value);

describe('SegmentEditor', () => {
  it('renders one editable card per scene with every field', () => {
    setup();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    const c = within(card(2));
    expect(c.getByLabelText('Título')).toHaveValue('Title 2');
    expect(c.getByLabelText('Narración')).toHaveValue('Narration 2');
    expect(c.getByLabelText('Prompt visual')).toHaveValue('Visual 2');
    expect(c.getByLabelText('Voz')).toHaveValue('female');
  });

  it('emits the edited scene on typing and on voice change', async () => {
    const { spy, user } = setup();
    const c = within(card(1));
    await user.type(c.getByLabelText('Título'), '!');
    expect(spy).toHaveBeenLastCalledWith([scene(1, { title: 'Title 1!' }), scene(2), scene(3)]);
    await user.selectOptions(c.getByLabelText('Voz'), 'female');
    expect(spy).toHaveBeenLastCalledWith([scene(1, { title: 'Title 1!', voice: 'female' }), scene(2), scene(3)]);
  });

  it('keeps an unknown voice as an extra option', () => {
    setup([scene(1, { voice: 'es_ES-custom' })]);
    expect(screen.getByLabelText('Voz')).toHaveValue('es_ES-custom');
  });

  it('shows live character counters against the caps', async () => {
    const { user } = setup([scene(1, { title: 'abc' })]);
    const c = within(card(1));
    expect(c.getByText('3/120')).toBeInTheDocument();
    expect(c.getByText(/^\d+\/1200$/)).toBeInTheDocument();
    expect(c.getByText(/^\d+\/600$/)).toBeInTheDocument();
    await user.type(c.getByLabelText('Título'), 'de');
    expect(c.getByText('5/120')).toBeInTheDocument();
  });

  it('flags empty and whitespace-only fields', async () => {
    const { user } = setup([scene(1)]);
    const c = within(card(1));
    await user.clear(c.getByLabelText('Título'));
    expect(c.getByLabelText('Título')).toBeInvalid();
    expect(c.getByLabelText('Título')).toHaveAccessibleDescription(/No puede estar vacío/);
    await user.clear(c.getByLabelText('Narración'));
    await user.type(c.getByLabelText('Narración'), '   ');
    expect(c.getByLabelText('Narración')).toBeInvalid();
  });

  it.each([
    ['Título', 120],
    ['Narración', 1200],
    ['Prompt visual', 600],
  ])('flags %s above %i characters (after trimming) but accepts exactly the cap', async (label, cap) => {
    setup([scene(1)]);
    const field = within(card(1)).getByLabelText(label);
    const user = userEvent.setup();
    await user.clear(field);
    await user.click(field);
    await user.paste('x'.repeat(cap));
    expect(field).toBeValid();
    await user.paste('x');
    expect(field).toBeInvalid();
    expect(field).toHaveAccessibleDescription(new RegExp(`${cap}`));
  });

  it('shows a speaker select on every scene when any scene has a speaker', () => {
    setup([scene(1, { speaker: 'A' }), scene(2, { speaker: 'B' }), scene(3)]);
    expect(screen.getAllByLabelText('Orador')).toHaveLength(3);
    const options = within(card(2)).getAllByLabelText('Orador')[0]!.querySelectorAll('option');
    expect(Array.from(options).map((o) => o.value)).toEqual(['A', 'B']);
  });

  it('shows no speaker select when no scene has one', () => {
    setup();
    expect(screen.queryAllByLabelText('Orador')).toHaveLength(0);
  });

  it('changing the speaker updates speaker and the mapped voice', async () => {
    const { spy, user } = setup([scene(1, { speaker: 'A', voice: 'male' }), scene(2, { speaker: 'B', voice: 'female' }), scene(3, { speaker: 'A' })]);
    await user.selectOptions(within(card(2)).getByLabelText('Orador'), 'A');
    const next = spy.mock.lastCall![0] as Scene[];
    expect(next[1]).toMatchObject({ speaker: 'A', voice: 'male' });
    expect(next[0]).toEqual(scene(1, { speaker: 'A', voice: 'male' }));
  });

  it('uses the speakerVoices mapping when provided', async () => {
    const { spy, user } = setup([scene(1, { speaker: 'A' }), scene(2, { speaker: 'B' })], speakerVoices);
    await user.selectOptions(within(card(1)).getByLabelText('Orador'), 'B');
    expect((spy.mock.lastCall![0] as Scene[])[0]).toMatchObject({ speaker: 'B', voice: 'es_ES-pepe' });
    await user.selectOptions(within(card(2)).getByLabelText('Orador'), 'A');
    expect((spy.mock.lastCall![0] as Scene[])[1]).toMatchObject({ speaker: 'A', voice: 'es_ES-anita' });
  });

  it('adds a new scene below with the speaker flipped from the scene above', async () => {
    const { spy, user } = setup([scene(1, { speaker: 'A', voice: 'male' }), scene(2, { speaker: 'B', voice: 'female' })], speakerVoices);
    await user.click(within(card(1)).getByRole('button', { name: 'Añadir escena debajo de la escena 1' }));
    const next = spy.mock.lastCall![0] as Scene[];
    expect(next[1]).toEqual({ scene: 2, title: '', narration: '', visualPrompt: '', voice: 'es_ES-pepe', speaker: 'B' });
    expect(next[2]!.speaker).toBe('B');
  });

  it('adds a plain empty scene below when the scene above has no speaker', async () => {
    const { spy, user } = setup([scene(1), scene(2)]);
    await user.click(within(card(1)).getByRole('button', { name: 'Añadir escena debajo de la escena 1' }));
    const next = spy.mock.lastCall![0] as Scene[];
    expect(next[1]).toEqual({ scene: 2, title: '', narration: '', visualPrompt: '', voice: 'male' });
    expect(next[1]).not.toHaveProperty('speaker');
  });

  describe('SegmentEditor move/delete', () => {
    it('keeps scenes\' speaker through move and delete', async () => {
      const { spy, user } = setup([scene(1, { speaker: 'A' }), scene(2, { speaker: 'B' })]);
      await user.click(within(card(2)).getByRole('button', { name: 'Subir escena 2' }));
      const moved = spy.mock.lastCall![0] as Scene[];
      expect(moved.map((s) => s.speaker)).toEqual(['B', 'A']);
      await user.click(within(card(1)).getByRole('button', { name: 'Eliminar escena 1' }));
      expect((spy.mock.lastCall![0] as Scene[])[0].speaker).toBe('A');
    });
  });

  it('adds an empty scene below with the neighbour voice and renumbers', async () => {
    const { spy, user } = setup();
    await user.click(within(card(2)).getByRole('button', { name: 'Añadir escena debajo de la escena 2' }));
    const next = spy.mock.lastCall![0] as Scene[];
    expect(next.map((s) => s.scene)).toEqual([1, 2, 3, 4]);
    expect(next[2]).toEqual({ scene: 3, title: '', narration: '', visualPrompt: '', voice: 'female' });
    expect(next[3]!.title).toBe('Title 3');
  });

  it('deletes a scene and renumbers', async () => {
    const { spy, user } = setup();
    await user.click(within(card(2)).getByRole('button', { name: 'Eliminar escena 2' }));
    const next = spy.mock.lastCall![0] as Scene[];
    expect(next.map((s) => [s.scene, s.title])).toEqual([
      [1, 'Title 1'],
      [2, 'Title 3'],
    ]);
  });

  it('disables delete when only one scene remains', () => {
    setup([scene(1)]);
    expect(screen.getByRole('button', { name: 'Eliminar escena 1' })).toBeDisabled();
  });

  it('moves scenes up and down, renumbers and announces it', async () => {
    const { user } = setup();
    await user.click(within(card(2)).getByRole('button', { name: 'Subir escena 2' }));
    expect(titles()).toEqual(['Title 2', 'Title 1', 'Title 3']);
    expect(screen.getByRole('status')).toHaveTextContent(/escena 2.*posición 1/i);
    await user.click(within(card(1)).getByRole('button', { name: 'Bajar escena 1' }));
    expect(titles()).toEqual(['Title 1', 'Title 2', 'Title 3']);
    expect(screen.getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual([
      'Escena 1',
      'Escena 2',
      'Escena 3',
    ]);
  });

  it('disables moving the first scene up and the last scene down', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Subir escena 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Bajar escena 3' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Subir escena 2' })).toBeEnabled();
  });

  it('disables adding at 20 scenes', () => {
    setup(Array.from({ length: 20 }, (_, i) => scene(i + 1)));
    for (const b of screen.getAllByRole('button', { name: /Añadir escena debajo/ })) expect(b).toBeDisabled();
  });
});

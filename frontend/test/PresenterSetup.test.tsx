import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { Character } from '../src/api/types';
import { PresenterSetup, type PresenterSetupProps } from '../src/components/PresenterSetup';
import { I18nProvider, LANGUAGE_STORAGE_KEY } from '../src/i18n';
import { fakeCharacter } from './helpers/fakeApi';

const makeCharacter = (over: Partial<Character> = {}): Character => fakeCharacter(over);

type Api = PresenterSetupProps['api'];

function makeApi(list: Character[] = []) {
  const api = {
    listCharacters: vi.fn(async () => list),
    createCharacter: vi.fn(async () => makeCharacter({ id: 'new', name: 'Nuevo' })),
    approveCharacter: vi.fn(async (id: string) => ({ ...list.find((c) => c.id === id)!, status: 'approved' as const })),
    deleteCharacter: vi.fn(async () => undefined),
  } satisfies Api;
  return api;
}

const ana = makeCharacter({ id: 'c1', name: 'Ana', description: 'Zorro', status: 'approved' });
const beto = makeCharacter({ id: 'c2', name: 'Beto', description: 'Oso', status: 'approved' });
const cleo = makeCharacter({ id: 'c3', name: 'Cleo', description: 'Gato', status: 'generated' });

function setup(api: Api = makeApi([ana, beto, cleo]), props: Partial<PresenterSetupProps> = {}) {
  const onChange = vi.fn();
  const view = render(
    <I18nProvider>
      <PresenterSetup api={api} a="" b="" onChange={onChange} {...props} />
    </I18nProvider>,
  );
  return { api, onChange, user: userEvent.setup(), ...view };
}

async function loaded() {
  await screen.findByRole('list', { name: 'Personajes' });
}

describe('PresenterSetup', () => {
  it('loads and lists the characters with image, name, description and status', async () => {
    const { api } = setup();
    await loaded();
    expect(api.listCharacters).toHaveBeenCalledTimes(1);
    const cards = within(screen.getByRole('list', { name: 'Personajes' })).getAllByRole('listitem');
    expect(cards.map((c) => within(c).getByRole('heading').textContent)).toEqual(['Ana', 'Beto', 'Cleo']);
    expect(within(cards[0]).getByRole('img', { name: 'Personaje Ana' })).toHaveAttribute('src', '/api/characters/c1/image');
    expect(within(cards[0]).getByText('Zorro')).toBeInTheDocument();
    expect(within(cards[0]).getByText('Aprobado')).toBeInTheDocument();
    expect(within(cards[2]).getByText('Pendiente de aprobar')).toBeInTheDocument();
  });

  it('pickers offer only approved characters plus none', async () => {
    setup();
    await loaded();
    const a = screen.getByLabelText('Presentador A');
    expect(within(a).getAllByRole('option').map((o) => o.textContent)).toEqual(['Sin personaje', 'Ana', 'Beto']);
  });

  it('disables the pickers and hints when nothing is approved', async () => {
    setup(makeApi([cleo]));
    await loaded();
    expect(screen.getByLabelText('Presentador A')).toBeDisabled();
    expect(screen.getByLabelText('Presentador B')).toBeDisabled();
    expect(screen.getByText('Aprueba al menos dos personajes para elegirlos.')).toBeInTheDocument();
  });

  it('keeps A and B different and reports changes', async () => {
    const { onChange, user } = setup(undefined, { a: 'c1' });
    await loaded();
    const optB = within(screen.getByLabelText('Presentador B')).getByRole('option', { name: 'Ana' });
    expect(optB).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Presentador B'), 'Beto');
    expect(onChange).toHaveBeenLastCalledWith({ a: 'c1', b: 'c2' });
    await user.selectOptions(screen.getByLabelText('Presentador A'), 'Sin personaje');
    expect(onChange).toHaveBeenLastCalledWith({ a: '', b: '' });
  });

  it('treats B as unset when the parent state has a === b', async () => {
    setup(undefined, { a: 'c1', b: 'c1' });
    await loaded();
    expect(screen.getByLabelText('Presentador B')).toHaveValue('');
    expect(screen.getByLabelText('Presentador A')).toHaveValue('c1');
  });

  it('shows the needBoth hint for one choice and ready for two', async () => {
    const one = setup(undefined, { a: 'c1' });
    await loaded();
    expect(screen.getByRole('note')).toHaveTextContent('Elige A y B');
    one.unmount();
    setup(undefined, { a: 'c1', b: 'c2' });
    await loaded();
    expect(screen.getByText(/aparecerán abajo a la izquierda/)).toBeInTheDocument();
  });

  describe('create', () => {
    it('keeps the button disabled for blank fields (whitespace counts as blank)', async () => {
      const { user } = setup();
      await loaded();
      const button = screen.getByRole('button', { name: 'Generar personaje' });
      expect(button).toBeDisabled();
      await user.type(screen.getByLabelText('Nombre'), '   ');
      await user.type(screen.getByLabelText('Descripción'), 'algo');
      expect(button).toBeDisabled();
    });

    it('submits trimmed values, shows pending state, then prepends the card and focuses its heading', async () => {
      const api = makeApi([ana]);
      let release: (c: Character) => void = () => {};
      api.createCharacter.mockImplementation(() => new Promise<Character>((r) => (release = r)));
      const { user } = setup(api);
      await loaded();
      await user.type(screen.getByLabelText('Nombre'), '  Nuevo ');
      await user.type(screen.getByLabelText('Descripción'), ' un zorro  ');
      await user.click(screen.getByRole('button', { name: 'Generar personaje' }));
      expect(api.createCharacter).toHaveBeenCalledWith({ name: 'Nuevo', description: 'un zorro' });
      expect(screen.getByRole('button', { name: 'Generando…' })).toBeDisabled();
      expect(screen.getByRole('status')).toHaveTextContent('La generación puede tardar hasta un minuto.');
      expect(screen.getByRole('group', { name: 'Presentadores' })).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByLabelText('Nombre')).toBeDisabled();
      await act(async () => release(makeCharacter({ id: 'new', name: 'Nuevo' })));
      const cards = within(screen.getByRole('list', { name: 'Personajes' })).getAllByRole('listitem');
      expect(cards.map((c) => within(c).getByRole('heading').textContent)).toEqual(['Nuevo', 'Ana']);
      expect(screen.getByLabelText('Nombre')).toHaveValue('');
      expect(screen.getByLabelText('Descripción')).toHaveValue('');
      expect(within(cards[0]).getByRole('heading')).toHaveFocus();
    });

    it.each([
      [new ApiError(429, 'a character is already being generated'), 'Ya se está generando otro personaje. Espera a que termine.'],
      [new ApiError(503, 'ComfyUI unavailable'), 'ComfyUI no está disponible. Inténtalo de nuevo más tarde.'],
      [new ApiError(502, 'boom'), 'La generación falló: boom'],
      [new ApiError(422, 'no crop'), 'No se pudo analizar la imagen generada. Prueba con otra descripción: no crop'],
      [new ApiError(400, 'name is required'), 'name is required'],
      [new Error('network'), 'No se pudo crear el personaje.'],
    ])('maps %s to an alert and keeps the form usable', async (error, message) => {
      const api = makeApi();
      api.createCharacter.mockRejectedValue(error);
      const { user } = setup(api);
      await loaded();
      await user.type(screen.getByLabelText('Nombre'), 'Zed');
      await user.type(screen.getByLabelText('Descripción'), 'desc');
      await user.click(screen.getByRole('button', { name: 'Generar personaje' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByLabelText('Nombre')).toHaveValue('Zed');
      expect(screen.getByLabelText('Descripción')).toHaveValue('desc');
      expect(screen.getByRole('button', { name: 'Generar personaje' })).toBeEnabled();
    });

    it('never shows raw server text for 429 and 503', async () => {
      const api = makeApi();
      api.createCharacter.mockRejectedValue(new ApiError(503, 'secret internals'));
      const { user } = setup(api);
      await loaded();
      await user.type(screen.getByLabelText('Nombre'), 'Zed');
      await user.type(screen.getByLabelText('Descripción'), 'desc');
      await user.click(screen.getByRole('button', { name: 'Generar personaje' }));
      expect(await screen.findByRole('alert')).not.toHaveTextContent('secret internals');
    });
  });

  describe('approve', () => {
    it('is offered only on generated cards and approves in place', async () => {
      const { api, user } = setup();
      await loaded();
      const cards = within(screen.getByRole('list', { name: 'Personajes' })).getAllByRole('listitem');
      expect(within(cards[0]).queryByRole('button', { name: 'Aprobar' })).not.toBeInTheDocument();
      expect(within(screen.getByLabelText('Presentador A')).queryByRole('option', { name: 'Cleo' })).not.toBeInTheDocument();
      await user.click(within(cards[2]).getByRole('button', { name: 'Aprobar' }));
      expect(api.approveCharacter).toHaveBeenCalledWith('c3');
      await waitFor(() => expect(within(cards[2]).getByText('Aprobado')).toBeInTheDocument());
      expect(within(screen.getByLabelText('Presentador A')).getByRole('option', { name: 'Cleo' })).toBeInTheDocument();
      expect(within(screen.getByLabelText('Presentador B')).getByRole('option', { name: 'Cleo' })).toBeInTheDocument();
    });

    it('shows an alert inside the card on failure and keeps it generated', async () => {
      const api = makeApi([cleo]);
      api.approveCharacter.mockRejectedValue(new Error('x'));
      const { user } = setup(api);
      await loaded();
      const card = screen.getByRole('listitem');
      await user.click(within(card).getByRole('button', { name: 'Aprobar' }));
      expect(await within(card).findByRole('alert')).toHaveTextContent('No se pudo aprobar el personaje.');
      expect(within(card).getByText('Pendiente de aprobar')).toBeInTheDocument();
    });
  });

  describe('delete', () => {
    const cardOf = (name: string) =>
      screen.getAllByRole('listitem').find((li) => within(li).queryByRole('heading', { name }))!;

    it('asks inline first, with focus on Yes; Escape aborts and returns focus to Delete', async () => {
      const { api, user } = setup();
      await loaded();
      await user.click(within(cardOf('Ana')).getByRole('button', { name: 'Eliminar' }));
      expect(api.deleteCharacter).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Sí, eliminar' })).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('button', { name: 'Sí, eliminar' })).not.toBeInTheDocument();
      expect(within(cardOf('Ana')).getByRole('button', { name: 'Eliminar' })).toHaveFocus();
    });

    it('Cancelar aborts and returns focus to Delete', async () => {
      const { api, user } = setup();
      await loaded();
      await user.click(within(cardOf('Ana')).getByRole('button', { name: 'Eliminar' }));
      await user.click(screen.getByRole('button', { name: 'Cancelar' }));
      expect(api.deleteCharacter).not.toHaveBeenCalled();
      expect(within(cardOf('Ana')).getByRole('button', { name: 'Eliminar' })).toHaveFocus();
    });

    it('confirming deletes the card and clears the slot when it was chosen', async () => {
      const { api, onChange, user } = setup(undefined, { a: 'c1', b: 'c2' });
      await loaded();
      await user.click(within(cardOf('Ana')).getByRole('button', { name: 'Eliminar' }));
      await user.click(screen.getByRole('button', { name: 'Sí, eliminar' }));
      expect(api.deleteCharacter).toHaveBeenCalledWith('c1');
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Ana' })).not.toBeInTheDocument());
      expect(onChange).toHaveBeenCalledWith({ a: '', b: 'c2' });
      expect(screen.getByLabelText('Nombre')).toHaveFocus();
    });

    it('a failed delete shows an alert and keeps the card', async () => {
      const api = makeApi([ana]);
      api.deleteCharacter.mockRejectedValue(new Error('x'));
      const { user } = setup(api);
      await loaded();
      await user.click(screen.getByRole('button', { name: 'Eliminar' }));
      await user.click(screen.getByRole('button', { name: 'Sí, eliminar' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo eliminar el personaje.');
      expect(screen.getByRole('heading', { name: 'Ana' })).toBeInTheDocument();
    });
  });

  it('shows a list failure with a retry that reloads', async () => {
    const api = makeApi([ana]);
    api.listCharacters.mockRejectedValueOnce(new Error('down'));
    const { user } = setup(api);
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cargar la lista de personajes.');
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(api.listCharacters).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('heading', { name: 'Ana' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('labels every control', async () => {
    setup();
    await loaded();
    expect(screen.getByLabelText('Nombre')).toBeInTheDocument();
    expect(screen.getByLabelText('Descripción')).toBeInTheDocument();
    expect(screen.getByLabelText('Presentador A')).toBeInTheDocument();
    expect(screen.getByLabelText('Presentador B')).toBeInTheDocument();
  });

  it('renders English copy when the language is en', async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
    setup();
    expect(await screen.findByLabelText('Presenter A')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate character' })).toBeInTheDocument();
    expect(screen.getAllByText('Approved').length).toBeGreaterThan(0);
  });
});

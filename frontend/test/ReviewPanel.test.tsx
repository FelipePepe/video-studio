import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReviewPanel } from '../src/components/ReviewPanel';
import { I18nProvider } from '../src/i18n';
import { draft } from './helpers/fakeApi';

function setup(over: Partial<React.ComponentProps<typeof ReviewPanel>> = {}) {
  const api = over.api ?? { listMusic: vi.fn(async () => null), listVoices: vi.fn(async () => []) };
  const props = {
    draft,
    api,
    error: null,
    onSave: vi.fn(async () => true),
    onApprove: vi.fn(),
    onBack: vi.fn(),
    ...over,
  };
  const view = render(
    <I18nProvider>
      <ReviewPanel {...props} />
    </I18nProvider>,
  );
  return { props, view, user: userEvent.setup() };
}

const title = (n: number) => within(screen.getByRole('listitem', { name: `Escena ${n}` })).getByLabelText('Título');

describe('ReviewPanel', () => {
  it('starts clean: Guardar disabled, no unsaved indicator, scene count shown', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled();
    expect(screen.queryByText('Cambios sin guardar')).not.toBeInTheDocument();
    expect(screen.getByText(/Escenas/)).toHaveTextContent('2');
  });

  it('tracks dirty state, including reverting an edit', async () => {
    const { user } = setup();
    await user.type(title(1), 'X');
    expect(screen.getByText('Cambios sin guardar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeEnabled();
    await user.type(title(1), '{Backspace}');
    expect(screen.queryByText('Cambios sin guardar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled();
  });

  it('Guardar sends the edited escaleta', async () => {
    const { props, user } = setup();
    await user.type(title(2), '!');
    await user.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(props.onSave).toHaveBeenCalledWith([draft.escaleta[0], { ...draft.escaleta[1], title: 'Body!' }]);
    expect(props.onApprove).not.toHaveBeenCalled();
  });

  it('disables Guardar and Aprobar with a reason while a field is invalid', async () => {
    const { user } = setup();
    await user.clear(title(1));
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled();
    const approve = screen.getByRole('button', { name: 'Aprobar y generar' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(/Corrige/);
  });

  it('shows the save error and approves nothing when the save fails', async () => {
    const { props, user } = setup({ onSave: vi.fn(async () => false), error: 'scene 1 title must be a non-empty string' });
    await user.type(title(1), 'X');
    await user.click(screen.getByRole('button', { name: 'Aprobar y generar' }));
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onApprove).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('scene 1 title must be a non-empty string');
  });

  it('Aprobar saves first and then approves when dirty', async () => {
    const order: string[] = [];
    const { props, user } = setup({
      onSave: vi.fn(async () => {
        order.push('save');
        return true;
      }),
      onApprove: vi.fn(() => order.push('approve')),
    });
    await user.type(title(1), 'X');
    await user.click(screen.getByRole('button', { name: 'Aprobar y generar' }));
    expect(order).toEqual(['save', 'approve']);
    expect(props.onSave).toHaveBeenCalledWith([{ ...draft.escaleta[0], title: 'IntroX' }, draft.escaleta[1]]);
  });

  it('Aprobar without edits approves directly', async () => {
    const { props, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Aprobar y generar' }));
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onApprove).toHaveBeenCalledTimes(1);
  });

  it('shows Guardando… while saving and blocks double actions', async () => {
    let finish: (ok: boolean) => void = () => {};
    const { props, user } = setup({ onSave: vi.fn(() => new Promise<boolean>((r) => (finish = r))) });
    await user.type(title(1), 'X');
    await user.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(screen.getByRole('button', { name: 'Guardando…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Aprobar y generar' })).toBeDisabled();
    finish(true);
    expect(await screen.findByRole('button', { name: 'Guardar' })).toBeInTheDocument();
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  it('Volver goes back directly when clean', async () => {
    const { props, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Volver' }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('Volver asks for confirmation in-app when dirty, and cancel keeps editing', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { props, user } = setup();
    await user.type(title(1), 'X');
    await user.click(screen.getByRole('button', { name: 'Volver' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAccessibleName(/cambios sin guardar/i);
    expect(props.onBack).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Seguir editando' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(title(1)).toHaveValue('IntroX');
    expect(props.onBack).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('confirming the dialog discards changes and goes back; Escape cancels', async () => {
    const { props, user } = setup();
    await user.type(title(1), 'X');
    await user.click(screen.getByRole('button', { name: 'Volver' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Volver' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Descartar cambios' }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('resets the local copy when the draft id changes', async () => {
    const { view, props, user } = setup();
    await user.type(title(1), 'X');
    view.rerender(
      <I18nProvider>
        <ReviewPanel {...props} draft={{ ...draft, id: 'd2', escaleta: [draft.escaleta[1]!] }} />
      </I18nProvider>,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(title(1)).toHaveValue('Body');
    expect(screen.queryByText('Cambios sin guardar')).not.toBeInTheDocument();
  });

  it('ignores whitespace-only differences because the backend trims', async () => {
    const { user } = setup();
    await user.type(title(1), ' ');
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled();
    expect(screen.queryByText('Cambios sin guardar')).not.toBeInTheDocument();
  });
});

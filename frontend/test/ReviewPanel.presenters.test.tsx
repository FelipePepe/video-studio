import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReviewPanel, type ReviewPanelProps } from '../src/components/ReviewPanel';
import { I18nProvider } from '../src/i18n';
import type { DraftCreated } from '../src/api/types';
import { draft, fakeCharacter } from './helpers/fakeApi';

const dialogueDraft: DraftCreated = {
  id: 'dd',
  status: 'draft',
  escaleta: [
    { scene: 1, title: 'Hola', narration: 'Hola', visualPrompt: 'a', voice: 'male', speaker: 'A' },
    { scene: 2, title: 'Adiós', narration: 'Adiós', visualPrompt: 'b', voice: 'female', speaker: 'B' },
  ],
};

const ana = fakeCharacter({ id: 'c1', name: 'Ana', status: 'approved' });
const beto = fakeCharacter({ id: 'c2', name: 'Beto', status: 'approved' });

function makeApi() {
  return {
    listMusic: vi.fn(async () => null),
    listVoices: vi.fn(async () => []),
    listCharacters: vi.fn(async () => [ana, beto]),
    createCharacter: vi.fn(async () => ana),
    approveCharacter: vi.fn(async () => ana),
    deleteCharacter: vi.fn(async () => undefined),
  };
}

function setup(props: Partial<ReviewPanelProps> = {}) {
  const base: ReviewPanelProps = {
    draft: dialogueDraft,
    api: makeApi(),
    error: null,
    onSave: vi.fn(async () => true),
    onApprove: vi.fn(),
    onBack: vi.fn(),
    ...props,
  };
  const ui = (p: ReviewPanelProps) => (
    <I18nProvider>
      <ReviewPanel {...p} />
    </I18nProvider>
  );
  const view = render(ui(base));
  return { props: base, user: userEvent.setup(), rerender: (p: Partial<ReviewPanelProps>) => view.rerender(ui({ ...base, ...p })) };
}

const approveBtn = () => screen.getByRole('button', { name: 'Aprobar y generar' });
const presentersSwitch = () => screen.getByRole('switch', { name: 'Presentadores en pantalla' });

async function chooseBoth(user: ReturnType<typeof userEvent.setup>) {
  await user.click(presentersSwitch());
  await user.selectOptions(await screen.findByLabelText('Presentador A'), 'Ana');
  await user.selectOptions(screen.getByLabelText('Presentador B'), 'Beto');
}

describe('ReviewPanel presenters', () => {
  it('shows nothing for a narration draft and approves with no body', async () => {
    const { props, user } = setup({ draft });
    expect(screen.queryByRole('switch', { name: 'Presentadores en pantalla' })).not.toBeInTheDocument();
    await user.click(approveBtn());
    expect(props.onApprove).toHaveBeenCalledWith(undefined);
  });

  it('offers an OFF switch for a dialogue and loads characters only when it is turned on', async () => {
    const api = makeApi();
    const { user } = setup({ api });
    expect(presentersSwitch()).not.toBeChecked();
    expect(api.listCharacters).not.toHaveBeenCalled();
    await user.click(presentersSwitch());
    expect(await screen.findByLabelText('Presentador A')).toBeInTheDocument();
    expect(api.listCharacters).toHaveBeenCalled();
  });

  it('sends presenters when both are chosen', async () => {
    const { props, user } = setup();
    await chooseBoth(user);
    await user.click(approveBtn());
    expect(props.onApprove).toHaveBeenCalledWith({ presenters: { mode: 'volume', a: 'c1', b: 'c2' } });
  });

  it('omits presenters when only one or none is chosen', async () => {
    const { props, user } = setup();
    await user.click(presentersSwitch());
    await user.click(approveBtn());
    expect(props.onApprove).toHaveBeenLastCalledWith(undefined);
    await user.selectOptions(await screen.findByLabelText('Presentador A'), 'Ana');
    await user.click(approveBtn());
    expect(props.onApprove).toHaveBeenLastCalledWith(undefined);
  });

  it('omits presenters after switching off again', async () => {
    const { props, user } = setup();
    await chooseBoth(user);
    await user.click(presentersSwitch());
    await user.click(approveBtn());
    expect(props.onApprove).toHaveBeenCalledWith(undefined);
  });

  it('combines presenters with the other options without extra keys', async () => {
    const { props, user } = setup();
    await chooseBoth(user);
    await user.click(screen.getByRole('switch', { name: /Vertical/i }));
    await user.click(screen.getByRole('switch', { name: /Subtítulos/i }));
    await user.click(approveBtn());
    expect(props.onApprove).toHaveBeenCalledWith({
      subtitles: false,
      vertical: true,
      presenters: { mode: 'volume', a: 'c1', b: 'c2' },
    });
  });

  it('drops the selection when the draft changes to a narration one', async () => {
    const { props, user, rerender } = setup();
    await chooseBoth(user);
    rerender({ draft });
    expect(screen.queryByRole('switch', { name: 'Presentadores en pantalla' })).not.toBeInTheDocument();
    await user.click(approveBtn());
    expect(props.onApprove).toHaveBeenCalledWith(undefined);
    // Back to a dialogue: the previous choice is gone and the switch is off again.
    rerender({ draft: dialogueDraft });
    expect(presentersSwitch()).not.toBeChecked();
  });

  it('does not render the block when the api lacks the character methods', () => {
    setup({ api: { listMusic: vi.fn(async () => null), listVoices: vi.fn(async () => []) } });
    expect(screen.queryByRole('switch', { name: 'Presentadores en pantalla' })).not.toBeInTheDocument();
  });
});

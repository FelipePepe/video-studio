import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProgressStages } from '../src/components/ProgressStages';
import type { StageInfo } from '../src/hooks/usePipeline';

const stages = (...s: StageInfo['status'][]): StageInfo[] =>
  (['tts', 'images', 'transitions', 'assemble'] as const).map((id, i) => ({ id, status: s[i] ?? 'pending' }));

function setup(props: Partial<React.ComponentProps<typeof ProgressStages>> = {}) {
  const onCancel = vi.fn();
  render(
    <ProgressStages stages={stages()} progress={0} warnings={[]} cancellable={false} onCancel={onCancel} {...props} />,
  );
  return { onCancel };
}

describe('ProgressStages', () => {
  it('lists the four stages in order with their state', () => {
    setup({ stages: stages('done', 'active', 'pending', 'pending') });
    const items = within(screen.getByRole('list', { name: 'Etapas' })).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Voz (TTS)'),
      expect.stringContaining('Imágenes'),
      expect.stringContaining('Transiciones'),
      expect.stringContaining('Montaje'),
    ]);
    expect(items[0]).toHaveAttribute('data-state', 'done');
    expect(items[1]).toHaveAttribute('data-state', 'active');
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(items[2]).toHaveAttribute('data-state', 'pending');
    expect(items[0]).toHaveTextContent('hecho');
  });

  it('marks a failed stage', () => {
    setup({ stages: stages('done', 'failed') });
    expect(screen.getAllByRole('listitem')[1]).toHaveAttribute('data-state', 'failed');
  });

  it('exposes an accessible progress bar', () => {
    setup({ progress: 0.456 });
    const bar = screen.getByRole('progressbar', { name: 'Progreso del renderizado' });
    expect(bar).toHaveAttribute('aria-valuenow', '46');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('shows warnings only when there are some', () => {
    setup();
    expect(screen.queryByText('Avisos')).not.toBeInTheDocument();
  });

  it('lists warnings', () => {
    setup({ warnings: ['Scene 2: hard cut'] });
    expect(screen.getByText('Avisos')).toBeInTheDocument();
    expect(screen.getByText('Scene 2: hard cut')).toBeInTheDocument();
  });

  it('shows Cancel only when cancellable and calls onCancel', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument();
    const { onCancel } = setup({ cancellable: true });
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

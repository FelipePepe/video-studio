import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { VideoPanel } from '../src/components/VideoPanel';

function setup(props: Partial<React.ComponentProps<typeof VideoPanel>> = {}) {
  const onRetry = vi.fn();
  const view = render(<VideoPanel state="idle" outputUrl={null} error={null} onRetry={onRetry} {...props} />);
  return { onRetry, view };
}

describe('VideoPanel', () => {
  it('shows a placeholder before there is output', () => {
    const { view } = setup();
    expect(screen.getByText('El vídeo aparecerá aquí')).toBeInTheDocument();
    expect(view.container.querySelector('video')).toBeNull();
  });

  it('shows a video with controls and a download link when done', () => {
    const { view } = setup({ state: 'done', outputUrl: '/api/jobs/j1/output' });
    const video = view.container.querySelector('video')!;
    expect(video).toHaveAttribute('src', '/api/jobs/j1/output');
    expect(video).toHaveAttribute('controls');
    expect(view.container.querySelector('audio')).toBeNull();
    expect(screen.getByRole('link', { name: 'Descargar' })).toHaveAttribute('href', '/api/jobs/j1/output');
  });

  it('shows the error and a retry button when failed', async () => {
    const user = userEvent.setup();
    const { onRetry } = setup({ state: 'failed', error: 'boom' });
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

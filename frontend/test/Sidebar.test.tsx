import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../src/components/Sidebar';
import { I18nProvider, LANGUAGE_STORAGE_KEY } from '../src/i18n';

afterEach(() => localStorage.clear());

function setup(onOpenSettings = vi.fn(), view: 'pipeline' | 'jobs' = 'pipeline') {
  render(
    <I18nProvider>
      <Sidebar view={view} onOpenSettings={onOpenSettings} />
    </I18nProvider>,
  );
  return { onOpenSettings, user: userEvent.setup() };
}

describe('Sidebar', () => {
  it('renders the app name and links to Pipeline and Trabajos, marking the active view', () => {
    setup();
    expect(screen.getByText('Video Studio')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Navegación principal' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pipeline' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Trabajos' })).toHaveAttribute('href', '#trabajos');
  });

  it('marks Trabajos active when the jobs view is on', () => {
    setup(vi.fn(), 'jobs');
    expect(screen.getByRole('link', { name: 'Trabajos' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Pipeline' })).not.toHaveAttribute('aria-current');
  });

  it('opens settings from the settings button', async () => {
    const { onOpenSettings, user } = setup();
    await user.click(screen.getByRole('button', { name: /Ajustes/ }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('switches language, relabels the UI and persists the choice', async () => {
    const { user } = setup();
    expect(screen.getByRole('button', { name: 'ES' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'EN' }));
    expect(screen.getByRole('button', { name: 'EN' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Settings/ })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
  });
});

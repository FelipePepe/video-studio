import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../src/components/Sidebar';
import { I18nProvider, LANGUAGE_STORAGE_KEY } from '../src/i18n';

afterEach(() => localStorage.clear());

function setup(onOpenSettings = vi.fn()) {
  render(
    <I18nProvider>
      <Sidebar onOpenSettings={onOpenSettings} />
    </I18nProvider>,
  );
  return { onOpenSettings, user: userEvent.setup() };
}

describe('Sidebar', () => {
  it('renders the app name and nav items with Pipeline active and Jobs disabled', () => {
    setup();
    expect(screen.getByText('Video Studio')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Navegación principal' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pipeline' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /Trabajos/ })).toBeDisabled();
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

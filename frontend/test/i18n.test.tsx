import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dictionaries, I18nProvider, LANGUAGE_STORAGE_KEY, useI18n } from '../src/i18n';
import type { ReactNode } from 'react';

const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider>{children}</I18nProvider>;

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('i18n', () => {
  it('defaults to Spanish', () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current.lang).toBe('es');
    expect(result.current.t('settings.save')).toBe(dictionaries.es['settings.save']);
  });

  it('switches language and persists it', () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLang('en'));
    expect(result.current.lang).toBe('en');
    expect(result.current.t('settings.save')).toBe(dictionaries.en['settings.save']);
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
  });

  it('restores the persisted language on mount', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current.lang).toBe('en');
  });

  it('ignores an unknown persisted value', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'fr');
    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current.lang).toBe('es');
  });

  it('keeps working when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current.lang).toBe('es');
    act(() => result.current.setLang('en'));
    expect(result.current.lang).toBe('en');
  });

  it('has the same keys in both dictionaries', () => {
    expect(Object.keys(dictionaries.en).sort()).toEqual(Object.keys(dictionaries.es).sort());
  });

  it('works without a provider using the default language', () => {
    function Probe() {
      return <span>{useI18n().t('nav.pipeline')}</span>;
    }
    render(<Probe />);
    expect(screen.getByText(dictionaries.es['nav.pipeline'])).toBeInTheDocument();
  });
});

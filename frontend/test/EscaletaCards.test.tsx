import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EscaletaCards } from '../src/components/EscaletaCards';
import { I18nProvider } from '../src/i18n';
import { draft } from './helpers/fakeApi';

describe('EscaletaCards', () => {
  it('renders number badge, title, narration and voice badge per scene', () => {
    render(
      <I18nProvider>
        <EscaletaCards escaleta={draft.escaleta} />
      </I18nProvider>,
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const first = within(items[0]!);
    expect(first.getByText('1')).toHaveClass('scene-badge');
    expect(first.getByText('Intro')).toBeInTheDocument();
    expect(first.getByText('Hello')).toBeInTheDocument();
    expect(first.getByText('Masculina')).toHaveClass('voice-badge');
    expect(within(items[1]!).getByText('Femenina')).toBeInTheDocument();
  });
});

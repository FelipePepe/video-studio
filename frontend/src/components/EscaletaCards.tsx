import { useI18n } from '../i18n';
import type { Escaleta } from '../api/types';

/** Extension point (T4c replaces/extends this): read-only scene cards. */
export function EscaletaCards({ escaleta }: { escaleta: Escaleta }) {
  const { t } = useI18n();
  return (
    <section className="escaleta" aria-label={t('escaleta.title')}>
      <h2>{t('escaleta.title')}</h2>
      <ul className="escaleta__list">
        {escaleta.map((scene) => (
          <li key={scene.scene} className="card">
            <strong>
              {scene.scene} · {scene.title}
            </strong>
            <p>{scene.narration}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

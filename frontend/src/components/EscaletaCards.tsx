import { useI18n } from '../i18n';
import type { Escaleta } from '../api/types';

/** Read-only scene cards. */
export function EscaletaCards({ escaleta }: { escaleta: Escaleta }) {
  const { t } = useI18n();
  return (
    <section className="escaleta" aria-label={t('escaleta.title')}>
      <h2>{t('escaleta.title')}</h2>
      <ul className="escaleta__list">
        {escaleta.map((scene) => (
          <li key={scene.scene} className="card scene-card scene-card--readonly">
            <div className="scene-card__head">
              <span className="scene-badge">{scene.scene}</span>
              <strong className="scene-card__title">{scene.title}</strong>
              <span className="voice-badge">{scene.voice === 'male' ? t('form.voice.male') : scene.voice === 'female' ? t('form.voice.female') : scene.voice}</span>
            </div>
            <p>{scene.narration}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

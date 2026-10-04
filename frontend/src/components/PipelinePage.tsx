import { useI18n } from '../i18n';

/** Extension point: the pipeline form, progress and video panel plug in here (T4b). */
export function PipelinePage() {
  const { t } = useI18n();
  return (
    <section className="panel placeholder">
      <p>{t('pipeline.placeholder')}</p>
    </section>
  );
}

import { useI18n } from '../i18n';

export function GuideCard() {
  const { t } = useI18n();
  return (
    <section className="panel guide" aria-label={t('guide.title')}>
      <h2>{t('guide.title')}</h2>
      <ol>
        <li>{t('guide.step1')}</li>
        <li>{t('guide.step2')}</li>
        <li>{t('guide.step3')}</li>
      </ol>
    </section>
  );
}

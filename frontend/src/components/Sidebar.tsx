import { useI18n } from '../i18n';
import type { Lang } from '../i18n';

const LANGS: Lang[] = ['es', 'en'];

export interface SidebarProps {
  onOpenSettings: () => void;
}

export function Sidebar({ onOpenSettings }: SidebarProps) {
  const { t, lang, setLang } = useI18n();

  return (
    <aside className="sidebar">
      <h1 className="sidebar__brand">{t('app.name')}</h1>

      <nav className="sidebar__nav" aria-label={t('nav.label')}>
        <ul>
          <li>
            <a className="nav-item nav-item--active" href="#pipeline" aria-current="page">
              {t('nav.pipeline')}
            </a>
          </li>
          <li>
            {/* Placeholder until the jobs view exists. */}
            <button type="button" className="nav-item" disabled>
              {t('nav.jobs')} <small>({t('nav.soon')})</small>
            </button>
          </li>
        </ul>
      </nav>

      <div className="sidebar__footer">
        <button type="button" className="btn btn--ghost" onClick={onOpenSettings}>
          {t('sidebar.settings')}
        </button>
        <div className="lang-switch" role="group" aria-label={t('sidebar.language')}>
          {LANGS.map((code) => (
            <button
              key={code}
              type="button"
              className="lang-switch__btn"
              aria-pressed={lang === code}
              onClick={() => setLang(code)}
            >
              {t(code === 'es' ? 'lang.es' : 'lang.en')}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}

import { useI18n } from '../i18n';
import type { Lang } from '../i18n';

const LANGS: Lang[] = ['es', 'en'];

export interface SidebarProps {
  /** Active view; marks the corresponding item with `aria-current`. Defaults to pipeline. */
  view?: 'pipeline' | 'jobs';
  onOpenSettings: () => void;
}

export function Sidebar({ view = 'pipeline', onOpenSettings }: SidebarProps) {
  const { t, lang, setLang } = useI18n();

  const itemClass = (active: boolean) => `nav-item${active ? ' nav-item--active' : ''}`;

  return (
    <aside className="sidebar">
      <h1 className="sidebar__brand">{t('app.name')}</h1>

      <nav className="sidebar__nav" aria-label={t('nav.label')}>
        <ul>
          <li>
            <a
              className={itemClass(view === 'pipeline')}
              href="#pipeline"
              aria-current={view === 'pipeline' ? 'page' : undefined}
            >
              {t('nav.pipeline')}
            </a>
          </li>
          <li>
            <a
              className={itemClass(view === 'jobs')}
              href="#trabajos"
              aria-current={view === 'jobs' ? 'page' : undefined}
            >
              {t('nav.jobs')}
            </a>
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

import { useMemo, useState } from 'react';
import { createApiClient, type ApiClient } from './api/client';
import { PipelinePage } from './components/PipelinePage';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar } from './components/Sidebar';
import { I18nProvider } from './i18n';

export interface AppProps {
  /** Injectable for tests; defaults to a client talking to `/api`. */
  api?: ApiClient | Pick<ApiClient, 'getConfig' | 'patchConfig'>;
}

export function App({ api }: AppProps) {
  const defaultApi = useMemo(() => createApiClient(), []);
  const client = api ?? defaultApi;
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <I18nProvider>
      <div className="app-shell">
        <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
        <main className="app-main">
          <PipelinePage />
        </main>
        {settingsOpen && <SettingsModal api={client} onClose={() => setSettingsOpen(false)} />}
      </div>
    </I18nProvider>
  );
}

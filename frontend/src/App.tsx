import { useMemo, useState } from 'react';
import { createApiClient, type ApiClient } from './api/client';
import type { PipelineApi } from './hooks/usePipeline';
import { PipelinePage } from './components/PipelinePage';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar } from './components/Sidebar';
import { I18nProvider } from './i18n';

export interface AppProps {
  /** Injectable for tests; defaults to a client talking to `/api`. */
  api?: (Pick<ApiClient, 'getConfig' | 'patchConfig' | 'listModels'> & Partial<PipelineApi>) | ApiClient;
}

export function App({ api }: AppProps) {
  const defaultApi = useMemo(() => createApiClient(), []);
  const client = api ?? defaultApi;
  // Tests may inject a settings-only fake; the pipeline then falls back to the real client.
  const pipelineApi: PipelineApi = client && 'createDraft' in client && client.createDraft ? (client as PipelineApi) : defaultApi;
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <I18nProvider>
      <div className="app-shell">
        <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
        <main className="app-main">
          <PipelinePage api={pipelineApi} />
        </main>
        {settingsOpen && <SettingsModal api={client} onClose={() => setSettingsOpen(false)} />}
      </div>
    </I18nProvider>
  );
}

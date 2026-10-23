import { useEffect, useMemo, useState } from 'react';
import { createApiClient, type ApiClient } from './api/client';
import { JobsPage } from './components/JobsPage';
import type { PipelineApi } from './hooks/usePipeline';
import { PipelinePage } from './components/PipelinePage';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar } from './components/Sidebar';
import { I18nProvider } from './i18n';

export type View = 'pipeline' | 'jobs';

const JOBS_HASH = '#trabajos';

function viewFromHash(hash: string): View {
  return hash === JOBS_HASH ? 'jobs' : 'pipeline';
}

export interface AppProps {
  /** Injectable for tests; defaults to a client talking to `/api`. */
  api?:
    | (Pick<ApiClient, 'getConfig' | 'patchConfig' | 'listModels'> &
        Partial<PipelineApi> &
        Partial<Pick<ApiClient, 'listJobs' | 'getJob' | 'cancelJob' | 'approveDraft' | 'deleteJob'>>)
    | ApiClient;
}

export function App({ api }: AppProps) {
  const defaultApi = useMemo(() => createApiClient(), []);
  const client = api ?? defaultApi;
  // Tests may inject a settings-only fake; the pipeline then falls back to the real client.
  const pipelineApi: PipelineApi =
    client && 'createDraft' in client && client.createDraft ? (client as PipelineApi) : defaultApi;
  const jobsApi: Pick<ApiClient, 'listJobs' | 'getJob' | 'cancelJob' | 'approveDraft' | 'deleteJob'> =
    client && 'listJobs' in client && (client as ApiClient).listJobs ? (client as Pick<ApiClient, 'listJobs' | 'getJob' | 'cancelJob' | 'approveDraft' | 'deleteJob'>) : defaultApi;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setView(viewFromHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <I18nProvider>
      <div className="app-shell">
        <Sidebar view={view} onOpenSettings={() => setSettingsOpen(true)} />
        <main className="app-main">
          {view === 'jobs' ? <JobsPage api={jobsApi} /> : <PipelinePage api={pipelineApi} />}
        </main>
        {settingsOpen && <SettingsModal api={client} onClose={() => setSettingsOpen(false)} />}
      </div>
    </I18nProvider>
  );
}

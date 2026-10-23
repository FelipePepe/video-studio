import { useEffect, useMemo, useState } from 'react';
import { createApiClient, type ApiClient } from './api/client';
import { JobsPage } from './components/JobsPage';
import { usePipeline, type PipelineApi } from './hooks/usePipeline';
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

export function App(props: AppProps) {
  // The shell calls useI18n through usePipeline, so the provider has to sit above it.
  return (
    <I18nProvider>
      <AppShell {...props} />
    </I18nProvider>
  );
}

function AppShell({ api }: AppProps) {
  const defaultApi = useMemo(() => createApiClient(), []);
  const client = api ?? defaultApi;
  // Tests may inject a settings-only fake; the pipeline then falls back to the real client.
  const pipelineApi: PipelineApi =
    client && 'createDraft' in client && client.createDraft ? (client as PipelineApi) : defaultApi;
  const jobsApi: Pick<ApiClient, 'listJobs' | 'getJob' | 'cancelJob' | 'approveDraft' | 'deleteJob'> =
    client && 'listJobs' in client && (client as ApiClient).listJobs ? (client as Pick<ApiClient, 'listJobs' | 'getJob' | 'cancelJob' | 'approveDraft' | 'deleteJob'>) : defaultApi;
  // Owned here (not in PipelinePage) so a running render and its draft survive tab switches.
  const pipeline = usePipeline(pipelineApi);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setView(viewFromHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <div className="app-shell">
      <Sidebar view={view} onOpenSettings={() => setSettingsOpen(true)} />
      <main className="app-main">
        {/* Kept mounted (just hidden) so unsaved form text and review edits aren't lost on a tab switch. */}
        <div hidden={view !== 'pipeline'}>
          <PipelinePage api={pipelineApi} pipeline={pipeline} />
        </div>
        {view === 'jobs' && <JobsPage api={jobsApi} />}
      </main>
      {settingsOpen && <SettingsModal api={client} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

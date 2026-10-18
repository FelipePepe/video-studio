import express, { type ErrorRequestHandler, type Express } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db/connection';
import { loadEnvDefaults, resolveEffectiveConfig, type EnvDefaults } from './config/settings';
import { configRouter } from './routes/config';
import { ollamaModelsRouter } from './routes/ollamaModels';
import { pipelineRouter } from './routes/pipeline';
import { jobsRouter } from './routes/jobs';
import { voicesRouter } from './routes/voices';
import { musicRouter } from './routes/music';
import { EventHub } from './jobs/eventHub';
import { JobRunner } from './jobs/runner';
import type { ExecuteFn } from './jobs/types';
import { createExecute, type FfmpegFn } from './pipeline/orchestrator';
import { ComfyClient } from './clients/comfy';
import { OllamaClient } from './clients/ollama';
import { PiperClient } from './clients/piper';

export interface AppOptions {
  db?: DatabaseSync;
  envDefaults?: EnvDefaults;
  comfy?: ComfyClient;
  ollama?: OllamaClient;
  piper?: PiperClient;
  fetchImpl?: typeof fetch;
  ffmpeg?: FfmpegFn;
  /** Music library directory (background music picker). Defaults to the MUSIC_DIR env var; empty = disabled. */
  musicDir?: string;
  jobs?: { workDir?: string; execute?: ExecuteFn; autoStart?: boolean; heartbeatMs?: number; cacheDir?: string };
}

export interface AppResolvers {
  resolveComfy: () => ComfyClient;
  resolveOllama: () => OllamaClient;
  resolvePiper: () => PiperClient;
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const e = err as { type?: string; status?: number; expose?: boolean } | null;
  if (e?.type === 'entity.parse.failed' || (e?.status === 400 && e.expose)) {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
};

export function buildApp(opts: AppOptions = {}): Express {
  const db = opts.db ?? openDatabase(':memory:');
  const envDefaults = opts.envDefaults ?? loadEnvDefaults();
  const effective = () => resolveEffectiveConfig(db, envDefaults);

  const app = express();
  app.use(express.json());

  const resolvers: AppResolvers = {
    resolveComfy: () => opts.comfy ?? new ComfyClient(effective().comfyHost),
    resolveOllama: () => opts.ollama ?? new OllamaClient(effective().ollamaHost, { model: effective().ollamaModel }),
    resolvePiper: () => opts.piper ?? new PiperClient(effective().piperHost),
  };
  const eventHub = new EventHub();
  const jobRunner = new JobRunner({
    db,
    hub: eventHub,
    execute:
      opts.jobs?.execute ??
      createExecute({
        db,
        resolveComfy: resolvers.resolveComfy,
        resolvePiper: resolvers.resolvePiper,
        ffmpeg: opts.ffmpeg,
        cacheDir: opts.jobs?.cacheDir ?? 'data/cache',
      }),
    workDir: opts.jobs?.workDir ?? 'data/jobs',
  });
  if (opts.jobs?.autoStart) jobRunner.start();
  Object.assign(app.locals, resolvers, { db, eventHub, jobRunner });

  app.use('/api/config', configRouter(db, envDefaults));
  app.use('/api/ollama/models', ollamaModelsRouter({ listModels: () => resolvers.resolveOllama().listModels() }));
  app.use('/api/music', musicRouter({ musicDir: () => opts.musicDir ?? process.env.MUSIC_DIR ?? '' }));
  app.use('/api/pipeline/voices', voicesRouter({ listVoices: () => resolvers.resolvePiper().listVoices() }));
  app.use(
    '/api/pipeline',
    pipelineRouter({
      db,
      resolveOllama: resolvers.resolveOllama,
      fetchImpl: opts.fetchImpl,
      runner: jobRunner,
      hub: eventHub,
      heartbeatMs: opts.jobs?.heartbeatMs,
    }),
  );
  app.use('/api/jobs', jobsRouter({ db, runner: jobRunner, hub: eventHub, heartbeatMs: opts.jobs?.heartbeatMs }));
  app.use(errorHandler);
  return app;
}

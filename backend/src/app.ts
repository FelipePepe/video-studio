import express, { type ErrorRequestHandler, type Express } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { resolve as resolvePath } from 'node:path';
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
import { makeTokenAuth } from './config/auth';
import type { ExecuteFn } from './jobs/types';
import { createExecute, type FfmpegFn } from './pipeline/orchestrator';
import { ComfyClient } from './clients/comfy';
import { OllamaClient } from './clients/ollama';
import { PiperClient } from './clients/piper';
import { logger } from './lib/logger';

const httpLog = logger.child('http');

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
  apiKey?: string;
  jobs?: { workDir?: string; execute?: ExecuteFn; autoStart?: boolean; heartbeatMs?: number; cacheDir?: string };
}

export interface AppResolvers {
  resolveComfy: () => ComfyClient;
  resolveOllama: () => OllamaClient;
  resolvePiper: () => PiperClient;
}

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const e = err as { type?: string; status?: number; expose?: boolean } | null;
  if (e?.type === 'entity.parse.failed' || (e?.status === 400 && e.expose)) {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }
  // originalUrl is never rewritten by sub-router mounting; req.path can already be stripped here.
  httpLog.error('unhandled error → 500', { method: req.method, path: req.originalUrl, err });
  res.status(500).json({ error: 'Internal server error' });
};

export function buildApp(opts: AppOptions = {}): Express {
  const db = opts.db ?? openDatabase(':memory:');
  const envDefaults = opts.envDefaults ?? loadEnvDefaults();
  const effective = () => resolveEffectiveConfig(db, envDefaults);

  const app = express();
  app.use((req, res, next) => {
    // Capture identity upfront: Express rewrites req.url while sub-routers run,
    // so reading req.path later (e.g. on res 'finish') would show the stripped path.
    const startedAt = Date.now();
    const method = req.method;
    const path = req.path;
    res.once('finish', () =>
      httpLog.info('request', { method, path, status: res.statusCode, ms: Date.now() - startedAt }),
    );
    next();
  });
  app.use(express.json());
  // Shared-token guard for state-changing routes (PATCH/POST/PUT/DELETE). No-op if unset.
  app.use(makeTokenAuth(opts.apiKey ?? process.env.API_TOKEN));

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
        cacheDir: resolvePath(opts.jobs?.cacheDir ?? 'data/cache'),
      }),
    workDir: resolvePath(opts.jobs?.workDir ?? 'data/jobs'),
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
      musicDir: () => opts.musicDir ?? process.env.MUSIC_DIR ?? '',
    }),
  );
  app.use('/api/jobs', jobsRouter({ db, runner: jobRunner, hub: eventHub, heartbeatMs: opts.jobs?.heartbeatMs }));
  app.use(errorHandler);
  return app;
}

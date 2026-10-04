import express, { type ErrorRequestHandler, type Express } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db/connection';
import { loadEnvDefaults, resolveEffectiveConfig, type EnvDefaults } from './config/settings';
import { configRouter } from './routes/config';
import type { ComfyClient, KokoroClient, OllamaClient } from './clients/types';

export interface AppOptions {
  db?: DatabaseSync;
  envDefaults?: EnvDefaults;
  comfy?: ComfyClient;
  ollama?: OllamaClient;
  kokoro?: KokoroClient;
}

export interface AppResolvers {
  resolveComfy: () => ComfyClient;
  resolveOllama: () => OllamaClient;
  resolveKokoro: () => KokoroClient;
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
    resolveComfy: () => opts.comfy ?? { host: effective().comfyHost },
    resolveOllama: () => opts.ollama ?? { host: effective().ollamaHost },
    resolveKokoro: () => opts.kokoro ?? { host: effective().kokoroHost },
  };
  Object.assign(app.locals, resolvers, { db });

  app.use('/api/config', configRouter(db, envDefaults));
  app.use(errorHandler);
  return app;
}

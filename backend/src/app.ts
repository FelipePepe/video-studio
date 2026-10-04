import express, { type Express } from 'express';
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
  return app;
}

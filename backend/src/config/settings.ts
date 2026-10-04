import type { DatabaseSync } from 'node:sqlite';

export interface HostConfig {
  comfyHost: string;
  ollamaHost: string;
  kokoroHost: string;
}

export type EnvDefaults = HostConfig;
export type SettingsPatch = Partial<HostConfig>;

export function loadEnvDefaults(env: NodeJS.ProcessEnv = process.env): EnvDefaults {
  return {
    comfyHost: env.COMFY_HOST || 'http://192.168.1.60:8188',
    ollamaHost: env.OLLAMA_HOST || 'http://192.168.1.60:11434',
    kokoroHost: env.KOKORO_HOST || 'http://localhost:8880',
  };
}

export function validateHostUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value === '') return true;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

interface SettingsRow {
  comfy_host: string;
  ollama_host: string;
  kokoro_host: string;
}

export function getSettings(db: DatabaseSync): HostConfig {
  const row = db
    .prepare('SELECT comfy_host, ollama_host, kokoro_host FROM server_settings WHERE id = 1')
    .get() as unknown as SettingsRow | undefined;
  return {
    comfyHost: row?.comfy_host ?? '',
    ollamaHost: row?.ollama_host ?? '',
    kokoroHost: row?.kokoro_host ?? '',
  };
}

export function updateSettings(db: DatabaseSync, patch: SettingsPatch): HostConfig {
  const next = { ...getSettings(db), ...patch };
  db.prepare(
    `INSERT INTO server_settings (id, comfy_host, ollama_host, kokoro_host)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       comfy_host = excluded.comfy_host,
       ollama_host = excluded.ollama_host,
       kokoro_host = excluded.kokoro_host`,
  ).run(next.comfyHost, next.ollamaHost, next.kokoroHost);
  return next;
}

export function resolveEffectiveConfig(db: DatabaseSync, envDefaults: EnvDefaults): HostConfig {
  const stored = getSettings(db);
  return {
    comfyHost: stored.comfyHost || envDefaults.comfyHost,
    ollamaHost: stored.ollamaHost || envDefaults.ollamaHost,
    kokoroHost: stored.kokoroHost || envDefaults.kokoroHost,
  };
}

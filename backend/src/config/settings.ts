import type { DatabaseSync } from 'node:sqlite';

export interface HostConfig {
  comfyHost: string;
  ollamaHost: string;
  piperHost: string;
}

export type EnvDefaults = HostConfig;
export type SettingsPatch = Partial<HostConfig>;

export function loadEnvDefaults(env: NodeJS.ProcessEnv = process.env): EnvDefaults {
  return {
    comfyHost: env.COMFY_HOST || 'http://192.168.1.60:8188',
    ollamaHost: env.OLLAMA_HOST || 'http://192.168.1.60:11434',
    piperHost: env.PIPER_HOST || 'tcp://192.168.1.60:10200',
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

export function validatePiperHost(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value === '') return true;
  const m = /^tcp:\/\/[^/:\s]+:(\d{1,5})$/.exec(value);
  if (!m) return false;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535;
}

interface SettingsRow {
  comfy_host: string;
  ollama_host: string;
  piper_host: string;
}

export function getSettings(db: DatabaseSync): HostConfig {
  const row = db
    .prepare('SELECT comfy_host, ollama_host, piper_host FROM server_settings WHERE id = 1')
    .get() as unknown as SettingsRow | undefined;
  return {
    comfyHost: row?.comfy_host ?? '',
    ollamaHost: row?.ollama_host ?? '',
    piperHost: row?.piper_host ?? '',
  };
}

export function updateSettings(db: DatabaseSync, patch: SettingsPatch): HostConfig {
  const next = { ...getSettings(db), ...patch };
  db.prepare(
    `INSERT INTO server_settings (id, comfy_host, ollama_host, piper_host)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       comfy_host = excluded.comfy_host,
       ollama_host = excluded.ollama_host,
       piper_host = excluded.piper_host`,
  ).run(next.comfyHost, next.ollamaHost, next.piperHost);
  return next;
}

export function resolveEffectiveConfig(db: DatabaseSync, envDefaults: EnvDefaults): HostConfig {
  const stored = getSettings(db);
  return {
    comfyHost: stored.comfyHost || envDefaults.comfyHost,
    ollamaHost: stored.ollamaHost || envDefaults.ollamaHost,
    piperHost: stored.piperHost || envDefaults.piperHost,
  };
}

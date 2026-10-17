const DEFAULT_DB_PATH = 'data/video-studio.sqlite';

export function parsePort(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const port = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${value}": must be an integer between 1 and 65535`);
  }
  return port;
}

export function resolveDbPath(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : DEFAULT_DB_PATH;
}

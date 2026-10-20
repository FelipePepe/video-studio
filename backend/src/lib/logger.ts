import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_FILE = 'data/logs/video-studio.log';
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_SCOPE = 'app';

export interface LoggerOptions {
  /** Minimum level to emit. Default: LOG_LEVEL env or 'info'. */
  level?: LogLevel;
  /** Destination file. `false` disables file output. Default: data/logs/video-studio.log */
  file?: string | false;
  /** Also echo to the console (routed to console.log/warn/error per level). Default: true. */
  console?: boolean;
  /** Rotate the file to `<file>.old` once it reaches this size. Default: 5 MB. */
  maxBytes?: number;
}

export interface Logger {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  /** A new logger whose scope is `parentScope.child`. */
  child: (scope: string) => Logger;
  /** Flush and release state. Synchronous writes today: a safe no-op, kept so callers can close it deterministically. */
  close: () => void;
}

/** Normalizes an arbitrary LOG_LEVEL value; anything unknown falls back to 'info'. */
export function parseLogLevel(value: string | undefined): LogLevel {
  const v = (value ?? '').trim().toLowerCase();
  return (LEVEL_RANK as Record<string, number>)[v] !== undefined ? (v as LogLevel) : 'info';
}

function serializeMeta(meta?: Record<string, unknown>): string | undefined {
  if (!meta) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    clean[k] = v instanceof Error ? { message: v.message, stack: v.stack } : v;
  }
  return JSON.stringify(clean);
}

function formatLine(level: LogLevel, scope: string, msg: string, meta?: Record<string, unknown>): string {
  const json = serializeMeta(meta);
  const base = `${new Date().toISOString()} ${level} [${scope}] ${msg}`;
  return json ? `${base} ${json}` : base;
}

function consoleSinkFor(level: LogLevel): (msg: string) => void {
  if (level === 'warn') return (m) => console.warn(m);
  if (level === 'error') return (m) => console.error(m);
  return (m) => console.log(m);
}

function appendToFile(file: string, line: string, maxBytes: number): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      // new file — nothing to rotate; fall through to the append.
    }
    if (size >= maxBytes) renameSync(file, `${file}.old`);
    appendFileSync(file, `${line}\n`);
  } catch {
    // Logging must never crash the process — the console echo already happened.
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minRank = LEVEL_RANK[options.level ?? parseLogLevel(process.env.LOG_LEVEL)];
  const file = options.file === false ? undefined : options.file ?? DEFAULT_FILE;
  const echo = options.console !== false;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  function build(scope: string): Logger {
    const write = (level: LogLevel) => (msg: string, meta?: Record<string, unknown>) => {
      if (LEVEL_RANK[level] < minRank) return;
      const line = formatLine(level, scope, msg, meta);
      if (file) appendToFile(file, line, maxBytes);
      if (echo) consoleSinkFor(level)(line);
    };
    return {
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      child: (childScope) => build(`${scope}.${childScope}`),
      close: () => {},
    };
  }

  return build(DEFAULT_SCOPE);
}

/** Shared default instance (scope 'app', file data/logs/video-studio.log, console echo). */
export const logger = createLogger();

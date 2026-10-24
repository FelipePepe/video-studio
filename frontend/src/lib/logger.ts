/**
 * Browser-side logger: a level-tagged ring buffer plus console echo.
 *
 * Deliberately minimal — the app runs in the user's own browser; the buffer
 * is inspectable from DevTools (`window.__vsLogs`) and `getLogs()` so it can
 * later be flushed to the server if that is ever wanted. See backend/src/lib/logger.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface ClientLoggerOptions {
  /** Minimum level to record. Default: 'info'. */
  level?: LogLevel;
  /** Default scope prefix. Default: 'ui'. */
  scope?: string;
}

export interface ClientLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  /** A new logger whose scope is `parentScope.child`. */
  child: (scope: string) => ClientLogger;
  /** Copy of the recent entries, oldest first. */
  getLogs: () => LogEntry[];
  /** For tests and (later) a "clear logs" UI. */
  clearLogs: () => void;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const CONSOLE_NAME: Record<LogLevel, 'log' | 'warn' | 'error'> = { debug: 'log', info: 'log', warn: 'warn', error: 'error' };
export const MAX_BUFFER = 500;

export function createClientLogger(options: ClientLoggerOptions = {}): ClientLogger {
  const minRank = LEVEL_RANK[options.level ?? 'info'];
  const rootScope = options.scope ?? 'ui';
  const buffer: LogEntry[] = [];

  function build(scope: string): ClientLogger {
    const emit = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => {
      if (LEVEL_RANK[level] < minRank) return;
      buffer.push({ at: new Date().toISOString(), level, scope, message: msg, ...(meta ? { meta } : {}) });
      if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
      console[CONSOLE_NAME[level]](`[${scope}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
    };
    return {
      debug: (m, meta) => emit('debug', m, meta),
      info: (m, meta) => emit('info', m, meta),
      warn: (m, meta) => emit('warn', m, meta),
      error: (m, meta) => emit('error', m, meta),
      child: (childScope) => build(`${scope}.${childScope}`),
      getLogs: () => [...buffer],
      clearLogs: () => {
        buffer.length = 0;
      },
    };
  }

  return build(rootScope);
}

/** Shared app-wide instance. Available in DevTools as `window.__vsLogs`. */
export const log = createClientLogger();
if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__vsLogs = log;

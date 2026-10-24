export interface ShutdownDeps {
  server: { close(cb?: () => void): unknown; closeAllConnections?(): void };
  runner: { stop(): Promise<void> };
  db: { close(): void };
  log: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  exit(code: number): void;
  /** Hard stop if the orderly sequence hangs. Keep below the container stop_grace_period. */
  hardTimeoutMs?: number;
}

/**
 * Builds the SIGTERM/SIGINT handler. Order matters: the runner writes `markCancelled` while it
 * winds down, so the DB must be closed only after `runner.stop()` settles.
 */
export function makeShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const { server, runner, db, log, exit, hardTimeoutMs = 8000 } = deps;
  let shuttingDown = false;
  return async (signal: string): Promise<void> => {
    if (shuttingDown) {
      log.info(`${signal} received while shutting down; ignored`);
      return;
    }
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    const timer = setTimeout(() => {
      log.error(`shutdown did not finish within ${hardTimeoutMs}ms; forcing exit`);
      exit(1);
    }, hardTimeoutMs);
    timer.unref?.();
    try {
      // Do not wait for the close callback: open SSE streams would hold it until we cut them.
      server.close();
      server.closeAllConnections?.();
    } catch (err) {
      log.error('server close failed', { err });
    }
    try {
      await runner.stop();
    } catch (err) {
      log.error('runner stop failed', { err });
    }
    try {
      db.close();
    } catch (err) {
      log.error('db close failed', { err });
    }
    clearTimeout(timer);
    exit(0);
  };
}

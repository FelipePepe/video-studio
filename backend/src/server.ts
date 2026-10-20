import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildApp } from './app';
import { parsePort, resolveDbPath } from './config/runtime';
import { openDatabase } from './db/connection';
import { logger } from './lib/logger';
import type { JobRunner } from './jobs/runner';

const log = logger.child('server');

function main(): void {
  const dbPath = resolveDbPath(process.env.DB_PATH);
  const port = parsePort(process.env.PORT, 3001);
  // Bind to loopback by default — on the LAN, only local processes can reach the API.
  // (doc §5.2: don't listen on all interfaces.) HOST=… to expose on a specific interface.
  const host = (process.env.HOST ?? '').trim() || '127.0.0.1';
  mkdirSync(dirname(dbPath), { recursive: true });
  const app = buildApp({ db: openDatabase(dbPath) });
  (app.locals.jobRunner as JobRunner).start();
  app.listen(port, host, () => {
    log.info(`backend listening on ${host}:${port}`);
  });
}

try {
  main();
} catch (err) {
  log.error('failed to start', { err });
  process.exit(1);
}

// A process-level error that escaped a request/job must be visible, not silent.
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { err: reason instanceof Error ? reason : new Error(String(reason)) });
});

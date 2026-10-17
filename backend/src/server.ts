import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildApp } from './app';
import { parsePort, resolveDbPath } from './config/runtime';
import { openDatabase } from './db/connection';
import type { JobRunner } from './jobs/runner';

function main(): void {
  const dbPath = resolveDbPath(process.env.DB_PATH);
  const port = parsePort(process.env.PORT, 3001);
  mkdirSync(dirname(dbPath), { recursive: true });
  const app = buildApp({ db: openDatabase(dbPath) });
  (app.locals.jobRunner as JobRunner).start();
  app.listen(port, () => {
    console.log(`video-studio backend listening on :${port}`);
  });
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

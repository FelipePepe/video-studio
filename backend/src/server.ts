import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildApp } from './app';
import { openDatabase } from './db/connection';

const dbPath = process.env.DB_PATH ?? 'data/video-studio.sqlite';
mkdirSync(dirname(dbPath), { recursive: true });

const port = Number(process.env.PORT ?? 3001);
buildApp({ db: openDatabase(dbPath) }).listen(port, () => {
  console.log(`video-studio backend listening on :${port}`);
});

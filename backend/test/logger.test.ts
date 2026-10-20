import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, parseLogLevel, type LogLevel } from '../src/lib/logger';

function tempLogFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vs-logger-'));
  return { dir, file: join(dir, 'logs', 'test.log') };
}

function lines(file: string): string[] {
  return readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean);
}

test('writes a structured line: ts level [scope] message', () => {
  const { dir, file } = tempLogFile();
  const log = createLogger({ file, console: false, level: 'debug' });
  log.info('hello world');
  log.close();
  const [line] = lines(file);
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s+info\s+\[app\]\s+hello world$/);
  assert.ok(m, `line does not match expected format: ${line}`);
  rmSync(dir, { recursive: true, force: true });
});

test('includes meta as trailing JSON when provided', () => {
  const { dir, file } = tempLogFile();
  const log = createLogger({ file, console: false, level: 'debug' });
  log.info('job started', { jobId: 'j1', stage: 'render' });
  log.close();
  const [line] = lines(file);
  assert.ok(line.endsWith('{"jobId":"j1","stage":"render"}'), line);
  rmSync(dir, { recursive: true, force: true });
});

test('filters messages below the configured level', () => {
  const { dir, file } = tempLogFile();
  const log = createLogger({ file, console: false, level: 'info' });
  log.debug('hidden');
  log.warn('visible');
  log.close();
  const out = lines(file);
  assert.equal(out.length, 1);
  assert.match(out[0], /\swarn\s/);
  rmSync(dir, { recursive: true, force: true });
});

test('error level records the stack when an Error is passed as meta err', () => {
  const { dir, file } = tempLogFile();
  const log = createLogger({ file, console: false, level: 'debug' });
  log.error('boom', { err: new Error('kaboom') });
  log.close();
  const [line] = lines(file);
  assert.match(line, /\serror\s/);
  assert.match(line, /kaboom/);
  rmSync(dir, { recursive: true, force: true });
});

test('child scopes nest with a dot', () => {
  const { dir, file } = tempLogFile();
  const log = createLogger({ file, console: false, level: 'debug' });
  log.child('pipeline').info('step');
  log.close();
  const [line] = lines(file);
  assert.match(line, /\[app\.pipeline\]\s+step/);
  rmSync(dir, { recursive: true, force: true });
});

test('rotates the log file when it exceeds maxBytes', () => {
  const { dir, file } = tempLogFile();
  const log = createLogger({ file, console: false, level: 'debug', maxBytes: 80 });
  for (let i = 0; i < 20; i++) log.info(`message number ${i} with some padding so it grows`);
  log.close();
  assert.ok(statSync(file).size < 80 * 4, 'current file should stay bounded');
  assert.ok(statSync(`${file}.old`).size > 0, 'rotated file should exist with content');
  const rotated = readFileSync(`${file}.old`, 'utf8');
  assert.match(rotated, /message number/);
  rmSync(dir, { recursive: true, force: true });
});

test('console:false keeps Node free, console:true writes to the global object', () => {
  const { dir, file } = tempLogFile();
  const captured: string[] = [];
  const orig = console.error;
  console.error = (msg: unknown) => { captured.push(String(msg)); };
  try {
    const log = createLogger({ file, console: true, level: 'debug' });
    log.error('to console');
    log.close();
  } finally {
    console.error = orig;
  }
  assert.ok(captured.some((c) => c.includes('to console')), `captured: ${captured.join(' | ')}`);
  rmSync(dir, { recursive: true, force: true });
});

test('parseLogLevel accepts valid names and falls back to info', () => {
  assert.equal(parseLogLevel('debug'), 'debug');
  assert.equal(parseLogLevel('ERROR'), 'error');
  assert.equal(parseLogLevel('nonsense'), 'info');
  assert.equal(parseLogLevel(undefined), 'info');
  const valid: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  for (const v of valid) assert.equal(parseLogLevel(v), v);
});

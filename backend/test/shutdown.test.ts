import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeShutdown } from '../src/lib/shutdown';

function setup(
  opts: {
    stop?: () => Promise<void>;
    close?: () => void;
    withCloseAll?: boolean;
    hardTimeoutMs?: number;
  } = {},
) {
  const calls: string[] = [];
  const logs: string[] = [];
  const exits: number[] = [];
  const server: {
    close: (cb?: () => void) => void;
    closeAllConnections?: () => void;
  } = {
    // Never invokes the callback: shutdown must not wait for it.
    close: () => {
      calls.push('server.close');
    },
  };
  if (opts.withCloseAll !== false) {
    server.closeAllConnections = () => {
      calls.push('server.closeAllConnections');
    };
  }
  const runner = {
    stop: async () => {
      calls.push('runner.stop');
      await opts.stop?.();
    },
  };
  const db = {
    close: () => {
      calls.push('db.close');
      opts.close?.();
    },
  };
  const log = {
    info: (m: string) => logs.push(`info:${m}`),
    warn: (m: string) => logs.push(`warn:${m}`),
    error: (m: string) => logs.push(`error:${m}`),
  };
  const exit = (code: number) => {
    calls.push(`exit(${code})`);
    exits.push(code);
  };
  const shutdown = makeShutdown({ server, runner, db, log, exit, hardTimeoutMs: opts.hardTimeoutMs });
  return { shutdown, calls, logs, exits };
}

test('shutdown closes the server, stops the runner, closes the db and exits 0 in that order', async () => {
  const h = setup();
  await h.shutdown('SIGTERM');
  assert.deepEqual(h.calls, ['server.close', 'server.closeAllConnections', 'runner.stop', 'db.close', 'exit(0)']);
});

test('a second signal during shutdown is ignored', async () => {
  let release!: () => void;
  const h = setup({ stop: () => new Promise<void>((r) => (release = r)) });
  const first = h.shutdown('SIGTERM');
  await new Promise<void>((r) => setImmediate(r));
  await h.shutdown('SIGINT');
  release();
  await first;
  assert.equal(h.calls.filter((c) => c === 'server.close').length, 1);
  assert.equal(h.calls.filter((c) => c === 'runner.stop').length, 1);
  assert.equal(h.calls.filter((c) => c === 'db.close').length, 1);
  assert.deepEqual(h.exits, [0]);
});

test('the hard timer exits 1 when runner.stop never settles', async () => {
  const h = setup({ stop: () => new Promise<void>(() => {}), hardTimeoutMs: 20 });
  void h.shutdown('SIGTERM');
  await new Promise<void>((r) => setTimeout(r, 80));
  assert.deepEqual(h.exits, [1]);
  assert.ok(h.logs.some((l) => l.startsWith('error:')));
});

test('an error from runner.stop is logged and shutdown still closes the db and exits', async () => {
  const h = setup({
    stop: async () => {
      throw new Error('boom');
    },
  });
  await h.shutdown('SIGTERM');
  assert.ok(h.logs.some((l) => l.startsWith('error:')));
  assert.deepEqual(h.calls.slice(-2), ['db.close', 'exit(0)']);
});

test('an error from db.close is logged and shutdown still exits', async () => {
  const h = setup({
    close: () => {
      throw new Error('locked');
    },
  });
  await h.shutdown('SIGTERM');
  assert.ok(h.logs.some((l) => l.startsWith('error:')));
  assert.equal(h.calls.at(-1), 'exit(0)');
});

test('a server without closeAllConnections is tolerated', async () => {
  const h = setup({ withCloseAll: false });
  await h.shutdown('SIGTERM');
  assert.deepEqual(h.calls, ['server.close', 'runner.stop', 'db.close', 'exit(0)']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCrashHandler } from '../src/lib/crashHandler';

function fakeLog() {
  const entries: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  return {
    entries,
    log: { error: (msg: string, meta?: Record<string, unknown>) => entries.push({ msg, meta }) },
  };
}

function withExitStub(fn: () => void): number | null {
  const original = process.exit;
  let code: number | null = null;
  // @ts-expect-error -- test stub overriding process.exit
  process.exit = (c?: number) => {
    code = c ?? -1;
  };
  try {
    fn();
  } finally {
    process.exit = original;
  }
  return code;
}

test('B1: uncaughtException handler logs the error and exits(1)', () => {
  const { entries, log } = fakeLog();
  const code = withExitStub(() => {
    makeCrashHandler(log)(new Error('writer blew up'));
  });
  assert.equal(code, 1);
  assert.match(entries[0].msg, /uncaughtException/);
  assert.match(String(entries[0].meta?.message), /writer blew up/);
});

test('B1: uncaughtException handler wraps non-Error throws', () => {
  const { entries, log } = fakeLog();
  const code = withExitStub(() => {
    makeCrashHandler(log)('string boom');
  });
  assert.equal(code, 1);
  assert.match(String(entries[0].meta?.message), /string boom/);
});

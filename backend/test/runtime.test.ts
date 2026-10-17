import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePort, resolveDbPath } from '../src/config/runtime';

test('parsePort returns the fallback when unset or blank', () => {
  assert.equal(parsePort(undefined, 3001), 3001);
  assert.equal(parsePort('', 3001), 3001);
  assert.equal(parsePort('  ', 3001), 3001);
});

test('parsePort accepts integers within 1-65535', () => {
  assert.equal(parsePort('1', 3001), 1);
  assert.equal(parsePort(' 8080 ', 3001), 8080);
  assert.equal(parsePort('65535', 3001), 65535);
});

for (const bad of ['0', '65536', '-1', '3.5', 'abc', '80abc', '1e3']) {
  test(`parsePort rejects ${JSON.stringify(bad)}`, () => {
    assert.throws(() => parsePort(bad, 3001), /PORT/);
  });
}

test('resolveDbPath defaults when unset or blank', () => {
  assert.equal(resolveDbPath(undefined), 'data/video-studio.sqlite');
  assert.equal(resolveDbPath(''), 'data/video-studio.sqlite');
  assert.equal(resolveDbPath('   '), 'data/video-studio.sqlite');
});

test('resolveDbPath keeps a provided path trimmed', () => {
  assert.equal(resolveDbPath(' /var/db/x.sqlite '), '/var/db/x.sqlite');
});

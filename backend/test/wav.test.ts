import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWav, wavDurationSec, wavFromPcm, wavSilence } from '../src/media/wav';

const fmt = { rate: 16000, width: 2, channels: 1 };

test('wavFromPcm writes a 44-byte header', () => {
  const wav = wavFromPcm(Buffer.from([0, 0]), fmt);
  assert.equal(wav.length, 46);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(40), 2);
});

test('wavDurationSec derives the length from the data chunk', () => {
  const wav = wavFromPcm(Buffer.alloc(16000 * 2 * 1.5), fmt);
  assert.equal(wavDurationSec(wav), 1.5);
  const stereo = wavFromPcm(Buffer.alloc(22050 * 4), { rate: 22050, width: 2, channels: 2 });
  assert.equal(wavDurationSec(stereo), 1);
});

test('parseWav skips unknown chunks before data', () => {
  const base = wavFromPcm(Buffer.alloc(32000), fmt);
  const list = Buffer.alloc(8 + 4);
  list.write('LIST', 0);
  list.writeUInt32LE(4, 4);
  const wav = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
  assert.equal(wavDurationSec(wav), 1);
  assert.deepEqual(parseWav(wav).format, fmt);
});

test('wavSilence produces zeroed PCM of the requested duration and format', () => {
  const wav = wavSilence(2.0625, fmt);
  assert.equal(wavDurationSec(wav), 2.0625);
  assert.deepEqual(parseWav(wav).format, fmt);
  assert.ok(wav.subarray(44).every((b) => b === 0));
  assert.throws(() => wavSilence(0, fmt), /duration/);
});

test('wavDurationSec rejects invalid input', () => {
  assert.throws(() => wavDurationSec(Buffer.from('nope')), /RIFF\/WAVE/);
  const ok = wavFromPcm(Buffer.alloc(4), fmt);
  const noFmt = Buffer.from(ok);
  noFmt.write('xxxx', 12);
  assert.throws(() => wavDurationSec(noFmt), /fmt/);
  const noData = Buffer.from(ok.subarray(0, 36));
  assert.throws(() => wavDurationSec(noData), /data/);
  const float = Buffer.from(ok);
  float.writeUInt16LE(3, 20);
  assert.throws(() => wavDurationSec(float), /PCM/);
  const zero = Buffer.from(ok);
  zero.writeUInt32LE(0, 24);
  assert.throws(() => wavDurationSec(zero), /format/);
});

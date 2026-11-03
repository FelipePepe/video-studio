import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDraft, validateEscaleta, DraftInputError, DraftValidationError } from '../src/pipeline/draft';
import { ArticleFetchError } from '../src/pipeline/article';

type ChatArgs = { system: string; user: string };

function fakeOllama(result: unknown | Error) {
  const calls: ChatArgs[] = [];
  return {
    calls,
    chatJson: (async (opts: ChatArgs) => {
      calls.push(opts);
      if (result instanceof Error) throw result;
      return result;
    }) as never,
  };
}

const scenes = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    title: ` Title ${i + 1} `,
    narration: `Narration ${i + 1}`,
    visualPrompt: `Prompt ${i + 1}`,
  }));

test('generateDraft builds an escaleta from text with defaults', async () => {
  const ollama = fakeOllama({ scenes: scenes(3) });
  const d = await generateDraft({ text: '  Un artículo.  ' }, { ollama });
  assert.equal(d.sourceKind, 'text');
  assert.equal(d.language, 'es');
  assert.equal(d.voiceA, 'male');
  assert.equal(d.voiceB, 'female');
  assert.equal(d.mix, false);
  assert.equal(d.article, 'Un artículo.');
  assert.deepEqual(
    d.escaleta.map((s) => [s.scene, s.title, s.voice]),
    [
      [1, 'Title 1', 'male'],
      [2, 'Title 2', 'male'],
      [3, 'Title 3', 'male'],
    ],
  );
  assert.equal(ollama.calls.length, 1);
  assert.match(ollama.calls[0].system, /JSON/);
  assert.match(ollama.calls[0].system, /es/);
  assert.match(ollama.calls[0].user, /Un artículo\./);
});

test('mix alternates voiceA and voiceB; scene numbers are renumbered', async () => {
  const raw = scenes(3).map((s, i) => ({ ...s, scene: 10 + i }));
  const d = await generateDraft({ text: 'x', mix: true, voiceA: 'a', voiceB: 'b' }, { ollama: fakeOllama({ scenes: raw }) });
  assert.deepEqual(d.escaleta.map((s) => [s.scene, s.voice]), [[1, 'a'], [2, 'b'], [3, 'a']]);
});

test('generateDraft fetches the article for url input', async () => {
  const fetchImpl = (async () =>
    new Response('<p>Desde la web</p>', { headers: { 'Content-Type': 'text/html' } })) as typeof fetch;
  const ollama = fakeOllama({ scenes: scenes(1) });
  const d = await generateDraft({ url: 'https://example.com/a' }, { ollama, fetchImpl });
  assert.equal(d.sourceKind, 'url');
  assert.equal(d.sourceRef, 'https://example.com/a');
  assert.match(ollama.calls[0].user, /Desde la web/);
});

test('generateDraft forwards deps.signal to the article fetch', async () => {
  let sent: AbortSignal | undefined;
  const fetchImpl = ((_u: unknown, init?: RequestInit) => {
    sent = init?.signal as AbortSignal;
    return new Promise((_resolve, reject) => {
      sent?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }) as typeof fetch;
  const ac = new AbortController();
  const p = generateDraft({ url: 'https://example.com/a' }, { ollama: fakeOllama({}), fetchImpl, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent?.aborted, false);
  ac.abort();
  await assert.rejects(p, (e: Error) => e.name === 'AbortError');
  assert.equal(sent?.aborted, true);
});

test('input must have exactly one of url or text', async () => {
  const ollama = fakeOllama({ scenes: scenes(1) });
  await assert.rejects(generateDraft({}, { ollama }), DraftInputError);
  await assert.rejects(generateDraft({ url: 'https://e.com', text: 'x' }, { ollama }), DraftInputError);
  await assert.rejects(generateDraft({ text: '   ' }, { ollama }), DraftInputError);
  await assert.rejects(generateDraft({ text: 'x', mix: 'yes' as never }, { ollama }), DraftInputError);
  await assert.rejects(generateDraft({ text: 'x', voiceA: '' }, { ollama }), DraftInputError);
  assert.equal(ollama.calls.length, 0);
});

test('an invalid url is a DraftInputError', async () => {
  await assert.rejects(generateDraft({ url: 'ftp://x/a' }, { ollama: fakeOllama({}) }), DraftInputError);
});

test('article fetch failures propagate as ArticleFetchError', async () => {
  const fetchImpl = (async () => new Response('x', { status: 500 })) as typeof fetch;
  await assert.rejects(
    generateDraft({ url: 'https://e.com' }, { ollama: fakeOllama({}), fetchImpl }),
    ArticleFetchError,
  );
});

test('model output that fails validation throws DraftValidationError', async () => {
  await assert.rejects(generateDraft({ text: 'x' }, { ollama: fakeOllama({ nope: 1 }) }), DraftValidationError);
});

test('ollama errors propagate', async () => {
  await assert.rejects(generateDraft({ text: 'x' }, { ollama: fakeOllama(new Error('Ollama unreachable')) }), /unreachable/);
});

const voices = { voiceA: 'male', voiceB: 'female', mix: false };

test('validateEscaleta enforces shape and caps', () => {
  const ok = scenes(1)[0];
  const cases: Array<[string, unknown]> = [
    ['not an object', 'x'],
    ['scenes missing', { scenes: 'x' }],
    ['empty', { scenes: [] }],
    ['too many', { scenes: scenes(21) }],
    ['scene not an object', { scenes: [null] }],
    ['empty title', { scenes: [{ ...ok, title: '  ' }] }],
    ['non-string narration', { scenes: [{ ...ok, narration: 5 }] }],
    ['title too long', { scenes: [{ ...ok, title: 'a'.repeat(121) }] }],
    ['narration too long', { scenes: [{ ...ok, narration: 'a'.repeat(1201) }] }],
    ['visualPrompt too long', { scenes: [{ ...ok, visualPrompt: 'a'.repeat(601) }] }],
    ['visualPrompt missing', { scenes: [{ title: 't', narration: 'n' }] }],
  ];
  for (const [label, value] of cases) {
    assert.throws(() => validateEscaleta(value, voices), DraftValidationError, label);
  }
});

test('validateEscaleta accepts the boundary sizes and trims strings', () => {
  const e = validateEscaleta(
    { scenes: [{ title: ` ${'a'.repeat(120)} `, narration: 'n'.repeat(1200), visualPrompt: 'v'.repeat(600) }] },
    voices,
  );
  assert.equal(e[0].title.length, 120);
  assert.equal(validateEscaleta({ scenes: scenes(20) }, voices).length, 20);
});

test('validateEscaleta ignores model-provided voices unless keepVoices is set', () => {
  const input = { scenes: [{ ...scenes(1)[0], voice: 'custom' }] };
  assert.equal(validateEscaleta(input, voices)[0].voice, 'male');
  assert.equal(validateEscaleta(input, { ...voices, keepVoices: true })[0].voice, 'custom');
});

test('generateDraft forwards deps.signal to chatJson', async () => {
  const seen: Array<AbortSignal | undefined> = [];
  const ollama = {
    chatJson: (async (opts: { signal?: AbortSignal }) => {
      seen.push(opts.signal);
      return { scenes: scenes(3) };
    }) as never,
  };
  const ac = new AbortController();
  await generateDraft({ text: 'x' }, { ollama, signal: ac.signal });
  assert.equal(seen[0], ac.signal);
});

// --- T6: dialogue format -----------------------------------------------------

test('narration (default): prompt has no speaker; output scenes have no speaker key', async () => {
  const ollama = fakeOllama({ scenes: scenes(2) });
  const d = await generateDraft({ text: 'x' }, { ollama });
  assert.doesNotMatch(ollama.calls[0].system, /\bspeaker\b/i);
  for (const s of d.escaleta) {
    assert.ok(!('speaker' in s), 'scene must not carry a speaker key');
  }
});

test('dialogue: prompt contains host names and "speaker"; speaker is kept and drives voice', async () => {
  const raw = scenes(2).map((s, i) => ({ ...s, speaker: i % 2 === 0 ? 'A' : 'B' }));
  const ollama = fakeOllama({ scenes: raw });
  const d = await generateDraft(
    { text: 'x', format: 'dialogue', hosts: { a: 'Marta', b: 'Diego' } },
    { ollama },
  );
  assert.match(ollama.calls[0].system, /Marta/);
  assert.match(ollama.calls[0].system, /Diego/);
  assert.match(ollama.calls[0].system, /"speaker"/);
  assert.deepEqual(
    d.escaleta.map((s) => [s.scene, s.speaker, s.voice]),
    [
      [1, 'A', 'male'],
      [2, 'B', 'female'],
    ],
  );
});

test('dialogue: mix is ignored for scenes that carry a speaker', async () => {
  const raw = [{ ...scenes(1)[0], speaker: 'A' }, { ...scenes(1)[0], speaker: 'A' }];
  const d = await generateDraft(
    { text: 'x', format: 'dialogue', mix: true, voiceA: 'male', voiceB: 'female' },
    { ollama: fakeOllama({ scenes: raw }) },
  );
  assert.deepEqual(d.escaleta.map((s) => s.speaker), ['A', 'A']);
  assert.deepEqual(d.escaleta.map((s) => s.voice), ['male', 'male']);
});

test('dialogue: a scene missing speaker is rejected', async () => {
  const raw = [{ ...scenes(1)[0], speaker: 'A' }, { ...scenes(1)[0] }]; // second scene lacks speaker
  await assert.rejects(
    generateDraft({ text: 'x', format: 'dialogue' }, { ollama: fakeOllama({ scenes: raw }) }),
    DraftValidationError,
  );
});

test('validateEscaleta rejects an invalid speaker value', () => {
  assert.throws(
    () => validateEscaleta({ scenes: [{ ...scenes(1)[0], speaker: 'C' }] }, voices),
    DraftValidationError,
  );
});

test('validateEscaleta: keepVoices explicit voice wins over speaker-derived voice', () => {
  const e = validateEscaleta(
    { scenes: [{ ...scenes(1)[0], speaker: 'B', voice: 'custom' }] },
    { ...voices, keepVoices: true },
  );
  assert.equal(e[0].voice, 'custom');
  assert.equal(e[0].speaker, 'B');
});

test('invalid format and invalid hosts are DraftInputErrors', async () => {
  const ollama = fakeOllama({ scenes: scenes(1) });
  await assert.rejects(generateDraft({ text: 'x', format: 'both' as never }, { ollama }), DraftInputError);
  await assert.rejects(generateDraft({ text: 'x', format: 'dialogue', hosts: { a: 'OnlyA' } as never }, { ollama }), DraftInputError);
  await assert.rejects(generateDraft({ text: 'x', format: 'dialogue', hosts: { a: '', b: 'B' } }, { ollama }), DraftInputError);
  await assert.rejects(generateDraft({ text: 'x', format: 'dialogue', hosts: 'nope' as never }, { ollama }), DraftInputError);
  await assert.rejects(generateDraft({ text: 'x', hosts: { a: 'a'.repeat(41), b: 'b' } }, { ollama }), DraftInputError);
  assert.equal(ollama.calls.length, 0);
});

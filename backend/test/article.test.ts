import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchArticleText, htmlToText, ArticleFetchError, ArticleInputError } from '../src/pipeline/article';

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, ...init });
}

function fakeFetch(res: Response | Error) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (res instanceof Error) throw res;
    return res;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test('htmlToText drops script/style/noscript, strips tags, decodes entities, collapses whitespace', () => {
  const text = htmlToText(
    `<html><head><style>p{color:red}</style><script>alert(1)</script></head>
     <body><!-- c --><h1>Tom &amp; Jerry</h1><p>1 &lt; 2 &gt; 0 &quot;q&quot; it&#39;s&nbsp;ok</p>
     <noscript>enable js</noscript><p>&amp;lt; stays</p></body></html>`,
  );
  assert.equal(text, `Tom & Jerry 1 < 2 > 0 "q" it's ok &lt; stays`);
});

test('fetchArticleText returns plain text and follows redirects', async () => {
  const { fetchImpl, calls } = fakeFetch(html('<p>Hola   mundo</p>'));
  const text = await fetchArticleText('https://example.com/a', { fetchImpl });
  assert.equal(text, 'Hola mundo');
  assert.equal(calls[0].url, 'https://example.com/a');
  assert.equal(calls[0].init?.redirect, 'follow');
});

test('fetchArticleText truncates to 12000 characters', async () => {
  const { fetchImpl } = fakeFetch(html(`<p>${'a'.repeat(20000)}</p>`));
  const text = await fetchArticleText('http://example.com', { fetchImpl });
  assert.equal(text.length, 12000);
});

test('private-network hosts are allowed', async () => {
  const { fetchImpl } = fakeFetch(html('<p>ok</p>'));
  assert.equal(await fetchArticleText('http://192.168.1.10:8080/x', { fetchImpl }), 'ok');
});

for (const url of ['ftp://example.com/a', 'file:///etc/passwd', 'not a url', 'https://user:pw@example.com/', 'https://user@example.com/']) {
  test(`rejects url ${url}`, async () => {
    const { fetchImpl, calls } = fakeFetch(html('x'));
    await assert.rejects(fetchArticleText(url, { fetchImpl }), ArticleInputError);
    assert.equal(calls.length, 0);
  });
}

test('rejects non-2xx responses', async () => {
  const { fetchImpl } = fakeFetch(html('nope', { status: 404 }));
  await assert.rejects(fetchArticleText('https://example.com', { fetchImpl }), /404/);
});

test('rejects non-html content types', async () => {
  const { fetchImpl } = fakeFetch(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(fetchArticleText('https://example.com', { fetchImpl }), /content type/i);
});

test('rejects bodies larger than maxBytes (streamed)', async () => {
  const { fetchImpl } = fakeFetch(html('a'.repeat(100)));
  await assert.rejects(fetchArticleText('https://example.com', { fetchImpl, maxBytes: 50 }), /too large/i);
});

test('rejects when content-length exceeds maxBytes', async () => {
  const { fetchImpl } = fakeFetch(html('a', { headers: { 'Content-Type': 'text/html', 'Content-Length': '999' } }));
  await assert.rejects(fetchArticleText('https://example.com', { fetchImpl, maxBytes: 50 }), /too large/i);
});

test('times out when the server never answers', async () => {
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as typeof fetch;
  await assert.rejects(fetchArticleText('https://example.com', { fetchImpl, timeoutMs: 20 }), /timed out/i);
});

test('wraps network failures in ArticleFetchError', async () => {
  const { fetchImpl } = fakeFetch(new Error('ECONNREFUSED'));
  await assert.rejects(fetchArticleText('https://example.com', { fetchImpl }), (e: Error) => {
    assert.ok(e instanceof ArticleFetchError);
    assert.match(e.message, /ECONNREFUSED/);
    return true;
  });
});

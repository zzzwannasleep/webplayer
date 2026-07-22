// HttpSource re-resolution: a signed direct link expires, so the source must
// refresh it (proactively near TTL, and on a 401/403/410) and retry the same
// bytes. Uses an injected mock fetch so no network is touched.
import { HttpSource } from '../src/demux/matroska.js';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
};
const resp = (status, body = null, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
  arrayBuffer: async () => (body ?? new Uint8Array(0)).buffer,
});

console.log('=== HttpSource ===');

// 1) Plain direct URL, no resolver -- behaves as before.
{
  const calls = [];
  const fetchMock = async (url, opts) => {
    calls.push(opts?.method === 'HEAD' ? 'HEAD' : url);
    return opts?.method === 'HEAD'
      ? resp(200, null, { 'accept-ranges': 'bytes', 'content-length': '1000' })
      : resp(206, new Uint8Array([1, 2, 3]));
  };
  const src = new HttpSource('http://x/v.mp4', { fetch: fetchMock });
  await src.open();
  check('plain: size from HEAD', src.size, 1000);
  check('plain: read length', (await src.read(0, 3)).length, 3);
  check('plain: fetched the given url', calls[1], 'http://x/v.mp4');
}

// 2) Resolver turns the page URL into a direct link; a 403 mid-read triggers a
//    re-resolve and a retry of the same byte range.
{
  let resolves = 0;
  const resolve = async () => ({ url: `http://cdn/sig${++resolves}`, expiresAt: 0 });
  let n = 0;
  const fetchMock = async (url, opts) => {
    if (opts?.method === 'HEAD') return resp(200, null, { 'accept-ranges': 'bytes', 'content-length': '500' });
    return ++n === 1 ? resp(403) : resp(206, new Uint8Array([9, 9]));
  };
  const src = new HttpSource('http://page/watch?id=1', { resolve, fetch: fetchMock });
  await src.open();
  check('resolve: resolved before HEAD', resolves, 1);
  check('resolve: fetch uses the direct link', src.url, 'http://cdn/sig1');
  const b = await src.read(0, 2);
  check('expiry: re-resolved on 403', resolves, 2);
  check('expiry: retried and got bytes', b.length, 2);
  check('expiry: retry used the fresh link', src.url, 'http://cdn/sig2');
}

// 3) A link that expires within the 5s window is refreshed BEFORE the request.
{
  let resolves = 0;
  const resolve = async () => ({ url: `http://cdn/${++resolves}`, expiresAt: Date.now() + 1000 });
  const fetchMock = async (url, opts) => opts?.method === 'HEAD'
    ? resp(200, null, { 'accept-ranges': 'bytes', 'content-length': '100' })
    : resp(206, new Uint8Array([7]));
  const src = new HttpSource('http://page', { resolve, fetch: fetchMock });
  await src.open();          // resolves=1
  await src.read(0, 1);      // near-expiry -> proactive refresh
  check('proactive: refreshed before a near-expiry read', resolves, 2);
}

// 4) Default fetch (no injected mock) must call the global with globalThis as
//    receiver -- a detached `const f = globalThis.fetch; f()` throws "Illegal
//    invocation" in browsers/workers. (The mock in tests 1-3 hid this.)
{
  const orig = globalThis.fetch;
  let receiverOk = false;
  globalThis.fetch = function () { receiverOk = this === globalThis; return resp(206, new Uint8Array([1])); };
  try {
    const src = new HttpSource('http://x/v');   // no fetch option -> default wrapper
    await src._fetch('http://x/v', {});
    check('default fetch: called with global receiver (no Illegal invocation)', receiverOk, true);
  } finally { globalThis.fetch = orig; }
}

console.log(failures ? `\n${failures} HTTPSOURCE CHECK(S) FAILED` : '\nALL HTTPSOURCE CHECKS PASSED');
process.exit(failures ? 1 : 0);

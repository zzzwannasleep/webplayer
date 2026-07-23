// HttpSource: open() probes with a tiny Range GET (not HEAD -- many CDNs only
// advertise Accept-Ranges on GET), and a signed direct link is refreshed
// (proactively near TTL, and on 401/403/410) with the same bytes retried.
// Uses an injected mock fetch so no network is touched.
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

// 1) Plain direct URL: open() gets the size from the 206 probe's Content-Range,
//    then reads work. (Regression guard: a HEAD without Accept-Ranges must not
//    be needed -- the probe is a Range GET.)
{
  const calls = [];
  let call = 0;
  const fetchMock = async (url) => {
    calls.push(url); call++;
    return call === 1
      ? resp(206, new Uint8Array([0, 0]), { 'content-range': 'bytes 0-1/1000' })     // open probe
      : resp(206, new Uint8Array([1, 2, 3]), { 'content-range': 'bytes 0-2/1000' });  // read
  };
  const src = new HttpSource('http://x/v.mp4', { fetch: fetchMock });
  await src.open();
  check('plain: size from Content-Range', src.size, 1000);
  check('plain: read length', (await src.read(0, 3)).length, 3);
  check('plain: fetched the given url', calls[1], 'http://x/v.mp4');
}

// 2) Resolver turns the page URL into a direct link; a 403 mid-read triggers a
//    re-resolve and a retry of the same byte range.
{
  let resolves = 0;
  const resolve = async () => ({ url: `http://cdn/sig${++resolves}`, expiresAt: 0 });
  let call = 0;
  const fetchMock = async () => {
    call++;
    if (call === 1) return resp(206, new Uint8Array([0, 0]), { 'content-range': 'bytes 0-1/500' }); // open probe
    if (call === 2) return resp(403);                                                                // read: expired
    return resp(206, new Uint8Array([9, 9]), { 'content-range': 'bytes 0-1/500' });                  // read retry
  };
  const src = new HttpSource('http://page/watch?id=1', { resolve, fetch: fetchMock });
  await src.open();
  check('resolve: resolved before probe', resolves, 1);
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
  const fetchMock = async () => resp(206, new Uint8Array([7]), { 'content-range': 'bytes 0-0/100' });
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

// 5) The Content-Range fix: a 302->CDN stream serves 206 with body readable
//    (ACAO:*) but does NOT CORS-expose Content-Range. Without a seeded size that
//    threw "did not expose a Content-Range total size". With a caller-seeded
//    size (Emby MediaSource.Size) open() succeeds and reads still work.
{
  const fetchMock = async () => resp(206, new Uint8Array([0, 0]), {}); // 206, NO content-range header
  const src = new HttpSource('http://cdn/stream.mkv', { fetch: fetchMock, size: 21235784353 });
  await src.open();
  check('seeded: size used when Content-Range is not exposed', src.size, 21235784353);
  check('seeded: read still works (body needs no header)', (await src.read(0, 2)).length, 2);
}

// 6) Regression: 206 without Content-Range AND no seeded size must still throw
//    the helpful message (the safety net must not mask a genuinely unusable
//    server for the non-Emby direct-URL path).
{
  const fetchMock = async () => resp(206, new Uint8Array([0, 0]), {});
  const src = new HttpSource('http://cdn/stream.mkv', { fetch: fetchMock });
  let msg = '';
  try { await src.open(); } catch (e) { msg = e.message; }
  check('unseeded: still throws Content-Range error', /did not expose a Content-Range/.test(msg), true);
}

// 7) An exposed Content-Range is authoritative: it wins over a (wrong) seed.
{
  const fetchMock = async () => resp(206, new Uint8Array([0, 0]), { 'content-range': 'bytes 0-1/999' });
  const src = new HttpSource('http://cdn/stream.mkv', { fetch: fetchMock, size: 12345 });
  await src.open();
  check('header wins: prefers exposed Content-Range over seed', src.size, 999);
}

// 8) A raw Emby /Videos/stream URL 302-redirects to a CDN. open()'s no-Range GET
//    (un-preflighted, so it may follow the cross-origin redirect) lands on the CDN
//    and response.url differs; HttpSource adopts it and Range-probes the CDN, never
//    the un-followable Emby URL. This is the "CORS on playback" fix.
{
  const calls = [];
  let call = 0;
  const fetchMock = async (url, init) => {
    calls.push({ url, range: init?.headers?.Range ?? null }); call++;
    if (call === 1) return { ...resp(200), url: 'http://cdn/final?sig=abc' };                 // no-Range follow -> redirected
    return resp(206, new Uint8Array([0, 0]), { 'content-range': 'bytes 0-1/2048' });          // Range probe on the CDN
  };
  const src = new HttpSource('http://emby/Videos/1/stream.mkv?api_key=t', { fetch: fetchMock });
  await src.open();
  check('redirect: no-Range follow ran first (no Range header)', calls[0].range, null);
  check('redirect: adopted CDN url from response.url', src.url, 'http://cdn/final?sig=abc');
  check('redirect: Range probe hit the CDN url', calls[1].url, 'http://cdn/final?sig=abc');
  check('redirect: probe carried a Range header', calls[1].range, 'bytes=0-1');
  check('redirect: size from the CDN probe', src.size, 2048);
}

// 9) A .strm-backed Emby item has no Size in PlaybackInfo, so nothing seeds the
//    size from above; if the proxied stream also does not CORS-expose
//    Content-Range, open() used to give up. The no-Range follow that already
//    runs first has a Content-Length that IS the whole file -- take it.
{
  let call = 0;
  const fetchMock = async () => {
    call++;
    return call === 1
      ? { ...resp(200), url: '', headers: { get: k => (k.toLowerCase() === 'content-length' ? '7340032' : null) } }
      : resp(206, new Uint8Array([0, 0]), {});     // 206 proves Range; Content-Range NOT exposed
  };
  const src = new HttpSource('http://emby/Videos/9/stream?api_key=t', { fetch: fetchMock });
  await src.open();
  check('strm: size recovered from the follow GET Content-Length', src.size, 7340032);
}

// 10) ...but an exposed Content-Range still wins over that hint.
{
  let call = 0;
  const fetchMock = async () => {
    call++;
    return call === 1
      ? { ...resp(200), url: '', headers: { get: k => (k.toLowerCase() === 'content-length' ? '111' : null) } }
      : resp(206, new Uint8Array([0, 0]), { 'content-range': 'bytes 0-1/222' });
  };
  const src = new HttpSource('http://emby/Videos/9/stream', { fetch: fetchMock });
  await src.open();
  check('strm: Content-Range still beats the Content-Length hint', src.size, 222);
}

// 11) The three failures src/player.js routes to the native <video> leg must
//     carry a machine-readable code -- postMessage flattens Errors, so matching
//     on the prose would silently stop working the day a message is reworded.
{
  const codeOf = async (fetchMock, opts) => {
    const src = new HttpSource('http://cdn/x', { fetch: fetchMock, ...opts });
    try { await src.open(); return '(no throw)'; } catch (e) { return e.code ?? '(uncoded)'; }
  };
  check('code: 200 to a Range probe -> NO_RANGE',
    await codeOf(async () => resp(200, new Uint8Array([0, 0]), {})), 'NO_RANGE');
  check('code: 206 with no total anywhere -> NO_SIZE',
    await codeOf(async () => resp(206, new Uint8Array([0, 0]), {})), 'NO_SIZE');
}

// 12) A read that is answered with the wrong bytes must not be handed on as if
//     it were the right ones. Reported from the field as Firefox's
//     "ConvertSampleToAVCC": a mid-file read came back with the head of the
//     file, the demuxer parsed it at the offset it had asked for, timestamps
//     jumped back to zero and every sample after it decoded as garbage. The
//     same stream played in Edge, which is exactly why this has to be caught
//     here rather than left to whichever decoder is stricter.
{
  const whole = new Uint8Array(1000).map((_, i) => i & 0xff);
  const said = [];
  // A server that ignores Range: 200 plus the entire file, every time.
  const ignoresRange = async (url, init) => init?.headers?.Range
    ? resp(200, whole, { 'content-length': '1000' })
    : resp(200, whole, {});
  const src = new HttpSource('http://cdn/x', {
    fetch: async (u, i) => i?.headers?.Range === 'bytes=0-1'
      ? resp(206, new Uint8Array([0, 1]), { 'content-range': 'bytes 0-1/1000' })   // open probe
      : ignoresRange(u, i),
    log: m => said.push(m),
  });
  await src.open();
  const got = await src.read(500, 4);
  check('ignored Range: length is the slice, not the file', got.length, 4);
  check('ignored Range: the bytes are the ones asked for', [...got].join(), '244,245,246,247');
  check('ignored Range: it says so, once', said.length, 1);
  await src.read(600, 4);
  check('ignored Range: still once after a second read', said.length, 1);

  // A 206 that serves a different offset than the one requested is the same
  // failure wearing the right status code.
  const wrongOffset = new HttpSource('http://cdn/y', {
    fetch: async (u, i) => i?.headers?.Range === 'bytes=0-1'
      ? resp(206, new Uint8Array([0, 1]), { 'content-range': 'bytes 0-1/1000' })
      : resp(206, new Uint8Array([9, 9, 9, 9]), { 'content-range': 'bytes 0-3/1000' }),
  });
  await wrongOffset.open();
  let msg = '(no throw)';
  try { await wrongOffset.read(500, 4); } catch (e) { msg = e.message; }
  check('206 at the wrong offset is refused', /Range mismatch/.test(msg), true);
}

console.log(failures ? `\n${failures} HTTPSOURCE CHECK(S) FAILED` : '\nALL HTTPSOURCE CHECKS PASSED');
process.exit(failures ? 1 : 0);

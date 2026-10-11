// The Emby client is browser-facing (fetch, localStorage), but its pure
// routing helpers decide correctness of the whole play handoff, so they get a
// node check. subtitleDelivery picks the render path; sourceUrl / deliveryUrl
// resolve the server-DECLARED delivery addresses (never client-built paths).
import assert from 'node:assert/strict';
import { EmbyClient, subtitleDelivery, reline, servers, serverIcons, isRemoteSource, directUrl } from '../src/emby/client.js';

// --- subtitleDelivery: which path a chosen subtitle stream takes ------------
assert.equal(subtitleDelivery({ Codec: 'ass' }), 'client', 'embedded ASS renders in-browser');
assert.equal(subtitleDelivery({ Codec: 'ssa' }), 'client', 'embedded SSA renders in-browser');
assert.equal(subtitleDelivery({ Codec: 'PGSSUB' }), 'client', 'embedded PGS renders in-browser');
// External ASS now goes to the in-browser libass path: the player fetches the
// ORIGINAL script (Stream.ass) and hands it to JASSUB whole, so the effects the
// SRT round trip used to flatten away are kept. (Server-side it is a first-
// class file: emby.media/support/articles/Subtitles.html lists ass/ssa as
// supported external formats.)
assert.equal(subtitleDelivery({ Codec: 'ass', IsExternal: true }), 'ext-ass',
  'external ASS renders in-browser from the original script');
assert.equal(subtitleDelivery({ Codec: 'SSA', IsExternal: true }), 'ext-ass',
  'external SSA renders in-browser from the original script');
// Embedded text used to be routed to Emby because there was no client renderer.
// src/subs/text.js is one, and the server round trip was the flaky half: Emby
// extracts on demand and answers 404/500/empty while ffmpeg runs.
assert.equal(subtitleDelivery({ Codec: 'subrip' }), 'client', 'embedded SRT is demuxed and drawn locally');
assert.equal(subtitleDelivery({ Codec: 'srt' }), 'client', 'embedded SRT (other codec spelling)');
assert.equal(subtitleDelivery({ Codec: 'mov_text' }), 'client', 'embedded tx3g is demuxed and drawn locally');
assert.equal(subtitleDelivery({ Codec: 'webvtt' }), 'client', 'embedded WebVTT is demuxed and drawn locally');
assert.equal(subtitleDelivery({ Codec: 'srt', IsExternal: true }), 'ext-text', 'external SRT — original bytes to browser <track>');
assert.equal(subtitleDelivery({ Codec: 'subrip', IsExternal: true }), 'ext-text', 'external SRT, other spelling');
assert.equal(subtitleDelivery({ Codec: 'vtt', IsExternal: true }), 'ext-text', 'external VTT — original bytes straight to <track>');
assert.equal(subtitleDelivery({ Codec: 'mov_text', IsExternal: true }), 'unsupported', 'external mp4-timed text is not a fetchable sidecar format');
assert.equal(subtitleDelivery({ Codec: 'dvb_teletext' }), 'unsupported',
  'an embedded format with no local renderer is NOT sent to the server for conversion — direct-pass everything');
assert.equal(subtitleDelivery({ Codec: 'pgssub', IsExternal: true }), 'unsupported',
  'external bitmap sub has no clean path');
assert.equal(subtitleDelivery({ Codec: 'vobsub', IsExternal: true }), 'unsupported', 'external VobSub unsupported');

// --- sourceUrl / deliveryUrl: the server's OWN addresses, never built --------
// The whole URL-construction layer is gone: different server implementations
// key their routes differently (measured on a live Gin-based server where the
// generic /Subtitles route keys by an internal file id), and the server's own
// declared address is the only one correct by construction.
const c = new EmbyClient('https://emby.example/');   // trailing slash trimmed
c.token = 'TKN';

// DirectStreamUrl is authoritative for the video; the api_key is re-keyed to
// the LIVE session (a stale one baked in by the server must not ride along).
const sv = new URL(c.sourceUrl({ DirectStreamUrl: '/play/video/01FILE?api_key=OLD' }));
assert.equal(sv.origin + sv.pathname, 'https://emby.example/play/video/01FILE',
  'video uses the server-declared DirectStreamUrl');
assert.equal(sv.searchParams.get('api_key'), 'TKN', 'video URL re-keyed to the live session token');
assert.equal(c.sourceUrl({}), null, 'no DirectStreamUrl -> null (callers report, not guess)');
assert.equal(c.sourceUrl(null), null, 'no source -> null');

// DeliveryUrl is authoritative for a sidecar subtitle file.
const dv = new URL(c.deliveryUrl({ Index: 1, DeliveryUrl: '/play/subtitle/01ASSET?api_key=OLD', DeliveryMethod: 'External' }));
assert.equal(dv.origin + dv.pathname, 'https://emby.example/play/subtitle/01ASSET',
  'subtitle uses the server-declared DeliveryUrl');
assert.equal(dv.searchParams.get('api_key'), 'TKN', 'DeliveryUrl re-keyed to the live session token');
// A relative path resolves against the SERVER origin, not the page.
const rel = new URL(c.deliveryUrl({ Index: 0, DeliveryUrl: '/play/subtitle/x' }));
assert.equal(rel.origin + rel.pathname, 'https://emby.example/play/subtitle/x', 'relative DeliveryUrl resolved against the server');
assert.equal(c.deliveryUrl({ Index: 2 }), null, 'no DeliveryUrl -> null (stream is not fetchable, not offered)');
assert.equal(c.deliveryUrl(null), null, 'no stream -> null');

// --- imageUrl: id and tag must be paired (the episode-cover-blank bug) -------
const idAndTag = url => { const u = new URL(url); return { id: u.pathname.split('/Items/')[1].split('/Images/')[0], tag: u.searchParams.get('tag') }; };

// Episode WITH its own cover (auto-generated thumbnail): must use the episode's
// own id + tag, NOT the series id. This is the regression that showed blank.
const epWithCover = { Id: 'EP1', Type: 'Episode', SeriesId: 'SER1', ImageTags: { Primary: 'epTag' }, SeriesPrimaryImageTag: 'serTag' };
assert.deepEqual(idAndTag(c.imageUrl(epWithCover)), { id: 'EP1', tag: 'epTag' }, 'episode with its own cover uses its own id+tag');

// Episode WITHOUT its own cover: falls back to the series poster, id+tag both series'.
const epNoCover = { Id: 'EP2', Type: 'Episode', SeriesId: 'SER1', ImageTags: {}, SeriesPrimaryImageTag: 'serTag' };
assert.deepEqual(idAndTag(c.imageUrl(epNoCover)), { id: 'SER1', tag: 'serTag' }, 'coverless episode falls back to series poster');

// Movie: its own id + tag.
const movie = { Id: 'MOV1', Type: 'Movie', ImageTags: { Primary: 'movTag' } };
assert.deepEqual(idAndTag(c.imageUrl(movie)), { id: 'MOV1', tag: 'movTag' }, 'movie uses its own id+tag');

// No image anywhere -> null, not a broken URL.
assert.equal(c.imageUrl({ Id: 'X', Type: 'Episode', ImageTags: {} }), null, 'no tag -> null');

// --- reline: swapping the entry domain mid-playback -------------------------
// The stream URL keeps its path, query and api_key; only the way in changes.
const stream = 'https://a.example/Videos/42/stream.mkv?Static=true&api_key=TKN';
assert.equal(reline(stream, 'https://a.example', 'https://b.example'),
  'https://b.example/Videos/42/stream.mkv?Static=true&api_key=TKN', 'origin swapped, path+query intact');
assert.equal(reline(stream, 'https://a.example', 'https://a.example'), stream, 'same line is a no-op');
// A line that lives under a path prefix keeps it; the home prefix is stripped first.
assert.equal(reline('https://a.example/emby/Videos/42/stream.mkv?x=1', 'https://a.example/emby', 'https://b.example/e'),
  'https://b.example/e/Videos/42/stream.mkv?x=1', 'path-prefixed line');
// URL built against some other host (shouldn't happen): fall back to path+query.
assert.equal(reline('https://c.example/Videos/9/stream.mkv?x=1', 'https://a.example', 'https://b.example'),
  'https://b.example/Videos/9/stream.mkv?x=1', 'unknown prefix falls back to path+query');

// --- .strm / remote sources -------------------------------------------------
// Emby resolves the .strm server-side, so the client only ever sees the SHAPE
// it produces; the URL inside it (source.Path) is itself server-given and is
// offered to play.html as the direct-connect CANDIDATE.
assert.equal(isRemoteSource({ Protocol: 'Http' }), true, 'Protocol=Http is remote');
assert.equal(isRemoteSource({ IsRemote: true }), true, 'IsRemote flag is remote');
assert.equal(isRemoteSource({ Path: 'https://s3.example/a.mkv?X-Amz-Signature=x' }), true, 'http path is remote');
assert.equal(isRemoteSource({ Path: '/media/movies/a.strm' }), true, '.strm path is remote');
assert.equal(isRemoteSource({ Protocol: 'File', Path: '/media/movies/a.mkv' }), false, 'local file is not remote');
assert.equal(isRemoteSource(null), false, 'no source is not remote');

// --- directUrl: the direct-connect candidate --------------------------------
// Only http(s) is a candidate. Everything else a .strm may legally hold is
// something a page cannot fetch, so offering it would burn a failed request
// before the server path runs anyway.
assert.equal(directUrl({ Protocol: 'Http', Path: 'https://s3.example/a.mkv?X-Amz-Signature=x' }),
  'https://s3.example/a.mkv?X-Amz-Signature=x', 'a signed https target is a candidate');
assert.equal(directUrl({ IsRemote: true, Path: ' http://alist.example/d/x.mkv ' }),
  'http://alist.example/d/x.mkv', 'trimmed');
assert.equal(directUrl({ Protocol: 'Http', Path: 'rtsp://cam.example/live' }), null, 'rtsp is not fetchable');
assert.equal(directUrl({ Protocol: 'Http', Path: '\\\\nas\\share\\a.mkv' }), null, 'a UNC share is not fetchable');
assert.equal(directUrl({ Protocol: 'File', Path: '/media/a.mkv' }), null, 'a local file has no direct URL');
assert.equal(directUrl({ Protocol: 'Http' }), null, 'no path -> no candidate');
assert.equal(directUrl(null), null, 'no source -> no candidate');

// --- serverIcons: server branding first, user avatar as the fallback --------
assert.deepEqual(serverIcons({ url: 'https://one.example', token: 'T', userId: 'U1' }), [
  'https://one.example/Branding/Splashscreen?api_key=T&maxWidth=96',
  'https://one.example/Users/U1/Images/Primary?api_key=T&maxWidth=96',
], 'branding image is tried before the avatar');
assert.equal(serverIcons({ url: 'https://one.example' }).length, 1, 'no user -> branding only');
assert.ok(serverIcons({ url: 'https://one.example', line: 'https://cdn.example' })[0].startsWith('https://cdn.example'),
  'icon is fetched over the line in use');
assert.deepEqual(serverIcons(null), [], 'no record -> nothing to try');

// --- item actions must pick the right VERB ----------------------------------
// Emby toggles played/favourite by method, not by payload: POST sets, DELETE
// clears, same URL. Swapping them fails silently and does the OPPOSITE of what
// the menu says, which no error path would ever catch.
{
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    calls.push({ url: String(url), method: opt?.method || 'GET' });
    return { ok: true, status: 204, json: async () => null, text: async () => '' };
  };
  const c2 = new EmbyClient('https://e.example');
  c2.token = 'T'; c2.userId = 'U9';
  const last = () => calls[calls.length - 1];

  await c2.markPlayed('i1', true);
  assert.equal(last().method, 'POST', 'mark played = POST');
  assert.ok(last().url.includes('/Users/U9/PlayedItems/i1'), 'played route');
  await c2.markPlayed('i1', false);
  assert.equal(last().method, 'DELETE', 'mark UNplayed = DELETE');

  await c2.setFavorite('i1', true);
  assert.equal(last().method, 'POST', 'favourite = POST');
  await c2.setFavorite('i1', false);
  assert.equal(last().method, 'DELETE', 'un-favourite = DELETE');

  await c2.setLike('i1', true);
  assert.equal(last().method, 'POST');
  assert.ok(last().url.includes('Likes=true'), 'like carries Likes=true');
  await c2.setLike('i1', null);
  assert.equal(last().method, 'DELETE', 'clearing a rating = DELETE');

  await c2.deleteItem('i1');
  assert.equal(last().method, 'DELETE', 'delete item = DELETE');

  // refresh: the default must NOT replace existing metadata, only fill gaps
  await c2.refreshMetadata('i1');
  assert.equal(last().method, 'POST');
  assert.ok(last().url.includes('MetadataRefreshMode=Default'), 'plain refresh does not re-scrape');
  assert.ok(last().url.includes('ReplaceAllMetadata=false'), 'plain refresh keeps existing metadata');
  await c2.refreshMetadata('i1', { replaceAll: true });
  assert.ok(last().url.includes('ReplaceAllMetadata=true'), 'replaceAll opts in explicitly');

  // admin task control is also verb-based
  await c2.runTask('t1');  assert.equal(last().method, 'POST', 'run task = POST');
  await c2.stopTask('t1'); assert.equal(last().method, 'DELETE', 'stop task = DELETE');

  globalThis.fetch = realFetch;
}

// --- resume(): the two ways 继续观看 filled up with things it shouldn't -----
// Reported twice: finished shows on the rail, and episodes from a library that
// is hidden from this account's home screen. Both come from the same query, so
// both are checked here.
{
  const calls = [];
  const realFetch = globalThis.fetch;
  const item = (Id, when) => ({ Id, UserData: { LastPlayedDate: when } });
  globalThis.fetch = async url => {
    const q = new URL(String(url)).searchParams;
    calls.push(q);
    const lib = q.get('ParentId');
    // LIB-A and LIB-B share SHARED so the dedupe has something to do.
    const byLib = {
      'LIB-A': [item('OLD', '2026-01-01T00:00:00Z'), item('SHARED', '2026-07-20T00:00:00Z')],
      'LIB-B': [item('NEW', '2026-07-25T00:00:00Z'), item('SHARED', '2026-07-20T00:00:00Z'), item('NODATE')],
    };
    return { ok: true, status: 200, json: async () => ({ Items: byLib[lib] ?? [item('ALL')] }) };
  };
  const c3 = new EmbyClient('https://e.example');
  c3.token = 'T'; c3.userId = 'U9';

  const rows = await c3.resume(['LIB-A', 'LIB-B']);

  assert.equal(calls.length, 2, 'one request per visible library, not one for the whole server');
  assert.deepEqual(calls.map(q => q.get('ParentId')), ['LIB-A', 'LIB-B'],
    'every request is scoped to a library -- an unscoped one also returns hidden libraries');
  for (const q of calls) {
    const f = (q.get('Filters') || '').split(',');
    assert.ok(f.includes('IsResumable'), 'still only half-watched items');
    assert.ok(f.includes('IsUnplayed'),
      'a finished item can keep a stale resume point; IsResumable alone still matches it');
  }
  assert.deepEqual(rows.map(r => r.Id), ['NEW', 'SHARED', 'OLD', 'NODATE'],
    'merged newest-first across libraries, deduped, and an item with no date sorts last');

  calls.length = 0;
  assert.deepEqual((await c3.resume([])).map(r => r.Id), ['ALL'], 'no libraries -> one unscoped query');
  assert.equal(calls[0].get('ParentId'), null, 'the fallback really is unscoped');

  // A server that refuses the filter pair must still produce a rail. An empty
  // 继续观看 reads as "you have finished everything", which is a worse lie than
  // the stale entries this filter exists to remove.
  calls.length = 0;
  globalThis.fetch = async url => {
    const q = new URL(String(url)).searchParams;
    calls.push(q);
    if ((q.get('Filters') || '').includes('IsUnplayed')) return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ Items: [item('KEPT', '2026-07-01T00:00:00Z'),
      { Id: 'DONE', UserData: { Played: true, LastPlayedDate: '2026-07-02T00:00:00Z' } }] }) };
  };
  const fallback = await c3.resume(['LIB-A']);
  assert.deepEqual(calls.map(q => q.get('Filters')), ['IsResumable,IsUnplayed', 'IsResumable'],
    'the pair is tried first, the lone filter only as a fallback');
  assert.deepEqual(fallback.map(r => r.Id), ['KEPT'],
    'and a played item is still dropped client-side, which is what makes the fallback safe');

  globalThis.fetch = realFetch;
}

// --- remembered servers: the "can't switch server after logout" bug ---------
// Needs Web Storage (npm test passes --experimental-webstorage); skipped without.
if (typeof localStorage !== 'undefined') {
  localStorage.clear();
  const signIn = (url, name) => { const c = new EmbyClient(url); c.token = 'T-' + name; c.userName = name; c.userId = 'U-' + name; c._persist(); return c; };

  const a = signIn('https://one.example', 'alice');
  const b = signIn('https://two.example/', 'bob');       // trailing slash must not fork the record
  assert.deepEqual(servers.all().map(s => s.url), ['https://two.example', 'https://one.example'], 'newest server first');

  // A line sync must not clobber the credentials already on the record.
  servers.put({ url: b.home, lines: [{ name: 'CN2', url: 'https://cn2.example' }] });
  assert.equal(servers.get('https://two.example').token, 'T-bob', 'sync keeps the token');
  assert.deepEqual(b.allLines().map(l => l.name), ['主线路', 'CN2'], 'home line first, then synced');

  // Logging out of B drops ONLY B's token; both servers stay listed, so the
  // login page can still offer them. This is the reported bug.
  b.logout();
  assert.deepEqual(servers.all().map(s => s.url), ['https://two.example', 'https://one.example'], 'logout forgets no server');
  assert.equal(servers.get('https://two.example').token, null, 'logged-out server has no token');
  assert.equal(servers.get('https://two.example').lines.length, 1, 'logout keeps the synced lines');
  assert.equal(EmbyClient.from(servers.get('https://two.example')), null, 'no token -> must re-enter the password');

  // The other account is still one click away, no password.
  const back = EmbyClient.from(servers.get('https://one.example'));
  assert.equal(back?.userName, 'alice', 'other server resumes from its remembered token');
  assert.equal(EmbyClient.restore().home, 'https://one.example', 'and becomes the active session');

  // Picking a line moves `server` without moving the record key `home`.
  back.useLine('https://cdn.example');
  assert.equal(back.server, 'https://cdn.example');
  assert.equal(back.home, 'https://one.example', 'line switch does not fork the remembered server');
  assert.equal(servers.all().length, 2, 'still two servers, not three');
  localStorage.clear();
} else console.log('test-emby: (server persistence skipped — no localStorage)');

console.log('test-emby: ok');

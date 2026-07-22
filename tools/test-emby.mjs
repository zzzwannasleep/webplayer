// The Emby client is browser-facing (fetch, localStorage), but its two pure
// routing helpers decide correctness of the whole play handoff, so they get a
// node check. subtitleDelivery picks the render path; subtitleUrl builds the
// Emby extraction URL for the text path.
import assert from 'node:assert/strict';
import { EmbyClient, subtitleDelivery, reline, servers, serverIcons } from '../src/emby/client.js';

// --- subtitleDelivery: which path a chosen subtitle stream takes ------------
assert.equal(subtitleDelivery({ Codec: 'ass' }), 'client', 'embedded ASS renders in-browser');
assert.equal(subtitleDelivery({ Codec: 'ssa' }), 'client', 'embedded SSA renders in-browser');
assert.equal(subtitleDelivery({ Codec: 'PGSSUB' }), 'client', 'embedded PGS renders in-browser');
assert.equal(subtitleDelivery({ Codec: 'ass', IsExternal: true }), 'text',
  'external ASS has no in-browser path (fonts) — served as SRT text');
assert.equal(subtitleDelivery({ Codec: 'subrip' }), 'text', 'embedded SRT has no client renderer — served by Emby');
assert.equal(subtitleDelivery({ Codec: 'srt', IsExternal: true }), 'text', 'external SRT — browser <track>');
assert.equal(subtitleDelivery({ Codec: 'mov_text' }), 'text', 'embedded text — served by Emby');
assert.equal(subtitleDelivery({ Codec: 'pgssub', IsExternal: true }), 'unsupported',
  'external bitmap sub has no clean path');
assert.equal(subtitleDelivery({ Codec: 'vobsub', IsExternal: true }), 'unsupported', 'external VobSub unsupported');

// --- subtitleUrl: Emby subtitle extraction endpoint -------------------------
const c = new EmbyClient('https://emby.example/');   // trailing slash trimmed
c.token = 'TKN';
const u = new URL(c.subtitleUrl('item42', { Id: 'srcA' }, { Index: 3 }));
assert.equal(u.origin + u.pathname, 'https://emby.example/Videos/item42/srcA/Subtitles/3/Stream.srt');
assert.equal(u.searchParams.get('api_key'), 'TKN', 'token carried for a plain GET');

const v = new URL(c.subtitleUrl('item42', null, { Index: 0 }, 'vtt'));
assert.ok(v.pathname.endsWith('/Subtitles/0/Stream.vtt'), 'format override honoured');
assert.ok(v.pathname.includes('/Videos/item42/item42/'), 'falls back to itemId when source has no Id');

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

// --- serverIcons: server branding first, user avatar as the fallback --------
assert.deepEqual(serverIcons({ url: 'https://one.example', token: 'T', userId: 'U1' }), [
  'https://one.example/Branding/Splashscreen?api_key=T&maxWidth=96',
  'https://one.example/Users/U1/Images/Primary?api_key=T&maxWidth=96',
], 'branding image is tried before the avatar');
assert.equal(serverIcons({ url: 'https://one.example' }).length, 1, 'no user -> branding only');
assert.ok(serverIcons({ url: 'https://one.example', line: 'https://cdn.example' })[0].startsWith('https://cdn.example'),
  'icon is fetched over the line in use');
assert.deepEqual(serverIcons(null), [], 'no record -> nothing to try');

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

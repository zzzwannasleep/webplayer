// The Emby client is browser-facing (fetch, localStorage), but its two pure
// routing helpers decide correctness of the whole play handoff, so they get a
// node check. subtitleDelivery picks the render path; subtitleUrl builds the
// Emby extraction URL for the text path.
import assert from 'node:assert/strict';
import { EmbyClient, subtitleDelivery } from '../src/emby/client.js';

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

console.log('test-emby: ok');

// The danmaku overlay: a comment track flying over the picture, plus the client
// that goes looking for one.
//
// Rendering is weizhenye/danmaku (MIT, 9.8 kB, no dependencies), driven in its
// canvas engine -- a popular episode is several thousand comments and the DOM
// engine would mean several thousand animated nodes. The library owns collision
// avoidance and the clock (it reads media.currentTime, so seeking, pausing and
// playbackRate all just work); this file owns where the layer sits, how the
// comments are styled, and where they come from.
//
// Where they come from is the part with a hard limit. dandanplay's API sends no
// Access-Control-Allow-Origin and requires a signature computed from an AppSecret
// -- measured, not assumed: every /api/v2/* route answers 403 "Missing
// Authentication Headers" and no CORS header at all, and bilibili's comment XML
// likewise returns 200 to curl with no ACAO. A secret cannot live in a page
// anyone can View Source on, so a static site CANNOT talk to either directly.
// What it can talk to is a dandanplay-SHAPED endpoint the viewer runs (the
// self-hostable aggregators expose exactly these routes), which is why the base
// URL is a setting and not a constant. With no endpoint configured the feature
// still works entirely offline: drop in an XML/JSON dump and it is remembered.

import { parseAny, throttle, block } from './parse.js';

export { parseAny, parseBiliXml, parseDandan, throttle, block } from './parse.js';
export * from './store.js';

/** Comments -> what the canvas engine wants to draw, at this stage size. */
function styled(list, s, stageHeight) {
  // ASS-style: author the text for a 1080-tall frame and scale to the real one,
  // so the same setting looks the same windowed and fullscreen.
  const px = Math.max(10, Math.round(s.fontSize * (stageHeight || 1080) / 1080));
  const font = `${s.bold ? 'bold ' : ''}${px}px "PingFang SC","Microsoft YaHei",sans-serif`;
  return list.map(c => ({
    text: c.text,
    mode: c.mode,
    time: c.time,
    style: {
      font,
      fillStyle: c.color,
      strokeStyle: c.color === '#000000' ? '#ffffff' : '#000000',
      lineWidth: Math.max(2, px / 12),
      textAlign: 'start',
      textBaseline: 'bottom',
    },
  }));
}

export class DanmakuLayer {
  /**
   * @param video the <video> the comments are timed against
   * @param stage the positioned element the overlay is layered into
   */
  constructor(video, stage, { log = () => {} } = {}) {
    this.video = video;
    this.stage = stage;
    this.log = log;
    this.raw = [];            // parsed comments, before throttle/block
    this.name = '';           // where they came from, for the UI
    this.dm = null;           // the renderer, null when off or empty
    this.settings = null;
    this.box = document.createElement('div');
    this.box.className = 'dmk';
    // Below the subtitle canvases on purpose: subtitles are the thing you must
    // be able to read, comments are the thing you chose to add on top of it.
    this.box.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:2';
    stage.append(this.box);

    // The renderer is handed this instead of the <video>. It reads the same
    // three properties and binds the same events, but going through here keeps
    // a reference to its own `seeking` handler -- see apply(), which has to
    // call it. Registering on the real element as well means playback, pausing
    // and real seeks reach the renderer exactly as before.
    this._seekers = [];
    this.media = {
      get currentTime() { return video.currentTime; },
      get paused() { return video.paused; },
      get playbackRate() { return video.playbackRate; },
      addEventListener: (t, f) => { if (t === 'seeking') this._seekers.push(f); video.addEventListener(t, f); },
      removeEventListener: (t, f) => { this._seekers = this._seekers.filter(x => x !== f); video.removeEventListener(t, f); },
    };
    this._onResize = () => this.dm?.resize();
    addEventListener('resize', this._onResize);
    // Fullscreen changes the stage size without a window resize event.
    document.addEventListener('fullscreenchange', this._onResize);
  }

  get count() { return this.raw.length; }

  /** Replace the comment track. Pass [] to clear it. */
  setComments(list, name = '') {
    this.raw = Array.isArray(list) ? list : [];
    this.name = name;
    this.apply(this.settings);
  }

  /**
   * (Re)build the overlay for these settings. One path for every control, so a
   * changed font size and a changed blocklist cost the same and cannot drift.
   */
  apply(s) {
    this.settings = s;
    this.destroyRenderer();
    if (!s) return;
    this.box.style.opacity = String(s.opacity);
    this.box.style.height = `${Math.round(Math.min(1, Math.max(0.1, s.area)) * 100)}%`;
    if (!s.on || !this.raw.length) return;

    const list = throttle(block(this.raw, s.block), s.limit);
    this.dm = new Danmaku({
      container: this.box,
      media: this.media,
      engine: 'canvas',
      speed: s.speed,
      comments: styled(list, s, this.box.clientHeight || this.stage.clientHeight),
    });
    this.shown = list.length;

    // A renderer built while the media is PAUSED starts at comment 0: the
    // library only seeks to the playhead when it is constructed on a playing
    // element. Every settings change rebuilds, and settings are exactly what
    // you fiddle with while paused, so without this the whole episode's
    // backlog floods the screen the moment playback resumes.
    if (this.video.paused && this.video.currentTime > 0) for (const f of this._seekers) f();
  }

  destroyRenderer() {
    try { this.dm?.destroy(); } catch {}
    this.dm = null;
  }

  destroy() {
    this.destroyRenderer();
    removeEventListener('resize', this._onResize);
    document.removeEventListener('fullscreenchange', this._onResize);
    this.box.remove();
  }
}

// The renderer is loaded from vendor/ by the page, the same way JASSUB is, and
// parked on the module so the class above does not care how it got here.
let Danmaku = null;
export async function loadRenderer(vendor = 'vendor/') {
  if (Danmaku) return Danmaku;
  const url = new URL(`${vendor}danmaku.js`, document.baseURI).href;
  Danmaku = (await import(url)).default;
  return Danmaku;
}

// --- looking for a comment track --------------------------------------------

const trim = u => String(u || '').trim().replace(/\/+$/, '');

/**
 * A cross-origin failure never reaches JS as a status: the browser drops the
 * response for want of a CORS header and reports "Failed to fetch", so a wrong
 * URL, a dead host and a server that simply does not allow us look identical.
 * Say so, rather than inventing a cause.
 */
async function get(url) {
  let r;
  try { r = await fetch(url); }
  catch { throw new Error('连不上弹幕服务（地址错误、服务未启动，或该服务未放行跨域）'); }
  if (!r.ok) throw new Error(`弹幕服务返回 ${r.status}`);
  return r.json();
}

export const source = {
  /** Series name + episode number -> candidate episodes. */
  async episodes(api, anime, episode) {
    const base = trim(api);
    if (!base) throw new Error('未配置弹幕服务地址');
    const q = new URLSearchParams({ anime });
    if (episode) q.set('episode', String(episode));
    const j = await get(`${base}/api/v2/search/episodes?${q}`);
    const out = [];
    for (const a of j?.animes || [])
      for (const e of a.episodes || [])
        out.push({ id: e.episodeId, label: `${a.animeTitle} · ${e.episodeTitle}` });
    return out;
  },

  /** Comments for one episode id, already parsed into the neutral shape. */
  async comments(api, episodeId) {
    const base = trim(api);
    if (!base) throw new Error('未配置弹幕服务地址');
    const j = await get(`${base}/api/v2/comment/${encodeURIComponent(episodeId)}?withRelated=true&format=json`);
    return parseAny(JSON.stringify(j));
  },
};

/**
 * "S01E05" style hints out of what Emby told us, so the search box starts with
 * something usable instead of the raw display title.
 */
export function matchHint({ series, name, season, episode }) {
  return { anime: (series || name || '').trim(), episode: episode || 0, season: season || 0 };
}

// A thin, dependency-free Emby client. It does exactly what the browse UI needs
// and nothing more: authenticate, list the server's libraries and items, build
// image URLs without extra round-trips (from the ImageTags the item already
// carries), and resolve a DIRECT stream URL so the original container bytes go
// straight into LinWeb's existing HttpSource -> worker -> MSE pipeline. No
// transcode: the DeviceProfile below advertises "I can play everything", which
// is the whole point of this player.
//
// Auth is carried two ways on purpose: API calls use the X-Emby-Token header,
// but the video stream uses ?api_key= in the query string -- a browser cannot
// attach a custom header to a plain Range GET without a preflight, and the
// player fetches the file as a plain URL.
//
// CORS caveat: a browser page on another origin can only read an Emby server
// that returns Access-Control-Allow-Origin (and exposes Accept-Ranges /
// Content-Range). Self-hosters either enable that or put the extractor proxy in
// front; that is a deployment concern, not this module's.

const CLIENT = 'LinWeb';
const VERSION = '0.1.0';

function deviceId() {
  try {
    let id = localStorage.getItem('linweb:deviceId');
    if (!id) { id = (crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)); localStorage.setItem('linweb:deviceId', id); }
    return id;
  } catch { return 'linweb-' + (Date.now().toString(36)); }
}

// Tell Emby the client can direct-play the containers/codecs LinWeb actually
// hands to the browser. No TranscodingProfiles -> the server has no fallback but
// to give us the original file. maxStreamingBitrate is high so nothing is capped.
const DIRECT_PROFILE = {
  MaxStreamingBitrate: 400_000_000,
  MaxStaticBitrate: 400_000_000,
  DirectPlayProfiles: [
    { Type: 'Video', Container: 'mkv,webm,mp4,m4v,mov,ts,m2ts', VideoCodec: 'h264,hevc,hev1,vp8,vp9,av1', AudioCodec: 'aac,ac3,eac3,mp3,opus,flac,vorbis,dts,truehd,pcm' },
  ],
  // Deliberately empty: force DirectPlay/DirectStream, never transcode.
  TranscodingProfiles: [],
  ContainerProfiles: [],
  CodecProfiles: [],
  SubtitleProfiles: [
    { Format: 'ass', Method: 'Embed' }, { Format: 'ssa', Method: 'Embed' },
    { Format: 'pgssub', Method: 'Embed' }, { Format: 'srt', Method: 'Embed' },
  ],
};

export class EmbyClient {
  constructor(server) {
    this.server = server ? server.replace(/\/+$/, '') : '';
    this.token = null;
    this.userId = null;
    this.userName = null;
    this.deviceId = deviceId();
  }

  // ---- session persistence -------------------------------------------------
  static restore() {
    try {
      const s = JSON.parse(localStorage.getItem('linweb:emby') || 'null');
      if (!s?.server || !s?.token) return null;
      const c = new EmbyClient(s.server);
      c.token = s.token; c.userId = s.userId; c.userName = s.userName;
      return c;
    } catch { return null; }
  }
  _persist() {
    try { localStorage.setItem('linweb:emby', JSON.stringify({ server: this.server, token: this.token, userId: this.userId, userName: this.userName })); } catch {}
  }
  logout() {
    this.token = this.userId = this.userName = null;
    try { localStorage.removeItem('linweb:emby'); } catch {}
  }

  // ---- low-level -----------------------------------------------------------
  // CORS-critical: use the STANDARD `Authorization` header, never the Emby-
  // specific X-Emby-Authorization / X-Emby-Token. A cross-origin Emby (verified
  // on smart.uhdnow.com) only allow-lists `Authorization` in its CORS preflight
  // (Access-Control-Allow-Headers: Content-Type, Authorization, ...), so any
  // X-Emby-* header makes the browser block the request as "not allowed". Emby
  // accepts the same `MediaBrowser Client=...` credential string in either
  // header. The access token rides both here (Token="...") and as ?api_key=
  // (added in _url) so simple GETs work without any custom header at all.
  _authHeader() {
    return `MediaBrowser Client="${CLIENT}", Device="Browser", DeviceId="${this.deviceId}", Version="${VERSION}"`
      + (this.token ? `, Token="${this.token}"` : '');
  }
  _headers(json) {
    const h = { 'Authorization': this._authHeader() };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }
  _url(path, params) {
    const u = new URL(this.server + path);
    if (params) for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    if (this.token && !u.searchParams.has('api_key')) u.searchParams.set('api_key', this.token);
    return u.toString();
  }
  async _get(path, params) {
    const r = await fetch(this._url(path, params), { headers: this._headers() });
    if (!r.ok) throw new Error(`Emby ${r.status} ${path}`);
    return r.json();
  }
  async _post(path, body, params) {
    const r = await fetch(this._url(path, params), { method: 'POST', headers: this._headers(true), body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`Emby ${r.status} ${path}`);
    return r.status === 204 ? null : r.json().catch(() => null);
  }

  // ---- auth ----------------------------------------------------------------
  async login(username, password) {
    const r = await fetch(this._url('/Users/AuthenticateByName'), {
      method: 'POST', headers: this._headers(true),
      body: JSON.stringify({ Username: username, Pw: password ?? '' }),
    });
    if (r.status === 401) throw new Error('用户名或密码错误');
    if (!r.ok) throw new Error(`登录失败 (${r.status})`);
    const data = await r.json();
    this.token = data.AccessToken;
    this.userId = data.User?.Id;
    this.userName = data.User?.Name;
    this._persist();
    return data.User;
  }
  publicUsers() { return this._get('/Users/Public').catch(() => []); }

  // ---- library / browse ----------------------------------------------------
  // One Fields set for everything so a list never needs a follow-up call per item.
  static FIELDS = 'PrimaryImageAspectRatio,Overview,Genres,ProductionYear,CommunityRating,OfficialRating,RunTimeTicks,MediaSources,People';

  views() { return this._get(`/Users/${this.userId}/Views`).then(r => r.Items || []); }

  items(opts = {}) {
    return this._get(`/Users/${this.userId}/Items`, {
      ParentId: opts.parentId, IncludeItemTypes: opts.types, Recursive: opts.recursive ?? true,
      SortBy: opts.sortBy || 'SortName', SortOrder: opts.sortOrder || 'Ascending',
      Fields: opts.fields || EmbyClient.FIELDS, StartIndex: opts.start, Limit: opts.limit,
      Filters: opts.filters, Genres: opts.genre, SearchTerm: opts.search,
    }).then(r => r.Items || []);
  }
  item(id) { return this._get(`/Users/${this.userId}/Items/${id}`, { Fields: EmbyClient.FIELDS }); }

  resume() {
    return this._get(`/Users/${this.userId}/Items`, {
      Filters: 'IsResumable', Recursive: true, SortBy: 'DatePlayed', SortOrder: 'Descending',
      IncludeItemTypes: 'Movie,Episode', Fields: EmbyClient.FIELDS, Limit: 24,
    }).then(r => r.Items || []);
  }
  latest(parentId, limit = 20) {
    return this._get(`/Users/${this.userId}/Items/Latest`, { ParentId: parentId, Limit: limit, Fields: EmbyClient.FIELDS });
  }
  nextUp(limit = 20) {
    return this._get('/Shows/NextUp', { UserId: this.userId, Limit: limit, Fields: EmbyClient.FIELDS }).then(r => r.Items || []).catch(() => []);
  }
  seasons(seriesId) { return this._get(`/Shows/${seriesId}/Seasons`, { UserId: this.userId, Fields: EmbyClient.FIELDS }).then(r => r.Items || []); }
  episodes(seriesId, seasonId) { return this._get(`/Shows/${seriesId}/Episodes`, { UserId: this.userId, SeasonId: seasonId, Fields: EmbyClient.FIELDS }).then(r => r.Items || []); }
  search(term, limit = 40) { return this.items({ search: term, recursive: true, types: 'Movie,Series,Episode,Person', limit }); }

  // ---- images (no extra request: tags come on the item) --------------------
  imageUrl(item, type = 'Primary', { maxWidth = 400, maxHeight, quality = 90 } = {}) {
    if (!item) return null;
    const id = type === 'Primary' && item.Type === 'Episode' && item.SeriesPrimaryImageTag ? item.SeriesId : item.Id;
    const tag = type === 'Primary'
      ? (item.ImageTags?.Primary || (item.Type === 'Episode' ? item.SeriesPrimaryImageTag : null))
      : (item.BackdropImageTags?.[0] || item.ImageTags?.[type]);
    if (!tag) return null;
    const p = new URLSearchParams({ tag, quality: String(quality), maxWidth: String(maxWidth) });
    if (maxHeight) p.set('maxHeight', String(maxHeight));
    if (this.token) p.set('api_key', this.token);
    return `${this.server}/Items/${id}/Images/${type}?${p}`;
  }
  backdropUrl(item, opts) {
    if (!item) return null;
    const tag = item.BackdropImageTags?.[0] || item.ParentBackdropImageTags?.[0];
    const id = item.BackdropImageTags?.[0] ? item.Id : (item.ParentBackdropItemId || item.Id);
    if (!tag) return this.imageUrl(item, 'Primary', { maxWidth: 1280 });
    const p = new URLSearchParams({ tag, quality: '85', maxWidth: String(opts?.maxWidth || 1280) });
    if (this.token) p.set('api_key', this.token);
    return `${this.server}/Items/${id}/Images/Backdrop?${p}`;
  }

  // ---- playback ------------------------------------------------------------
  // Ask the server how it will serve this item; with the empty-transcode profile
  // above it can only answer with a direct source. Returns { source, url,
  // playSessionId } ready to hand to the player.
  async playbackInfo(itemId) {
    const data = await this._post(`/Items/${itemId}/PlaybackInfo`, {
      UserId: this.userId, DeviceProfile: DIRECT_PROFILE, MaxStreamingBitrate: 400_000_000,
      AutoOpenLiveStream: true,
    }, { UserId: this.userId });
    const source = data?.MediaSources?.[0];
    if (!source) throw new Error('该条目没有可用的媒体源');
    return { source, sources: data.MediaSources, playSessionId: data.PlaySessionId, url: this.streamUrl(itemId, source) };
  }
  // The untouched original file. Static=true guarantees no server-side remux.
  streamUrl(itemId, source) {
    const container = source?.Container ? '.' + source.Container.split(',')[0] : '';
    const p = new URLSearchParams({ Static: 'true', mediaSourceId: source?.Id || itemId });
    if (source?.ETag) p.set('Tag', source.ETag);
    if (this.token) p.set('api_key', this.token);
    return `${this.server}/Videos/${itemId}/stream${container}?${p}`;
  }

  // ---- progress (best-effort: never let a report break playback) -----------
  reportStart(itemId, source, playSessionId) {
    return this._post('/Sessions/Playing', { ItemId: itemId, MediaSourceId: source?.Id, PlaySessionId: playSessionId, PlayMethod: 'DirectStream', CanSeek: true }).catch(() => {});
  }
  reportProgress(itemId, source, playSessionId, positionSec, paused) {
    return this._post('/Sessions/Playing/Progress', { ItemId: itemId, MediaSourceId: source?.Id, PlaySessionId: playSessionId, PositionTicks: Math.round(positionSec * 1e7), IsPaused: !!paused, PlayMethod: 'DirectStream', EventName: 'TimeUpdate' }).catch(() => {});
  }
  reportStopped(itemId, source, playSessionId, positionSec) {
    return this._post('/Sessions/Playing/Stopped', { ItemId: itemId, MediaSourceId: source?.Id, PlaySessionId: playSessionId, PositionTicks: Math.round(positionSec * 1e7) }).catch(() => {});
  }
}

// ---- small shared helpers the UI needs -------------------------------------
export const ticksToSec = t => (t || 0) / 1e7;
export const fmtRuntime = ticks => {
  const s = ticksToSec(ticks); if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};
export const progressOf = item => {
  const pct = item?.UserData?.PlayedPercentage;
  if (pct) return pct / 100;
  const pos = item?.UserData?.PlaybackPositionTicks, run = item?.RunTimeTicks;
  return pos && run ? pos / run : 0;
};

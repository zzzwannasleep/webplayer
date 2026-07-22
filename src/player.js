// MSE playback controller.
//
// The heavy work -- reading the file, demuxing Matroska, remuxing to fMP4 --
// runs in src/player.worker.js, off the main thread, so a 4K remux burst can no
// longer stall compositing or the audio clock. This file keeps only what has to
// live on the main thread: the MediaSource and its SourceBuffers, the software
// audio transcoder (it drives the browser's AudioEncoder, main-thread only), and
// the glue that forwards playhead/seek to the worker and appends what it sends
// back. The public API is unchanged from the old single-thread Player.
import { buildRemuxer, audioNote } from './remux/tracks.js';
import { SoftwareAudioDecoder, RAW_FORMATS } from './audio/decode.js';
import { AudioTranscoder, describeError } from './audio/transcode.js';

const KEEP_BEHIND = 12;           // seconds retained behind the playhead before eviction

/**
 * Serialises appendBuffer calls (MSE allows only one in flight) and recovers
 * from a full SourceBuffer by evicting already-played media.
 */
class BufferQueue {
  constructor(sb, video, ms, log) {
    this.sb = sb; this.video = video; this.ms = ms; this.log = log;
    this.q = []; this.backlog = 0; this.evictions = 0;
    sb.addEventListener('updateend', () => this._pump());
  }
  push(data) { this.q.push(data); this.backlog += data.length; this._pump(); }
  _pump() {
    if (!this.q.length || this.sb.updating || this.ms.readyState !== 'open') return;
    const data = this.q[0];
    try {
      this.sb.appendBuffer(data);
      this.q.shift(); this.backlog -= data.length;
    } catch (e) {
      if (e.name === 'QuotaExceededError') { this._evict(); return; }
      this.q.shift(); this.backlog -= data.length;
      this.log(`append failed (${e.name}): ${e.message}`, 'error');
    }
  }
  _evict() {
    const b = this.sb.buffered;
    if (!b.length) { this.q.shift(); this.log('quota exceeded with empty buffer; dropping fragment', 'error'); return; }
    const start = b.start(0);
    const cutoff = this.video.currentTime - KEEP_BEHIND;
    if (cutoff - start < 1) { setTimeout(() => this._pump(), 300); return; }
    this.evictions++;
    try { this.sb.remove(start, cutoff); } catch { setTimeout(() => this._pump(), 300); }
  }
  clear() { this.q.length = 0; this.backlog = 0; }
  get idle() { return !this.q.length && !this.sb.updating; }
}

export class Player {
  constructor(video) {
    this.video = video;
    this.info = null;
    this.log = () => {};
    this.onSubtitlePacket = null;

    this.mediaSource = null;
    this.streams = [];            // { track, mime, kind, sb, queue }
    this.transcoder = null;
    this.audioDecoder = null;
    this.softwareAudio = true;
    this._subs = new Map();       // track number -> entry
    this._fonts = [];
    this._worker = null;
    this._pending = null;         // { resolve, reject } for the in-flight open/play
    this._objectUrl = null;
  }

  _spawn() {
    if (this._worker) return;
    this._worker = new Worker(new URL('./player.worker.js', import.meta.url), { type: 'module' });
    this._worker.onmessage = (e) => this._onWorker(e.data);
    this._worker.onerror = (e) => this.log(`worker crashed: ${e.message}`, 'error');
  }

  _post(msg, transfer) { this._worker?.postMessage(msg, transfer || []); }

  async load(input) {
    this._spawn();
    // Switching files: tear down the previous MediaSource/streams first, so a
    // rapid load(B) after load(A)/play(A) does not leave the old pipeline
    // appending into a half-gone MediaSource.
    if (this.mediaSource) await this._teardown();
    const info = await new Promise((resolve, reject) => {
      this._pending = { resolve, reject, op: 'open' };
      this._post({ type: 'open', input });
    });
    // Only the main thread has MediaSource.isTypeSupported, so the playability
    // verdict is filled in here rather than in the worker.
    for (const v of info.video) v.supported = v.mime ? MediaSource.isTypeSupported(v.mime) : false;
    for (const a of info.audio) {
      a.supported = a.mime ? MediaSource.isTypeSupported(a.mime) : false;
      if (a.supported) a.note = null;
    }
    this._fonts = (info._fontData ?? []).map(f => ({ name: f.name, mime: f.mime, data: f.data }));
    this.info = info;
    return info;
  }

  /** Start playback with the chosen video/audio track indices. */
  async play({ videoIndex = 0, audioIndex = 0 } = {}) {
    await this._teardown();

    const v = this.info.video[videoIndex];
    const a = this.info.audio[audioIndex];
    let videoTrack = null, audioTrack = null, transcodeTrack = null;
    if (v?.supported) videoTrack = v.track.number;
    else if (v) this.log(`video track unplayable via MSE (${v.mime}) — no repackaging path`, 'error');

    if (a?.supported) audioTrack = a.track.number;
    else if (a && RAW_FORMATS[a.track.codecId] && this.softwareAudio !== false) transcodeTrack = a.track;
    else if (a) this.log(`audio "${a.label}" needs a software decoder that is unavailable — playing without audio`, 'warn');

    if (videoTrack == null) throw new Error('nothing playable in this file');

    // A tiny file can reach EOF in the worker before _startTranscode has added
    // the opus SourceBuffer; endOfStream() then closes the MediaSource and the
    // addSourceBuffer fails. Hold off ending until the audio pipeline is built.
    this._audioSetupDone = !transcodeTrack;
    this._eofSeen = false;

    const ms = this.mediaSource = new MediaSource();
    this._objectUrl = URL.createObjectURL(ms);
    this.video.src = this._objectUrl;
    this.video.load();
    await this._awaitSourceOpen(ms);
    this.log(`MediaSource open (readyState=${ms.readyState})`);
    ms.addEventListener('sourceclose', () => this.log('MediaSource CLOSED', 'warn'));
    if (Number.isFinite(this.info.duration) && this.info.duration > 0) ms.duration = this.info.duration;

    // The worker streams init segments + fragments once told to play; the
    // handlers below wire each init into a SourceBuffer. The video (and any
    // native audio) SourceBuffers MUST be added before the transcode one:
    // Chromium caps the SourceBuffer count and rejects a second video/audio SB
    // added after appends to the first have begun, so order matters.
    this._playReady = new Promise((resolve, reject) => { this._pending = { resolve, reject, op: 'play' }; });
    this._expectInit = [videoTrack, audioTrack].filter(x => x != null).length;
    this._post({ type: 'play', video: videoTrack, audio: audioTrack, transcode: transcodeTrack?.number ?? null });

    this.video.addEventListener('timeupdate', this._onTick);
    this.video.addEventListener('waiting', this._onTick);
    this.video.addEventListener('seeking', this._onSeek);
    await this._playReady;   // video (+ native audio) SourceBuffers now exist

    // The transcode SourceBuffer is added last. Blocks the worker forwards
    // before this is ready are dropped (a fraction of a second at the very
    // start); the transcoder keys off source timestamps so it stays in sync.
    if (transcodeTrack) {
      try { await this._startTranscode(transcodeTrack, ms); }
      catch (e) { this.log(`software audio unavailable (${describeError(e)}) — playing without audio`, 'warn'); this.transcoder = null; }
    }
    this._audioSetupDone = true;
    if (this._eofSeen) { this.transcoder?.flush(); this._maybeEnd('audio setup complete after eof'); }
  }

  _onTick = () => { if (this.mediaSource) this._post({ type: 'time', currentTime: this.video.currentTime }); };
  _onSeek = () => {
    if (!this.mediaSource) return;
    // Already buffered? Let the browser handle it, no worker round trip.
    const b = this.video.buffered, t = this.video.currentTime;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) && t < b.end(i) - 0.5) return;
    this._post({ type: 'seek', seconds: t });
  };

  _onWorker(m) {
    switch (m.type) {
      case 'info': this._pending?.op === 'open' && this._pending.resolve(m.info); this._pending = null; break;
      case 'init': this._addSource(m.track, m.mime, m.data); break;
      case 'fragment': { const s = this.streams.find(x => x.track === m.track); s?.queue.push(new Uint8Array(m.data)); break; }
      case 'audioBlock': this.transcoder?.push({ time: m.time, data: new Uint8Array(m.data) }); this.transcoder?.emitPending?.(); break;
      case 'subtitle': this._emitSubtitle(m); break;
      case 'flush': this._onFlush(); break;
      case 'eof': this._eofSeen = true; this.transcoder?.flush(); this._maybeEnd('worker reached end'); break;
      case 'log': this.log(m.msg, m.level); break;
      case 'error': this._pending?.reject(new Error(m.message)); this._pending = null; break;
    }
  }

  _addSource(track, mime, data) {
    if (this.mediaSource?.readyState !== 'open') return;
    let sb;
    try {
      sb = this.mediaSource.addSourceBuffer(mime);
    } catch (e) {
      this.log(`addSourceBuffer("${mime}") failed: ${e.name} ${e.message}`, 'error');
      return;
    }
    sb.mode = 'segments';
    const kind = mime.startsWith('video') ? 'video' : 'audio';
    const queue = new BufferQueue(sb, this.video, this.mediaSource, (msg, lvl) => this.log(`${mime}: ${msg}`, lvl));
    queue.push(new Uint8Array(data));
    this.streams.push({ track, mime, kind, sb, queue });
    this.log(`SourceBuffer ${mime}`);
    if (this.streams.length >= this._expectInit && this._pending?.op === 'play') { this._pending.resolve(); this._pending = null; }
  }

  _onFlush() {
    // A worker seek restarts the timeline; drop queued fragments and the buffered
    // island around the old position so the new fragments are not rejected.
    for (const s of this.streams) {
      s.queue.clear();
      const b = Player._ranges(s.sb);
      if (b?.length) { try { s.sb.remove(b.start(0), b.end(b.length - 1)); } catch {} }
    }
    if (this.transcoder) { this.transcoder.reset(); this.transcoder.queue?.clear(); }
  }

  async _startTranscode(track, ms) {
    if (!window.AudioEncoder) throw new Error('no AudioEncoder in this browser');
    this.audioDecoder ??= new SoftwareAudioDecoder({ log: (msg, l) => this.log(msg, l) });
    let queue = null;
    const tc = new AudioTranscoder(track, this.audioDecoder, this.info.duration, {
      log: (msg, l) => this.log(msg, l),
      onFragment: (frag) => queue?.push(frag),
    });
    if (!MediaSource.isTypeSupported(tc.mime)) throw new Error(`${tc.mime} rejected by MSE`);
    const sb = ms.addSourceBuffer(tc.mime);
    sb.mode = 'segments';
    queue = new BufferQueue(sb, this.video, ms, (msg, lvl) => this.log(`transcoded audio: ${msg}`, lvl));
    queue.push(tc.initSegment());
    tc.queue = queue; tc.sb = sb;
    this.transcoder = tc;
    this.log(`software audio: ${track.codecId} -> ${tc.mime}`);
  }

  static _ranges(sb) { try { return sb.buffered; } catch { return null; } }

  _awaitSourceOpen(ms, visibleTimeout = 10000) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const NET = ['EMPTY', 'IDLE', 'LOADING', 'NO_SOURCE'];
      const finish = fn => { clearTimeout(timer); document.removeEventListener('visibilitychange', arm); fn(); };
      const arm = () => {
        clearTimeout(timer);
        if (document.hidden) { this.log('waiting for the tab to become visible before attaching media'); return; }
        timer = setTimeout(() => finish(() => reject(new Error(
          `sourceopen never fired (${visibleTimeout / 1000}s): ms=${ms.readyState} `
          + `networkState=${NET[this.video.networkState]} readyState=${this.video.readyState}`))), visibleTimeout);
      };
      ms.addEventListener('sourceopen', () => finish(resolve), { once: true });
      document.addEventListener('visibilitychange', arm);
      arm();
    });
  }

  _maybeEnd(why) {
    if (!this._audioSetupDone) return;   // audio SourceBuffer still being added
    const audioBusy = this.transcoder && (!this.transcoder.queue?.idle || this.transcoder._busy || this.transcoder._queue?.length);
    if (this.mediaSource?.readyState === 'open' && !audioBusy && this.streams.every(s => s.queue.idle)) {
      this.log(`endOfStream() <- ${why}`, 'warn');
      try { this.mediaSource.endOfStream(); } catch {}
    }
  }

  // --- subtitles (renderers live on the main thread) -----------------------

  enableSubtitle(index) {
    const entry = this.info?.subtitles?.[index];
    if (!entry) throw new Error(`no subtitle track at index ${index}`);
    this._subs.set(entry.track.number, entry);
    this.log(`subtitles on: ${entry.label}`);
    this._post({ type: 'sub', track: entry.track.number, on: true });   // worker backfills the buffered region
    return entry;
  }
  disableSubtitle(index) {
    const entry = this.info?.subtitles?.[index];
    if (entry) { this._subs.delete(entry.track.number); this._post({ type: 'sub', track: entry.track.number, on: false }); }
  }
  _emitSubtitle(m) {
    const entry = this._subs.get(m.track);
    if (entry && this.onSubtitlePacket) this.onSubtitlePacket({ time: m.time, duration: m.duration, data: new Uint8Array(m.data), track: m.track }, entry);
  }

  fontAttachments() { return this._fonts; }

  dispose() { return this._teardown(); }

  async _teardown() {
    this.video.removeEventListener('timeupdate', this._onTick);
    this.video.removeEventListener('waiting', this._onTick);
    this.video.removeEventListener('seeking', this._onSeek);
    this._post({ type: 'dispose' });
    // Explicitly remove every SourceBuffer before dropping the MediaSource.
    // Nulling the reference alone leaves the SourceBuffers (and their decoders)
    // alive until GC, and Chromium caps how many can exist -- playing a series
    // of files then hits "reached the limit of SourceBuffer objects".
    const ms = this.mediaSource;
    if (ms) {
      const drop = (sb) => { if (!sb) return; try { if (sb.updating) sb.abort(); } catch {} try { ms.removeSourceBuffer(sb); } catch {} };
      for (const s of this.streams) drop(s.sb);
      drop(this.transcoder?.sb);
    }
    this.streams = [];
    if (this.transcoder) { await this.transcoder.destroy?.().catch?.(() => {}); this.transcoder = null; }
    if (ms?.readyState === 'open') { try { ms.endOfStream(); } catch {} }
    this.mediaSource = null;
    if (this.video.src) { URL.revokeObjectURL(this.video.src); this.video.removeAttribute('src'); this.video.load(); }
  }
}

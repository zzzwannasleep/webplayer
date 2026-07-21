// MSE playback engine.
//
// Video and audio go into separate SourceBuffers as fMP4. Nothing is decoded
// in JS, so the browser keeps hardware decode, HDR passthrough, PiP, fullscreen
// and casting -- all of which a WebCodecs+canvas pipeline throws away.
import { MatroskaDemuxer, FileSource, HttpSource, TRACK_VIDEO, TRACK_AUDIO, TRACK_SUBTITLE } from './demux/matroska.js';
import { buildRemuxer, SUBTITLE_CODECS, audioNote } from './remux/tracks.js';
import { colourFromTrack, isHdr, parseHvcC, scanAccessUnit, TRANSFER_NAMES, PRIMARY_NAMES } from './demux/hevc.js';
import { parseVp9Keyframe } from './demux/vp9.js';

const BUFFER_AHEAD = 20;          // seconds of media to keep ahead of the playhead
const KEEP_BEHIND = 12;           // seconds retained behind it before eviction
const READ_CHUNK = 2 << 20;       // cluster payload consumed per demux pass
const MAX_QUEUE_BYTES = 12 << 20; // cap on bytes waiting to be appended

/**
 * Serialises appendBuffer calls (MSE allows only one in flight) and recovers
 * from a full SourceBuffer.
 *
 * Quota is not a tuning problem: a two-hour 4K stream cannot fit in a
 * SourceBuffer at any buffer-ahead setting, so the queue must be able to evict
 * already-played media and retry. The pending item is peeked, not shifted,
 * so a rejected append is retried rather than silently dropped -- dropping it
 * would punch a hole in the timeline and stall playback.
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
      this.q.shift();
      this.backlog -= data.length;
    } catch (e) {
      if (e.name === 'QuotaExceededError') { this._evict(); return; }
      this.q.shift();
      this.backlog -= data.length;
      this.log(`append failed (${e.name}): ${e.message}`, 'error');
    }
  }

  /** Drop everything more than KEEP_BEHIND seconds behind the playhead. */
  _evict() {
    const b = this.sb.buffered;
    if (!b.length) { this.q.shift(); this.log('quota exceeded with empty buffer; dropping fragment', 'error'); return; }
    const start = b.start(0);
    const cutoff = this.video.currentTime - KEEP_BEHIND;
    if (cutoff - start < 1) {
      // Nothing safe to remove yet -- the playhead has not moved far enough.
      // Retry shortly instead of dropping data.
      setTimeout(() => this._pump(), 300);
      return;
    }
    this.evictions++;
    try { this.sb.remove(start, cutoff); }        // updateend re-enters _pump
    catch { setTimeout(() => this._pump(), 300); }
  }

  get idle() { return !this.q.length && !this.sb.updating; }
}

export class Player {
  constructor(video) {
    this.video = video;
    this.demuxer = null;
    this.mediaSource = null;
    this.streams = [];        // { track, remuxer, sb, queue }
    this.subtitleTracks = [];
    this.attachments = [];
    this._subs = new Map();   // track number -> { track, onPacket }
    /** Called with (packet, track) for every packet of an enabled subtitle track. */
    this.onSubtitlePacket = null;
    this.info = null;
    this.log = () => {};
    this._readPos = 0;
    this._filling = false;
    this._eof = false;
    this._alive = false;
    this._generation = 0;
  }

  async load(input) {
    const source = typeof input === 'string' ? await new HttpSource(input).open() : new FileSource(input);
    this.demuxer = await new MatroskaDemuxer(source).parseHeader();
    this.info = await this._describe();
    return this.info;
  }

  /** Human-readable summary of what is in the file, plus playability verdict. */
  async _describe() {
    const dx = this.demuxer;
    const out = { name: dx.src.name, duration: dx.duration, size: dx.src.size,
                  video: [], audio: [], subtitles: [], attachments: dx.attachments.length,
                  fonts: 0, hdr: null, dolbyVision: null, dynamicHdr: null,
                  hdr10plus: false, hdrVivid: false, mastering: null, cll: null };

    // VP9 has to be probed before any remuxer is built: Matroska stores no
    // CodecPrivate for it, so profile and bit depth exist only in a keyframe.
    for (const t of dx.tracks) {
      if (t.codecId === 'V_VP9' && !t.vp9) t.vp9 = await this._probeVp9(t);
    }

    for (const t of dx.tracks) {
      if (t.type === TRACK_VIDEO) {
        const colour = colourFromTrack(t);
        const rx = buildRemuxer(t, dx.duration);
        const supported = rx ? MediaSource.isTypeSupported(rx.mime) : false;
        out.video.push({ track: t, colour, mime: rx?.mime, supported,
                         label: `${t.video.width}x${t.video.height} ${t.codecId.split('/').pop()}` });
        if (isHdr(colour)) {
          out.hdr = { transfer: TRANSFER_NAMES[colour.transfer] ?? colour.transfer,
                      primaries: PRIMARY_NAMES[colour.primaries] ?? colour.primaries,
                      bitDepth: colour.bitDepth };
        }
      } else if (t.type === TRACK_AUDIO) {
        const rx = buildRemuxer(t, dx.duration);
        const supported = rx ? MediaSource.isTypeSupported(rx.mime) : false;
        out.audio.push({ track: t, mime: rx?.mime, supported,
                         note: supported ? null : audioNote(t, t.audio.channels),
                         label: `${t.codecId.replace('A_', '')} ${t.audio.channels}ch ${Math.round(t.audio.sampleRate / 1000)}kHz`
                                + (t.name ? ` · ${t.name}` : '') + ` [${t.language}]` });
      } else if (t.type === TRACK_SUBTITLE) {
        out.subtitles.push({ track: t, format: SUBTITLE_CODECS[t.codecId] ?? t.codecId,
                             label: `${SUBTITLE_CODECS[t.codecId] ?? t.codecId}${t.name ? ` · ${t.name}` : ''} [${t.language}]` });
      }
    }

    out.fonts = dx.attachments.filter(f => /font|sfnt/i.test(f.mime) || /\.(ttf|otf|ttc)$/i.test(f.name)).length;

    // Everything below comes from the bitstream, not the container: dynamic
    // range metadata, Dolby Vision, HDR10+ and HDR Vivid all live in the access
    // units. One scan collects the lot -- the alternative is several passes
    // over the same 2 MB.
    const v = out.video[0]?.track;
    if (v?.codecId === 'V_MPEGH/ISO/HEVC') {
      const lenSize = (parseHvcC(v.codecPrivate)?.lengthSizeMinusOne ?? 3) + 1;
      let rpu = false, el = false, n = 0;
      for await (const b of dx.readBlocks(await dx.seekTo(0, v.number), 2 << 20)) {
        if (b.track !== v.number) continue;
        const r = scanAccessUnit(b.data, lenSize);
        rpu ||= r.rpu; el ||= r.el;
        out.hdr10plus ||= r.hdr10plus;
        out.hdrVivid ||= r.hdrVivid;
        // Stored on the track so buildRemuxer writes mdcv/clli into the MP4.
        v.mastering ??= r.mastering;
        v.cll ??= r.cll;
        if (++n > 30) break;
      }
      out.mastering = v.mastering ?? null;
      out.cll = v.cll ?? null;
      if (out.hdr10plus) {
        out.dynamicHdr = {
          format: 'HDR10+ (SMPTE ST 2094-40)',
          // The browser has no HDR10+ tone-mapping path, and the metadata is
          // per-frame -- there is nowhere to put it. Saying so beats implying
          // the extra dynamic range is being used.
          note: 'Detected and preserved in the stream, but Chromium tone-maps from the static HDR10 metadata only.',
        };
      } else if (out.hdrVivid) {
        out.dynamicHdr = {
          format: 'HDR Vivid / CUVA (T/UWA 005)',
          note: 'Detected. No browser implements CUVA tone-mapping; the base layer plays as HDR10.',
        };
      }
      if (rpu) {
        out.dolbyVision = {
          el,
          // A single-layer DV stream whose base layer is already HDR10 is
          // profile 8.1: dropping the RPU yields a correct HDR10 picture,
          // which is exactly what handing hvc1 to MSE does.
          profile: el ? '7 (dual layer)' : '8.x (single layer)',
          playable: !el,
          note: el
            ? 'Dual-layer: the enhancement layer cannot be decoded in a browser; base layer plays as HDR10.'
            : 'Single layer with an HDR10-compatible base layer — plays as HDR10 with the RPU ignored.',
        };
      }
    }
    return out;
  }

  /** Read profile and bit depth out of the first VP9 keyframe. */
  async _probeVp9(track) {
    let n = 0;
    for await (const b of this.demuxer.readBlocks(await this.demuxer.seekTo(0, track.number), 2 << 20)) {
      if (b.track !== track.number) continue;
      const cfg = parseVp9Keyframe(b.data);
      if (cfg) return cfg;
      if (++n > 60) break;   // a keyframe this far in means something is wrong
    }
    this.log(`VP9 track ${track.number}: no keyframe header found — cannot determine profile`, 'warn');
    return null;
  }

  /** Start playback with the chosen video/audio track indices. */
  async play({ videoIndex = 0, audioIndex = 0 } = {}) {
    const dx = this.demuxer;
    this._generation++;
    await this._teardown();

    const chosen = [];
    const v = this.info.video[videoIndex];
    if (v?.supported) chosen.push(v.track);
    else if (v) this.log(`video track unplayable via MSE (${v.mime}) — no repackaging path`, 'error');

    const a = this.info.audio[audioIndex];
    if (a?.supported) chosen.push(a.track);
    else if (a) {
      // E-AC3 lands here on Chromium: MSE and WebCodecs both refuse it, so the
      // only route is a software decoder feeding WebAudio. Not wired up yet —
      // play video rather than failing the whole file.
      this.log(`audio "${a.label}" not supported by MSE (${a.mime}) — playing without audio`, 'warn');
    }
    if (!chosen.length) throw new Error('nothing playable in this file');

    const ms = this.mediaSource = new MediaSource();
    this._objectUrl = URL.createObjectURL(ms);
    this.video.src = this._objectUrl;
    this.video.load();   // some paths leave the element in NETWORK_EMPTY otherwise
    await this._awaitSourceOpen(ms);
    this.log(`MediaSource open (readyState=${ms.readyState})`);
    ms.addEventListener('sourceclose', () => this.log('MediaSource CLOSED', 'warn'));
    ms.addEventListener('sourceended', () => this.log('MediaSource ended'));
    if (Number.isFinite(dx.duration) && dx.duration > 0) ms.duration = dx.duration;

    for (const track of chosen) {
      const remuxer = buildRemuxer(track, dx.duration);
      const sb = ms.addSourceBuffer(remuxer.mime);
      sb.mode = 'segments';
      const queue = new BufferQueue(sb, this.video, ms,
        (msg, lvl) => this.log(`${remuxer.mime}: ${msg}`, lvl));
      queue.push(remuxer.initSegment());
      this.streams.push({ track, remuxer, sb, queue });
      this.log(`SourceBuffer ${remuxer.mime}`);
    }

    this._readPos = await dx.seekTo(0, chosen[0].number);
    this._eof = false;
    this._alive = true;
    this.video.addEventListener('seeking', this._onSeek);
    this.video.addEventListener('timeupdate', this._onTick);
    // 'waiting' is the safety net: if the buffer runs dry for any reason,
    // timeupdate stops firing and only this wakes the fill loop back up.
    this.video.addEventListener('waiting', this._onTick);
    this.video.addEventListener('seeked', this._onTick);
    await this._fill();
  }

  /**
   * Wait for the MediaSource to attach.
   *
   * Chromium defers media element resource loading while the document is
   * hidden, so in a background tab the blob URL never attaches and the source
   * stays "closed" with networkState stuck at LOADING. That is not an error --
   * it resolves the moment the tab becomes visible -- so the timeout only runs
   * while visible, and is re-armed on visibilitychange. Failing here instead
   * would break playback for anyone who hits play and switches tabs.
   */
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
          + `networkState=${NET[this.video.networkState]} readyState=${this.video.readyState} `
          + `err=${this.video.error ? this.video.error.code : 'none'}`))), visibleTimeout);
      };
      ms.addEventListener('sourceopen', () => finish(resolve), { once: true });
      document.addEventListener('visibilitychange', arm);
      arm();
    });
  }

  _onSeek = () => { if (this._alive) this._seekTo(this.video.currentTime); };
  _onTick = () => { if (this._alive) this._fill(); };

  /** Buffered ranges of a SourceBuffer that may already be detached. */
  static _ranges(sb) { try { return sb.buffered; } catch { return null; } }

  async _seekTo(seconds) {
    const dx = this.demuxer;
    const primary = this.streams[0]?.track;
    if (!primary || !this._alive || this.mediaSource?.readyState !== 'open') return;
    const buffered = this.video.buffered;
    for (let i = 0; i < buffered.length; i++) {
      // Already buffered: let the browser handle it, no refetch needed.
      if (seconds >= buffered.start(i) && seconds < buffered.end(i) - 0.5) return;
    }
    this._generation++;
    this._readPos = await dx.seekTo(seconds, primary.number);
    this._eof = false;
    for (const s of this.streams) {
      try { if (s.sb.updating) s.sb.abort(); } catch {}
      s.queue.q.length = 0;
      s.queue.backlog = 0;
      s.remuxer.pending.length = 0;
    }
    this.log(`seek ${seconds.toFixed(1)}s -> byte ${this._readPos}`);

    // Drop what was buffered around the old position. Without this a long seek
    // leaves an unreachable island of media occupying the quota, and the
    // fragments for the new position get rejected as "SourceBuffer is full".
    for (const s of this.streams) {
      const b = Player._ranges(s.sb);
      if (!b?.length) continue;
      try { s.sb.remove(b.start(0), b.end(b.length - 1)); } catch {}
    }

    // The previous fill loop only notices the generation bump when it next
    // checks; until it returns, _fill() is a no-op because of the re-entry
    // guard. Awaiting it here is what keeps a seek from deadlocking: playback
    // is stalled, so no timeupdate will ever arrive to retry.
    while (this._filling) await new Promise(r => setTimeout(r, 10));
    await this._fill();
  }

  /** Pull from the demuxer until we are BUFFER_AHEAD seconds ahead of playback. */
  async _fill() {
    if (this._filling || this._eof || !this.mediaSource || this.mediaSource.readyState !== 'open') return;
    const gen = this._generation;
    this._filling = true;
    try {
      let pass = 0;
      while (gen === this._generation) {
        // A detached MediaSource can never accept data again; without this the
        // loop happily reads the whole file into a dead sink.
        if (this.mediaSource.readyState !== 'open') {
          this.log(`fill stopped: MediaSource is ${this.mediaSource.readyState}`, 'warn');
          break;
        }
        // Throttle on queued-but-not-yet-appended bytes as well as on
        // video.buffered: appends are async, so buffered stays at 0 for the
        // first few passes and a buffered-only check would read the whole
        // file into memory before the first fragment lands.
        if (this._bufferedAhead() > BUFFER_AHEAD) break;
        if (this.streams.some(s => s.queue.backlog > MAX_QUEUE_BYTES)) {
          await new Promise(r => setTimeout(r, 60));
          continue;
        }

        const wanted = new Map(this.streams.map(s => [s.track.number, s]));
        const state = {};
        let got = 0;
        for await (const block of this.demuxer.readBlocks(this._readPos, READ_CHUNK, state)) {
          if (gen !== this._generation) return;
          const s = wanted.get(block.track);
          if (s) s.remuxer.push(block);
          else this._emitSubtitle(block);
          got++;
        }
        // Resume exactly where the demuxer stopped. Advancing by READ_CHUNK
        // instead lands mid-cluster and reads garbage.
        if (pass < 3) {
          this.log(`fill pass ${pass}: ${got} blocks, ${this._readPos}->${state.nextPos}, atEnd=${!!state.atEnd}, parseErr=${state.parseError ?? '-'}, ahead=${this._bufferedAhead().toFixed(1)}s`);
        }
        pass++;
        this._readPos = state.nextPos;

        for (const s of this.streams) {
          const frag = s.remuxer.flush();
          if (frag) s.queue.push(frag);
        }

        // Only genuine end-of-source ends the stream. A parse failure is not
        // EOF -- ending there truncates playback.
        if (state.parseError) { this.log(`demux stopped: ${state.parseError}`, 'warn'); break; }
        if (state.atEnd) { this._eof = true; this._maybeEnd('reached end of segment'); break; }
        if (!got) { this.log(`no blocks at byte ${this._readPos}; stopping fill`, 'warn'); break; }
        await new Promise(r => setTimeout(r, 0));
      }
    } catch (e) {
      this.log(`fill error: ${e.message}`, 'error');
    } finally {
      this._filling = false;
    }
  }

  _bufferedAhead() {
    const b = this.video.buffered;
    const t = this.video.currentTime;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.1 && t <= b.end(i)) return b.end(i) - t;
    return 0;
  }

  _maybeEnd(why) {
    if (this.mediaSource?.readyState === 'open' && this.streams.every(s => s.queue.idle)) {
      this.log(`endOfStream() <- ${why}`, 'warn');
      try { this.mediaSource.endOfStream(); } catch {}
    }
  }

  /**
   * Detach from the media element. Must be called before pointing another
   * Player at the same <video>: otherwise this instance keeps handling seek
   * and timeupdate events and reaches into SourceBuffers that no longer exist.
   */
  dispose() { this._generation++; return this._teardown(); }

  async _teardown() {
    this._alive = false;
    this.video.removeEventListener('seeking', this._onSeek);
    this.video.removeEventListener('timeupdate', this._onTick);
    this.video.removeEventListener('waiting', this._onTick);
    this.video.removeEventListener('seeked', this._onTick);
    this.streams = [];
    if (this.mediaSource?.readyState === 'open') {
      this.log('endOfStream() <- teardown', 'warn');
      try { this.mediaSource.endOfStream(); } catch {}
    }
    this.mediaSource = null;
    if (this.video.src) { URL.revokeObjectURL(this.video.src); this.video.removeAttribute('src'); this.video.load(); }
  }

  /**
   * Route a subtitle track's packets to `onSubtitlePacket`.
   *
   * Packets arrive from the same sequential read as video, so a renderer only
   * ever sees the packets for the region being buffered -- and after a seek,
   * only those from the seek point onward. That is correct for PGS, where every
   * display set is self-contained, and acceptable for ASS, where the cost is
   * that an event which started before the seek point does not reappear.
   * Collecting a whole track up front would mean reading the entire file, which
   * is not an option at 21 GB.
   */
  enableSubtitle(index) {
    const entry = this.info?.subtitles?.[index];
    if (!entry) throw new Error(`no subtitle track at index ${index}`);
    this._subs.set(entry.track.number, entry);
    this.log(`subtitles on: ${entry.label}`);
    // Everything already buffered was read before this track was enabled, so
    // its packets were dropped. Without this, turning subtitles on mid-playback
    // shows nothing until the buffer drains and the fill loop reads again --
    // up to BUFFER_AHEAD seconds of silence that looks like a broken renderer.
    this._backfillSubtitles(entry).catch(e => this.log(`subtitle backfill: ${e.message}`, 'warn'));
    return entry;
  }

  /**
   * Re-read the region that is already buffered, emitting only subtitle blocks.
   *
   * This deliberately does not touch `_readPos` or the remuxers: the video and
   * audio for this region are already in the SourceBuffers, and pushing them
   * again would duplicate samples.
   */
  async _backfillSubtitles(entry) {
    if (!this._alive) return;
    const from = Math.max(0, this.video.currentTime - 2);
    const ahead = this._bufferedAhead();
    if (ahead <= 0) return;
    const gen = this._generation;
    let pos = await this.demuxer.seekTo(from, entry.track.number);
    const until = from + ahead + 2;
    let emitted = 0, budget = 24;   // clusters, so a long buffer cannot run away

    while (budget-- > 0 && gen === this._generation) {
      const state = {};
      let past = false;
      for await (const block of this.demuxer.readBlocks(pos, 2 << 20, state)) {
        if (gen !== this._generation) return;
        if (block.track !== entry.track.number) continue;
        if (block.time > until) { past = true; break; }
        if (block.time + (block.duration || 0) < from) continue;
        this._emitSubtitle(block);
        emitted++;
      }
      if (past || state.atEnd || state.parseError || state.nextPos <= pos) break;
      pos = state.nextPos;
    }
    this.log(`subtitle backfill: ${emitted} packet(s) for the buffered ${ahead.toFixed(1)}s`);
  }

  disableSubtitle(index) {
    const entry = this.info?.subtitles?.[index];
    if (entry) this._subs.delete(entry.track.number);
  }

  _emitSubtitle(block) {
    const entry = this._subs.get(block.track);
    if (entry && this.onSubtitlePacket) this.onSubtitlePacket(block, entry);
  }

  /** Fonts embedded in the MKV, ready to hand to a subtitle renderer. */
  fontAttachments() {
    return this.demuxer.attachments.filter(f => /font|sfnt/i.test(f.mime) || /\.(ttf|otf|ttc)$/i.test(f.name));
  }
}

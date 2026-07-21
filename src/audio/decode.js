// Software audio decoding for the codecs no browser will take.
//
// E-AC3, AC-3, DTS and TrueHD are all rejected by MSE and by WebCodecs
// AudioDecoder on this platform (measured -- see public/audio-probe.html), so
// the only route to the speakers is decoding them ourselves.
//
// The decoded PCM does NOT go to WebAudio. It is re-encoded to Opus with the
// browser's own AudioEncoder and appended to a normal SourceBuffer, so the
// <video> element stays the clock and the browser does A/V sync, seeking,
// pausing and rate changes. Driving WebAudio against video.currentTime by hand
// is where the bugs in this design would live, and this removes the whole
// category.
//
// The load-bearing fact, verified in tools/test-eac3.mjs: AC-3 family frames
// are self-framing (syncword 0x0B77, own length), so concatenating consecutive
// Matroska blocks yields a valid elementary stream. A window can therefore be
// decoded on its own, without the container and without the whole track.

/** Matroska codec id -> the raw format name ffmpeg should be told to expect. */
export const RAW_FORMATS = {
  A_EAC3: 'eac3', A_AC3: 'ac3', A_DTS: 'dts', A_TRUEHD: 'truehd', A_MLP: 'mlp',
};

export const OUT_RATE = 48000;
export const OUT_CHANNELS = 2;   // WebAudio reports maxChannelCount 2 here; 5.1 downmixes regardless

/**
 * ffmpeg.wasm, loaded once and reused.
 *
 * Loading costs ~31 MB, so it is deliberately lazy: a file whose audio the
 * browser can already play never pays for it.
 */
export class SoftwareAudioDecoder {
  constructor({ vendor, log = () => {} } = {}) {
    this.vendor = new URL(vendor ?? 'vendor/', document.baseURI).href.replace(/\/$/, '');
    this.log = log;
    this._ff = null;
    this._loading = null;
    this._seq = 0;
  }

  async _load() {
    if (this._ff) return this._ff;
    if (this._loading) return this._loading;
    this._loading = (async () => {
      const t0 = performance.now();
      const { FFmpeg } = await import(`${this.vendor}/ffmpeg.js`);
      const ff = new FFmpeg();
      ff.on('log', ({ message }) => { if (/error|Error|invalid/.test(message)) this.log(message, 'warn'); });
      await ff.load({
        coreURL: `${this.vendor}/ffmpeg-core.js`,
        wasmURL: `${this.vendor}/ffmpeg-core.wasm`,
        classWorkerURL: `${this.vendor}/ffmpeg-worker.js`,
      });
      this.log(`software audio decoder ready in ${(performance.now() - t0).toFixed(0)}ms`);
      this._ff = ff;
      return ff;
    })();
    return this._loading;
  }

  /**
   * Decode one window of elementary stream to interleaved stereo float PCM.
   *
   * Each call writes and deletes its own files: the in-memory filesystem is
   * shared across calls and leaking entries there is a slow memory leak that
   * looks like ordinary heap growth.
   */
  async decode(bytes, format) {
    const ff = await this._load();
    const id = this._seq++;
    const inFile = `a${id}.${format}`, outFile = `a${id}.f32`;
    try {
      await ff.writeFile(inFile, bytes);
      const code = await ff.exec([
        '-hide_banner', '-nostdin', '-v', 'error',
        '-f', format, '-i', inFile,
        '-f', 'f32le', '-ac', String(OUT_CHANNELS), '-ar', String(OUT_RATE),
        outFile,
      ]);
      if (code !== 0) throw new Error(`ffmpeg exited ${code} decoding ${format}`);
      const out = await ff.readFile(outFile);
      const u8 = out instanceof Uint8Array ? out : new Uint8Array(out);
      // The buffer ffmpeg.wasm hands back is not guaranteed to be aligned for
      // a Float32Array view, so it is copied rather than viewed in place.
      const copy = new Uint8Array(u8.length - (u8.length % 4));
      copy.set(u8.subarray(0, copy.length));
      return new Float32Array(copy.buffer);
    } finally {
      for (const f of [inFile, outFile]) {
        try { await ff.deleteFile(f); } catch {}
      }
    }
  }

  async destroy() {
    try { (await this._ff)?.terminate?.(); } catch {}
    this._ff = null;
    this._loading = null;
  }
}

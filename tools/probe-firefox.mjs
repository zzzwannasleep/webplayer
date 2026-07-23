// Asks a real Firefox what it can actually do, instead of trusting a support
// table. Run it with:  node tools/probe-firefox.mjs
//
// This exists because every second-hand answer about Firefox and MSE disagrees
// with the next one, and MediaSource.isTypeSupported is the only opinion that
// decides whether a track plays. The codec strings below are the ones
// src/remux/tracks.js actually emits, not textbook examples.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchFirefox } from './firefox-bidi.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const PORT = 8082;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const serve = spawn(process.execPath, [`${ROOT}/tools/serve.mjs`, ROOT],
  { stdio: 'ignore', env: { ...process.env, PORT: String(PORT) } });
process.on('exit', () => { try { serve.kill(); } catch {} });

const ff = await launchFirefox({ port: 9225 });
process.on('exit', ff.kill);

await ff.navigate(`http://localhost:${PORT}/public/index.html`);
await sleep(1500);

const ua = await ff.evalJS('navigator.userAgent');
console.log(`\n${ua}\n`);

// The strings src/remux/tracks.js hands to addSourceBuffer, verbatim in shape.
const CODECS = [
  ['H.264 baseline', 'video/mp4; codecs="avc1.42c01e"'],
  ['H.264 high', 'video/mp4; codecs="avc1.640028"'],
  ['HEVC Main', 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
  ['HEVC Main10 (HDR)', 'video/mp4; codecs="hvc1.2.4.L150.B0"'],
  ['HEVC hev1 spelling', 'video/mp4; codecs="hev1.1.6.L93.B0"'],
  ['Dolby Vision', 'video/mp4; codecs="dvh1.05.06"'],
  ['AV1 8-bit', 'video/mp4; codecs="av01.0.08M.08"'],
  ['AV1 10-bit', 'video/mp4; codecs="av01.0.09M.10"'],
  ['VP9', 'video/mp4; codecs="vp09.00.10.08"'],
  ['AAC-LC', 'audio/mp4; codecs="mp4a.40.2"'],
  ['HE-AAC', 'audio/mp4; codecs="mp4a.40.5"'],
  ['MP3 in MP4', 'audio/mp4; codecs="mp4a.6B"'],
  ['AC-3', 'audio/mp4; codecs="ac-3"'],
  ['E-AC-3', 'audio/mp4; codecs="ec-3"'],
  ['Opus in MP4', 'audio/mp4; codecs="opus"'],
  ['FLAC in MP4', 'audio/mp4; codecs="flac"'],
  ['DTS', 'audio/mp4; codecs="dtsc"'],
];

const rows = await ff.evalJSON(`(${JSON.stringify(CODECS)}).map(([n, t]) => [n, t,
  MediaSource.isTypeSupported(t), document.createElement('video').canPlayType(t) || 'no'])`);

console.log('MediaSource.isTypeSupported  /  <video>.canPlayType');
console.log('-'.repeat(78));
for (const [name, type, mse, native] of rows) {
  console.log(`${mse ? 'YES' : ' - '}  ${native === 'no' ? ' - ' : native.slice(0, 3)}   ${name.padEnd(22)} ${type}`);
}

const apis = await ff.evalJSON(`({
  MediaSource: typeof MediaSource,
  ManagedMediaSource: typeof ManagedMediaSource,
  changeType: 'changeType' in SourceBuffer.prototype,
  requestVideoFrameCallback: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
  webgpu: !!navigator.gpu,
  VideoDecoder: typeof VideoDecoder,
  AudioDecoder: typeof AudioDecoder,
  AudioEncoder: typeof AudioEncoder,
  VideoEncoder: typeof VideoEncoder,
  showOpenFilePicker: typeof window.showOpenFilePicker,
  SharedArrayBuffer: typeof SharedArrayBuffer,
  crossOriginIsolated: crossOriginIsolated,
  // () -> v128 whose result is returned, not dropped. Dropping it makes the
  // module itself invalid and the probe reports every browser as SIMD-less.
  wasmSimd: WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,8,1,6,0,65,0,253,15,11])),
  moduleWorker: (() => { try { new Worker('data:text/javascript,', { type: 'module' }).terminate(); return true; } catch { return false; } })(),
  popover: HTMLElement.prototype.hasOwnProperty('popover'),
  hdr: matchMedia('(dynamic-range: high)').matches,
  videoHdr: matchMedia('(video-dynamic-range: high)').matches,
})`);

console.log('\nAPI surface');
console.log('-'.repeat(78));
for (const [k, v] of Object.entries(apis)) console.log(`${String(v).padEnd(10)} ${k}`);

// The E-AC3/AC3/DTS fallback in src/audio/ decodes with ffmpeg.wasm and then
// re-encodes with the browser's own AudioEncoder. If opus encoding is missing
// the whole software-audio leg is dead here, whatever ffmpeg.wasm can do.
const enc = await ff.evalJSON(`(async () => {
  if (typeof AudioEncoder === 'undefined') return { AudioEncoder: false };
  const cfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 };
  try { const s = await AudioEncoder.isConfigSupported(cfg); return { AudioEncoder: true, opus: !!s.supported }; }
  catch (e) { return { AudioEncoder: true, opus: false, err: String(e) }; }
})()`);
console.log('\nsoftware-audio fallback (E-AC3/AC3/DTS -> Opus)');
console.log('-'.repeat(78));
for (const [k, v] of Object.entries(enc)) console.log(`${String(v).padEnd(10)} ${k}`);

console.log(`\npage errors: ${ff.errors.length ? '\n  ' + ff.errors.join('\n  ') : 'none'}`);
ff.kill();
serve.kill();
process.exit(0);

// End-to-end playback in a real Firefox. Run it with:  node tools/test-firefox.mjs
//
// Firefox is not a Chromium skin: it speaks WebDriver BiDi instead of CDP (see
// tools/firefox-bidi.mjs) and its MSE refuses codecs Chromium accepts. What it
// refuses is measured by tools/probe-firefox.mjs, not assumed here.
//
// The samples are chosen so each one isolates one leg of the pipeline:
//   native-h264.mp4  -- the container path, no exotic codec involved
//   audio-eac3.mkv   -- MSE rejects ec-3 in Firefox, so this must reach the
//                       ffmpeg.wasm -> Opus fallback or play silent, never die
//   hdr-hevc.mp4     -- Firefox 134+ does decode HEVC, including Main10
// A sample the file tree does not have is skipped loudly rather than passing.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchFirefox } from './firefox-bidi.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const PORT = 8083;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const serve = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs'), ROOT],
  { stdio: 'ignore', env: { ...process.env, PORT: String(PORT) } });
process.on('exit', () => { try { serve.kill(); } catch {} });

const ff = await launchFirefox({ port: 9226 });
process.on('exit', ff.kill);

const out = [];
const ok = (name, pass, detail = '') => {
  out.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass || !detail ? '' : `  <- ${detail}`}`);
};

/** Load one file through the page's own <input type=file> and let it settle. */
async function playFile(file) {
  await ff.navigate(`http://localhost:${PORT}/public/index.html`);
  for (let i = 0; i < 40; i++) {
    if (await ff.evalJS(`!!document.querySelector('#file')`).catch(() => false)) break;
    await sleep(300);
  }
  await ff.setFiles('#file', [join(ROOT, 'samples', file)]);
  // Playback needs a moment: demux, then a first fragment, then a frame.
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    const t = await ff.evalJS(`document.querySelector('video').currentTime`).catch(() => 0);
    if (t > 0.15) break;
  }
  return ff.evalJSON(`(() => {
    const v = document.querySelector('video');
    return {
      currentTime: v.currentTime, readyState: v.readyState, error: v.error?.message || null,
      width: v.videoWidth, height: v.videoHeight,
      buffered: v.buffered.length ? v.buffered.end(0) : 0,
      log: (document.querySelector('#log')?.textContent || '').replace(/\\s+/g, ' ').slice(-900),
    };
  })()`);
}

// wantAudio marks the files whose audio Firefox's MSE refuses outright, so the
// only pass is the software decoder actually catching them. Chromium takes
// several of these natively, which is exactly why they are the parity risk.
for (const [file, label, wantAudio] of [
  ['native-h264.mp4', 'H.264 mp4', false],
  ['mp4-multi.mp4', 'mp4 multi-track', false],
  ['no-cues.mkv', 'mkv without cues', false],
  ['hdr-hevc.mp4', 'HEVC Main10 HDR', false],
  ['native-vp9.webm', 'VP9 webm', false],
  ['audio-eac3.mkv', 'E-AC3 (ec-3 refused)', true],
  ['audio-ac3.mkv', 'AC-3 (ac-3 refused)', true],
  ['audio-dts.mkv', 'DTS (dtsc refused)', true],
  ['audio-truehd.mkv', 'TrueHD (refused)', true],
  ['flv-mp3.flv', 'MP3 in flv (mp4a.6B refused)', true],
]) {
  if (!existsSync(join(ROOT, 'samples', file))) { ok(`${label}: sample present`, false, `samples/${file} missing -- run npm run samples`); continue; }
  ff.errors.length = 0;
  const r = await playFile(file);
  ok(`${label}: video decodes`, r.width > 0 && r.height > 0, `${r.width}x${r.height} readyState=${r.readyState} err=${r.error}`);
  ok(`${label}: clock advances`, r.currentTime > 0.15, `currentTime=${r.currentTime} buffered=${r.buffered} err=${r.error}`);
  ok(`${label}: page threw nothing`, ff.errors.length === 0, ff.errors.slice(0, 2).join(' | '));
  if (wantAudio) {
    // Asserting on the log alone is circular: the message this fix edits is the
    // message the assertion reads. mozHasAudio is Firefox reporting what it
    // actually decoded, which no wording change can fake.
    const audible = await ff.evalJS(`(() => {
      const v = document.querySelector('video');
      const l = document.querySelector('#log')?.textContent || '';
      return !!(v.mozHasAudio ?? (v.audioTracks?.length > 0)) && !/playing without audio/.test(l);
    })()`);
    ok(`${label}: audio actually reaches the element`, audible, r.log.slice(-400));
  }
  if (!r.currentTime) console.log(`      log tail: ${r.log.slice(-500)}`);
}

// --- the legs that lean hardest on engine-specific machinery ---------------
// Audio was the measured gap, but wasm subtitles, WebGPU upscaling and the
// Emby page had never been run on Gecko at all. Untested is not the same as
// working, and each of these fails in a way the codec matrix above cannot see.

// Step back out of whatever panel the previous assertion left open.
const TO_ROOT = `const p=document.querySelector('#picks');
  if(p.hidden) document.querySelector('#gearBtn').click();
  const back=p.querySelector('[data-back]'); if(back) back.click();`;
const openPanel = key => ff.evalJS(`(()=>{${TO_ROOT}
  const b=p.querySelector('[data-group="${key}"]'); if(!b) return null; b.click();
  return p.querySelector('.mhead .mrow-l')?.textContent;})()`);

if (existsSync(join(ROOT, 'samples/subs-srt.mkv'))) {
  ff.errors.length = 0;
  await playFile('subs-srt.mkv');
  await openPanel('sub');
  const subs = await ff.evalJSON(`(async () => {
    const s = document.querySelector('#picks select[data-row="sub"]');
    if (!s) return { picker: false };
    s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 2500));
    const v = document.querySelector('video');
    const t = [...v.textTracks];
    return { picker: true, tracks: t.length, mode: t[0]?.mode ?? null, cues: t[0]?.cues?.length ?? 0 };
  })()`);
  ok('subtitles: the picker offers the demuxed track', subs.picker);
  ok('subtitles: a track is attached and showing', subs.mode === 'showing', JSON.stringify(subs));
  ok('subtitles: cues actually parsed', subs.cues > 0, JSON.stringify(subs));
  ok('subtitles: page threw nothing', ff.errors.length === 0, ff.errors.slice(0, 2).join(' | '));
}

// SDR only by design, so native-h264.mp4 is the honest input. A refusal is a
// pass -- what must not happen is a silent crash or a stuck black frame.
ff.errors.length = 0;
await playFile('native-h264.mp4');
await openPanel('a4k');
const a4k = await ff.evalJSON(`(async () => {
  const s = document.querySelector('#picks select[data-row="a4k"]');
  if (!s) return { picker: false };
  const opt = [...s.options].find(o => o.value !== 'off');
  s.value = opt.value; s.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 4000));
  const v = document.querySelector('video');
  const t0 = v.currentTime;
  await new Promise(r => setTimeout(r, 1500));
  return { picker: true, webgpu: !!navigator.gpu, chosen: opt.value,
           advanced: v.currentTime > t0, err: v.error?.message || null };
})()`);
ok('Anime4K: the picker exists', a4k.picker);
ok('Anime4K: playback survives switching it on', a4k.advanced, JSON.stringify(a4k));
ok('Anime4K: page threw nothing', ff.errors.length === 0, ff.errors.slice(0, 2).join(' | '));
// "Nothing threw" also describes an upscaler that never started. Gecko must
// report taking the canvas route, and the overlay must actually be on screen.
const bridged = await ff.evalJSON(`(() => {
  const l = document.querySelector('#log')?.textContent || '';
  const c = document.querySelector('canvas');
  return { bridge: /不接受 <video> 作为纹理源/.test(l), started: /超分已启用/.test(l),
           canvas: !!c && c.width > 0 };
})()`);
ok('Anime4K: the upscaler really started', bridged.started, JSON.stringify(bridged));
ok('Anime4K: Gecko took the canvas bridge', bridged.bridge && bridged.canvas, JSON.stringify(bridged));

// play.html is the page that actually gets used. It needs no Emby server to
// prove its modules evaluate -- a TDZ fault there is invisible on index.html.
ff.errors.length = 0;
await ff.navigate(`http://localhost:${PORT}/public/play.html`);
await sleep(2500);
const play = await ff.evalJSON(`({ gear: !!document.querySelector('#gearBtn'),
  video: !!document.querySelector('video'), dmk: !!document.querySelector('#dmkBtn') })`);
ok('play.html: controls rendered', play.gear && play.video && play.dmk, JSON.stringify(play));
ok('play.html: modules evaluated without throwing', ff.errors.length === 0, ff.errors.slice(0, 3).join(' | '));

const bad = out.filter(o => !o.pass).length;
console.log(`\n${out.length - bad}/${out.length} Firefox checks passed`);
ff.kill(); serve.kill();
process.exit(bad ? 1 : 0);

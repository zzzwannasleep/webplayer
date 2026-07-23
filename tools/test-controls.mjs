// Drives the in-frame settings menu at a real file and asserts the three picks
// a viewer actually reaches for. Run it with:  node tools/test-controls.mjs
//
// Not part of `npm test`, which is pure Node -- this one needs a browser. Like
// tools/test-touch.mjs it may run HEADLESS: samples/subs-srt.mkv is H.264 + SRT,
// so headless Chromium's missing HEVC decoder is irrelevant here.
//
// The one that matters most is speed surviving a track switch. Every track
// change reloads the <video> src, and the media load algorithm resets
// playbackRate to defaultPlaybackRate -- so setting only playbackRate gives you
// a speed control that silently snaps back to 1x the next time anything else is
// touched. That failure is invisible until someone switches audio at 1.5x.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const PORT = 8081, CDP = 9224;
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SAMPLE = join(ROOT, 'samples/subs-srt.mkv');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'linweb-ctl-'));
const kids = [];
const bye = () => { for (const k of kids) { try { k.kill(); } catch {} } try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', bye);

// serve.mjs reads the port from the environment, not argv.
kids.push(spawn(process.execPath, [join(ROOT, 'tools/serve.mjs'), ROOT],
  { stdio: 'ignore', env: { ...process.env, PORT: String(PORT) } }));
kids.push(spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync', '--autoplay-policy=no-user-gesture-required',
  'about:blank'], { stdio: 'ignore' }));

let targets = null;
for (let i = 0; i < 40 && !targets; i++) {
  await sleep(400);
  try { targets = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).filter(t => t.type === 'page'); } catch {}
}
if (!targets?.length) { console.error('could not reach Edge on CDP -- set EDGE to the browser path'); process.exit(1); }

const ws = new WebSocket(targets.find(t => !t.url.startsWith('devtools://'))?.webSocketDebuggerUrl || targets[0].webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });

let id = 0; const pending = new Map();
const errors = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id != null) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
  // A page that throws during module evaluation still renders its HTML, so a
  // TDZ mistake would pass every DOM assertion below without this.
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((ok, no) => {
  const n = ++id;
  pending.set(n, r => r.error ? no(new Error(`${method}: ${r.error.message}`)) : ok(r.result));
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evalJS = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');
await send('Page.navigate', { url: `http://localhost:${PORT}/public/index.html` });

let ready = false;
for (let i = 0; i < 50 && !ready; i++) {
  await sleep(300);
  ready = await evalJS(`!!document.querySelector('#gearBtn') && !!document.querySelector('#file')`).catch(() => false);
}
if (!ready) { console.error('index.html never finished booting'); process.exit(1); }

const out = [];
const check = (name, pass, detail = '') => out.push({ name, pass, detail });

// ---- the file ------------------------------------------------------------
const doc = await send('DOM.getDocument');
const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
await send('DOM.setFileInputFiles', { files: [SAMPLE], nodeId: input.nodeId });

let loaded = false;
for (let i = 0; i < 60 && !loaded; i++) {
  await sleep(300);
  loaded = await evalJS(`(document.querySelector('#video').readyState||0) >= 1`).catch(() => false);
}
check('the sample loaded', loaded, `readyState = ${await evalJS(`document.querySelector('#video').readyState`)}`);

// The menu is rendered on demand, and a control inside a closed panel does not
// exist -- so every read below goes through opening it, the way a viewer does.
// Open, and step back out of whatever panel the previous assertion left open --
// the menu remembers, so a bare gear click is not enough to see the root list.
const TO_ROOT = `const p=document.querySelector('#picks');
  if(p.hidden) document.querySelector('#gearBtn').click();
  const back=p.querySelector('[data-back]'); if(back) back.click();`;
const openRoot = () => evalJS(`(()=>{${TO_ROOT}
  return [...p.querySelectorAll('[data-group]')].map(b=>b.querySelector('.mrow-l').textContent);})()`);
const openPanel = key => evalJS(`(()=>{${TO_ROOT}
  const b=p.querySelector('[data-group="${key}"]'); if(!b) return null; b.click();
  return p.querySelector('.mhead .mrow-l')?.textContent;})()`);

const groups = await openRoot();
check('字幕 is a top-level group, not buried in 轨道', groups.includes('字幕'), groups.join(' / '));
check('倍速 is a top-level group', groups.includes('倍速'), groups.join(' / '));

// ---- speed ---------------------------------------------------------------
check('the 倍速 panel opens', (await openPanel('rate')) === '倍速');
const rate = await evalJS(`(()=>{const s=document.querySelector('#picks select[data-row="rate"]');
  s.value='1.5'; s.dispatchEvent(new Event('change',{bubbles:true}));
  const v=document.querySelector('#video');
  return {playback:v.playbackRate, dflt:v.defaultPlaybackRate, options:[...s.options].map(o=>o.value)};})()`);
check('picking 1.5x sets playbackRate', rate.playback === 1.5, `playbackRate = ${rate.playback}`);
// The whole point: without this the next track switch silently returns to 1x.
check('1.5x is also the default, so a src reload keeps it', rate.dflt === 1.5, `defaultPlaybackRate = ${rate.dflt}`);
check('the speed list runs from 0.5x to 3x', rate.options[0] === '0.5' && rate.options.at(-1) === '3', rate.options.join(','));

// A real track switch, which is what actually reloads the src.
const survived = await evalJS(`(()=>{${TO_ROOT}
  const g=p.querySelector('[data-group="track"]');
  if(!g) return 'no 轨道 group: ' + [...p.querySelectorAll('[data-group]')].map(b=>b.dataset.group).join(',');
  g.click();
  const s=p.querySelector('select[data-row="video"]') || p.querySelector('select[data-row="audio"]');
  if(!s) return 'no track select';
  s.dispatchEvent(new Event('change',{bubbles:true}));
  return true;})()`);
if (survived === true) {
  await sleep(2500);
  const after = await evalJS(`document.querySelector('#video').playbackRate`);
  check('speed survives a track switch', after === 1.5, `playbackRate after reload = ${after}`);
} else {
  check('speed survives a track switch', false, survived);
}

// ---- subtitles -----------------------------------------------------------
check('the 字幕 panel opens', (await openPanel('sub')) === '字幕');
const sub = await evalJS(`(()=>{const s=document.querySelector('#picks select[data-row="sub"]');
  if(!s) return {err:'no subtitle select'};
  return {options:[...s.options].map(o=>o.textContent), off:s.options[0].value};})()`);
check('the subtitle picker offers the demuxed track', !sub.err && sub.options.length > 1, JSON.stringify(sub.options));
check('关闭 is the first option', sub.off === '-1', `first value = ${sub.off}`);

// ---- the button that looked broken --------------------------------------
// Zero comments loaded: the old handler toggled a setting nothing was drawing,
// so the press did nothing at all and read as a dead subtitle button.
const dmk = await evalJS(`(async()=>{
  const p=document.querySelector('#picks');
  if(!p.hidden) document.querySelector('#gearBtn').click();
  const b=document.querySelector('#dmkBtn');
  if(b.hidden) return {err:'danmaku button never un-hidden'};
  b.click();
  await new Promise(r=>setTimeout(r,60));
  return {open:!p.hidden, head:p.querySelector('.mhead .mrow-l')?.textContent};})()`);
check('pressing 弹幕 with no track opens the 弹幕 panel', dmk.open === true, JSON.stringify(dmk));
check('and the panel it opens is the danmaku one', dmk.head === '弹幕', `panel = ${dmk.head}`);
// It opened via a click that bubbles to the same document handler that closes
// the menu on an outside click; without stopPropagation it shut immediately.
check('the menu stays open after that press', dmk.open === true, 'not closed by the outside-click handler');

check('index.html threw nothing', errors.length === 0, errors.join(' | '));

// ---- play.html: the Emby leg --------------------------------------------
// Its subtitle can arrive as a <track> the server rendered, which is not in any
// demuxed list. That track had no entry in the picker at all: it could not be
// switched away from and could not be turned off from inside the player.
errors.length = 0;
const suburl = encodeURIComponent(`http://localhost:${PORT}/samples/sample.srt`);
await send('Page.navigate', { url: `http://localhost:${PORT}/public/play.html`
  + `?url=http://localhost:${PORT}/samples/subs-srt.mkv&suburl=${suburl}&sublabel=Emby%20SRT` });

let pReady = false;
for (let i = 0; i < 60 && !pReady; i++) {
  await sleep(400);
  pReady = await evalJS(`!!document.querySelector('#gearBtn')
    && !!document.querySelector('#video')?.textTracks?.length`).catch(() => false);
}
check('play.html attached the Emby-served subtitle', pReady,
  `textTracks = ${await evalJS(`document.querySelector('#video')?.textTracks?.length`).catch(e => e.message)}`);

const pGroups = await openRoot();
check('play.html offers 字幕 and 倍速 too', pGroups.includes('字幕') && pGroups.includes('倍速'), pGroups.join(' / '));

check('the play.html 字幕 panel opens', (await openPanel('sub')) === '字幕');
const ext = await evalJS(`(()=>{const s=document.querySelector('#picks select[data-row="sub"]');
  if(!s) return {err:'no subtitle select'};
  return {labels:[...s.options].map(o=>o.textContent), value:s.value,
          mode:document.querySelector('#video').textTracks[0].mode};})()`);
check('the Emby track appears in the picker', !ext.err && ext.labels.some(l => /Emby SRT/.test(l)), JSON.stringify(ext.labels));
check('and is selected, matching what is on screen', ext.value === 'ext' && ext.mode === 'showing', JSON.stringify(ext));

// 关闭 has to reach the <track>, not just the demuxed renderer -- the old code
// re-asserted 'showing' on every loadedmetadata and put it straight back.
const off = await evalJS(`(async()=>{const s=document.querySelector('#picks select[data-row="sub"]');
  s.value='-1'; s.dispatchEvent(new Event('change',{bubbles:true}));
  await new Promise(r=>setTimeout(r,300));
  return document.querySelector('#video').textTracks[0].mode;})()`);
check('choosing 关闭 actually hides the Emby subtitle', off === 'disabled', `track mode = ${off}`);

check('play.html threw nothing', errors.length === 0, errors.join(' | '));

let bad = 0;
for (const r of out) { console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  <- ${r.detail}`}`); if (!r.pass) bad++; }
console.log(bad ? `\n${bad} problem(s) in the player controls` : '\nplayer controls hold');
ws.close();
process.exit(bad ? 1 : 0);

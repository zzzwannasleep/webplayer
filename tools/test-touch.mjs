// Drives real synthetic touches at the player and asserts the gesture layer
// reacted. Run it with:  node tools/test-touch.mjs
//
// Not part of `npm test`, which is pure Node -- this one needs a browser. It is
// also the one browser test that may run HEADLESS: unlike the playback checks it
// never decodes a frame, and headless Chromium's missing HEVC decoder (see
// tools/run-browser-test.ps1) is irrelevant to whether a swipe moved the volume.
//
// Everything it asserts is invisible to a screenshot: a screenshot proves the
// control bar is 46px, only a dispatched touch proves a long press reaches 2x.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A native path with no trailing separator: serve.mjs resolves its root and
// compares prefixes, and a trailing slash makes every request fall outside it
// (the symptom is a page that is just the word "forbidden").
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const PORT = 8080, CDP = 9223;
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'linweb-touch-'));
const kids = [];
const bye = () => { for (const k of kids) { try { k.kill(); } catch {} } try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', bye);

kids.push(spawn(process.execPath, [join(ROOT, 'tools/serve.mjs'), ROOT], { stdio: 'ignore', detached: false }));
kids.push(spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync', '--hide-scrollbars', 'about:blank'],
  { stdio: 'ignore' }));

// Edge takes a moment to open the debugging port; poll rather than guess.
let targets = null;
for (let i = 0; i < 40 && !targets; i++) {
  await sleep(400);
  try { targets = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).filter(t => t.type === 'page'); } catch {}
}
if (!targets?.length) { console.error('could not reach Edge on CDP -- set EDGE to the browser path'); process.exit(1); }

const ws = new WebSocket(targets.find(t => !t.url.startsWith('devtools://'))?.webSocketDebuggerUrl || targets[0].webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });

let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id != null) { pending.get(m.id)?.(m); pending.delete(m.id); } };
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
const touch = (type, x, y) => send('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }],
});
const tap = async (x, y) => { await touch('touchStart', x, y); await sleep(30); await touch('touchEnd', x, y); };

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Page.navigate', { url: `http://localhost:${PORT}/public/play.html?url=x` });
// Poll for the module script having run rather than sleeping a guessed amount:
// a cold browser takes several seconds longer than a warm one, and a fixed wait
// turns that into a spurious failure.
let ready = false;
for (let i = 0; i < 50 && !ready; i++) {
  await sleep(300);
  ready = await evalJS(`!!document.querySelector('#stage') && !!document.querySelector('.g-hud') && !!document.querySelector('#placeholder')`).catch(() => false);
}
if (!ready) {
  console.error('the player page never finished booting. What the browser sees:');
  console.error(await evalJS(`({url:location.href,title:document.title,body:document.body?.innerHTML.slice(0,300)})`).catch(e => e.message));
  process.exit(1);
}

const out = [];
const check = (name, pass, detail) => out.push({ name, pass, detail });

// The stream is deliberately bogus: none of these gestures needs a decoded
// frame, and a real file would make the test depend on a sample being present.
const box = await evalJS(`(()=>{
  document.querySelector('#placeholder').style.display='none';
  document.querySelector('#vctl').hidden=false;
  const b=document.querySelector('#stage').getBoundingClientRect();
  return {x:b.x,y:b.y,w:b.width,h:b.height};})()`);
// Above the control bar: on a 219px inline stage the bar owns the lower half.
const cx = box.x + box.w / 2, cy = box.y + box.h * 0.25;
const leftX = box.x + box.w * 0.15, rightX = box.x + box.w * 0.85;

// ---- the CSS contract the gesture tests below stand on -------------------
const css = await evalJS(`(() => {
  const s = document.querySelector('#stage');
  let fsRule = null;
  for (const sh of document.styleSheets) {
    let cr; try { cr = sh.cssRules; } catch { continue; }
    for (const r of cr) if (r.selectorText && /#stage\\.touch:fullscreen/.test(r.selectorText)) fsRule = r.style.touchAction;
  }
  const v = document.querySelector('#vctl'), was = v.hidden;
  v.hidden = true; const hiddenDisplay = getComputedStyle(v).display; v.hidden = was;
  return { hasTouchClass: s.classList.contains('touch'), inline: getComputedStyle(s).touchAction, fsRule, hiddenDisplay,
           vbtn: getComputedStyle(document.querySelector('.vbtn')).width,
           volSlider: getComputedStyle(document.querySelector('.vol')).display };
})()`);
check('the stage is marked as touch-driven', css.hasTouchClass, 'class="touch" applied');
check('inline, a vertical drag still scrolls the page', css.inline === 'pan-y', `touch-action = ${css.inline}`);
check('fullscreen claims both axes', css.fsRule === 'none', `#stage.touch:fullscreen touch-action = ${css.fsRule}`);
// Regression: an author `display` beats the UA's [hidden] rule, so the control
// bar used to paint over the "drop a file here" placeholder at every size.
check('[hidden] really hides the control bar', css.hiddenDisplay === 'none', `display = ${css.hiddenDisplay}`);
check('controls are thumb-sized', parseFloat(css.vbtn) >= 44, `.vbtn width = ${css.vbtn}`);
// A slider that only appears on :hover cannot be reached by a finger at all.
check('the hover-only volume slider is gone', css.volSlider === 'none', `.vol display = ${css.volSlider}`);

// ---- long press -> 2x ----------------------------------------------------
await touch('touchStart', cx, cy);
await sleep(650);
const rateHeld = await evalJS(`document.querySelector('#video').playbackRate`);
const hudHeld = await evalJS(`document.querySelector('.g-hud').classList.contains('on') && document.querySelector('.g-hud').textContent`);
await touch('touchEnd', cx, cy);
await sleep(120);
check('long press sets 2x', rateHeld === 2, `rate while held = ${rateHeld}`);
check('long press shows a HUD', !!hudHeld, `hud = ${JSON.stringify(hudHeld)}`);
check('release restores rate', (await evalJS(`document.querySelector('#video').playbackRate`)) === 1, 'rate back to 1');

// ---- double tap the edge zones ------------------------------------------
await tap(rightX, cy); await sleep(90); await tap(rightX, cy); await sleep(120);
const r2 = await evalJS(`(()=>{const z=document.querySelector('.g-seek.r');return {on:z.classList.contains('on'),text:z.textContent};})()`);
check('double tap right seeks +10s', r2.on && /10/.test(r2.text), JSON.stringify(r2));

await tap(rightX, cy); await sleep(120);
check('a third tap accumulates to 20s', /20/.test(await evalJS(`document.querySelector('.g-seek.r').textContent`)), 'label advanced');

await sleep(500);
await tap(leftX, cy); await sleep(90); await tap(leftX, cy); await sleep(120);
const l2 = await evalJS(`(()=>{const z=document.querySelector('.g-seek.l');return {on:z.classList.contains('on'),text:z.textContent};})()`);
check('double tap left seeks -10s', l2.on && /10/.test(l2.text), JSON.stringify(l2));

// ---- a single tap is how you summon the bar, not how you pause -----------
await sleep(600);
await evalJS(`document.querySelector('#stage').classList.add('idle')`);
await tap(cx, cy); await sleep(150);
check('a tap wakes the controls', await evalJS(`!document.querySelector('#stage').classList.contains('idle')`), 'idle cleared');

// ---- vertical drags. Only meaningful where the page cannot scroll instead:
//      inline, `touch-action:pan-y` hands a vertical drag to the scroller and the
//      UA cancels our pointer stream. Fullscreen removes that, so the drags are
//      driven in the fullscreen geometry -- via the pseudo-fs class, which is a
//      real state of the player (the WebKit path) rather than a mock. Faking it
//      by setting height alone does NOT work: #stage carries aspect-ratio:16/9,
//      so a 390px height computes a 693px width and the touches land in the
//      wrong half of a stage that overflows the viewport. -----------------------
await evalJS(`(() => { const s = document.querySelector('#stage');
  s.classList.add('pseudo-fs'); document.body.classList.add('fs-lock');
  document.querySelector('#video').volume = 0.5; return 'ok'; })()`);
await sleep(150);
const fb = await evalJS(`(()=>{const b=document.querySelector('#stage').getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height};})()`);

const drag = async (x, from, to) => {
  await touch('touchStart', x, fb.y + fb.h * from);
  const step = (to - from) / 4;
  for (let i = 1; i <= 4; i++) { await touch('touchMove', x, fb.y + fb.h * (from + step * i)); await sleep(30); }
};
await drag(fb.x + fb.w * 0.8, 0.6, 0.25);
const vol = await evalJS(`({v:document.querySelector('#video').volume,hud:document.querySelector('.g-hud').textContent})`);
await touch('touchEnd', fb.x + fb.w * 0.8, fb.y + fb.h * 0.25);
check('swipe up on the right raises volume', vol.v > 0.5, `volume ${vol.v.toFixed(2)}, hud "${vol.hud}"`);

await sleep(300);
await drag(fb.x + fb.w * 0.2, 0.4, 0.75);
const dim = await evalJS(`({o:document.querySelector('.g-dim').style.opacity,hud:document.querySelector('.g-hud').textContent})`);
await touch('touchEnd', fb.x + fb.w * 0.2, fb.y + fb.h * 0.75);
check('swipe down on the left dims the picture', parseFloat(dim.o) > 0, `dim ${dim.o}, hud "${dim.hud}"`);

// ---- horizontal drag scrubs ---------------------------------------------
await sleep(300);
await touch('touchStart', fb.x + fb.w * 0.3, fb.y + fb.h * 0.5);
for (const f of [0.4, 0.5, 0.6, 0.7]) { await touch('touchMove', fb.x + fb.w * f, fb.y + fb.h * 0.5); await sleep(30); }
const scrub = await evalJS(`({hud:document.querySelector('.g-hud').textContent,on:document.querySelector('.g-hud').classList.contains('on')})`);
await touch('touchEnd', fb.x + fb.w * 0.7, fb.y + fb.h * 0.5);
check('horizontal drag shows a scrub readout', scrub.on && /\+/.test(scrub.hud), `hud "${scrub.hud}"`);

// ---- the controls keep their own touches --------------------------------
await evalJS(`(() => { const s = document.querySelector('#stage');
  s.classList.remove('pseudo-fs'); document.body.classList.remove('fs-lock');
  document.querySelector('#video').playbackRate = 1; return 'ok'; })()`);
await sleep(150);
const gear = await evalJS(`(()=>{const b=document.querySelector('#gearBtn').getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
await touch('touchStart', gear.x, gear.y); await sleep(700); await touch('touchEnd', gear.x, gear.y);
check('a long press on the gear is not a 2x hold', (await evalJS(`document.querySelector('#video').playbackRate`)) === 1, 'rate stayed 1');

// ---- real fullscreen, on the stage ---------------------------------------
// There is no fallback path any more, so this IS the path. Two things have to
// hold: the element that goes into the top layer is the stage and not the
// <video>, and the overlay layers are still inside it -- fullscreening the video
// would show the decoded frame and drop subtitles, danmaku and Anime4K.
// requestFullscreen needs user activation, which a synthetic mouse click gives.
const fsBtn = await evalJS(`(() => { const b = document.querySelector('#fsBtn').getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
for (const type of ['mousePressed', 'mouseReleased'])
  await send('Input.dispatchMouseEvent', { type, x: fsBtn.x, y: fsBtn.y, button: 'left', clickCount: 1 });
await sleep(700);
const fsState = await evalJS(`(() => { const el = document.fullscreenElement; return {
  id: el?.id ?? null,
  overlaysInside: !!el && ['.g-hud', '.g-dim', '.g-seek', '.vctl'].every(s => !!el.querySelector(s)),
  videoInside: !!el?.querySelector('video'),
}; })()`);
check('the fullscreen button puts the STAGE in the top layer', fsState.id === 'stage', `fullscreenElement = #${fsState.id}`);
check('video + every overlay are inside it', fsState.overlaysInside && fsState.videoInside, 'hud/dim/zones/controls/video are all descendants');

// ---- the WebKit path -----------------------------------------------------
// An iPhone has no Element.requestFullscreen -- every browser there is WKWebView,
// so this is Chrome and Firefox on iOS too, not just Safari. Its only real
// fullscreen is video.webkitEnterFullscreen: the native player, which knows
// nothing about the canvases stacked on the video and would drop subtitles,
// danmaku and Anime4K. Removing the method is exactly what enter() tests for,
// so deleting it here reproduces that device without sniffing a user agent.
await evalJS(`(() => {
  const s = document.querySelector('#stage');
  if (document.fullscreenElement) document.exitFullscreen();
  s._rfs = s.requestFullscreen; s.requestFullscreen = undefined; return 'ok'; })()`);
await sleep(600);
const btn2 = await evalJS(`(() => { const b = document.querySelector('#fsBtn').getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
for (const type of ['mousePressed', 'mouseReleased'])
  await send('Input.dispatchMouseEvent', { type, x: btn2.x, y: btn2.y, button: 'left', clickCount: 1 });
await sleep(600);
const pseudo = await evalJS(`(() => { const s = document.querySelector('#stage'), b = s.getBoundingClientRect(); return {
  on: s.classList.contains('pseudo-fs'),
  bodyLocked: document.body.classList.contains('fs-lock'),
  fills: Math.round(b.width) === innerWidth && Math.round(b.height) === innerHeight,
  touchAction: getComputedStyle(s).touchAction,
  overlays: ['.g-hud', '.g-dim', '.g-seek', '.vctl', 'video'].every(x => !!s.querySelector(x)),
  usedNativeVideoFullscreen: !!document.querySelector('video').webkitDisplayingFullscreen,
}; })()`);
check('no requestFullscreen -> the stand-in fills the viewport', pseudo.on && pseudo.fills && pseudo.bodyLocked,
  `pseudo-fs=${pseudo.on} fills=${pseudo.fills} bodyLocked=${pseudo.bodyLocked}`);
check('the stand-in keeps video AND every overlay', pseudo.overlays, 'hud/dim/zones/controls/video all still inside the stage');
check('it does NOT hand the frame to the native video player', !pseudo.usedNativeVideoFullscreen, 'webkitDisplayingFullscreen is false');
check('the stand-in claims both gesture axes', pseudo.touchAction === 'none', `touch-action = ${pseudo.touchAction}`);

const btn3 = await evalJS(`(() => { const b = document.querySelector('#fsBtn').getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
for (const type of ['mousePressed', 'mouseReleased'])
  await send('Input.dispatchMouseEvent', { type, x: btn3.x, y: btn3.y, button: 'left', clickCount: 1 });
await sleep(600);
const restored = await evalJS(`(() => { const s = document.querySelector('#stage');
  s.requestFullscreen = s._rfs; return {
    on: s.classList.contains('pseudo-fs'),
    bodyLocked: document.body.classList.contains('fs-lock'),
    touchAction: getComputedStyle(s).touchAction,
  }; })()`);
check('leaving the stand-in gives the page back', !restored.on && !restored.bodyLocked && restored.touchAction === 'pan-y',
  `pseudo-fs=${restored.on} bodyLocked=${restored.bodyLocked} touch-action=${restored.touchAction}`);

// ---- iOS: video.volume is read-only --------------------------------------
// Writes are silently ignored there and no flag reports it, so attachTouch
// probes by writing and reading back. Get that wrong and the volume swipe slides
// a readout up and down while nothing happens -- the one gesture that can fail
// without looking broken. Reproduced by making the property genuinely
// unwritable BEFORE the page's modules run, which is why it needs a reload.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  Object.defineProperty(HTMLMediaElement.prototype, 'volume', { configurable: true, get: d.get, set() {} });` });
await send('Page.navigate', { url: 'about:blank' });
await sleep(300);
// Re-apply the phone metrics: they do not survive this second navigation, and
// without it the rest of this section silently runs at the default window width
// (measured: a 693px stage instead of 390px, which still matches the ≤760px
// breakpoint -- so it looks like it passed while testing the wrong thing).
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Page.navigate', { url: `http://localhost:${PORT}/public/play.html?url=x` });
let ready2 = false;
for (let i = 0; i < 50 && !ready2; i++) {
  await sleep(300);
  ready2 = await evalJS(`!!window.touch && !!document.querySelector('.g-hud')`).catch(() => false);
}
if (!ready2) { console.error('the reload for the read-only volume check never booted'); process.exit(1); }

const ro = await evalJS(`(() => {
  const v = document.querySelector('video');
  document.querySelector('#placeholder').style.display = 'none';
  document.querySelector('#vctl').hidden = false;
  v.volume = 0.3;
  const b = document.querySelector('#stage').getBoundingClientRect();
  return { writable: window.touch.volumeWritable, stuck: v.volume, viewport: innerWidth,
           box: { x: b.x, y: b.y, w: b.width, h: b.height } };
})()`);
check('a read-only video.volume is detected', ro.writable === false,
  `volumeWritable=${ro.writable}, volume stayed ${ro.stuck} after writing 0.3`);
check('the reload is still a phone', ro.viewport === 390, `innerWidth = ${ro.viewport}`);

// ...and the gesture says so rather than pretending to work. Measure AFTER the
// state change, never before -- the stage resizes and a stale rect puts the
// touch in the wrong half.
const rb = await evalJS(`(() => { const s = document.querySelector('#stage');
  s.classList.add('pseudo-fs'); document.body.classList.add('fs-lock');
  const b = s.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
await sleep(150);
const rx = rb.x + rb.w * 0.8;
await touch('touchStart', rx, rb.y + rb.h * 0.6);
for (const f of [0.55, 0.45, 0.35, 0.25]) { await touch('touchMove', rx, rb.y + rb.h * f); await sleep(30); }
const roHud = await evalJS(`document.querySelector('.g-hud').textContent`);
await touch('touchEnd', rx, rb.y + rb.h * 0.25);
check('the volume swipe explains itself instead of dying quietly', /侧键/.test(roHud),
  `hud = "${roHud}" (touch at x=${Math.round(rx)} of a ${Math.round(rb.w)}px stage at x=${Math.round(rb.x)})`);

console.log('');
let bad = 0;
for (const r of out) { if (!r.pass) bad++; console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name} -- ${r.detail}`); }
console.log(`\n${out.length - bad}/${out.length} touch checks passed`);
ws.close();
process.exit(bad ? 1 : 0);

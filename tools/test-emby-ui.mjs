// Drives the Emby browse page in a real browser against a stubbed server. Run it
// with:  node tools/test-emby-ui.mjs
//
// Not part of `npm test`, which is pure Node -- this one needs a browser. Like
// tools/test-touch.mjs it may run HEADLESS: nothing here decodes a frame.
//
// It exists for the things a unit test structurally cannot reach:
//
//   * a module-top-level `$('#x').onclick` on an element that was deleted throws
//     during evaluation and silently kills every line after it. The page still
//     renders, so nothing looks wrong until you click something.
//   * the overlay/history bookkeeping (LAYERS + owedPops in emby.html) is only
//     真 correct if a real back press closes the top layer AND leaves the app on
//     the same document. There is no way to assert that without a history stack.
//   * "继续观看 asks per library" is a claim about which URLs get fetched.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// No trailing separator: serve.mjs resolves its root and compares prefixes, and
// a trailing slash puts every request outside it (symptom: the word "forbidden").
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const PORT = Number(process.env.PORT ?? 8087), CDP = 9229;
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'linweb-smoke-'));
const kids = [];
const bye = () => { for (const k of kids) { try { k.kill(); } catch {} } try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', bye);

kids.push(spawn(process.execPath, [join(ROOT, 'tools/serve.mjs'), ROOT],
  { stdio: 'ignore', env: { ...process.env, PORT: String(PORT) } }));
kids.push(spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  // A machine-level proxy answers even localhost through a dead route -- the
  // worker/video fetches the stub cannot intercept then die with
  // "Failed to fetch". The stubbed UI itself never notices; the player page
  // (real bytes, real wasm worker) does. Bypass the proxy outright.
  '--no-proxy-server',
  '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank'], { stdio: 'ignore' }));

let targets = null;
for (let i = 0; i < 40 && !targets; i++) {
  await sleep(400);
  try { targets = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).filter(t => t.type === 'page'); } catch {}
}
if (!targets?.length) { console.error('could not reach Edge on CDP'); process.exit(1); }

const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id != null) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    errors.push('console.error: ' + m.params.args.map(a => a.description || a.value).join(' '));
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

// A whole fake Emby, installed before any page script runs.
const STUB = `
localStorage.setItem('linweb:emby', JSON.stringify({
  home:'http://localhost:${PORT}', server:'http://localhost:${PORT}', token:'T', userId:'U1',
  userName:'tester', policy:{ IsAdministrator:false } }));
localStorage.setItem('linweb:servers', JSON.stringify([
  { url:'http://localhost:${PORT}', line:'http://localhost:${PORT}', token:'T', userId:'U1', userName:'tester' },
  { url:'http://other.test', token:null, userName:'someone' } ]));
window.__calls = [];
const item = (Id, Name, extra) => Object.assign({ Id, Name, Type:'Movie', RunTimeTicks:36000000000,
  ImageTags:{}, UserData:{ PlaybackPositionTicks: 100, LastPlayedDate:'2026-07-25T00:00:00Z' },
  MediaSources:[{ Id:'s1', Container:'mkv', Size:1000, MediaStreams:[
    { Type:'Video', Codec:'hevc', Width:3840, Height:2160 },
    { Type:'Audio', Codec:'eac3', DisplayTitle:'EAC3 5.1' }] }] }, extra);
// R1 carries an EXTERNAL (sidecar) ass subtitle: the regression target of the
// play-handoff assertions below.
const extSubItem = extra => item('R1', '继续看的片', Object.assign({
  MediaSources:[{ Id:'s1', Container:'mkv', Size:1000, MediaStreams:[
    { Type:'Video', Codec:'hevc', Width:3840, Height:2160 },
    { Type:'Audio', Codec:'eac3', DisplayTitle:'EAC3 5.1' },
    { Type:'Subtitle', Codec:'ass', IsExternal:true, Index:2, DisplayTitle:'中文 ASS' }] }] }, extra));
window.__fail401 = null;      // set by the test to expire the session mid-browse
const __realFetch = window.fetch.bind(window);
window.fetch = async (u, opt) => {
  const url = String(u); window.__calls.push(url);
  const p = new URL(url); const q = p.searchParams; let body = {};
  // The video stream itself: hand the player REAL playable bytes (a small MP4
  // served by the dev server) instead of JSON, so loadAny succeeds, render()
  // runs, and the external-subtitle seeding below actually executes.
  if (/\\/Videos\\/[^/]+\\/stream/.test(p.pathname)) return __realFetch('/samples/ext-sub-test.mp4', opt);
  if (window.__fail401 && p.pathname.includes(window.__fail401))
    return { ok:false, status:401, url, json: async () => ({}), text: async () => '' };
  // Eight libraries on purpose, two of them collection types the home page used
  // to filter out (homevideos / musicvideos) and two past the old cap of six.
  if (p.pathname.endsWith('/Views')) body = { Items:[
    {Id:'LIB-A',Name:'电影',CollectionType:'movies',ImageTags:{}},
    {Id:'LIB-B',Name:'剧集',CollectionType:'tvshows',ImageTags:{}},
    {Id:'LIB-C',Name:'动画',CollectionType:'tvshows',ImageTags:{}},
    {Id:'LIB-D',Name:'纪录片',CollectionType:'movies',ImageTags:{}},
    {Id:'LIB-E',Name:'音乐',CollectionType:'music',ImageTags:{}},
    {Id:'LIB-F',Name:'合集',CollectionType:'boxsets',ImageTags:{}},
    {Id:'LIB-G',Name:'家庭视频',CollectionType:'homevideos',ImageTags:{}},
    {Id:'LIB-H',Name:'音乐视频',CollectionType:'musicvideos',ImageTags:{}} ] };
  else if (p.pathname.includes('/Items/Latest')) body = [ item('SER1','一部剧', { Type:'Series' }) ];
  else if (/\\/Seasons$/.test(p.pathname)) body = { Items:[ { Id:'SEA1', Name:'第 1 季', ImageTags:{} } ] };
  else if (/\\/Episodes$/.test(p.pathname)) body = { Items:[ item('EP1','第 1 集', { Type:'Episode', IndexNumber:1 }) ] };
  else if (/\\/Items\\/[^/]+$/.test(p.pathname)) {
    const id = p.pathname.split('/').pop();
    body = id === 'R1' ? extSubItem() : item(id, '详情条目', id.startsWith('SER') ? { Type:'Series' } : {});
  }
  else if (p.pathname.includes('/PlaybackInfo')) body = {
    PlaySessionId:'ps1',
    MediaSources:[{ Id:'s1', Container:'mkv', Size:1000, MediaStreams:[
      { Type:'Video', Codec:'hevc', Width:3840, Height:2160 },
      { Type:'Audio', Codec:'eac3', DisplayTitle:'EAC3 5.1' },
      { Type:'Subtitle', Codec:'ass', IsExternal:true, Index:2, DisplayTitle:'中文 ASS' }] }] };
  else if (p.pathname.endsWith('/Items')) body = { Items:[ extSubItem(), item('R2','另一部') ], TotalRecordCount:2 };
  else if (p.pathname.includes('/Genres')) body = { Items:[] };
  else body = { Items:[] };
  // The subtitle extraction route: a minimal but structurally complete ASS the
  // in-player JASSUB path can parse (the script-info guard checks for it).
  const subText = '[Script Info]\\nTitle: t\\n\\n[V4+ Styles]\\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\\nStyle: Main,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,30,1\\n\\n[Events]\\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\\nDialogue: 0,0:00:01.00,0:00:05.00,Main,,0,0,0,,测试字幕一行\\n';
  return { ok:true, status:200, url, json: async () => body,
           text: async () => p.pathname.includes('/Subtitles/') ? subText : '' };
};`;

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
await send('Page.navigate', { url: `http://localhost:${PORT}/public/emby.html` });

let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  await sleep(300);
  ready = await evalJS(`!document.querySelector('#app').classList.contains('hidden')`).catch(() => false);
}

const out = [];
const check = (name, pass, detail = '') => { out.push({ name, pass, detail }); };

check('the app booted past the login screen', ready,
  await evalJS(`document.querySelector('#login').className`).catch(e => e.message));
check('no uncaught exception or console.error during boot', errors.length === 0, errors.join(' | '));

// --- structure: the account/server merge and the moved theme toggle ---
check('theme toggle now lives in the top bar, not the rail',
  await evalJS(`!!document.querySelector('#topbar #themeBtn') && !document.querySelector('#rail #themeBtn')`));
check('theme toggle is the right-most thing in the top bar',
  await evalJS(`document.querySelector('#topbar').lastElementChild.id === 'themeBtn'`));
check('the old avatar button is gone',
  await evalJS(`!document.querySelector('#avatarBtn')`));
check('the 服务器 tab is visible to a NON-admin account',
  await evalJS(`!document.querySelector('#adminBtn').hidden && getComputedStyle(document.querySelector('#adminBtn')).display !== 'none'`));
check('the rail is a 3-tab bottom bar on a phone',
  await evalJS(`document.querySelectorAll('#rail .navbtn').length === 3`));
check('theme toggle actually flips the theme', await evalJS(`(()=>{
  const before = document.documentElement.dataset.theme || '';
  document.querySelector('#themeBtn').click();
  const after = document.documentElement.dataset.theme || '';
  return before !== after && (after === 'light' || after === 'dark');
})()`));

// --- 继续观看 is scoped per visible library and excludes finished items ---
const resumeCalls = await evalJS(`window.__calls.filter(u => /Filters=IsResumable/.test(u))`);
check('继续观看 asks once per visible library, not once for the server',
  resumeCalls.length === 8, `${resumeCalls.length} call(s)`);
check('every 继续观看 query is scoped to a ParentId',
  resumeCalls.every(u => /ParentId=LIB-/.test(u)), resumeCalls.join(' | '));
check('继续观看 excludes finished items (IsUnplayed)',
  resumeCalls.every(u => /Filters=IsResumable%2CIsUnplayed|Filters=IsResumable,IsUnplayed/.test(u)),
  resumeCalls[0]);

// --- the home page shows EVERY library, under its own name ---
// Both halves were wrong before: a whitelist of collection types dropped the
// home-video and music-video libraries entirely, and .slice(0,6) dropped
// whatever came seventh. Every rail was also prefixed "最近添加 ·", so a
// library called 电影 appeared as 最近添加 · 电影.
const railTitles = await evalJS(`[...document.querySelectorAll('#rails .rail-head h2')].map(h => h.textContent)`);
check('every library gets a rail, past the old cap of six',
  railTitles.length === 9, `${railTitles.length} rail(s): ${railTitles.join(' | ')}`);
check('a rail is named exactly after its library',
  JSON.stringify(railTitles) === JSON.stringify(['继续观看', '电影', '剧集', '动画', '纪录片', '音乐', '合集', '家庭视频', '音乐视频']),
  railTitles.join(' | '));
check('no rail says 最近添加 any more', !railTitles.some(t => t.includes('最近添加')), railTitles.join(' | '));

// --- the account card inside 服务器管理 ---
await evalJS(`document.querySelector('#adminBtn').click()`);
await sleep(500);
check('服务器管理 opens and leads with the account card',
  await evalJS(`document.querySelector('#admGrid').firstElementChild?.id === 'aAccount'`));
check('the account card names the signed-in user',
  await evalJS(`/tester/.test(document.querySelector('#aAccount .an')?.textContent || '')`));
check('the account card lists the remembered servers',
  await evalJS(`document.querySelectorAll('#aAccount [data-srv]').length === 2`));
check('log out lives on the account card now',
  await evalJS(`!!document.querySelector('#acOut')`));

// --- nothing may overflow a 390px phone sideways ---
// The classic "it is just the desktop, smaller" symptom, and the one that is
// invisible on the machine it was written on. Reported per pane so a failure
// names the screen instead of the app.
for (const [view, label] of [['home','首页'], ['library','媒体库'], ['admin','服务器管理']]) {
  await evalJS(`document.querySelector('.navbtn[data-view="${view}"]').click()`);
  await sleep(500);
  const wide = await evalJS(`(()=>{
    const bad = [...document.querySelectorAll('.view-pane.on *')]
      .filter(el => el.getBoundingClientRect().right > innerWidth + 1)
      .map(el => el.className || el.tagName);
    return { doc: document.documentElement.scrollWidth, win: innerWidth, bad: [...new Set(bad)].slice(0,6) };
  })()`);
  check(`${label} does not overflow a 390px phone sideways`,
    wide.doc <= wide.win, `scrollWidth ${wide.doc} > ${wide.win}; offenders: ${wide.bad.join(', ')}`);
}

// --- the system back button ---
await evalJS(`document.querySelector('.navbtn[data-view="home"]').click()`);
await sleep(400);
const depth0 = await evalJS(`history.length`);
await evalJS(`window.__before = location.href; document.querySelectorAll('[data-open]')[0].click()`);
await sleep(600);
check('opening the detail page pushes a history entry',
  await evalJS(`history.length > ${depth0}`), `${depth0} -> ${await evalJS('history.length')}`);
check('detail page is open', await evalJS(`document.querySelector('#detail').classList.contains('open')`));

await evalJS(`history.back()`);
await sleep(500);
check('system back CLOSES the detail page instead of leaving the app',
  await evalJS(`!document.querySelector('#detail').classList.contains('open')`));
check('and the app is still on the same page',
  await evalJS(`location.href === window.__before`));

// back again with nothing open must not throw
await evalJS(`document.querySelectorAll('[data-open]')[0].click()`);
await sleep(500);
await evalJS(`document.querySelector('#dclose').click()`);   // close via the X, not back
await sleep(400);
check('closing with the X also closes it',
  await evalJS(`!document.querySelector('#detail').classList.contains('open')`));
// the X gave its entry back, so the app must still be one back-press from the base
check('closing with X hands the history entry back (no stale entry left)',
  await evalJS(`history.state === null || history.state?.linweb === undefined`),
  JSON.stringify(await evalJS(`history.state`)));

// scroll with no menu open used to be the risky path: closeCtx() -> dismiss()
await evalJS(`document.querySelector('#view').dispatchEvent(new Event('scroll',{bubbles:true}))`);
await sleep(300);
check('a stray closeCtx() with no menu open does not pop history',
  await evalJS(`location.href === window.__before`));

check('still no uncaught exceptions after driving the UI', errors.length === 0, errors.join(' | '));

// --- the external (sidecar) subtitle handoff, end to end -------------------
// R1 carries an external ASS stream. Open its preplay, pick the sub, hit play,
// and the handoff must land on play.html with the ORIGINAL-script URL
// (Stream.ass + subkind=ass) -- then JASSUB must actually draw it. This is the
// feature that used to be flattened into SRT, asserted at the pixel layer.
await evalJS(`document.querySelector('.navbtn[data-view="home"]').click()`);
await sleep(800);
check('home shows a resume card to click',
  await evalJS(`!!document.querySelector('[data-resume]')`),
  await evalJS(`document.querySelector('#rails')?.innerHTML.slice(0, 300) || 'NO RAILS'`));
await evalJS(`document.querySelector('[data-resume]')?.click()`);
await sleep(600);
check('preplay opens for a resume item',
  await evalJS(`document.querySelector('#preplay').classList.contains('open')`));
const subOpts = await evalJS(`[...document.querySelectorAll('#ppChooser .chz')].find(z => z.dataset.k==='sub')?.querySelectorAll('.chopt').length`);
check('the preplay chooser lists the external sub', subOpts === 2, `${subOpts} option(s)`);
await evalJS(`[...document.querySelectorAll('#ppChooser .chz')].find(z => z.dataset.k==='sub').querySelectorAll('.chopt')[1].click()`);
await sleep(200);
await evalJS(`document.querySelector('#ppGo').click()`);
// play() resolves PlaybackInfo then navigates to play.html.
let onPlayer = null;
for (let i = 0; i < 30 && !onPlayer; i++) {
  await sleep(400);
  onPlayer = await evalJS(`location.pathname.endsWith('/play.html') && !!document.querySelector('#video')`).catch(() => false);
}
check('play handed off to play.html', !!onPlayer);
const handoff = await evalJS(`Object.fromEntries([...new URLSearchParams(location.search)].slice(0, 40))`);
check('external ASS travels as the ORIGINAL script (Stream.ass + subkind=ass)',
  /Stream\.ass/.test(handoff.suburl || '') && handoff.subkind === 'ass',
  JSON.stringify({ suburl: handoff.suburl, subkind: handoff.subkind, subidx: handoff.subidx }));
// The <video> has no real bytes behind it in the stub, so drive the picker the
// way a viewer would and assert on the DOM + log instead of pixels.
let subOn = null;
for (let i = 0; i < 25 && !subOn; i++) {
  await sleep(400);
  subOn = await evalJS(`[...document.querySelectorAll('#log div')].some(d => /字幕已开启（外挂 ASS · 特效）/.test(d.textContent))`).catch(() => false);
}
check('the player logs the external ASS as ACTIVE (effects renderer)',
  !!subOn, (await evalJS(`(() => { const v = document.querySelector('#video');
    return [...document.querySelectorAll('#log div')].map(d => d.textContent).join(' | ')
      + ' || PH: ' + document.querySelector('#phText')?.textContent
      + ' || video: rs=' + v?.readyState + ' src=' + (v?.currentSrc || '').slice(0, 60)
      + ' || calls: ' + (window.__calls || []).slice(-4).join(' ; '); })()`).catch(e => 'EVAL ERR ' + e.message)));
check('no uncaught exception on the player page', errors.length === 0, errors.join(' | '));

// Hand the page back to the session-expiry test below, which assumes it is
// standing on emby.html with a fresh document (the stub re-runs, so __calls,
// the session and history all start over -- exactly what that test expects).
await send('Page.navigate', { url: `http://localhost:${PORT}/public/emby.html` });
await sleep(900);

// --- a session that expires UNDER an open overlay ---
// Runs last: it logs the session out. The overlay outliving its session is the
// bug -- #login sits above #detail, so re-logging-in used to reveal the app with
// a detail page welded over it and no way to reach the close button.
await evalJS(`document.querySelectorAll('[data-open]')[0].click()`);
await sleep(600);
const openedSeries = await evalJS(`document.querySelector('#detail').classList.contains('open')`);
await evalJS(`window.__fail401 = '/Episodes'; document.querySelector('#dSeasons .stab').click()`);
await sleep(700);
check('a 401 under an open detail page tears the overlay down with the session',
  openedSeries && await evalJS(`!document.querySelector('#detail').classList.contains('open')
                                && document.querySelector('#login').classList.contains('open')`),
  `detail opened first: ${openedSeries}`);

let bad = 0;
for (const c of out) { console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '  <- ' + c.detail}`); if (!c.pass) bad++; }
console.log(bad ? `\n${bad} failure(s)` : '\nemby.html smoke: all good');
process.exit(bad ? 1 : 0);

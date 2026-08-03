// Drives 一起看 in TWO real browsers against the real relay. Run it with:
//   node tools/test-together-ui.mjs
//
// Not part of `npm test`, which is pure Node -- this one needs a browser, like
// tools/test-emby-ui.mjs and tools/test-touch.mjs. It may run headless: the one
// clip it plays is plain H.264 in mp4, which headless Edge decodes.
//
// TWO BROWSER PROCESSES, NOT TWO TABS. A background tab has its media loading
// throttled, so the second member would sit at readyState 0 forever and every
// sync assertion would be about a video that never started. Two processes each
// have a foreground tab.
//
// tools/test-together.mjs already proves the relay and the frame codec. What
// only a browser can show is the half that lives in the page: that the modules
// evaluate at all (a throw at module top level kills every line after it and
// still renders a page that looks fine), that a room really forms over a real
// socket, and that one browser pressing play moves the picture in the other.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const PORT = Number(process.env.PORT ?? 8091);
const RELAY = Number(process.env.RELAY_PORT ?? 23699);
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const kids = [], profiles = [];
const bye = () => {
  for (const k of kids) { try { k.kill(); } catch {} }
  for (const p of profiles) { try { rmSync(p, { recursive: true, force: true }); } catch {} }
};
process.on('exit', bye);

kids.push(spawn(process.execPath, [join(ROOT, 'tools/serve.mjs'), ROOT],
  { stdio: 'ignore', env: { ...process.env, PORT: String(PORT) } }));
kids.push(spawn(process.execPath, [join(ROOT, 'tools/together-server.mjs')],
  { stdio: 'inherit', env: { ...process.env, PORT: String(RELAY) } }));

/** One browser process with one foreground tab, wrapped in a CDP client. */
async function browser(cdpPort) {
  const profile = mkdtempSync(join(tmpdir(), 'linweb-tg-'));
  profiles.push(profile);
  kids.push(spawn(EDGE, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' }));

  let targets = null;
  for (let i = 0; i < 50 && !targets?.length; i++) {
    await sleep(400);
    try { targets = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).filter(t => t.type === 'page'); } catch {}
  }
  if (!targets?.length) throw new Error(`could not reach Edge on CDP ${cdpPort}`);

  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id != null) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown')
      errors.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
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
  await send('Page.enable'); await send('Runtime.enable');
  return { send, evalJS, errors };
}

const out = [];
const check = (name, pass, detail = '') => { out.push({ name, pass: !!pass, detail }); };
/** Poll until `fn()` is truthy — the room is asynchronous end to end. */
const until = async (fn, ms = 8000) => {
  for (let t = 0; t < ms; t += 150) { const v = await fn().catch(() => null); if (v) return v; await sleep(150); }
  return null;
};

const A = await browser(9251);
const B = await browser(9252);
const ROOM = 'UITEST';
const relayUrl = `ws://127.0.0.1:${RELAY}`;

// The page is opened with no source on purpose: this test is about the room,
// and the clip is attached to the same <video> afterwards. play.html reports a
// missing source and carries on, which is itself worth knowing.
for (const p of [A, B]) await p.send('Page.navigate', { url: `http://localhost:${PORT}/public/play.html` });
for (const p of [A, B]) {
  const ok = await until(() => p.evalJS(`!!document.querySelector('.tgp')`));
  check('the 一起看 card is on the page', ok);
}
check('no uncaught exception while the page evaluated (A)', A.errors.length === 0, A.errors.join(' | '));
check('no uncaught exception while the page evaluated (B)', B.errors.length === 0, B.errors.join(' | '));

// Same clip in both, muted so autoplay policy is never the reason a test fails.
// Wrapped in an arrow: CDP evaluates every expression in the SAME global
// scope, so a top-level `const` here collides with the next evaluate.
for (const p of [A, B]) await p.evalJS(`(() => {
  const v = document.querySelector('#video');
  v.muted = true; v.src = '/samples/native-h264.mp4'; v.load();
  return new Promise(r => v.readyState >= 2 ? r(1) : v.addEventListener('loadeddata', () => r(1), { once: true }));
})()`);
for (const p of [A, B]) check('the sample clip is decodable in this browser',
  await p.evalJS(`document.querySelector('#video').readyState >= 2`));

// Join. tg is the module-scope panel in play.html.
for (const p of [A, B]) await p.evalJS(`tg.join(${JSON.stringify(ROOM)}, ${JSON.stringify(relayUrl)}); 1`);

check('A connected to the relay', await until(() => A.evalJS(`tg.room.connected`)));
check('B connected to the relay', await until(() => B.evalJS(`tg.room.connected`)));
check('both see two members', await until(async () =>
  await A.evalJS(`tg.room.members.length`) === 2 && await B.evalJS(`tg.room.members.length`) === 2));
check('exactly one of them is the host', await until(async () =>
  (await A.evalJS(`tg.room.isHost`) ? 1 : 0) + (await B.evalJS(`tg.room.isHost`) ? 1 : 0) === 1));
check('the clock offset got estimated', await until(() => A.evalJS(`tg.room.rtt !== null`)));
check('the member list is rendered, not just held',
  await until(() => A.evalJS(`document.querySelectorAll('.tgp-who > div').length === 2`)));

// Chat.
await A.evalJS(`tg.room.sendChat('喂喂', 12.5); 1`);
check('a chat message crosses the relay',
  await until(() => B.evalJS(`tg.chat.some(c => c.text === '喂喂' && Math.abs(c.pos - 12.5) < 0.01)`)));
check('it is rendered with its playback time',
  await until(() => B.evalJS(`[...document.querySelectorAll('.tgp-log p')].some(p => p.textContent.includes('0:12') && p.textContent.includes('喂喂'))`)));

// Playback. Whoever presses play, the other one follows.
// The .catch is the test's, not the player's: pausing while a play() promise is
// still pending rejects it with AbortError, and an uncaught one here would show
// up as a page exception that the page did not cause.
await A.evalJS(`(() => { const v = document.querySelector('#video'); v.currentTime = 3; v.play().catch(() => {}); return 1; })()`);
check('B is told the room is playing',
  await until(() => B.evalJS(`tg.sync.state && tg.sync.state.paused === false`)));
check('B started playing without being touched',
  await until(() => B.evalJS(`!document.querySelector('#video').paused`)));
check('B landed near A, not at zero', await until(async () => {
  const [a, b] = [await A.evalJS(`document.querySelector('#video').currentTime`),
                  await B.evalJS(`document.querySelector('#video').currentTime`)];
  return Math.abs(a - b) < 1.5;
}), `A=${await A.evalJS(`document.querySelector('#video').currentTime`).catch(() => '?')} B=${await B.evalJS(`document.querySelector('#video').currentTime`).catch(() => '?')}`);

await A.evalJS(`document.querySelector('#video').pause(); 1`);
check('a pause in A pauses B', await until(() => B.evalJS(`document.querySelector('#video').paused`)));

// Leaving.
await A.evalJS(`tg.leave(); 1`);
check('B sees the room shrink', await until(() => B.evalJS(`tg.room.members.length === 1`)));
check('B is now the host, so the room still has one',
  await until(() => B.evalJS(`tg.room.isHost`)));

check('still no uncaught exception at the end (A)', A.errors.length === 0, A.errors.join(' | '));
check('still no uncaught exception at the end (B)', B.errors.length === 0, B.errors.join(' | '));

let bad = 0;
for (const r of out) { if (!r.pass) bad++; console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : `  (${r.detail})`}`); }
console.log(bad ? `\n${bad} TOGETHER UI CHECK(S) FAILED` : '\nALL TOGETHER UI CHECKS PASSED');
process.exit(bad ? 1 : 0);

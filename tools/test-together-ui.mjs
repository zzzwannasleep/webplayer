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
// Printed as it happens, not only in the summary. Anything that throws
// mid-run -- a page that navigated away, a function that is not there in the
// version under test -- used to take every result collected so far with it,
// which is the opposite of what you want from the run that just broke.
const check = (name, pass, detail = '') => {
  out.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${pass || !detail ? '' : `  (${detail})`}`);
};
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

// THE HOST PAUSING ITSELF.
// `waiting` fires whenever the element runs out of data, which for the remux
// pipeline is routine: a seek, a GOP boundary, a fill throttle. That goes out
// as "I am buffering", the relay sends it to everyone INCLUDING the sender,
// and the sender's own hold pauses it. That much is harmless -- it was already
// stalled. What is not harmless is the `pause` event that pause() then fires:
// if it escapes the suppression window it goes out as a state frame, and now
// the room is not held, it is genuinely paused, by nobody. Do it while the
// picture is moving, because that is when a viewer notices.
await A.evalJS(`(() => {
  window.__out = [];
  const s = tg.room.sendState.bind(tg.room);
  tg.room.sendState = f => { window.__out.push(f); return s(f); };
  const v = document.querySelector('#video');
  v.currentTime = 2; v.play().catch(() => {});
  return 1;
})()`);
await until(() => A.evalJS(`!document.querySelector('#video').paused`));
await A.evalJS(`window.__out = []; 1`);
for (let i = 0; i < 3; i++) {
  await A.evalJS(`document.querySelector('#video').dispatchEvent(new Event('waiting')); 1`);
  await sleep(300);
  await A.evalJS(`document.querySelector('#video').dispatchEvent(new Event('playing')); 1`);
  await sleep(300);
}
check('the panel names who the room is waiting for',
  await B.evalJS(`(() => {
    tg.sync.waiters = [tg.room.id]; tg.paint();
    const on = [...document.querySelectorAll('.tgp-who .tag')].some(t => t.textContent === '缓冲中');
    tg.sync.waiters = []; tg.paint();
    return on;
  })()`));

check('the host buffering does not broadcast a pause to the room',
  (await A.evalJS(`window.__out.filter(f => f.paused).length`)) === 0,
  `it sent ${JSON.stringify(await A.evalJS(`window.__out`).catch(() => '?'))}`);
check('the host is still playing after its own buffer stalls',
  await until(() => A.evalJS(`!document.querySelector('#video').paused`)));
check('B was not left paused by the host\'s stall',
  await until(() => B.evalJS(`!document.querySelector('#video').paused`)));

// THE REPORTED FAILURE, in the two browsers that are the only place it showed
// up: one member cannot open the film at all -- wrong account, dead link, a
// source this browser will not decode. It reads paused-at-zero, because that is
// what an empty <video> reads, and it used to broadcast that as if a person had
// pressed pause. The host was dragged back to the start and stopped, over and
// over, and the member never saw a picture. Neither browser was doing anything
// wrong, which is why it was so hard to see from one of them.
// A source that EXISTS and does not work, which is the shape the real one had:
// an Emby link the other account cannot read, a codec this browser will not
// decode, a line that 404s. An element with no src at all is not the same
// thing -- play() there simply stays pending and says nothing, so it never
// reproduced anything.
// Watch what B actually puts on the wire. This is the observable the bug is
// made of: everything else downstream (the host jumping to 0, the host
// pausing) is other people obeying these frames.
await B.evalJS(`(() => {
  window.__sent = [];
  const send = tg.room.sendState.bind(tg.room);
  tg.room.sendState = s => { window.__sent.push(s); return send(s); };
  const wait = tg.room.sendWait.bind(tg.room);
  tg.room.sendWait = w => { window.__sent.push({ wait: w }); return wait(w); };
  return 1;
})()`);
await B.evalJS(`(() => {
  const v = document.querySelector('#video');
  v.pause(); v.src = '/samples/no-such-film.mp4'; v.load();
  return 1;
})()`);
check('B really has nothing loaded now', await until(() => B.evalJS(`document.querySelector('#video').readyState === 0`)));

await A.evalJS(`(() => { const v = document.querySelector('#video'); v.currentTime = 5; v.play().catch(() => {}); return 1; })()`);
check('A is playing', await until(() => A.evalJS(`!document.querySelector('#video').paused`)));

// Give the empty member every chance to misbehave: it is told to play, it
// fails, it buffers, it fails again.
for (let i = 0; i < 3; i++) {
  await B.evalJS(`(() => { const v = document.querySelector('#video'); v.play().catch(() => {}); return 1; })()`);
  await sleep(400);
}
// The invariant, stated directly: a member with no film has nothing true to
// say about where the film is, so it must say nothing at all.
check('the empty member put nothing on the wire',
  (await B.evalJS(`window.__sent.length`)) === 0,
  `it sent ${JSON.stringify(await B.evalJS(`window.__sent`).catch(() => '?'))}`);

check('the empty member did not drag the host back to the start',
  await A.evalJS(`document.querySelector('#video').currentTime > 4`),
  `A is at ${await A.evalJS(`document.querySelector('#video').currentTime`).catch(() => '?')}`);
check('the empty member did not pause the host',
  !(await A.evalJS(`document.querySelector('#video').paused`)));
check('the empty member did not freeze the room in a buffer wait',
  !(await A.evalJS(`tg.sync.waiting`)));

// And it is not silently stuck either: it knows where the room is, so the panel
// can say so and the moment it gets a source it lands in the right place.
check('the empty member still tracks the room position',
  await B.evalJS(`tg.sync.target() > 4`));

// Sharing what the room is watching. play.html was opened with no query string
// here, so there is no descriptor to send -- the room degrades to position-only
// sync, and that must not throw. Then a real descriptor is pushed through the
// relay and B is told about it.
check('a page with no source describes nothing rather than throwing',
  await A.evalJS(`tg.media.describe() === null`));
await A.evalJS(`tg.sync.shareMedia({ href: '/public/play.html?url=%2Fsamples%2Fnative-h264.mp4&title=%E7%89%87%E5%AD%90',
                                     want: { title: '片子', url: '/samples/native-h264.mp4' } }); 1`);
check('B is told what the room is watching',
  await until(() => B.evalJS(`tg.sync.media && tg.sync.media.want.title === '片子'`)));
check('B, which has nothing open, is sent to it',
  await until(() => B.evalJS(`location.search.includes('native-h264')`), 6000),
  `B is at ${await B.evalJS(`location.pathname + location.search`).catch(() => '?')}`);
check('B kept the room in its address, so the navigation did not drop it',
  await B.evalJS(`location.hash.includes('together=${ROOM}')`));
check('B rejoined the room by itself after navigating',
  await until(() => B.evalJS(`tg.room.connected`), 8000));

// What was said survives the navigation. B was sent to a new URL a moment ago,
// which reloads the page -- and before sessionStorage that wiped the chat every
// time the room changed episode, which is exactly when people are talking.
check('B still has what was said before it was sent to the new source',
  await until(() => B.evalJS(`tg.chat.some(c => c.text === '喂喂')`), 6000),
  `B has ${JSON.stringify(await B.evalJS(`tg.chat.map(c => c.text)`).catch(() => '?'))}`);

// The fullscreen mini bar. It has to be INSIDE the stage: the stage is what
// goes fullscreen, so anything left in the sidebar is off screen there.
check('the mini bar lives inside the stage, not the sidebar',
  await A.evalJS(`!!document.querySelector('#stage > .tgm')`));
check('it is switched on while in a room', await A.evalJS(`document.querySelector('.tgm').classList.contains('on')`));
// The last few lines, not all of them -- it is a strip over a picture, so it
// shows what was just said and lets the sidebar keep the history.
await B.evalJS(`tg.room.sendChat('全屏也看得见吧', 60); 1`);
check('it carries what was just said',
  await until(() => A.evalJS(`[...document.querySelectorAll('.tgm-log p')].some(p => p.textContent.includes('全屏也看得见吧'))`)));
check('it does not try to be the whole history',
  await A.evalJS(`document.querySelectorAll('.tgm-log p').length <= 4`));
check('it names who the room is waiting for', await A.evalJS(`(() => {
  tg.sync.waiters = [...tg.room.members.map(m => m.id)]; tg.paint();
  const on = [...document.querySelectorAll('.tgm-who .buf')].some(s => s.textContent.includes('缓冲'));
  tg.sync.waiters = []; tg.paint();
  return on;
})()`));
// Typing a message with a space in it must not also pause the film.
check('keys typed into the mini bar do not reach the player', await A.evalJS(`(() => {
  let leaked = false;
  const spy = () => { leaked = true; };
  document.addEventListener('keydown', spy);
  const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  document.querySelector('.tgm-say').dispatchEvent(ev);
  document.removeEventListener('keydown', spy);
  return !leaked;
})()`));

// A room with a password turns away whoever does not have it, and says so
// rather than dropping the connection and letting the page guess.
await A.evalJS(`tg.leave(); 1`);
await B.evalJS(`tg.leave(); 1`);
await sleep(300);
await A.evalJS(`tg.join('LOCKED', ${JSON.stringify(relayUrl)}, 'kaimen'); 1`);
check('a passworded room opens', await until(() => A.evalJS(`tg.room.connected`)));
await B.evalJS(`tg.join('LOCKED', ${JSON.stringify(relayUrl)}, 'wrong'); 1`);
check('the wrong password does not get in', await until(() => B.evalJS(`tg.room.status === 'closed'`)));
check('and the panel says so in words', await until(() =>
  B.evalJS(`tg.chat.some(c => c.sys && c.text.includes('密码'))`)));
check('and puts the password field in front of you',
  await B.evalJS(`!document.querySelector('.tgp-row [placeholder="房间密码"]').closest('.tgp-row').hidden`));
check('a wrong password does not retry forever',
  await B.evalJS(`tg.room._closing === true`));
await B.evalJS(`tg.join('LOCKED', ${JSON.stringify(relayUrl)}, 'kaimen'); 1`);
check('the right password gets in', await until(() => B.evalJS(`tg.room.connected`)));
check('and both are in the same room', await until(() => B.evalJS(`tg.room.members.length === 2`)));
check('the invite link carries the password', await B.evalJS(`tg._inviteHash().includes('pass=kaimen')`));

// Leaving.
await A.evalJS(`tg.leave(); 1`);
check('B sees the room shrink', await until(() => B.evalJS(`tg.room.members.length === 1`)));
check('B is now the host, so the room still has one',
  await until(() => B.evalJS(`tg.room.isHost`)));

check('still no uncaught exception at the end (A)', A.errors.length === 0, A.errors.join(' | '));
check('still no uncaught exception at the end (B)', B.errors.length === 0, B.errors.join(' | '));

const bad = out.filter(r => !r.pass);
for (const r of bad) console.log(`  FAIL  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
console.log(bad.length ? `\n${bad.length} TOGETHER UI CHECK(S) FAILED` : `\nALL TOGETHER UI CHECKS PASSED (${out.length})`);
process.exit(bad.length ? 1 : 0);

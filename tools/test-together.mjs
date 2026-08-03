// 一起看: the relay protocol and the hand-rolled websocket framing.
//
// Two halves, because they fail in different ways. The Relay is pure and gets
// driven with fake connections -- membership, host election, the wait lockstep
// and the fact that SDP never goes anywhere but its addressee. The framing gets
// a real TCP socket against the real server, because a frame codec that is
// wrong by one byte still looks right in a unit test that uses its own encoder
// to build the input.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { Relay } from '../src/together/relay.js';
import { server, rooms, frame, unframe, GUID } from './together-server.mjs';

let n = 0;
const check = (label, fn) => { fn(); n++; console.log(`  PASS  ${label}`); };

/** What a browser puts on the wire: a text frame, always masked, RFC 6455 §5. */
const mask = payload => {
  const key = randomBytes(4);
  const body = Buffer.from(payload);
  const len = body.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xfe; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0xff; head.writeBigUInt64BE(BigInt(len), 2); }
  for (let i = 0; i < len; i++) body[i] ^= key[i & 3];
  return Buffer.concat([head, key, body]);
};

// --- Relay ------------------------------------------------------------------

console.log('=== relay ===');
const conn = name => ({ name, box: [], send(m) { this.box.push(m); }, last(t) { return [...this.box].reverse().find(x => x.t === t); } });

{
  const r = new Relay();
  const a = conn('a'), b = conn('b');
  r.message(a, { t: 'hello', name: '甲' });
  r.message(b, { t: 'hello', name: '乙' });

  const wa = a.last('welcome'), wb = b.last('welcome');
  check('first in gets a welcome with an id', () => assert.ok(wa.you));
  check('first in is the host', () => assert.equal(wa.host, wa.you));
  check('second in is told the same host', () => assert.equal(wb.host, wa.you));
  check('second in sees both members', () => assert.equal(wb.members.length, 2));
  check('the first is told somebody joined', () => assert.equal(a.last('join').member.name, '乙'));
  check('nobody is told about their own join', () => assert.equal(b.last('join'), undefined));

  // State is stamped by the relay, not the sender: it is the only clock every
  // member has measured an offset against.
  r.message(b, { t: 'state', paused: false, pos: 42.5, rate: 1, seq: 1 });
  check('state reaches the other member', () => assert.equal(a.last('state').pos, 42.5));
  check('state is echoed to the sender too', () => assert.equal(b.last('state').pos, 42.5));
  check('state carries a relay timestamp', () => assert.ok(a.last('state').s > 0));
  check('state is attributed to its sender', () => assert.equal(a.last('state').from, wb.you));
  check('a state frame with no position is ignored', () => {
    const before = a.box.length;
    r.message(b, { t: 'state', paused: false, pos: 'soon' });
    assert.equal(a.box.length, before);
  });

  // A joiner arriving after the fact must be handed the room's position, or it
  // sits at 0 until the next anchor.
  const c = conn('c');
  r.message(c, { t: 'hello', name: '丙' });
  check('a late joiner is seeded with the last state', () => assert.equal(c.last('welcome').state.pos, 42.5));

  // Signalling is point to point. SDP describes the sender's network, so
  // broadcasting it would hand every member's candidates to the whole room.
  r.message(a, { t: 'signal', to: wb.you, data: { sdp: 'x' } });
  check('a signal reaches its addressee', () => assert.equal(b.last('signal').data.sdp, 'x'));
  check('a signal reaches nobody else', () => assert.equal(c.last('signal'), undefined));

  // The wait lockstep.
  r.message(c, { t: 'wait', waiting: true });
  check('a buffering member puts the room in wait', () => assert.deepEqual(a.last('wait').waiters, [c.last('welcome').you]));
  check('repeating the same wait state is not re-broadcast', () => {
    const before = a.box.length;
    r.message(c, { t: 'wait', waiting: true });
    assert.equal(a.box.length, before);
  });
  r.message(c, { t: 'wait', waiting: false });
  check('the room comes out of wait', () => assert.deepEqual(a.last('wait').waiters, []));

  // The host leaving must hand the seat on: nobody else re-anchors the room or
  // releases a wait.
  r.message(c, { t: 'wait', waiting: true });
  r.leave(c);
  check('a member that leaves mid-buffer stops holding the room',
    () => assert.deepEqual(a.last('wait').waiters, []));
  r.leave(a);
  check('the host seat moves when the host leaves', () => assert.equal(b.last('leave').host, wb.you));
  check('the room shrinks', () => assert.equal(r.size, 1));
}

{
  const r = new Relay();
  const a = conn('a'), b = conn('b');
  r.message(a, { t: 'hello', name: 'a' });
  r.message(b, { t: 'hello', name: 'b' });
  r.message(b, { t: 'claim' });
  check('anyone can claim the host seat', () => assert.equal(a.last('host').host, b.last('welcome').you));
  check('an unknown frame type is ignored, not fatal', () => assert.equal(r.message(a, { t: 'nonsense' }), false));
  check('a frame before hello is ignored', () => assert.equal(r.message(conn('x'), { t: 'chat', text: 'hi' }), false));
  r.message(a, { t: 'chat', text: 'x'.repeat(9999) });
  check('chat is length-capped', () => assert.equal(b.last('chat').text.length, 500));
  r.message(a, { t: 'ping', c: 12345 });
  check('ping is answered with the relay clock', () => {
    const p = a.last('pong');
    assert.equal(p.c, 12345); assert.ok(p.s > 0);
  });
}

// --- what the room is watching ----------------------------------------------
// The relay remembers it exactly like a state frame, because a member who joins
// late needs to be told WHICH film the playhead refers to before the playhead
// means anything.

console.log('\n=== media ===');
{
  const r = new Relay();
  const a = conn('a'), b = conn('b');
  r.message(a, { t: 'hello', name: '甲' });
  r.message(b, { t: 'hello', name: '乙' });

  r.message(a, { t: 'media', href: '/play.html?url=x', want: { id: '77', title: '片子' } });
  check('a media frame reaches the other member', () => assert.equal(b.last('media').want.id, '77'));
  check('a media frame is attributed to its sender', () => assert.equal(b.last('media').from, a.last('welcome').you));

  const c = conn('c');
  r.message(c, { t: 'hello', name: '丙' });
  check('a late joiner is told what the room is watching',
    () => assert.equal(c.last('welcome').media.want.title, '片子'));
  check('an empty media frame is ignored', () => assert.equal(r.message(a, { t: 'media' }), false));
  r.message(a, { t: 'media', href: 'x'.repeat(9999) });
  check('href is length-capped', () => assert.equal(b.last('media').href.length, 4096));
  check('a non-object want is refused rather than forwarded',
    () => assert.equal(r.message(a, { t: 'media', want: 'nope' }), false));
}

// --- playback sync ----------------------------------------------------------
// The half that decides what to DO with a state frame, driven against a fake
// element. This is where the reported failure lived: a member who could not
// open the film still answered "paused, at 0", and every other member obeyed —
// so the host appeared to pause itself at random and the member never saw a
// picture. The checks below are the invariants that stop that, so they are
// written as "says nothing", not as "produces the right frame".

console.log('\n=== playback sync ===');
{
  const { PlaybackSync } = await import('../src/together/sync.js');

  /** A <video> that fires its events the way a browser does — synchronously
   *  from inside the call that caused them, which is the ordering the old
   *  setTimeout(…, 0) suppression could not survive. */
  class FakeVideo {
    constructor(readyState = 4) {
      this.readyState = readyState;         // 0 = nothing was ever loaded
      this.paused = true; this.playbackRate = 1; this.duration = 3600;
      this.playFails = null;                // e.g. 'NotAllowedError'
      this._t = 0; this._h = {};
    }
    get currentTime() { return this._t; }
    set currentTime(v) { this._t = v; this.emit('seeking'); }
    addEventListener(ev, fn) { (this._h[ev] ??= []).push(fn); }
    removeEventListener(ev, fn) { this._h[ev] = (this._h[ev] ?? []).filter(f => f !== fn); }
    emit(ev) { for (const fn of [...(this._h[ev] ?? [])]) fn(); }
    pause() { if (this.paused) return; this.paused = true; this.emit('pause'); }
    play() {
      if (this.playFails) {
        // Chrome pauses the element and fires `pause` BEFORE the promise
        // rejects. That event is the one that used to reach the room.
        this.paused = true; this.emit('pause');
        return Promise.reject(Object.assign(new Error('blocked'), { name: this.playFails }));
      }
      if (this.paused) { this.paused = false; this.emit('play'); }
      return Promise.resolve();
    }
  }

  const fakeRoom = ({ host = false } = {}) => ({
    id: 'me', host: host ? 'me' : 'them', connected: true, sent: [],
    get isHost() { return this.host === this.id; },
    now() { return Date.now(); },
    nameOf(id) { return id; },
    sendState(s) { this.sent.push({ t: 'state', ...s }); return true; },
    sendWait(w) { this.sent.push({ t: 'wait', waiting: w }); return true; },
    sendMedia(m) { this.sent.push({ t: 'media', ...m }); return true; },
    said(t) { return this.sent.filter(x => x.t === t); },
  });

  const rig = (opts = {}) => {
    const v = new FakeVideo(opts.readyState ?? 4);
    const room = fakeRoom(opts);
    const sync = new PlaybackSync(v, room, { log: () => {} });
    sync.start();
    room.sent.length = 0;                   // the host seeds one frame on start
    return { v, room, sync };
  };

  // THE REPORTED BUG. A member who never got a picture — no source, wrong
  // account, dead link — is handed the room's position and told it is playing.
  {
    const { v, room, sync } = rig({ readyState: 0 });
    sync.onMessage({ t: 'state', from: 'them', paused: false, pos: 1200, rate: 1, seq: 1, s: Date.now() });
    check('a member with nothing loaded never answers with a state frame',
      () => assert.deepEqual(room.said('state'), []));
    check('a member with nothing loaded is not dragged to the room position',
      () => assert.equal(v.currentTime, 0));
    check('a member with nothing loaded still knows where the room is',
      () => assert.ok(Math.abs(sync.target() - 1200) < 1));
    // …and it must not hold the room hostage either.
    v.emit('waiting');
    check('an empty player does not put the room in a buffer wait',
      () => assert.deepEqual(room.said('wait'), []));
    sync.stop();
  }

  // The same member, but the film IS loaded and autoplay is what refuses. The
  // rejection fires `pause` synchronously; it is still ours, not a person's.
  {
    const { v, room, sync } = rig();
    v.playFails = 'NotAllowedError';
    sync.onMessage({ t: 'state', from: 'them', paused: false, pos: 5, rate: 1, seq: 1, s: Date.now() });
    check('a blocked autoplay does not broadcast a pause back to the room',
      () => assert.deepEqual(room.said('state'), []));
    sync.stop();
  }

  // Adopting somebody else's frame must never bounce back: two members echoing
  // each other is a room that pauses itself forever.
  {
    const { v, room, sync } = rig();
    v.paused = false; v._t = 100;
    sync.onMessage({ t: 'state', from: 'them', paused: true, pos: 100, rate: 1, seq: 1, s: Date.now() });
    check('adopting a remote pause pauses the element', () => assert.equal(v.paused, true));
    check('adopting a remote pause does not echo a frame', () => assert.deepEqual(room.said('state'), []));

    sync.onMessage({ t: 'state', from: 'them', paused: true, pos: 900, rate: 1, seq: 2, s: Date.now() });
    check('adopting a remote seek moves the playhead', () => assert.equal(v.currentTime, 900));
    check('adopting a remote seek does not echo a frame', () => assert.deepEqual(room.said('state'), []));
    sync.stop();
  }

  // A real person pressing pause still has to reach the room, or the fix has
  // simply broken the feature.
  {
    const { v, room, sync } = rig();
    v.paused = false; v._t = 42;
    v.pause();
    check('a person pressing pause does reach the room', () => assert.equal(room.said('state').length, 1));
    check('the frame carries the real position', () => assert.equal(room.said('state')[0].pos, 42));
    check('the frame says paused', () => assert.equal(room.said('state')[0].paused, true));
    sync.stop();
  }

  // The drift correction writes playbackRate every tick. Each write used to
  // become a state frame, so a member that was merely 200ms behind re-anchored
  // the whole room twice a second.
  {
    const { v, room, sync } = rig();
    v.paused = false; v._t = 0;
    // 1s behind: inside the nudge window (80ms…2500ms), so it is absorbed by
    // speeding up rather than by a seek.
    sync.state = { paused: false, pos: 1, rate: 1, at: Date.now(), from: 'them' };
    sync._correct();
    check('a member that is behind speeds up', () => assert.ok(v.playbackRate > 1));
    check('a drift nudge puts nothing on the wire', () => assert.deepEqual(room.said('state'), []));
    sync.stop();
  }

  // A speed the viewer actually chose is a different thing and must be shared.
  {
    const { room, sync } = rig();
    sync.setRate(1.5);
    check('a speed the viewer picked is broadcast', () => assert.equal(room.said('state')[0]?.rate, 1.5));
    sync.stop();
  }

  // Waiting for a straggler is right. Waiting forever is the deadlock that
  // froze the host with no explanation on screen.
  {
    const { v, room, sync } = rig({ host: true });
    v.paused = false;
    sync.onMessage({ t: 'wait', from: 'slowpoke', waiting: true, waiters: ['slowpoke'] });
    check('the room holds for a buffering member', () => assert.equal(v.paused, true));
    check('the hold is visible', () => assert.equal(sync.waiting, true));

    const real = Date.now;
    try {
      Date.now = () => real() + 21_000;      // past HOLD_MAX_MS
      sync._correct();
      check('a straggler that never arrives stops holding the room',
        () => assert.equal(sync.waiting, false));
      // …and a repeat of the stale waiter list does not re-freeze it.
      sync.onMessage({ t: 'wait', from: 'slowpoke', waiting: true, waiters: ['slowpoke'] });
      check('the given-up member cannot re-hold the room', () => assert.equal(sync.waiting, false));
    } finally { Date.now = real; }

    sync.onMessage({ t: 'wait', from: 'slowpoke', waiting: false, waiters: [] });
    sync.onMessage({ t: 'wait', from: 'slowpoke', waiting: true, waiters: ['slowpoke'] });
    check('a member that recovers is waited for again', () => assert.equal(sync.waiting, true));
    sync.stop();
  }

  // The descriptor half: what the room is watching, kept apart from where it is.
  {
    const { room, sync } = rig({ host: true });
    sync.shareMedia({ href: '/play.html?url=x', want: { id: '9', title: '片子' } });
    check('the host can say what it is watching', () => assert.equal(room.said('media')[0].want.id, '9'));
    sync.onMessage({ t: 'media', from: 'them', href: '/play.html?url=y', want: { id: '12', title: '别的' } });
    check('a member learns what the room switched to', () => assert.equal(sync.media.want.id, '12'));
    check('the media frame does not disturb the playhead', () => assert.equal(sync.state, null));
    sync.stop();
  }
}

// --- what the viewer is allowed to paste ------------------------------------
// A relay hands out an https:// address (Cloudflare prints one, a tunnel prints
// one), and people paste what they were given. Every shape below is something
// a real deployment actually prints.

console.log('\n=== relay address ===');
{
  const { Room } = await import('../src/together/room.js');
  globalThis.location = { protocol: 'https:' };
  const at = (url, code = 'ABC123') => Object.assign(new Room(), { url, code })._wsUrl();

  check('https:// becomes wss://', () => assert.equal(at('https://a.workers.dev'), 'wss://a.workers.dev/room/ABC123'));
  check('http:// becomes ws://', () => assert.equal(at('http://192.168.1.9:31614'), 'ws://192.168.1.9:31614/room/ABC123'));
  check('wss:// is left alone', () => assert.equal(at('wss://a.example/x'), 'wss://a.example/x/room/ABC123'));
  check('ws:// is left alone', () => assert.equal(at('ws://a.example'), 'ws://a.example/room/ABC123'));
  check('a trailing slash does not double up', () => assert.equal(at('https://a.workers.dev//'), 'wss://a.workers.dev/room/ABC123'));
  check('surrounding whitespace is trimmed', () => assert.equal(at('  https://a.workers.dev  '), 'wss://a.workers.dev/room/ABC123'));
  // A scheme-less host takes the PAGE's scheme. Guessing ws:// on an https page
  // would only produce a mixed-content error that says nothing useful.
  check('a bare host on an https page gets wss://', () => assert.equal(at('a.example:31614'), 'wss://a.example:31614/room/ABC123'));
  globalThis.location = { protocol: 'http:' };
  check('a bare host on an http page gets ws://', () => assert.equal(at('192.168.1.9:31614'), 'ws://192.168.1.9:31614/room/ABC123'));
  check('a room code is percent-encoded, not injected raw',
    () => assert.equal(at('ws://a.example', 'a/b?c'), 'ws://a.example/room/a%2Fb%3Fc'));
  delete globalThis.location;
}

// --- what the one-command launcher prints -----------------------------------
// The launcher's whole job is to end with a correct address on screen, so the
// two things that decide which address that is get checked here rather than by
// running it and reading the box.

console.log('\n=== launcher ===');
{
  const { localAddresses, displayWidth, stopHint, saidYes, DEFAULT_PORT } = await import('./together-deploy.mjs');

  // The site is on 23685. Two things fighting over one port fails in the least
  // helpful way -- whichever loses simply is not there.
  check('the relay does not default to the site port', () => {
    assert.equal(DEFAULT_PORT, 31614);
    assert.notEqual(DEFAULT_PORT, 23685);
  });

  const ifaces = {
    'lo':        [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    'docker0':   [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    'eth0':      [{ family: 'IPv4', address: '192.168.1.9', internal: false }],
    'eth1':      [{ family: 'IPv4', address: '203.0.113.7', internal: false }],
    'wlan0':     [{ family: 'IPv4', address: '169.254.10.2', internal: false }],
    'VPN':       [{ family: 'IPv4', address: '198.18.0.1', internal: false }],
    'eth0:ipv6': [{ family: 'IPv6', address: 'fe80::1', internal: false }],
  };
  const picked = localAddresses(ifaces).map(a => a.address);
  check('loopback is not offered as an address', () => assert.ok(!picked.includes('127.0.0.1')));
  check('IPv6 is left out', () => assert.ok(!picked.some(a => a.includes(':'))));
  // 169.254.x is what an OS invents when DHCP failed. Printing it sends someone
  // off to debug the relay when the machine has no working network at all.
  check('a self-assigned 169.254 address is left out', () => assert.ok(!picked.some(a => a.startsWith('169.254'))));
  // RFC 2544 benchmarking space. Real machines only have one of these because a
  // VPN client invented a fake adapter, and it was outranking the real LAN card.
  check('a 198.18 VPN pseudo-address is left out', () => assert.ok(!picked.some(a => a.startsWith('198.18'))));
  check('a real LAN address comes first', () => assert.equal(picked[0], '192.168.1.9'));
  // docker0 is a private address too, so the private-first rule alone would
  // float it to the top on any server running Docker.
  check('a docker bridge sinks below the real ones', () => assert.equal(picked.at(-1), '172.17.0.1'));
  check('no interfaces at all is not a crash', () => assert.deepEqual(localAddresses({}), []));

  check('CJK counts as two columns so the box does not skew',
    () => { assert.equal(displayWidth('一起看'), 6); assert.equal(displayWidth('abc'), 3); });

  // Backgrounding it is only half the job: "how do I stop it" is the same
  // platform-specific knowledge the prompt exists to spare people.
  check('the stop command matches the platform', () => {
    assert.equal(stopHint(4321, 'win32'), 'taskkill /PID 4321 /F');
    assert.equal(stopHint(4321, 'linux'), 'kill 4321');
  });

  // Enter must mean no. Backgrounding a process is the answer that is harder
  // to undo, so it does not get to be the one you fall into by pressing return.
  for (const yes of ['y', 'Y', 'yes', 'YES', ' y ', '是']) {
    check(`"${yes}" means yes`, () => assert.equal(saidYes(yes), true));
  }
  for (const no of ['', ' ', 'n', 'no', 'N', undefined, null, 'yeah', 'sure', '\n']) {
    check(`${JSON.stringify(no)} does not mean yes`, () => assert.equal(saidYes(no), false));
  }
}

// --- frame codec ------------------------------------------------------------

console.log('\n=== websocket framing ===');
{
  // Round-trip through the real client masking, which is the thing the server
  // has to undo. Sizes chosen to cross both length-encoding boundaries.
  for (const size of [0, 5, 125, 126, 1000, 70000]) {
    const text = 'x'.repeat(size);
    const { frames, rest, fatal } = unframe(mask(Buffer.from(text, 'utf8')));
    check(`a ${size}-byte masked frame decodes`, () => {
      assert.equal(fatal, null);
      assert.equal(frames.length, 1);
      assert.equal(frames[0].payload.toString('utf8'), text);
      assert.equal(rest.length, 0);
    });
  }
  check('a partial frame is left in the buffer, not mis-decoded', () => {
    const full = mask(Buffer.from('hello'));
    const { frames, rest } = unframe(full.subarray(0, full.length - 2));
    assert.equal(frames.length, 0);
    assert.equal(rest.length, full.length - 2);
  });
  check('two frames in one chunk both decode', () => {
    const { frames } = unframe(Buffer.concat([mask(Buffer.from('a')), mask(Buffer.from('bb'))]));
    assert.deepEqual(frames.map(f => f.payload.toString()), ['a', 'bb']);
  });
  check('an unmasked client frame is fatal, per RFC 6455', () => {
    assert.equal(unframe(Buffer.from([0x81, 0x01, 0x41])).fatal, 'unmasked frame from client');
  });
  check('an oversized length is refused rather than allocated', () => {
    const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 0xff; b.writeBigUInt64BE(1n << 40n, 2);
    assert.equal(unframe(b).fatal, 'frame too large');
  });
  // The server's own encoder, read back by the decoder's rules.
  check('server frames are unmasked with the right header', () => {
    const f = frame(0x1, Buffer.from('hi'));
    assert.equal(f[0], 0x81);
    assert.equal(f[1], 2, 'no mask bit, length in the low 7 bits');
  });
  check('server frames switch to 16-bit length at 126', () => assert.equal(frame(0x1, Buffer.alloc(126))[1], 126));
  check('server frames switch to 64-bit length at 65536', () => assert.equal(frame(0x1, Buffer.alloc(65536))[1], 127));
}

// --- end to end over a real socket -----------------------------------------

console.log('\n=== live server ===');
{
  // The other direction. unframe() is the SERVER's decoder and rightly rejects
  // an unmasked frame; server->client frames are unmasked by the same RFC, so
  // reading them needs its own few lines rather than a looser unframe().
  const readServerFrames = buf => {
    const out = [];
    let p = 0;
    while (p + 2 <= buf.length) {
      const opcode = buf[p] & 0x0f;
      let len = buf[p + 1] & 0x7f, q = p + 2;
      if (len === 126) { if (q + 2 > buf.length) break; len = buf.readUInt16BE(q); q += 2; }
      else if (len === 127) { if (q + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(q)); q += 8; }
      if (q + len > buf.length) break;
      out.push({ opcode, payload: buf.subarray(q, q + len) });
      p = q + len;
    }
    return { frames: out, rest: buf.subarray(p) };
  };

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  /** Handshake, then hand back a socket that yields parsed JSON frames. */
  const open = code => new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(`GET /room/${code} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n`
        + `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), upgraded = false;
    const got = [];
    const api = { sock, got, send: m => sock.write(mask(Buffer.from(JSON.stringify(m), 'utf8'))),
                  last: t => [...got].reverse().find(x => x.t === t) };
    sock.on('error', reject);
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.subarray(0, i).toString();
        const accept = createHash('sha1').update(key + GUID).digest('base64');
        if (!head.startsWith('HTTP/1.1 101')) return reject(new Error(head.split('\r\n')[0]));
        if (!head.includes(accept)) return reject(new Error('Sec-WebSocket-Accept did not match'));
        upgraded = true; buf = buf.subarray(i + 4); resolve(api);
      }
      const { frames, rest } = readServerFrames(buf);
      buf = rest;
      for (const f of frames) if (f.opcode === 0x1) got.push(JSON.parse(f.payload.toString('utf8')));
    });
  });
  const settle = () => new Promise(r => setTimeout(r, 60));

  const a = await open('LIVE01');
  a.send({ t: 'hello', name: '甲' });
  await settle();
  check('the handshake completes and a welcome arrives', () => assert.ok(a.last('welcome')?.you));

  const b = await open('live01');           // lower case: the same room
  b.send({ t: 'hello', name: '乙' });
  await settle();
  check('the room code is case-insensitive', () => assert.equal(b.last('welcome').members.length, 2));
  check('a different room is a different room', () => assert.equal(rooms.size, 1));

  b.send({ t: 'state', paused: false, pos: 7.25, rate: 1, seq: 1 });
  await settle();
  check('state crosses two real sockets', () => assert.equal(a.last('state').pos, 7.25));

  // A frame big enough to need the 16-bit length path in BOTH directions --
  // which is exactly where a real SDP offer lands, and where an off-by-one in
  // either header would show up. Sent as a signal rather than as chat because
  // chat is length-capped on purpose.
  const big = 'q'.repeat(4000);
  b.send({ t: 'signal', to: a.last('welcome').you, data: { sdp: big } });
  await settle();
  check('a 4 KB frame survives the round trip both ways', () => assert.equal(a.last('signal').data.sdp, big));

  a.send({ t: 'ping', c: 999 });
  await settle();
  check('ping/pong works over the socket', () => assert.equal(a.last('pong').c, 999));

  b.sock.destroy();
  await settle();
  check('a dropped socket leaves the room', () => assert.equal(a.last('leave').members.length, 1));

  a.sock.destroy();
  await settle();
  check('an empty room is forgotten', () => assert.equal(rooms.size, 0));

  await new Promise(r => server.close(r));
}

console.log(`\nALL TOGETHER CHECKS PASSED (${n})`);

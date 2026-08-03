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
  check('http:// becomes ws://', () => assert.equal(at('http://192.168.1.9:23686'), 'ws://192.168.1.9:23686/room/ABC123'));
  check('wss:// is left alone', () => assert.equal(at('wss://a.example/x'), 'wss://a.example/x/room/ABC123'));
  check('ws:// is left alone', () => assert.equal(at('ws://a.example'), 'ws://a.example/room/ABC123'));
  check('a trailing slash does not double up', () => assert.equal(at('https://a.workers.dev//'), 'wss://a.workers.dev/room/ABC123'));
  check('surrounding whitespace is trimmed', () => assert.equal(at('  https://a.workers.dev  '), 'wss://a.workers.dev/room/ABC123'));
  // A scheme-less host takes the PAGE's scheme. Guessing ws:// on an https page
  // would only produce a mixed-content error that says nothing useful.
  check('a bare host on an https page gets wss://', () => assert.equal(at('a.example:23686'), 'wss://a.example:23686/room/ABC123'));
  globalThis.location = { protocol: 'http:' };
  check('a bare host on an http page gets ws://', () => assert.equal(at('192.168.1.9:23686'), 'ws://192.168.1.9:23686/room/ABC123'));
  check('a room code is percent-encoded, not injected raw',
    () => assert.equal(at('ws://a.example', 'a/b?c'), 'ws://a.example/room/a%2Fb%3Fc'));
  delete globalThis.location;
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

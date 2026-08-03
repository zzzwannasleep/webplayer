// 一起看 relay — self-hosted, on bare node:http, with no dependencies.
//
//   node tools/together-server.mjs           # listens on 23686
//   PORT=9000 node tools/together-server.mjs
//
// then point the player's 一起看 card at ws://your-host:23686 (or wss:// if it
// is behind a reverse proxy or a Cloudflare Tunnel that terminates TLS -- a
// browser on an https page cannot open a plain ws://).
//
// This is the alternative to worker/watch-together.js for anyone who would
// rather not have a Cloudflare account. Same protocol, same src/together/
// relay logic, so a room does not care which one it is on.
//
// WHY NO `ws` PACKAGE
// The whole of RFC 6455 that a relay needs is a SHA-1 handshake and a frame
// header: about a hundred lines, below. A dependency here would be a
// dependency in a project that has kept itself to zero for the server side,
// for messages that are almost all under 125 bytes.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Relay } from '../src/together/relay.js';

const PORT = Number(process.env.PORT || 23686);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 20;      // 1 MiB. An SDP offer is a few KB; nothing here is big.
const IDLE_MS = 120_000;        // clients ping every 25s, so silence this long is a dead socket.

const rooms = new Map();        // code -> Relay

// --- RFC 6455, the parts a relay uses ---------------------------------------

/** Server -> client frames are never masked. */
function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2)
             : len < 65536 ? Buffer.alloc(4)
             : Buffer.alloc(10);
  head[0] = 0x80 | opcode;                       // FIN + opcode
  if (len < 126) head[1] = len;
  else if (len < 65536) { head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

/**
 * Pull whole frames out of an accumulating buffer.
 * @returns { frames: [{ opcode, payload }], rest, fatal }
 */
function unframe(buf) {
  const frames = [];
  let p = 0;
  while (p + 2 <= buf.length) {
    const b0 = buf[p], b1 = buf[p + 1];
    const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, q = p + 2;
    if (len === 126) { if (q + 2 > buf.length) break; len = buf.readUInt16BE(q); q += 2; }
    else if (len === 127) {
      if (q + 8 > buf.length) break;
      const big = buf.readBigUInt64BE(q); q += 8;
      if (big > BigInt(MAX_FRAME)) return { frames, rest: buf, fatal: 'frame too large' };
      len = Number(big);
    }
    if (len > MAX_FRAME) return { frames, rest: buf, fatal: 'frame too large' };
    // A client MUST mask. An unmasked frame is either a broken client or
    // something that is not a websocket at all; both end the connection.
    if (!masked) return { frames, rest: buf, fatal: 'unmasked frame from client' };
    if (q + 4 + len > buf.length) break;
    const key = buf.subarray(q, q + 4); q += 4;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = buf[q + i] ^ key[i & 3];
    q += len;
    frames.push({ fin, opcode, payload });
    p = q;
  }
  return { frames, rest: buf.subarray(p), fatal: null };
}

// --- one connection ---------------------------------------------------------

function attach(socket, code) {
  let relay = rooms.get(code);
  if (!relay) { relay = new Relay(); rooms.set(code, relay); }

  let buf = Buffer.alloc(0);
  let cont = null;              // { opcode, chunks } across continuation frames
  let closed = false;

  const conn = {
    send(msg) {
      if (closed || socket.destroyed) return;
      socket.write(frame(0x1, Buffer.from(JSON.stringify(msg), 'utf8')));
    },
    close() { end(1000); },
  };

  function end(code_ = 1000) {
    if (closed) return;
    closed = true;
    try { socket.write(frame(0x8, Buffer.from([code_ >> 8, code_ & 0xff]))); } catch {}
    socket.destroy();
    if (relay.leave(conn) && !relay.size) rooms.delete(code);
  }

  socket.setTimeout(IDLE_MS, () => end(1001));
  // 'end', not just 'close'. An upgraded socket is half-open-capable: when the
  // browser goes away the server sees the client's FIN as 'end' and stays
  // writable, so 'close' does not arrive until WE hang up. Waiting for it left
  // departed members in the room forever -- the list never shrank, and a
  // member that left mid-buffer held the whole room paused.
  socket.on('end', () => end());
  socket.on('error', () => end());
  socket.on('close', () => { closed = true; if (relay.leave(conn) && !relay.size) rooms.delete(code); });

  socket.on('data', chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const { frames, rest, fatal } = unframe(buf);
    buf = rest;
    if (fatal) { console.warn(`[together] ${code}: ${fatal}`); return end(1002); }

    for (const f of frames) {
      if (f.opcode === 0x8) return end(1000);              // close
      if (f.opcode === 0x9) { socket.write(frame(0xa, f.payload)); continue; }   // ping -> pong
      if (f.opcode === 0xa) continue;                      // pong
      // Text (0x1) and continuation (0x0). Browsers rarely fragment, but a
      // large SDP through a proxy can arrive split, and half an offer parses
      // as nothing.
      if (f.opcode === 0x1 || f.opcode === 0x0) {
        if (f.opcode === 0x1) cont = { chunks: [f.payload] };
        else if (cont) cont.chunks.push(f.payload);
        else continue;
        if (!f.fin) continue;
        const text = Buffer.concat(cont.chunks).toString('utf8');
        cont = null;
        let msg; try { msg = JSON.parse(text); } catch { continue; }
        relay.message(conn, msg);
        if (msg.t === 'hello' && !relay.conns.has(conn)) return end(1013);   // room full
      }
    }
  });
}

// --- server -----------------------------------------------------------------

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(`LinWeb 一起看 relay. Connect a websocket to /room/<code>.\n${rooms.size} room(s) open.\n`);
});

server.on('upgrade', (req, socket) => {
  const bad = (line) => { socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  const m = new URL(req.url, 'http://x').pathname.match(/^\/room\/([^/]{1,64})$/);
  if (!m) return bad('404 Not Found');
  const key = req.headers['sec-websocket-key'];
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) return bad('400 Bad Request');

  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  // Case-folded, so a code read out loud reaches the same room either way.
  attach(socket, decodeURIComponent(m[1]).toUpperCase());
});

// Only listen when run directly; tools/test-together.mjs imports the frame
// codec and drives a real socket against it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, () => console.log(`[together] listening on :${PORT} — ws://…:${PORT}/room/<code>`));
}

export { server, rooms, frame, unframe, GUID };

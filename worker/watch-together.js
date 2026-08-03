// 一起看 relay — Cloudflare Worker + Durable Object.
//
//   cd worker && npx wrangler deploy
//
// and paste the wss:// address it prints into the player's 一起看 card. That
// is the whole deployment. Nothing about this player is committed with an
// address in it; the viewer types theirs in.
//
// WHY A DURABLE OBJECT AND NOT A PLAIN WORKER
// A room is state shared by several sockets, and plain Workers have no shared
// state — two members would land on two isolates that cannot see each other. A
// Durable Object is addressed by name, so `/room/ABC123` always reaches the
// same instance, everywhere in the world.
//
// WHY HIBERNATION
// With ctx.acceptWebSocket() the runtime may evict this object between frames
// and bring it back when one arrives, so an idle room costs nothing. The price
// is that memory does not survive: everything that must outlive an eviction is
// stored on the sockets themselves via serializeAttachment(). The last state
// frame is deliberately NOT stored — a room re-anchors within a few seconds
// anyway (see ANCHOR_MS in src/together/sync.js), and writing a row every time
// somebody nudges the seek bar is a worse trade than that.
//
// COST
// Free tier as of 2026: 100,000 requests and 13,000 GB-s per day, and each
// WebSocket message counts as a request. A four-person room pings every 25s
// and re-anchors every 5s, so an evening is in the low thousands.

import { Relay } from '../src/together/relay.js';

export class WatchRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.relay = new Relay();
    this.wrap = new WeakMap();
    // Came back from hibernation: the sockets are still open but this object
    // is brand new, so the member list is rebuilt from what each socket
    // carries rather than from memory that no longer exists.
    for (const ws of ctx.getWebSockets()) {
      let meta = null;
      try { meta = ws.deserializeAttachment(); } catch {}
      if (meta) this.relay.restore(this._conn(ws), meta);
    }
  }

  /** One stable wrapper per socket: Relay keys its member map by identity. */
  _conn(ws) {
    let c = this.wrap.get(ws);
    if (!c) {
      c = {
        ws,
        send(msg) { try { ws.send(JSON.stringify(msg)); } catch {} },
        close() { try { ws.close(1000, 'bye'); } catch {} },
      };
      this.wrap.set(ws, c);
    }
    return c;
  }

  /** Push the parts of the member record that must survive an eviction. */
  _persist() {
    for (const ws of this.ctx.getWebSockets()) {
      const m = this.relay.conns.get(this._conn(ws));
      if (m) try { ws.serializeAttachment({ id: m.id, name: m.name, waiting: m.waiting, host: this.relay.host === m.id }); } catch {}
    }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); }
    catch { return; }
    const conn = this._conn(ws);
    const changed = this.relay.message(conn, msg);
    // The room being full is the one case the relay cannot answer with a
    // frame, because the sender is not a member and has nothing to receive on.
    if (msg.t === 'hello' && !this.relay.conns.has(conn)) { ws.close(1013, 'room full'); return; }
    if (changed) this._persist();
  }

  async webSocketClose(ws) { if (this.relay.leave(this._conn(ws))) this._persist(); }
  async webSocketError(ws) { if (this.relay.leave(this._conn(ws))) this._persist(); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/room\/([^/]{1,64})$/);
    if (!m) {
      // A plain GET is how someone checks the address they just pasted is real.
      return new Response('LinWeb 一起看 relay. Connect a websocket to /room/<code>.\n',
        { headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' } });
    }
    // Room code -> object name. Case-folded so "abc123" and "ABC123" are the
    // same room, which is what anyone reading a code aloud assumes.
    const id = env.WATCH_ROOM.idFromName(decodeURIComponent(m[1]).toUpperCase());
    return env.WATCH_ROOM.get(id).fetch(request);
  },
};

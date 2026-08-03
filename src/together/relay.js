// 一起看 — the relay's brain, with no I/O in it.
//
// Both bundled relays are the same twenty decisions wrapped in a different
// socket API, so the decisions live here and get imported by each:
//
//   worker/watch-together.js   Cloudflare Worker + Durable Object
//   tools/together-server.mjs  bare node:http, no dependencies
//
// which also means the protocol can be tested without a socket at all
// (tools/test-together.mjs).
//
// The relay is deliberately close to dumb. It keeps who is here, who is
// buffering, who the host is, and the last state frame it saw — and forwards
// everything else. It never decides where the film should be; that is sync.js
// on the client, so a room does not break when someone runs an older relay.
//
// A `conn` is anything with `.send(object)` and, optionally, `.close()`.

const CODE = 'abcdefghijkmnpqrstuvwxyz23456789';
const newId = () => {
  const r = (globalThis.crypto ?? {}).getRandomValues?.(new Uint8Array(8));
  if (!r) throw new Error('no crypto.getRandomValues in this runtime');
  return [...r].map(b => CODE[b % CODE.length]).join('');
};

const MAX_NAME = 24;
const MAX_CHAT = 500;
const MAX_MEMBERS = 32;

export class Relay {
  constructor({ now = () => Date.now(), makeId = newId } = {}) {
    this.now = now;
    this.makeId = makeId;
    this.conns = new Map();   // conn -> { id, name, waiting }
    this.host = null;
    this.state = null;        // last { paused, pos, rate, from, seq, s }
  }

  get members() { return [...this.conns.values()].map(m => ({ id: m.id, name: m.name })); }
  get waiters() { return [...this.conns.values()].filter(m => m.waiting).map(m => m.id); }
  get size() { return this.conns.size; }

  /** Re-attach a socket that outlived this object (a hibernated Durable Object). */
  restore(conn, meta) {
    if (!meta?.id) return;
    this.conns.set(conn, { id: meta.id, name: meta.name || '匿名', waiting: !!meta.waiting });
    if (meta.host) this.host = meta.id;
  }

  /**
   * @returns the member record, or null if the room is full — the caller is
   *          expected to close the socket in that case.
   */
  _join(conn, name) {
    if (this.conns.size >= MAX_MEMBERS) return null;
    const me = { id: this.makeId(), name: String(name || '匿名').slice(0, MAX_NAME), waiting: false };
    this.conns.set(conn, me);
    // First one in is the host. Not a privilege — see sync.js; it is only the
    // member that re-anchors the room and restarts it after a buffer wait.
    if (!this.host || !this.members.some(m => m.id === this.host)) this.host = me.id;
    const s = this.now();
    conn.send({ t: 'welcome', you: me.id, host: this.host, members: this.members, state: this.state, s });
    this._others(conn, { t: 'join', member: { id: me.id, name: me.name }, host: this.host, members: this.members });
    // A member that joins mid-wait must be told, or it plays on alone.
    if (this.waiters.length) conn.send({ t: 'wait', from: me.id, waiting: false, waiters: this.waiters });
    return me;
  }

  /** @returns true if anything changed that the caller should persist. */
  message(conn, msg) {
    const me = this.conns.get(conn);
    if (!msg || typeof msg.t !== 'string') return false;

    if (!me) return msg.t === 'hello' ? !!this._join(conn, msg.name) : false;

    switch (msg.t) {
      case 'ping':
        conn.send({ t: 'pong', c: msg.c, s: this.now() });
        return false;

      case 'state': {
        if (!Number.isFinite(msg.pos)) return false;
        // Stamped HERE, with the relay's clock, which is the one clock every
        // member has measured its offset against. A sender's own timestamp
        // would be in a frame of reference nobody else shares.
        this.state = { paused: !!msg.paused, pos: msg.pos, rate: Number(msg.rate) || 1,
                       from: me.id, seq: msg.seq ?? 0, s: this.now() };
        this._all({ t: 'state', ...this.state });
        return true;
      }

      case 'wait': {
        const waiting = !!msg.waiting;
        if (me.waiting === waiting) return false;
        me.waiting = waiting;
        this._all({ t: 'wait', from: me.id, waiting, waiters: this.waiters });
        return true;
      }

      case 'chat': {
        const text = String(msg.text ?? '').slice(0, MAX_CHAT);
        if (!text.trim()) return false;
        this._all({ t: 'chat', from: me.id, name: me.name, text,
                    pos: Number.isFinite(msg.pos) ? msg.pos : null, s: this.now() });
        return false;
      }

      case 'signal': {
        // Point to point, and only inside the room: this carries SDP, which
        // describes the sender's network. Broadcasting it would hand every
        // member's candidate addresses to everyone whether they asked to talk
        // or not.
        for (const [c, m] of this.conns) if (m.id === msg.to) c.send({ t: 'signal', from: me.id, data: msg.data });
        return false;
      }

      case 'claim':
        this.host = me.id;
        this._all({ t: 'host', host: this.host });
        return true;

      default:
        return false;
    }
  }

  leave(conn) {
    const me = this.conns.get(conn);
    if (!me) return false;
    this.conns.delete(conn);
    const wasWaiting = me.waiting;
    // The host leaving must not leave the room without one: nobody would
    // re-anchor it, and a buffer wait would never be released.
    if (this.host === me.id) this.host = this.conns.size ? this.members[0].id : null;
    this._all({ t: 'leave', member: { id: me.id, name: me.name }, host: this.host, members: this.members });
    if (wasWaiting) this._all({ t: 'wait', from: me.id, waiting: false, waiters: this.waiters });
    return true;
  }

  _all(msg)          { for (const c of this.conns.keys()) c.send(msg); }
  _others(not, msg)  { for (const c of this.conns.keys()) if (c !== not) c.send(msg); }
}

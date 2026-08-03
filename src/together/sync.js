// 一起看 — the playback half. Everything about WHEN the picture moves.
//
// The room has exactly one shared fact: the last explicit command anybody
// gave, stamped with the relay's clock.
//
//   { paused, pos, rate, at }      at = the relay's Date.now() when it landed
//
// Where the film should be right now is a projection off that fact:
//
//   target = paused ? pos : pos + (relayNow - at) / 1000 * rate
//
// Anyone may play, pause, seek or change speed; the command is broadcast and
// everyone — including whoever sent it — re-anchors to it. There is no "only
// the host may touch it" mode, because a room is two to eight people who are
// already talking to each other, and asking permission to pause is a worse
// experience than the occasional double-pause.
//
// The host still exists, for the two jobs that need one voice: it re-anchors
// the room every few seconds from its own real playhead (so slow accumulated
// drift does not become everyone's problem), and it is the one that presses
// play again after the room has waited for a straggler.
//
// CORRECTING DRIFT
// Jellyfin's SyncPlay nudges playbackRate between 50ms and 3s of drift and
// seeks past 400ms. Those numbers assume a seek is cheap. Here it is not: a
// seek re-reads the container from the nearest keyframe, re-demuxes, and
// re-fills the MSE buffer, which is seconds of black picture — much more
// disruptive than being 800ms out. So the rate window is stretched and the
// seek threshold is pushed well past it: a seek is the last resort, for
// "somebody jumped to a different scene", not for "we drifted".
//
// The rate correction is deliberately gentle (±8%). Anything stronger is
// audible on dialogue, and the whole point is to be watching the same thing,
// not to be watching a chipmunk.

const DEAD_MS   = 80;      // below this, do nothing at all: it is measurement noise
const SEEK_MS   = 2500;    // above this, a nudge would take half a minute — seek
const ABSORB_MS = 8000;    // aim to eat the drift over this long
const MAX_NUDGE = 0.08;    // ±8% of the room's playback rate
const SETTLE_MS = 3000;    // after a seek, let the pipeline refill before judging
const ANCHOR_MS = 5000;    // how often the host re-anchors the room
const TICK_MS   = 500;

export class PlaybackSync {
  /**
   * @param video the <video> element
   * @param room  a connected Room (src/together/room.js)
   */
  constructor(video, room, { log = () => {}, onChange = () => {} } = {}) {
    this.video = video;
    this.room = room;
    this.log = log;
    this.onChange = onChange;      // called whenever the UI-visible state moves

    this.enabled = false;
    this.state = null;             // { paused, pos, rate, at, from, seq }
    this.waiters = [];             // ids the room is waiting for
    this.drift = 0;                // seconds; + means we are ahead
    this.baseRate = 1;             // the speed the room agreed on

    this._applying = false;        // suppress echo while we drive the element
    this._settleUntil = 0;
    this._lastAnchor = 0;
    this._heldPlaying = false;     // were we playing when the room started waiting
    this._wasWaiting = false;      // last value sent, so a repeat is not re-sent
    this._seq = -1;
    this._tick = null;
    this._onEv = {};
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    const v = this.video;
    // Explicit user actions. `seeking` rather than `seeked`: the other members
    // should start moving while this browser is still refilling, not after.
    this._bind(v, 'play',        () => this._broadcast());
    this._bind(v, 'pause',       () => this._broadcast());
    this._bind(v, 'seeking',     () => { this._settleUntil = Date.now() + SETTLE_MS; this._broadcast(); });
    this._bind(v, 'ratechange',  () => this._broadcast());
    // Buffering. `waiting` fires when the element runs out of data; `playing`
    // when it has some again. Together they are the lockstep signal.
    this._bind(v, 'waiting',     () => this._setWaiting(true));
    this._bind(v, 'playing',     () => this._setWaiting(false));
    this._bind(v, 'canplay',     () => this._setWaiting(false));
    this._tick = setInterval(() => this._correct(), TICK_MS);
    // Seed the room with where this member already is, so a second joiner is
    // not told the film is at 0 just because nobody has touched it yet.
    if (this.room.isHost) this._broadcast();
  }

  stop() {
    if (!this.enabled) return;
    this.enabled = false;
    clearInterval(this._tick);
    for (const [ev, fn] of Object.entries(this._onEv)) this.video.removeEventListener(ev, fn);
    this._onEv = {};
    this.video.playbackRate = this.baseRate;
    this.state = null; this.waiters = []; this.drift = 0;
    this.onChange();
  }

  /** Relay frames the panel hands over. */
  onMessage(m) {
    if (!this.enabled) return;
    if (m.t === 'state') this._adopt(m);
    else if (m.t === 'wait') { this.waiters = m.waiters || []; this._applyHold(); }
    else if (m.t === 'welcome' && m.state) this._adopt({ ...m.state, seq: -1 });
    else if (m.t === 'leave') {
      // A member that vanished mid-buffer would otherwise hold the room
      // paused forever.
      this.waiters = this.waiters.filter(id => id !== m.member?.id);
      this._applyHold();
    }
  }

  /** Where the room says the film is, right now. null when nothing is set. */
  target() {
    const s = this.state;
    if (!s) return null;
    if (s.paused) return s.pos;
    return s.pos + (this.room.now() - s.at) / 1000 * (s.rate || 1);
  }

  get waiting() { return this.waiters.length > 0; }

  // --- outgoing ------------------------------------------------------------

  _bind(el, ev, fn) { this._onEv[ev] = fn; el.addEventListener(ev, fn); }

  _broadcast() {
    if (!this.enabled || this._applying || !this.room.connected) return;
    const v = this.video;
    if (!Number.isFinite(v.currentTime)) return;
    // Report the speed the room should run at, not the corrected one this
    // element happens to be running at — otherwise a nudge propagates and the
    // whole room slowly accelerates.
    this.room.sendState({ paused: v.paused, pos: v.currentTime, rate: this.baseRate });
    this._lastAnchor = Date.now();
  }

  _setWaiting(waiting) {
    if (this._applying) return;
    if (this._wasWaiting === waiting) return;
    this._wasWaiting = waiting;
    this.room.sendWait(waiting);
  }

  // --- incoming ------------------------------------------------------------

  _adopt(m) {
    // Frames can overtake each other on a reconnect. seq is per sender, so it
    // only orders frames from the same one; a different sender always wins,
    // because it is a fresh human action.
    if (m.from === this.state?.from && m.seq != null && m.seq <= this._seq) return;
    this._seq = m.seq ?? this._seq;
    this.state = { paused: !!m.paused, pos: m.pos, rate: m.rate || 1, at: m.s ?? this.room.now(), from: m.from };
    if (m.rate && m.rate !== this.baseRate) this.baseRate = m.rate;

    if (m.from === this.room.id) { this.onChange(); return; }   // our own frame, echoed

    const v = this.video;
    const want = this.target();
    this._applying = true;
    try {
      // Jump only when it is a real jump. A remote pause/play at roughly our
      // position must not turn into a seek, or every pause in the room costs
      // everyone a buffer refill.
      if (Number.isFinite(want) && Math.abs(v.currentTime - want) > SEEK_MS / 1000) {
        v.currentTime = Math.max(0, want);
        this._settleUntil = Date.now() + SETTLE_MS;
      }
      if (this.state.paused && !v.paused) v.pause();
      else if (!this.state.paused && v.paused && !this.waiting) v.play().catch(e => this.log(`一起看：无法自动播放（${e.message}）`, 'warn'));
      v.playbackRate = this.baseRate;
    } finally {
      // Released on the next task: pause()/play() fire their events
      // asynchronously, and clearing the flag synchronously would let our own
      // reaction to them bounce back into the room.
      setTimeout(() => { this._applying = false; }, 0);
    }
    this.onChange();
  }

  /**
   * Somebody is buffering: everyone stops until they are not. Without this the
   * member on the slow line falls a minute behind over an evening and the only
   * fix is a manual seek, which then yanks everybody else.
   */
  _applyHold() {
    const v = this.video;
    this._applying = true;
    try {
      if (this.waiting) {
        if (!v.paused) { this._heldPlaying = true; v.pause(); }
      } else if (this._heldPlaying) {
        this._heldPlaying = false;
        // One voice presses play, or eight members each broadcast a state
        // frame at once and the last one wins by luck.
        if (this.room.isHost) { setTimeout(() => this._resume(), 120); }
      }
    } finally { setTimeout(() => { this._applying = false; }, 0); }
    this.onChange();
  }

  _resume() {
    if (!this.enabled || this.waiting) return;
    this.video.play().catch(() => {});
    this._broadcast();
  }

  // --- the correction loop -------------------------------------------------

  _correct() {
    if (!this.enabled || !this.room.connected) return;
    const v = this.video, s = this.state;

    // The host re-anchors the room from its own real playhead. Everything else
    // in the room is a projection off that, so leaving it stale for an hour
    // means the projection carries an hour's worth of accumulated rate error.
    if (this.room.isHost && Date.now() - this._lastAnchor > ANCHOR_MS) this._broadcast();

    if (!s || s.paused || v.paused || this.waiting || this.room.isHost) {
      if (v.playbackRate !== this.baseRate) v.playbackRate = this.baseRate;
      this.drift = 0;
      return;
    }
    if (Date.now() < this._settleUntil) return;

    const want = this.target();
    if (!Number.isFinite(want) || !Number.isFinite(v.currentTime)) return;
    const drift = v.currentTime - want;          // + we are ahead, - we are behind
    this.drift = drift;
    const ms = Math.abs(drift) * 1000;

    if (ms > SEEK_MS) {
      this._applying = true;
      v.currentTime = Math.max(0, want);
      this._settleUntil = Date.now() + SETTLE_MS;
      setTimeout(() => { this._applying = false; }, 0);
      this.log(`一起看：偏差 ${drift.toFixed(1)}s，已跳转对齐`);
      v.playbackRate = this.baseRate;
    } else if (ms > DEAD_MS) {
      // Negative drift (behind) has to speed up, so the sign flips.
      const nudge = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, -drift * 1000 / ABSORB_MS));
      v.playbackRate = this.baseRate * (1 + nudge);
    } else if (v.playbackRate !== this.baseRate) {
      v.playbackRate = this.baseRate;
    }
    this.onChange();
  }

  /** The speed the viewer picked, as opposed to a correction. */
  setRate(rate) {
    this.baseRate = rate;
    this.video.playbackRate = rate;
    this._broadcast();
  }
}

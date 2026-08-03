// 一起看 — the panel. Owns the room, the playback sync and the voice mesh, and
// is the only file the two player pages have to know about.
//
// It lives in the sidebar rather than in the gear popover for the same reason
// the danmaku panel does: a relay address is a URL, a member list is a list,
// and chat is composing. None of those survive a popover that closes when you
// click away from it, over a picture you are trying to keep watching.
//
// Nothing here is committed to the repository. The relay address, the display
// name and any TURN credentials are localStorage, like the Emby servers.

import { Room, newRoomCode } from './room.js';
import { PlaybackSync } from './sync.js';
import { Voice, DEFAULT_ICE } from './voice.js';

const KEY = 'linweb:together';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
const save = s => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter(Boolean));
  return n;
};
const clock = s => {
  if (!Number.isFinite(s) || s < 0) return '--:--';
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
};
/** A default name that is not "user4821" but is also not a personal detail. */
const NAMES = ['沙发', '茶几', '爆米花', '遥控器', '抱枕', '拖鞋', '夜宵', '台灯'];

export function panelStyles() {
  return `
  /* The hidden attribute is only display:none at author-origin weight, so every
     rule below that sets display:flex silently beats it and the "folded away"
     rows show up anyway. Restore it once, for the whole card, rather than
     remembering to guard each flex rule. */
  .tgp [hidden] { display:none !important; }

  .tgp h2 { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .tgp-st { display:flex; align-items:center; gap:5px; font-size:11.5px; text-transform:none;
            letter-spacing:0; color:var(--faint); font-weight:400; }
  .tgp-st i { width:7px; height:7px; border-radius:50%; background:var(--faint); display:block; flex-shrink:0; }
  .tgp-st.open i { background:var(--ok); }
  .tgp-st.warn i { background:var(--dv, #d9a441); }
  .tgp-st.err i  { background:var(--err); }

  .tgp input[type=text] {
    width:100%; background:var(--bg); border:1px solid var(--line); border-radius:6px;
    padding:7px 9px; font-size:12.5px; min-width:0;
  }
  .tgp input[type=text]:focus { outline:none; border-color:var(--acc-dim); }
  .tgp input::placeholder { color:var(--faint); }
  .tgp-row { display:flex; gap:6px; align-items:center; }
  .tgp-row + .tgp-row { margin-top:6px; }
  .tgp-row .btn { padding:7px 11px; font-size:12.5px; flex-shrink:0; }
  .tgp .btn:disabled { opacity:.38; cursor:default; }

  /* The one thing to press. There is no second primary action: a blank room
     code means "open a new one", so joining and creating are one button. */
  .tgp-go { background:var(--acc-dim); border-color:var(--acc-dim); color:#fff; font-weight:600; }
  .tgp-go:hover:not(:disabled) { background:var(--acc); border-color:var(--acc); }

  /* Everything that is setup rather than use: shown in full the first time,
     folded into one line of grey once it is remembered. */
  .tgp-meta { margin-top:9px; font-size:11.5px; color:var(--faint); display:flex;
              flex-wrap:wrap; gap:4px 10px; align-items:baseline; }
  .tgp-meta button { background:none; border:0; padding:0; font:inherit; color:var(--dim);
                     cursor:pointer; border-bottom:1px dotted var(--line); }
  .tgp-meta button:hover { color:var(--acc); border-bottom-color:var(--acc-dim); }
  .tgp-meta b { color:var(--dim); font-weight:400; max-width:15em; overflow:hidden;
                text-overflow:ellipsis; white-space:nowrap; display:inline-block;
                vertical-align:bottom; }

  /* In a room the code IS the interface: it is what you read out loud. */
  .tgp-head { display:flex; align-items:center; gap:8px; margin-bottom:2px; }
  .tgp-code { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:19px; letter-spacing:3px;
              font-weight:600; text-transform:uppercase; color:var(--fg); line-height:1.1; }
  .tgp-head .btn { margin-left:auto; }

  .tgp-who { margin:11px 0 0; display:flex; flex-direction:column; gap:3px; }
  .tgp-who div { display:flex; align-items:center; gap:6px; font-size:12.5px; }
  .tgp-who .n { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tgp-who .tag { font-size:10.5px; color:var(--faint); border:1px solid var(--line);
                  border-radius:4px; padding:0 4px; flex-shrink:0; }
  .tgp-who .tag.buf { color:var(--dv, #d9a441); border-color:currentColor; }
  .tgp-who .d { margin-left:auto; color:var(--faint); font-variant-numeric:tabular-nums; font-size:11.5px; }
  .tgp-who .mic { color:var(--ok); flex-shrink:0; }
  .tgp-who .mic.bad { color:var(--err); }

  /* Who is here and what is being said are two lists, and without a line
     between them they read as one list where half the rows are in italics. */
  .tgp-log { margin:10px 0; padding-top:10px; border-top:1px solid var(--line);
             max-height:190px; overflow-y:auto; overscroll-behavior:contain;
             display:flex; flex-direction:column; gap:5px; font-size:12.5px; }
  .tgp-log p { margin:0; overflow-wrap:anywhere; }
  .tgp-log .at { color:var(--faint); font-variant-numeric:tabular-nums; margin-right:5px; font-size:11px; }
  .tgp-log .by { color:var(--acc); margin-right:4px; }
  .tgp-log .sys { color:var(--faint); font-style:italic; }

  .tgp-mic.on { color:var(--acc); border-color:var(--acc-dim); }
  .tgp-note { color:var(--faint); font-size:11.5px; margin:7px 0 0; line-height:1.55; }
  .tgp details { margin-top:8px; }
  .tgp summary { font-size:11.5px; color:var(--dim); cursor:pointer; }
  .tgp summary:hover { color:var(--acc); }

  /* The room is on something this page is not. Loud enough to notice, quiet
     enough that it is clearly an offer and not an error. */
  .tgp-offer { margin-top:10px; padding:8px 9px; border:1px solid var(--acc-dim); border-radius:6px;
               display:flex; gap:8px; align-items:center; background:rgba(76,154,255,.07); }
  .tgp-offert { font-size:12.5px; line-height:1.45; min-width:0; overflow-wrap:anywhere; }
  .tgp-offer .btn { margin-left:auto; }
  `;
}

export class TogetherPanel {
  /**
   * @param video  the <video> the room is synchronised to
   * @param button optional toolbar button, kept in sync with the connection
   */
  /**
   * @param media  how this page describes and opens a source, so the room can
   *        share WHAT it is watching and not only WHERE it has got to:
   *          describe() -> { href, want } | null    what is open here now
   *          same(want, href) -> boolean            is that what is already open
   *          open(want, href)                       go and watch it
   *        Omit it and the room degrades to position-only sync, which is what
   *        it used to be for everyone.
   */
  constructor(video, { log = () => {}, button = null, title = '', media = null } = {}) {
    this.video = video;
    this.log = log;
    this.button = button;
    this.title = title;
    this.media = media;
    this.s = load();
    this.chat = [];          // { by, text, pos, sys }
    this.offer = null;       // a source the room is on that this page is not
    this.edit = null;        // which folded-away setting is open: 'relay' | 'name'

    this.room = new Room({ log, onEvent: m => this._onEvent(m) });
    this.sync = new PlaybackSync(video, this.room, { log, onChange: () => this.paint() });
    this.voice = new Voice(this.room, { log, onChange: () => this.paint(), iceServers: this._ice() });

    this.build();
    this.paint();
    button?.addEventListener('click', () => this.el.scrollIntoView({ behavior: 'smooth', block: 'center' }));

    // The host announces the film once the element knows what it has. Bound
    // rather than called once: switching stream or subtitle track reloads the
    // element, and the room should follow that too.
    this._onMeta = () => this._share();
    video.addEventListener('loadedmetadata', this._onMeta);
  }

  /** `#together=CODE&relay=wss://…` — what the 复制邀请 button produces. */
  static inviteFromHash() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    const code = h.get('together');
    return code ? { code, relay: h.get('relay') || '' } : null;
  }

  _ice() {
    if (!this.s.ice) return DEFAULT_ICE;
    try { const v = JSON.parse(this.s.ice); return Array.isArray(v) && v.length ? v : DEFAULT_ICE; }
    catch { return DEFAULT_ICE; }
  }

  // --- DOM -----------------------------------------------------------------

  /**
   * Two screens, never both.
   *
   * The old card showed everything at once: a relay field, a paragraph
   * explaining it, a nickname, a room code, two buttons that did almost the
   * same thing, an empty member list, an empty chat, a disabled message box and
   * a disabled microphone -- four inputs and five buttons before you had done
   * anything. In a room, half of it was dead weight; out of one, the other half
   * was.
   *
   * So: a LOBBY with one field and one button, and a ROOM with the code, who is
   * here, and what is being said. Setup that has already been done once folds
   * into a line of grey text with the answer in it, which is the only form in
   * which a returning viewer needs to see it.
   */
  build() {
    this.dot = el('i');
    this.stText = el('span', { textContent: '未连接' });
    this.st = el('span', { className: 'tgp-st' }, this.dot, this.stText);

    // ---- lobby ------------------------------------------------------------
    this.relay = el('input', { type: 'text', placeholder: '中转地址，粘贴部署后拿到的那个', value: this.s.relay || '' });
    this.relay.addEventListener('change', () => { this._save({ relay: this.relay.value.trim() }); this.paint(); });
    this.relay.addEventListener('keydown', e => { if (e.key === 'Enter') { this.relay.blur(); this.edit = null; this.paint(); } });

    this.who = el('input', { type: 'text', placeholder: '你的昵称',
      value: this.s.name || NAMES[Math.floor(Math.random() * NAMES.length)] });
    this.who.addEventListener('change', () => this._save({ name: this.who.value.trim() }));
    this.who.addEventListener('keydown', e => { if (e.key === 'Enter') { this.edit = null; this.paint(); } });

    this.codeIn = el('input', { type: 'text', placeholder: '房间号（留空就开一个新的）', value: '' });
    this.codeIn.addEventListener('keydown', e => { if (e.key === 'Enter') this.join(); });
    this.codeIn.addEventListener('input', () => this.paint());

    // ONE action. A blank code means a new room, so there is nothing to choose
    // between -- the old 加入 / 开房间 pair asked the viewer to make a decision
    // the field they had just filled in (or not) had already made.
    this.goBtn = el('button', { className: 'btn tgp-go', type: 'button', textContent: '开个房间' });
    this.goBtn.addEventListener('click', () => this.join());

    // Setup, folded away once it is remembered.
    this.relayBtn = el('button', { type: 'button' });
    this.relayBtn.addEventListener('click', () => { this.edit = this.edit === 'relay' ? null : 'relay'; this.paint(); this.relay.focus(); });
    this.nameBtn = el('button', { type: 'button' });
    this.nameBtn.addEventListener('click', () => { this.edit = this.edit === 'name' ? null : 'name'; this.paint(); this.who.focus(); });
    this.relayName = el('b');
    this.whoName = el('b');
    this.metaName = el('span', {}, '昵称 ', this.whoName, ' ', this.nameBtn);
    this.metaRelay = el('span', {}, '中转 ', this.relayName, ' ', this.relayBtn);
    this.meta = el('div', { className: 'tgp-meta' }, this.metaName, this.metaRelay);

    this.hint = el('p', { className: 'tgp-note',
      textContent: '和朋友看同一集，进度自动对齐，还能打字和开麦聊天。先要一个中转地址——房主部署一次，之后大家共用。' });
    this.setup = el('details', {},
      el('summary', { textContent: '还没有中转地址？' }),
      el('p', { className: 'tgp-note', textContent:
        '两条命令挑一条，都会把该粘的地址打印出来：自己机器上 npm run together，或者 cd worker && npx wrangler deploy（Cloudflare 免费额度够用）。https:// 和 wss:// 都能直接粘。细节见 DEPLOY-TOGETHER.md。' }));

    this.lobby = el('div', {},
      this.hint,
      this.relayRow = el('div', { className: 'tgp-row' }, this.relay),
      this.whoRow = el('div', { className: 'tgp-row' }, this.who),
      el('div', { className: 'tgp-row' }, this.codeIn, this.goBtn),
      this.meta,
      this.setup);

    // ---- room -------------------------------------------------------------
    this.code = el('span', { className: 'tgp-code' });
    this.copyBtn = el('button', { className: 'btn ghost', type: 'button', textContent: '复制邀请' });
    this.copyBtn.addEventListener('click', () => this.copyInvite());
    this.head = el('div', { className: 'tgp-head' }, this.code, this.copyBtn);

    this.openBtn = el('button', { className: 'btn tgp-go', type: 'button', textContent: '跟上房间' });
    this.openBtn.addEventListener('click', () => this._follow());
    this.offerRow = el('div', { className: 'tgp-offer', hidden: true },
      this.offerText = el('span', { className: 'tgp-offert' }), this.openBtn);

    this.whoList = el('div', { className: 'tgp-who' });
    this.logBox = el('div', { className: 'tgp-log' });

    this.say = el('input', { type: 'text', placeholder: '说点什么…（回车发送）' });
    this.say.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || !this.say.value.trim()) return;
      this.room.sendChat(this.say.value.trim(), this.video.currentTime);
      this.say.value = '';
    });

    this.micBtn = el('button', { className: 'btn tgp-mic', type: 'button', textContent: '开麦' });
    this.micBtn.addEventListener('click', () => this.toggleVoice());
    this.muteBtn = el('button', { className: 'btn ghost', type: 'button', textContent: '静音自己', hidden: true });
    this.muteBtn.addEventListener('click', () => this.voice.setMuted(!this.voice.muted));
    this.leaveBtn = el('button', { className: 'btn ghost', type: 'button', textContent: '退出' });
    this.leaveBtn.addEventListener('click', () => this.leave());

    this.iceIn = el('input', { type: 'text', placeholder: 'TURN（JSON iceServers 数组，可留空）', value: this.s.ice || '' });
    this.iceIn.addEventListener('change', () => {
      this._save({ ice: this.iceIn.value.trim() });
      this.voice.iceServers = this._ice();
    });

    this.room_ = el('div', { hidden: true },
      this.head,
      this.offerRow,
      this.whoList,
      this.logBox,
      this.say,
      el('div', { className: 'tgp-row', style: 'margin-top:8px' }, this.micBtn, this.muteBtn, this.leaveBtn),
      el('details', {},
        el('summary', { textContent: '语音打不通？' }),
        el('div', {},
          el('p', { className: 'tgp-note', textContent:
            '语音是浏览器之间直连，中转不经手也听不到。大约一成的网络打不通直连（两端都是对称 NAT，或者公司网络丢 UDP），那种情况才需要填 TURN。' }),
          this.iceIn)));

    this.el = el('div', { className: 'card tgp' },
      el('h2', {}, el('span', { textContent: '一起看' }), this.st),
      this.lobby, this.room_);
  }

  // --- room ----------------------------------------------------------------

  _save(patch) { this.s = { ...this.s, ...patch }; save(this.s); }

  /** A blank room code is not an error — it is how you open a new room. */
  join(code = this.codeIn.value.trim().toUpperCase() || newRoomCode(), relay = this.relay.value.trim()) {
    if (!relay) { this.edit = 'relay'; this.paint(); this.relay.focus(); this._sys('先填中转地址'); return; }
    this.codeIn.value = code; this.relay.value = relay;
    this._save({ relay, name: this.who.value.trim() });
    this.chat = [];
    this._sys(`正在加入 ${code}…`);
    this.room.connect(relay, code, this.who.value.trim() || '匿名');
  }

  leave() {
    this.voice.disable();
    this.sync.stop();
    this.room.disconnect();
    this._sys('已退出房间');
  }

  /** `#together=CODE&relay=…` for the room this member is in. */
  _inviteHash() {
    return '#' + new URLSearchParams({ together: this.room.code, relay: this.room.url });
  }

  async copyInvite() {
    const u = new URL(location.href);
    u.hash = this._inviteHash();
    try { await navigator.clipboard.writeText(u.toString()); this._sys('邀请链接已复制'); }
    catch { this._sys(u.toString()); }
  }

  /**
   * Put the room in this page's own address bar.
   *
   * Two things need it. Following a source navigates the page, and a room that
   * did not survive that would drop everyone the moment it started working.
   * And a refresh -- which is what anybody does when a stream stalls -- would
   * otherwise mean typing the code and the relay address again, at exactly the
   * moment the room is waiting for you.
   *
   * replaceState, not a hash assignment: this is a note to self about where we
   * already are, and it should not turn the back button into a list of rooms.
   */
  _stamp() {
    if (!this.room.connected) return;
    try { history.replaceState(history.state, '', this._inviteHash()); } catch {}
  }

  // --- what the room is watching -------------------------------------------

  /** Say what is open here, if this member is the one who decides that. */
  _share() {
    if (!this.media || !this.room.connected || !this.room.isHost) return;
    const d = this.media.describe?.();
    if (d && (d.href || d.want)) this.sync.shareMedia(d);
  }

  _onMedia(m) {
    if (!this.media || !m || m.from === this.room.id) return;
    const { want = null, href = '' } = m;
    if (this.media.same?.(want, href)) { this.offer = null; this.paint(); return; }

    this.offer = { want, href };
    const name = want?.title || '房主放的东西';
    // An empty player has nothing to lose, so it just follows -- and that is
    // precisely the member who "could never see the video": they were sitting
    // in a synced room with no source at all. Anyone already watching gets
    // asked instead.
    if (this.video.readyState === 0) {
      this._sys(`房间在放《${name}》，正在打开…`);
      this._follow();
    } else {
      this._sys(`房间换成了《${name}》，点"跟上房间"切过去`);
    }
    this.paint();
  }

  _follow() {
    const o = this.offer;
    if (!o || !this.media?.open) return;
    this._stamp();                       // so the room survives the navigation
    try { this.media.open(o.want, o.href, this._inviteHash()); }
    catch (e) { this._sys(`打不开这个源：${e.message}`); this.log(`一起看：打开失败 ${e.message}`, 'warn'); }
  }

  async toggleVoice() {
    try {
      if (this.voice.on) this.voice.disable();
      else { await this.voice.enable(); this._sys('麦克风已开'); }
    } catch (e) {
      this._sys(`麦克风打不开：${e.message}`);
      this.log(`一起看：getUserMedia 失败 ${e.message}`, 'warn');
    }
    this.paint();
  }

  _sys(text) { this.chat.push({ sys: true, text }); this._trim(); this.paint(); }
  _trim() { if (this.chat.length > 200) this.chat.splice(0, this.chat.length - 200); }

  _onEvent(m) {
    this.sync.onMessage(m);
    this.voice.onMessage(m);
    switch (m.t) {
      case 'status':
        if (m.state === 'open') {
          this.sync.start(); this._stamp(); this._share();
          this._sys(`已连上房间 ${this.room.code}`);
        }
        else if (m.state === 'retrying') this._sys(m.detail || '连接断开，正在重连');
        else if (m.state === 'closed' && m.detail) this._sys(m.detail);
        break;
      case 'media': this._onMedia(m); break;
      case 'welcome': if (m.media) this._onMedia(m.media); break;
      // The seat can land here because the previous host left. Whoever holds it
      // is the one who says what the room is on, so it says so immediately.
      case 'host': case 'join': case 'leave':
        if (m.t === 'join' && m.member?.id !== this.room.id) this._sys(`${m.member?.name || '有人'} 进来了`);
        if (m.t === 'leave') this._sys(`${m.member?.name || '有人'} 走了`);
        if (this.room.isHost) this._share();
        break;
      case 'chat':  this.chat.push({ by: m.name || this.room.nameOf(m.from), text: m.text, pos: m.pos }); this._trim(); break;
      case 'wait':
        if (m.waiting && m.from !== this.room.id) this._sys(`等 ${this.room.nameOf(m.from)} 缓冲…`);
        break;
    }
    this.paint();
  }

  // --- paint ---------------------------------------------------------------

  paint() {
    const r = this.room;
    // `connecting` and `retrying` belong on the room side: the code has been
    // decided, and dropping back to the lobby mid-reconnect would look like
    // being thrown out of a room you are still in.
    const inRoom = r.status !== 'idle' && r.status !== 'closed';
    const joined = r.connected;
    const cls = { open: 'open', connecting: 'warn', retrying: 'err', closed: 'err' }[r.status] || '';
    this.st.className = `tgp-st ${cls}`;
    this.stText.textContent = joined
      ? `${r.members.length} 人${r.rtt != null ? ` · ${r.rtt}ms` : ''}`
      : { connecting: '连接中', retrying: '重连中', closed: '已断开' }[r.status] || '未连接';

    this.lobby.hidden = inRoom;
    this.room_.hidden = !inRoom;

    // --- lobby ---
    if (!inRoom) {
      const hasRelay = !!this.relay.value.trim();
      // First run shows the field and says why. Once there is an address it
      // collapses to one line of grey with the answer in it, and the sentence
      // explaining what a relay is has done its job and goes away.
      this.relayRow.hidden = hasRelay && this.edit !== 'relay';
      this.whoRow.hidden = this.edit !== 'name';
      this.hint.hidden = hasRelay;
      this.setup.hidden = hasRelay && this.edit !== 'relay';
      // The nickname line stays even on the first run -- it is the only way to
      // change it. Repeating the relay address underneath the field you are
      // currently typing it into is not.
      this.metaRelay.hidden = !this.relayRow.hidden;
      this.relayName.textContent = this.relay.value.trim().replace(/^\w+:\/\//, '') || '未设置';
      this.whoName.textContent = this.who.value.trim() || '匿名';
      this.relayBtn.textContent = this.edit === 'relay' ? '收起' : '改';
      this.nameBtn.textContent = this.edit === 'name' ? '收起' : '改';
      // The button says what pressing it will actually do.
      this.goBtn.textContent = this.codeIn.value.trim() ? '加入房间' : '开个房间';
      this.goBtn.disabled = !hasRelay;
    }

    // --- room ---
    this.code.textContent = r.code || '……';
    this.copyBtn.disabled = !joined;
    this.say.disabled = !joined;
    this.micBtn.disabled = !joined;
    this.offerRow.hidden = !joined || !this.offer;
    if (this.offer) this.offerText.textContent = `房间在放《${this.offer.want?.title || '房主的片子'}》`;
    this.micBtn.textContent = this.voice.on ? '关麦' : '开麦';
    this.micBtn.classList.toggle('on', this.voice.on);
    this.muteBtn.hidden = !this.voice.on;
    this.muteBtn.textContent = this.voice.muted ? '取消静音' : '静音自己';
    if (this.button) {
      this.button.classList.toggle('on', joined);
      this.button.setAttribute('aria-pressed', String(joined));
    }

    this.whoList.replaceChildren(...r.members.map(m => {
      const mine = m.id === r.id;
      const peer = this.voice.peers.get(m.id);
      const mic = mine ? (this.voice.on ? (this.voice.muted ? '静音' : '麦克风开') : '')
                       : (peer?.on ? (peer.state === 'connected' ? '语音' : peer.state === 'failed' ? '打不通' : '接通中') : '');
      // Who the room is waiting for. Without this the hold is invisible: the
      // picture stops, nobody pressed anything, and the only explanation is a
      // line of chat that has already scrolled away.
      const held = this.sync.waiters.includes(m.id);
      return el('div', {},
        el('span', { className: 'n', textContent: m.name || '匿名' }),
        m.id === r.host ? el('span', { className: 'tag', textContent: '房主' }) : null,
        mine ? el('span', { className: 'tag', textContent: '你' }) : null,
        held ? el('span', { className: 'tag buf', textContent: '缓冲中' }) : null,
        mic ? el('span', { className: `mic${peer?.state === 'failed' ? ' bad' : ''}`, textContent: mic }) : null,
        mine && !r.isHost && Math.abs(this.sync.drift) > 0.15
          ? el('span', { className: 'd', textContent: `${this.sync.drift > 0 ? '+' : ''}${this.sync.drift.toFixed(1)}s` })
          : null);
    }));

    const wasBottom = this.logBox.scrollHeight - this.logBox.scrollTop - this.logBox.clientHeight < 24;
    this.logBox.replaceChildren(...this.chat.map(c => c.sys
      ? el('p', { className: 'sys', textContent: c.text })
      : el('p', {},
          el('span', { className: 'at', textContent: clock(c.pos) }),
          el('span', { className: 'by', textContent: c.by }),
          document.createTextNode(c.text))));
    if (wasBottom) this.logBox.scrollTop = this.logBox.scrollHeight;
  }

  destroy() {
    this.video.removeEventListener('loadedmetadata', this._onMeta);
    this.voice.destroy(); this.sync.stop(); this.room.disconnect();
  }
}

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
  .tgp h2 { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .tgp-st { display:flex; align-items:center; gap:5px; font-size:11.5px; text-transform:none;
            letter-spacing:0; color:var(--faint); font-weight:400; }
  .tgp-st i { width:7px; height:7px; border-radius:50%; background:var(--faint); display:block; }
  .tgp-st.open i { background:var(--ok); }
  .tgp-st.warn i { background:var(--dv, #d9a441); }
  .tgp-st.err i  { background:var(--err); }

  .tgp input[type=text] {
    width:100%; background:var(--bg); border:1px solid var(--line); border-radius:6px;
    padding:6px 9px; font-size:12.5px; min-width:0;
  }
  .tgp input[type=text]:focus { outline:none; border-color:var(--acc-dim); }
  .tgp input::placeholder { color:var(--faint); }
  .tgp-row { display:flex; gap:6px; margin-top:6px; align-items:center; }
  .tgp-row .btn { padding:6px 11px; font-size:12.5px; flex-shrink:0; }
  .tgp .btn:disabled { opacity:.38; cursor:default; }
  .tgp-code { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:15px; letter-spacing:2px;
              font-weight:600; text-transform:uppercase; }

  .tgp-who { margin:10px 0 0; display:flex; flex-direction:column; gap:3px; }
  .tgp-who div { display:flex; align-items:center; gap:6px; font-size:12.5px; }
  .tgp-who .n { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tgp-who .tag { font-size:10.5px; color:var(--faint); border:1px solid var(--line);
                  border-radius:4px; padding:0 4px; flex-shrink:0; }
  .tgp-who .d { margin-left:auto; color:var(--faint); font-variant-numeric:tabular-nums; font-size:11.5px; }
  .tgp-who .mic { color:var(--ok); flex-shrink:0; }
  .tgp-who .mic.bad { color:var(--err); }

  .tgp-log { margin-top:10px; max-height:210px; overflow-y:auto; overscroll-behavior:contain;
             display:flex; flex-direction:column; gap:5px; font-size:12.5px; }
  .tgp-log p { margin:0; overflow-wrap:anywhere; }
  .tgp-log .at { color:var(--faint); font-variant-numeric:tabular-nums; margin-right:5px; font-size:11px; }
  .tgp-log .by { color:var(--acc); margin-right:4px; }
  .tgp-log .sys { color:var(--faint); font-style:italic; }

  .tgp-mic.on { color:var(--acc); border-color:var(--acc-dim); }
  .tgp-note { color:var(--faint); font-size:11.5px; margin:8px 0 0; line-height:1.55; }
  `;
}

export class TogetherPanel {
  /**
   * @param video  the <video> the room is synchronised to
   * @param button optional toolbar button, kept in sync with the connection
   */
  constructor(video, { log = () => {}, button = null, title = '' } = {}) {
    this.video = video;
    this.log = log;
    this.button = button;
    this.title = title;
    this.s = load();
    this.chat = [];          // { by, text, pos, sys }

    this.room = new Room({ log, onEvent: m => this._onEvent(m) });
    this.sync = new PlaybackSync(video, this.room, { log, onChange: () => this.paint() });
    this.voice = new Voice(this.room, { log, onChange: () => this.paint(), iceServers: this._ice() });

    this.build();
    this.paint();
    button?.addEventListener('click', () => this.el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
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

  build() {
    this.dot = el('i');
    this.stText = el('span', { textContent: '未连接' });
    const st = el('span', { className: 'tgp-st' }, this.dot, this.stText);
    this.st = st;

    this.relay = el('input', { type: 'text', placeholder: '中转地址，粘贴部署后拿到的那个', value: this.s.relay || '' });
    this.relay.addEventListener('change', () => this._save({ relay: this.relay.value.trim() }));
    // Said once, in front of the field, rather than only inside the collapsed
    // section: the first thing anyone needs is to know that pasting the address
    // their host printed -- https:// and all -- is the correct thing to do.
    this.relayHint = el('p', { className: 'tgp-note',
      textContent: 'https:// 或 wss:// 都行，直接粘贴部署时拿到的地址。还没有中转？见 DEPLOY-TOGETHER.md，Cloudflare 一条命令，或者自己机器上 npm run together。' });

    this.who = el('input', { type: 'text', placeholder: '你的昵称',
      value: this.s.name || NAMES[Math.floor(Math.random() * NAMES.length)] });
    this.who.addEventListener('change', () => this._save({ name: this.who.value.trim() }));

    this.codeIn = el('input', { type: 'text', placeholder: '房间号', value: '' });
    this.codeIn.addEventListener('keydown', e => { if (e.key === 'Enter') this.join(); });

    this.joinBtn = el('button', { className: 'btn', type: 'button', textContent: '加入' });
    this.joinBtn.addEventListener('click', () => this.join());
    this.makeBtn = el('button', { className: 'btn', type: 'button', textContent: '开房间' });
    this.makeBtn.addEventListener('click', () => { this.codeIn.value = newRoomCode(); this.join(); });
    this.leaveBtn = el('button', { className: 'btn ghost', type: 'button', textContent: '退出', hidden: true });
    this.leaveBtn.addEventListener('click', () => this.leave());
    this.copyBtn = el('button', { className: 'btn ghost', type: 'button', textContent: '复制邀请', hidden: true });
    this.copyBtn.addEventListener('click', () => this.copyInvite());

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

    this.iceIn = el('input', { type: 'text', placeholder: 'TURN（JSON iceServers 数组，可留空）', value: this.s.ice || '' });
    this.iceIn.addEventListener('change', () => {
      this._save({ ice: this.iceIn.value.trim() });
      this.voice.iceServers = this._ice();
    });

    this.el = el('div', { className: 'card tgp' },
      el('h2', {}, el('span', { textContent: '一起看' }), st),
      this.relay,
      this.relayHint,
      el('div', { className: 'tgp-row' }, this.who),
      el('div', { className: 'tgp-row' }, this.codeIn, this.joinBtn, this.makeBtn),
      el('div', { className: 'tgp-row' }, this.copyBtn, this.leaveBtn),
      this.whoList,
      this.logBox,
      this.say,
      el('div', { className: 'tgp-row' }, this.micBtn, this.muteBtn),
      el('details', {},
        el('summary', { textContent: '中转与打洞' }),
        el('div', {}, this.iceIn,
          el('p', { className: 'tgp-note', textContent:
            '进度、聊天和语音的呼叫走中转；语音本身是浏览器之间直连，中转看不到也不承担流量。中转可以自己部署：worker/watch-together.js 跑在 Cloudflare（免费额度足够），tools/together-server.mjs 是零依赖的 Node 版，随便挑一个。约一成的网络打不通直连，那种情况才需要填 TURN。' }))));
  }

  // --- room ----------------------------------------------------------------

  _save(patch) { this.s = { ...this.s, ...patch }; save(this.s); }

  join(code = this.codeIn.value.trim().toUpperCase(), relay = this.relay.value.trim()) {
    if (!relay) { this._sys('先填中转地址'); return; }
    if (!code) { this._sys('先填房间号，或者点开房间'); return; }
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

  async copyInvite() {
    const u = new URL(location.href);
    u.hash = new URLSearchParams({ together: this.room.code, relay: this.room.url }).toString();
    try { await navigator.clipboard.writeText(u.toString()); this._sys('邀请链接已复制'); }
    catch { this._sys(u.toString()); }
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
        if (m.state === 'open') { this.sync.start(); this._sys(`已连上房间 ${this.room.code}`); }
        else if (m.state === 'retrying') this._sys(m.detail || '连接断开，正在重连');
        else if (m.state === 'closed' && m.detail) this._sys(m.detail);
        break;
      case 'join':  if (m.member?.id !== this.room.id) this._sys(`${m.member?.name || '有人'} 进来了`); break;
      case 'leave': this._sys(`${m.member?.name || '有人'} 走了`); break;
      case 'chat':  this.chat.push({ by: m.name || this.room.nameOf(m.from), text: m.text, pos: m.pos }); this._trim(); break;
      case 'wait':
        if (m.waiting && m.from !== this.room.id) this._sys(`等 ${this.room.nameOf(m.from)} 缓冲…`);
        break;
    }
    this.paint();
  }

  // --- paint ---------------------------------------------------------------

  paint() {
    const r = this.room, joined = r.connected;
    const cls = { open: 'open', connecting: 'warn', retrying: 'err', closed: 'err' }[r.status] || '';
    this.st.className = `tgp-st ${cls}`;
    this.stText.textContent = joined
      ? `${r.code} · ${r.members.length} 人${r.rtt != null ? ` · ${r.rtt}ms` : ''}`
      : { connecting: '连接中', retrying: '重连中', closed: '已断开' }[r.status] || '未连接';

    this.relay.disabled = joined; this.who.disabled = joined; this.codeIn.disabled = joined;
    this.relayHint.hidden = joined;   // it is setup advice; in a room it is just noise
    this.joinBtn.hidden = joined; this.makeBtn.hidden = joined;
    this.leaveBtn.hidden = !joined; this.copyBtn.hidden = !joined;
    this.say.disabled = !joined;
    this.micBtn.disabled = !joined;
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
      return el('div', {},
        el('span', { className: 'n', textContent: m.name || '匿名' }),
        m.id === r.host ? el('span', { className: 'tag', textContent: '房主' }) : null,
        mine ? el('span', { className: 'tag', textContent: '你' }) : null,
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

  destroy() { this.voice.destroy(); this.sync.stop(); this.room.disconnect(); }
}

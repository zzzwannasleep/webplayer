// 一起看中转,一条命令起来,并把该粘贴的那条地址打在屏幕上。
//
//   npm run together                                    # 问你要不要后台跑,然后打印地址
//   npm run together -- --bg                            # 直接后台
//   npm run together -- --fg                            # 直接前台(不问)
//   npm run together -- --stop                          # 停掉后台那个
//   npm run together -- --url https://together.example  # 你已经有反代/域名了
//   PORT=9000 npm run together                          # 换端口
//
// 前台跑的问题是关掉终端它就没了,而"怎么让一个命令在后台跑"是个跟这个项目
// 完全无关的知识点(nohup / & / disown / screen,每个平台还不一样)。所以这里
// 问一句 y/n,选 y 就自己 detach 出去,并把停止命令一起打出来 —— 不然后台跑起来
// 之后"怎么停"又是同一个问题。
//
// 隧道(公网地址)不在这个脚本里:那是一个把机器挂上公网的动作,一句 y/n 带过
// 不合适,而且 cloudflared 自己就一条命令。写在 DEPLOY-TOGETHER.md 里。

import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, unlinkSync, openSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

/** 网页端是 23685;中转另开一个,免得两个东西抢同一个端口。 */
export const DEFAULT_PORT = 31614;

// --- 要单独测的纯逻辑 -------------------------------------------------------

/**
 * 这台机器上别人能拨到的 IPv4。
 * 排除回环、169.254(DHCP 失败时系统自己编的)、198.18(RFC 2544 测试网段,
 * 一些 VPN 客户端拿它造假网卡)—— 三种都是没人能连上的地址。
 * 虚拟网卡排到最后:服务器上第一个非回环网卡经常是 docker0 之类的桥,
 * 把它打在第一行只会让人白试一次。
 */
export function localAddresses(ifaces = networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      if (/^169\.254\./.test(a.address) || /^198\.1[89]\./.test(a.address)) continue;
      const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      const virtual = /^(docker|br-|veth|virbr|vEthernet|VMware|VirtualBox|Hyper-V|WSL|Tailscale|ZeroTier)/i.test(name);
      out.push({ name, address: a.address, priv, virtual });
    }
  }
  return out.sort((x, y) => (x.virtual - y.virtual) || (y.priv - x.priv));
}

/** 中文按两列算,不然框会歪。 */
export function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) > 0x2e7f ? 2 : 1;
  return w;
}

/** 怎么停掉一个后台进程,各平台说法不同,直接把命令给出来。 */
export function stopHint(pid, platform = process.platform) {
  return platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill ${pid}`;
}

/** 回答里只有明确的 y/yes 才算同意;直接回车 = 不后台。 */
export function saidYes(answer) {
  return /^(y|yes|是)$/i.test(String(answer ?? '').trim());
}

// --- 以下是脚本本体,被 import 时不执行 --------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

async function main() {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const ROOT = join(HERE, '..');
  const PID_FILE = join(ROOT, '.together.pid');
  const LOG_FILE = join(ROOT, '.together.log');
  const PORT = Number(process.env.PORT || DEFAULT_PORT);
  const args = process.argv.slice(2);
  const urlAt = args.indexOf('--url');
  const fixedUrl = urlAt >= 0 ? args[urlAt + 1] : null;

  if (urlAt >= 0 && (!fixedUrl || fixedUrl.startsWith('--'))) {
    console.error('--url 后面要跟地址，比如：--url https://together.example');
    process.exit(2);
  }

  if (args.includes('--stop')) return stop();

  const W = 74;
  const box = lines => {
    console.log('\n┌' + '─'.repeat(W) + '┐');
    for (const l of lines) console.log('│' + l + ' '.repeat(Math.max(0, W - displayWidth(l))) + '│');
    console.log('└' + '─'.repeat(W) + '┘');
  };

  /** 后台跑起来之后,PID 文件是唯一能再找到它的东西。 */
  function stop() {
    if (!existsSync(PID_FILE)) {
      console.log('没有在后台跑的中转（找不到 .together.pid）。');
      return;
    }
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    try {
      process.kill(pid);
      console.log(`已停止后台中转（pid ${pid}）。`);
    } catch (e) {
      // ESRCH = 那个进程早就没了,PID 文件是上次没清干净的残留。
      console.log(e.code === 'ESRCH'
        ? `pid ${pid} 已经不在了（上次可能是直接关机停的），清掉记录。`
        : `停不掉 pid ${pid}：${e.message}`);
    }
    try { unlinkSync(PID_FILE); } catch {}
  }

  function addressLines() {
    if (fixedUrl) return [`     ${fixedUrl.replace(/\/+$/, '')}`];
    const addrs = localAddresses();
    if (!addrs.length) return [`     http://<这台机器的 IP>:${PORT}`];
    return addrs.slice(0, 4).map(a =>
      `     http://${a.address}:${PORT}` + (a.virtual ? `   ← ${a.name}，虚拟网卡，多半不是这个` : ''));
  }

  function report({ bg, pid }) {
    const lines = [
      ` 一起看中转已启动${bg ? '（后台）' : ''}`,
      '',
      ' 把下面这条粘进播放页右侧「一起看」卡片：',
      '',
      ...addressLines(),
      '',
    ];
    if (fixedUrl) {
      lines.push(' 这是你自己给的地址，脚本没验证它通不通。连不上先确认反代把 /room/',
        ` 转到了本机 ${PORT} 端口，并且转发了 Upgrade / Connection 头。`);
    } else {
      lines.push(' ⚠ 局域网地址，只有和这台机器在同一个网络里的人连得上。',
        '',
        ' 要让外面的人也能进：给它一个公网 https 入口（Cloudflare 隧道，或者',
        ' 挂在你已有的反代后面再 --url https://你的域名）。',
        ' 两种做法 DEPLOY-TOGETHER.md 里都有现成命令。',
        '',
        ' ⚠ 播放器页面如果是 https 打开的，浏览器不允许它连 http/ws 的中转，',
        '   那种情况必须走上面那步。');
    }
    if (bg) {
      lines.push('', ` 后台运行中，pid ${pid}。关掉这个窗口不影响它。`,
        ` 停止：npm run together -- --stop     （或 ${stopHint(pid)}）`,
        ` 日志：${LOG_FILE}`);
    }
    box(lines);
    if (!bg) console.log('（Ctrl-C 停止。想让它开机自启，见 DEPLOY-TOGETHER.md）\n');
    else console.log('');
  }

  /** 起来了没。端口被占的话这里一直是 false,好过先打印地址再发现连不上。 */
  async function waitReady() {
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 150));
      try { if ((await fetch(`http://127.0.0.1:${PORT}/`).then(r => r.text())).includes('一起看')) return true; } catch {}
    }
    return false;
  }
  const portBusyNote = () =>
    console.error(`中转没能在 ${PORT} 端口上起来。最常见的原因是这个端口被占了 ——`
      + `\n换一个再跑：PORT=9000 npm run together`);

  // 已经有一个在后台跑着就别再起一个:两个进程抢同一个端口,后起的那个会
  // 静悄悄失败,而人看到的是"我明明起过了"。
  if (existsSync(PID_FILE)) {
    const old = Number(readFileSync(PID_FILE, 'utf8').trim());
    let alive = false;
    try { process.kill(old, 0); alive = true; } catch {}
    if (alive) {
      console.log(`已经有一个中转在后台跑着（pid ${old}）。`);
      if (await waitReady()) return report({ bg: true, pid: old });
      console.log('但它没有响应，先停掉再重开：npm run together -- --stop');
      return;
    }
    try { unlinkSync(PID_FILE); } catch {}   // 上次没清干净的残留
  }

  // 后台还是前台。非交互环境(CI、管道、systemd)不问,默认前台 —— 在那里
  // 弹一个等输入的问题就是挂死。
  let bg = args.includes('--bg');
  if (!bg && !args.includes('--fg') && process.stdin.isTTY && process.stdout.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question('要在后台跑吗？选 y 之后关掉这个窗口它也继续跑。[y/N] ');
    rl.close();
    bg = saidYes(ans);
  }

  if (bg) {
    // detached + unref:父进程退出后它不跟着走。stdio 全接到日志文件,
    // 不然父进程一走,写 stdout 就是往一个没人读的管子里写。
    const out = openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, [join(HERE, 'together-server.mjs')],
      { detached: true, stdio: ['ignore', out, out], windowsHide: true,
        env: { ...process.env, PORT: String(PORT) } });
    child.unref();
    if (!await waitReady()) { portBusyNote(); try { process.kill(child.pid); } catch {} process.exit(1); }
    writeFileSync(PID_FILE, String(child.pid));
    report({ bg: true, pid: child.pid });
    process.exit(0);
  }

  const kids = [];
  let stopping = false, ready = false;
  const bye = () => { stopping = true; for (const k of kids) { try { k.kill(); } catch {} } };
  process.on('SIGINT', () => { console.log('\n停止。'); bye(); process.exit(0); });
  process.on('SIGTERM', () => { bye(); process.exit(0); });
  process.on('exit', bye);

  const relay = spawn(process.execPath, [join(HERE, 'together-server.mjs')],
    { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, PORT: String(PORT) } });
  kids.push(relay);
  relay.on('exit', (code, signal) => {
    // Ctrl-C 把信号发给整个进程组,子进程往往比我们先死 —— 那不是崩溃。
    // 光看 stopping 不够:它在我们自己的信号处理里才置上,会晚一拍。
    if (stopping || signal || code === 130 || code === 143) return;
    console.error(`\n中转进程退出了（code ${code}）。`);
    if (!ready) portBusyNote();
    bye();
    process.exit(code ?? 1);
  });

  ready = await waitReady();
  if (!ready) { portBusyNote(); bye(); process.exit(1); }
  report({ bg: false });
}

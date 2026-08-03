// 一起看中转,一条命令起来,并把该粘贴的那条地址打在屏幕上。
//
//   npm run together                                  # 起服务,打印局域网地址
//   npm run together -- --tunnel                      # 顺便开一条 Cloudflare 隧道,给公网 https 地址
//   npm run together -- --url https://together.example  # 你已经有反代/域名了
//   PORT=9000 npm run together
//
// 为什么隧道要显式加 --tunnel,而不是"检测到 cloudflared 就自动开":开隧道等于
// 把这台机器上的一个服务挂到公网上。那是一个对外的动作,不该由一个"启动脚本"
// 替人做主。不加就只在局域网里,谁都不会被意外暴露。
//
// 这个脚本只负责"跑起来 + 告诉你地址"。要让它开机自启、掉了自动拉起,见
// DEPLOY-TOGETHER.md 里的 systemd / 计划任务 / Docker 三段。

import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// --- 两块要单独测的纯逻辑 ---------------------------------------------------

/**
 * 这台机器上别人能拨到的 IPv4。
 * 排除回环和 169.254（自动私有地址：DHCP 没拿到时系统自己编的，谁也连不上）。
 * 虚拟网卡排到最后 —— 服务器上第一个非回环网卡经常是 docker0 之类的桥，
 * 把它打在第一行只会让人白试一次。
 */
export function localAddresses(ifaces = networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      // 169.254 是 DHCP 失败时系统自己编的；198.18/15 是 RFC 2544 的测试网段，
      // 一些 VPN 客户端拿它造假网卡。两个都不是任何人能拨到的地址。
      if (/^169\.254\./.test(a.address) || /^198\.1[89]\./.test(a.address)) continue;
      const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      const virtual = /^(docker|br-|veth|virbr|vEthernet|VMware|VirtualBox|Hyper-V|WSL|Tailscale|ZeroTier)/i.test(name);
      out.push({ name, address: a.address, priv, virtual });
    }
  }
  return out.sort((x, y) => (x.virtual - y.virtual) || (y.priv - x.priv));
}

/**
 * cloudflared 把地址混在自己的日志里，格式随版本变过几次（有时带方框、有时带
 * 时间戳前缀），所以是从整块输出里找那个域名，而不是按行号或前缀取。
 */
export function findTunnelUrl(text) {
  const m = String(text).match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i);
  return m ? m[0] : null;
}

/** 中文按两列算，不然框会歪。 */
export function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) > 0x2e7f ? 2 : 1;
  return w;
}

// --- 以下是脚本本体，被 import 时不执行 --------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

async function main() {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const PORT = Number(process.env.PORT || 23686);
  const args = process.argv.slice(2);
  const wantTunnel = args.includes('--tunnel');
  const urlAt = args.indexOf('--url');
  const fixedUrl = urlAt >= 0 ? args[urlAt + 1] : null;

  if (urlAt >= 0 && (!fixedUrl || fixedUrl.startsWith('--'))) {
    console.error('--url 后面要跟地址，比如：--url https://together.example');
    process.exit(2);
  }

  const W = 74;
  const box = lines => {
    console.log('\n┌' + '─'.repeat(W) + '┐');
    for (const l of lines) console.log('│' + l + ' '.repeat(Math.max(0, W - displayWidth(l))) + '│');
    console.log('└' + '─'.repeat(W) + '┘');
  };
  const tail = () => console.log('（Ctrl-C 停止。想让它常驻，见 DEPLOY-TOGETHER.md）\n');

  function report({ tunnelUrl, fixedUrl } = {}) {
    if (fixedUrl) {
      box([
        ' 一起看中转已启动',
        '',
        ' 把下面这条粘进播放页右侧「一起看」卡片：',
        '',
        `     ${fixedUrl}`,
        '',
        ' 这是你自己给的地址，脚本没有验证它通不通。连不上的话先确认反代把',
        ` /room/ 转到了本机 ${PORT} 端口，并且转发了 Upgrade / Connection 头。`,
      ]);
      return tail();
    }
    if (tunnelUrl) {
      box([
        ' 一起看中转已启动（公网可达）',
        '',
        ' 把下面这条粘进播放页右侧「一起看」卡片：',
        '',
        `     ${tunnelUrl}`,
        '',
        ' 这是 Cloudflare 的临时隧道，自带 https/wss，任何人都能连。',
        '',
        ' ⚠ 脚本一停隧道就没了，下次再开会换一个新地址。要固定地址就按',
        '   DEPLOY-TOGETHER.md 建一条命名隧道绑自己的域名。',
      ]);
      return tail();
    }
    const addrs = localAddresses();
    const lines = [' 一起看中转已启动（仅局域网）', '', ' 把下面这条粘进播放页右侧「一起看」卡片：', ''];
    if (addrs.length) {
      for (const a of addrs.slice(0, 4)) {
        lines.push(`     http://${a.address}:${PORT}` + (a.virtual ? `   ← ${a.name}，虚拟网卡，多半不是这个` : ''));
      }
    } else {
      lines.push(`     http://<这台机器的 IP>:${PORT}`);
    }
    lines.push(
      '',
      ' ⚠ 局域网地址，只有和这台机器在同一个网络里的人连得上。',
      '',
      ' 要让外面的人也能进，二选一：',
      '   · 加 --tunnel 重跑（Cloudflare 临时隧道，需要装 cloudflared）',
      '   · 挂在你已有的反代/域名后面，然后 --url https://你的域名',
      '',
      ' ⚠ 播放器页面如果是 https 打开的，浏览器不允许它连 http/ws 的中转，',
      '   那种情况必须走上面两条里的一条。',
    );
    box(lines);
    tail();
  }

  const kids = [];
  let stopping = false;
  const bye = () => { stopping = true; for (const k of kids) { try { k.kill(); } catch {} } };
  process.on('SIGINT', () => { console.log('\n停止。'); bye(); process.exit(0); });
  process.on('SIGTERM', () => { bye(); process.exit(0); });
  process.on('exit', bye);

  const relay = spawn(process.execPath, [join(HERE, 'together-server.mjs')],
    { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, PORT: String(PORT) } });
  kids.push(relay);
  let ready = false;
  relay.on('exit', (code, signal) => {
    // Ctrl-C 把信号发给整个进程组，子进程往往比我们先死 —— 那不是崩溃。
    // 光看 `stopping` 不够：它是在我们自己的信号处理里才置上的，会晚一拍。
    if (stopping || signal || code === 130 || code === 143) return;
    // 端口被占只可能发生在还没听上的时候。已经跑起来又退出的，说别的原因
    // 只会把人往错的方向带。
    console.error(`\n中转进程退出了（code ${code}）。`
      + (ready ? '' : `\n最常见的原因是 ${PORT} 端口被占了 —— 换一个再跑：PORT=9000 npm run together`));
    bye();
    process.exit(code ?? 1);
  });

  // 等它真的听上了再打印地址。反过来的话，端口被占时也会先打印出一条看着
  // 很正常的地址，人复制走了才发现根本连不上。
  for (let i = 0; i < 40 && !ready; i++) {
    await new Promise(r => setTimeout(r, 150));
    try { ready = (await fetch(`http://127.0.0.1:${PORT}/`).then(r => r.text())).includes('一起看'); } catch {}
  }
  if (!ready) { console.error(`中转没能在 ${PORT} 端口上起来。`); bye(); process.exit(1); }

  if (fixedUrl) return report({ fixedUrl: fixedUrl.replace(/\/+$/, '') });
  if (!wantTunnel) return report();

  console.log('正在开 Cloudflare 隧道…');
  const cf = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  kids.push(cf);
  let buf = '', done = false;
  const finish = fn => { if (!done) { done = true; fn(); } };
  const onData = d => { buf += d; const url = findTunnelUrl(buf); if (url) finish(() => report({ tunnelUrl: url })); };
  cf.stdout.on('data', onData);
  cf.stderr.on('data', onData);      // cloudflared 把地址打在 stderr 上
  cf.on('error', e => finish(() => noCloudflared(e)));
  cf.on('exit', c => finish(() => { console.error(`cloudflared 退出了（code ${c}）。它最后说的是：\n${buf.slice(-800)}`); report(); }));
  setTimeout(() => finish(() => {
    console.error('等了 30 秒没等到隧道地址。cloudflared 的输出：\n' + buf.slice(-800));
    report();
  }), 30_000).unref?.();

  function noCloudflared(e) {
    console.error([
      '',
      `没有找到 cloudflared（${e?.code || e?.message || '未知原因'}）—— 装一下再加 --tunnel 重跑：`,
      '  Debian/Ubuntu  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cf.deb && sudo dpkg -i cf.deb',
      '  macOS          brew install cloudflared',
      '  Windows        winget install --id Cloudflare.cloudflared',
      '',
      '中转本身已经起来了，先按局域网地址用：',
    ].join('\n'));
    report();
  }
}

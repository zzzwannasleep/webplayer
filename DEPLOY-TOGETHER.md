# 一起看 · 中转部署教程

只有要用「一起看」才需要这份文档。播放、字幕、弹幕都不依赖它。

---

## 先弄明白你在部署什么

「一起看」需要一个**中转**，因为两个浏览器互相找不到对方 —— 就算做成纯 P2P，第一次
握手的地址也得有个地方交换。所以「不用服务器」从来不成立，只是「用不用别人的服务器」。

这个中转搬的东西非常少：

| 走中转 | 不走中转 |
|---|---|
| 房间成员表、谁是房主 | **语音**（浏览器之间直连） |
| 播放进度（每 5 秒一帧 + 有人操作时一帧） | 影片本身（还是你自己的 Emby） |
| 文字聊天 | |
| WebRTC 呼叫用的 SDP / ICE（每对人几 KB，一次） | |

**语音一个字节都不过中转**。两个人交换完 SDP 之后音频就是端到端直连，WebRTC 强制
DTLS-SRTP 加密，中转的运维者（哪怕是你自己）也听不到。所以中转跑在免费额度上不是
带宽问题 —— 它本来就没有带宽压力。

**协议是裸 WebSocket + JSON**（写在 `src/together/room.js` 顶部）。仓库里给了两份
实现，共用同一份房间逻辑 `src/together/relay.js`，所以两边行为不会漂：

| 文件 | 跑在哪 |
|---|---|
| `worker/watch-together.js` | Cloudflare Workers + Durable Objects |
| `tools/together-server.mjs` | 任何能跑 Node 的地方（裸 `node:http`，零依赖，RFC6455 手写） |

你想自己再写一个也行，协议就那十来种消息。

---

## 选哪条路

```
你愿意注册一个 Cloudflare 账号吗？
├── 愿意 ────────────────────► 路线 A（最省事，不用有机器，不用绑卡）
└── 不愿意
    └── 你有一台常开、外网能访问到的机器吗？（VPS / 云主机 / NAS / 家里的电脑）
        ├── 有 ──────────────► 路线 B（自己跑 Node）
        └── 没有 ────────────► 路线 C（找个平台托管那个 Node 脚本）
```

---

# 路线 A · Cloudflare Workers（推荐）

不用有机器，不用绑卡，一条命令。

```bash
cd worker
npx wrangler deploy
```

第一次会打开浏览器让你登录 Cloudflare（免费账号就行）。跑完它会打印一行：

```
Deployed linweb-together triggers (1.23 sec)
  https://linweb-together.<你的用户名>.workers.dev
```

**把这个 https 地址整条复制下来**，就是你的中转地址。到此结束。

想换个名字就改 `worker/wrangler.toml` 里的 `name`。

### 额度够不够

免费版每天 10 万次请求、13000 GB-s。WebSocket 的**每条消息算一次请求**。一个房间的
消息量：每人每 25 秒一次心跳、房主每 5 秒一帧进度、加上聊天和操作。四个人看完一部
两小时的电影大概是**低四位数**次请求，离 10 万很远。

用的是 WebSocket Hibernation：没人说话的时候这个对象会被休眠，不计算时长费用。

出处：[Durable Objects 免费额度](https://developers.cloudflare.com/durable-objects/platform/pricing/)、
[WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/examples/websocket-server/)

### 为什么必须是 Durable Object 而不是普通 Worker

普通 Worker 没有共享状态，同一个房间的两个人会落到两个互相看不见的 isolate 上。
Durable Object 是**按名字寻址**的，`/room/ABC123` 在全世界任何地方都指向同一个实例。
`wrangler.toml` 里那段 `new_sqlite_classes` 是必须的 —— 免费版只开放 SQLite 版的
Durable Objects。

---

# 路线 B · 自己的机器（一条命令）

```bash
npm run together
```

零依赖，**不用 `npm install`**（这个仓库的依赖是给构建用的，中转一个都不需要）。
它会起中转、**等它真的听上端口**、然后把该粘贴的那条地址框出来：

```
┌──────────────────────────────────────────────────────────────┐
│ 一起看中转已启动（仅局域网）                                 │
│                                                              │
│ 把下面这条粘进播放页右侧「一起看」卡片：                     │
│                                                              │
│     http://192.168.1.9:23686                                 │
│                                                              │
│ ⚠ 局域网地址，只有和这台机器在同一个网络里的人连得上。       │
└──────────────────────────────────────────────────────────────┘
```

复制那条，粘进播放页右侧的「一起看」卡片，完事。

（先等端口听上再打印，是因为反过来的话端口被占时也会先打出一条看着很正常的地址，
人复制走了才发现根本连不上。）

## 三种用法

```bash
npm run together                                      # 只在局域网里
npm run together -- --tunnel                          # 顺便开隧道，给一条公网 https 地址
npm run together -- --url https://together.example    # 你已经有反代/域名了，直接打印它
PORT=9000 npm run together                            # 换端口
```

**`--tunnel` 得自己加，不会因为装了 cloudflared 就自动开** —— 开隧道等于把这台机器上
的一个服务挂到公网上，那是个对外的动作，不该由一个启动脚本替你做主。加了之后它调
`cloudflared tunnel --url`，把那条地址打出来：

```
┌──────────────────────────────────────────────────────────────┐
│ 一起看中转已启动（公网可达）                                 │
│                                                              │
│     https://weird-lamp-echo-42.trycloudflare.com             │
│                                                              │
│ ⚠ 脚本一停隧道就没了，下次再开会换一个新地址。               │
└──────────────────────────────────────────────────────────────┘
```

没装 cloudflared 的话它会把三个平台的安装命令打出来，同时中转照常在局域网上跑着 ——
不会因为隧道开不起来就整个失败。

想跳过这层封装直接跑裸服务：`npm run together:raw`。

启动后本机自测：

```bash
curl http://127.0.0.1:23686/
# 期望:LinWeb 一起看 relay. Connect a websocket to /room/<code>.
```

## ⚠️ 一条铁律：https 的页面只能连 wss

如果你的播放器是 `https://` 打开的（Pages 托管、或者你自己配了证书），浏览器**禁止**
它连 `ws://`，会被当成混合内容直接拦掉，而且报错信息不会告诉你这一点。

这个脚本自己**不做 TLS**。所以它必须挂在一个已经有证书的东西后面。三种办法：

### B-1 · Cloudflare Tunnel（家宽 / NAS 首选，免费，不用公网 IP、不用开端口）

```bash
cloudflared tunnel --url http://localhost:23686
```

它会打印一个 `https://<随机词>.trycloudflare.com`，直接拿去用。这种临时隧道**重启就换
地址**，长期用就按 [Cloudflare 官方文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
建一条命名隧道绑自己的域名。

Cloudflare Tunnel 免费版转发 WebSocket 没问题，注意两条：空闲超时 100 秒（心跳 25 秒
一次，够了）、单条消息上限 32 MiB（我们最大的一条是几 KB 的 SDP）。
出处：[Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets/)

### B-2 · 已有 nginx

和 [DEPLOY.md](DEPLOY.md) 方式 D 里那段是同一套写法，`map` 那块复用：

```nginx
location /room/ {
    proxy_pass http://127.0.0.1:23686;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;      # 一部电影比默认的 60s 长得多,不改会中途掉线
}
```

中转地址就填 `https://你的域名`（客户端会自己换成 `wss://`）。

### B-3 · 已有 Caddy

```
你的域名 {
    reverse_proxy /room/* 127.0.0.1:23686
}
```

Caddy 自动处理 WebSocket 升级，也自动签证书，不用额外配置。

## 让它常驻

### Linux（systemd）

```ini
# /etc/systemd/system/linweb-together.service
[Unit]
Description=LinWeb 一起看 relay
After=network.target

[Service]
# 裸服务，不是 together-deploy.mjs：后者只是为了把地址打给人看，
# systemd 下没人看那个框，重启也由 systemd 自己管
ExecStart=/usr/bin/node /opt/webplayer/tools/together-server.mjs
Environment=PORT=23686
Restart=always
User=nobody

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now linweb-together
```

### Windows

用「任务计划程序」建一个「计算机启动时」触发的任务，程序填 `node`，参数填
`D:\...\tools\together-server.mjs`。

### Docker

仓库现有的镜像只发静态站，没带中转（多一个进程、多一个端口，不想让所有人都被迫背上）。
要一起跑就自己加一层：

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY src/together ./src/together
COPY tools/together-server.mjs ./tools/
EXPOSE 23686
CMD ["node", "tools/together-server.mjs"]
```

```bash
docker build -f Dockerfile.together -t linweb-together .
docker run -d --restart unless-stopped -p 23686:23686 linweb-together
```

---

# 路线 C · 托管平台

把 `tools/together-server.mjs`（和它依赖的 `src/together/relay.js`）推上去，启动命令
`node tools/together-server.mjs`，端口读 `PORT` 环境变量 —— 这三点是所有平台的通用要求，
这个脚本都满足了。

⚠️ 这里用**裸服务**，不是 `npm run together`。后者是给人看地址用的封装，托管平台自己
会给你域名，不需要它 —— 而且它会在前台等着，有些平台会因此判定启动没完成。

## ⚠️ 先看这条：免费档「休眠」会掐断连接

Render、Koyeb、Replit 的免费实例都会在「一段时间没流量」之后休眠，**休眠 = 杀进程 =
所有正在看的人一起掉线**。而且据这些平台的文档和社区反馈，它们判断「有没有流量」看的
是 **HTTP 请求**，WebSocket 帧不算 —— 也就是说你们正看得好好的，它认为你在闲置。

（这一条我没有实测，是从各家文档和社区报告推出来的。你要是不怕折腾可以试，掉线了
客户端会自己重连、并把房间状态重新对齐，但会黑一下。）

**所以免费档我只推荐不休眠的那几家。**

| 平台 | 是否休眠 | 免费额度现状 | 要绑卡 | 出处 |
|---|---|---|---|---|
| **Cloudflare Workers + DO** | 否（休眠不掉线，专门设计的） | 10 万请求/天 | 否 | [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| **Railway** | 否 | $5 试用 30 天，之后要付费 | 否 | [pricing](https://railway.com/pricing) |
| **Render 免费档** | **是**（15 分钟） | 750 小时/月 | 否 | [free tier](https://render.com/docs/free) |
| **Koyeb 免费档** | **是**（1 小时） | 512MB / 0.1 vCPU | 否 | [pricing](https://www.koyeb.com/pricing) |
| **Google Cloud e2-micro** | 否 | 永久免费小机器 | 是（不扣费） | [free tier](https://cloud.google.com/free) |
| **Oracle Cloud Always Free** | 否 | ARM 实例（2026 已缩水） | 是（不扣费） | [free tier](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm) |
| **Render / Koyeb 最小付费档** | 否 | 约 $5–7/月 | 是 | — |

**Glitch 已经关站**（2025-07-08 停止托管项目），别再找它了。
出处：[官方公告](https://support.glitch.com/t/discussion-thread-project-hosting-ending-july-8/75660)

拿到平台给的 `https://xxx.onrender.com` 之类的地址，整条填进播放器就行。

---

# 用不了的平台（问得最多的两个）

## ❌ Vercel

Vercel 从 2026 年 6 月起**确实支持 WebSocket 了**，但对「一起看」这个场景仍然不行，
两个理由都是硬伤：

1. **连接会跟着函数一起被掐掉。** 官方原文，就在 WebSocket 那页上：
   > *"WebSocket connections close when a Vercel Function reaches its maximum duration."*

   Hobby 档的 maximum duration 是 **300 秒**。也就是说**每 5 分钟必掉一次线**，一部
   两小时的电影要掉 24 次。Pro 档最长 30 分钟（还在 beta），也不够。
   出处：[Vercel WebSockets](https://vercel.com/docs/functions/websockets)、
   [Functions limitations](https://vercel.com/docs/functions/limitations)
2. **连接被钉在单个函数实例上，实例之间没有共享内存。** 官方原文：
   > *"A single WebSocket connection is pinned to one Vercel Function instance… New WebSocket connections are not guaranteed to reach the same Vercel Function instance."*

   也就是说房间里第二个人可能连到另一个实例上，**看不见第一个人**。Vercel 自己给的
   解法是「把房间状态放进外部的 Redis」—— 那就等于还要再租一个 Redis，为了省一个中转
   而多一个中转。
   出处：[Vercel WebSockets](https://vercel.com/docs/functions/websockets)

Vercel 官方文档自己也把 realtime 需求导向 Ably / Pusher / PartyKit 这些第三方。
出处：[Vercel 的 realtime 指南](https://vercel.com/kb/guide/publish-and-subscribe-to-realtime-data-on-vercel)

**Vercel 用来托管播放器本身（静态站）完全没问题**，只是别拿它当中转。

## ❌ Netlify

Netlify Functions 明确不支持 WebSocket；Edge Functions 底层虽然是 Deno，但官方从没
承诺过 WebSocket 支持，也没有示例。Netlify 自己的博客把这类需求导向 Jamsocket / Ably。
出处：[Netlify 官方博客](https://www.netlify.com/blog/web-sockets-in-a-serverless-world/)

同样，**托管静态站没问题**，当中转不行。

## 🟡 Deno Deploy — 有希望，但我没敢写

`Deno.upgradeWebSocket` 是标准 API，免费额度 100 万请求/月、不用绑卡，看起来很合适。
卡住的是**同一个房间的两个人可能落在两个 isolate 上，互相看不见** —— 和 Vercel 一样的
问题，Cloudflare 用 Durable Object 的按名寻址解决了，Deno 这边：

- 老版本（Deno Deploy Classic）有 `BroadcastChannel` 做跨 isolate 广播，正好能解决。
  但 **Classic 已经在 2026-07-20 关站**了。
- 新版 Deno Deploy 的官方文档里**找不到 BroadcastChannel 那一页**，迁移指南也没提它
  （被移除的 Queues 倒是写了）。官方 GA 公告里改推 **Deno KV 的 `watch()`** 来做实时。

也就是说要么 BroadcastChannel 还在只是没写进文档，要么得改成用 KV watch 重写一遍
广播 —— 两种情况我都没有能拿来验证的环境（这台机器上没装 Deno，也没有 Deno Deploy
账号）。

**没验证过的东西我不往仓库里放。** 你要是想要 Deno 版本，说一声，我先把这件事查实
（或者你有账号我们直接试）再写，不会拿一个「应该能行」的文件糊弄过去。

出处：[Deno Deploy 迁移指南](https://docs.deno.com/deploy/migration_guide/)、
[KV watch](https://deno.com/blog/kv-watch)

---

# 部署完了，怎么加进播放器

1. 正常从媒体库进到播放页（`play.html`）
2. 右侧栏往下找到 **「一起看」** 那张卡片
3. 最上面那个输入框，**把中转地址整条粘进去** —— `https://` 开头的直接粘，不用手动
   改成 `wss://`，客户端自己会换；只写个 `我的域名:23686` 也认，会跟着当前页面用
   `ws` 还是 `wss`
4. 填个昵称（默认随机给一个）
5. 点 **「开房间」** —— 它会随机生成一个 6 位房间号并立刻连上

地址存在浏览器的 localStorage 里，**下次自动带上**，不用每次填。它不进任何提交、不进
代码、不上传到托管静态文件的服务器。

## 叫人进来

点 **「复制邀请」**，把链接发给对方。链接长这样：

```
https://你的站/play.html?url=…#together=ABC123&relay=https://你的中转
```

对方打开就自动进房间 —— 中转地址在 URL 的 **`#` 后面**，也就是 fragment，浏览器**不会
把它发给服务器**，所以哪怕你的播放器托管在 Pages 上，托管商也拿不到你的中转地址。

对方要是自己已经填过中转，也可以只把 6 位房间号念给他，他填进「房间号」点「加入」。

⚠️ **邀请链接里带的是你这边的播放地址。** 对方得能访问到同一个 Emby（同一条线路、
有自己的账号）才能真的播出来 —— 一起看同步的是「进度」，不是影片本身。

## 房间里能干什么

| | |
|---|---|
| **播放 / 暂停 / 拖进度** | 谁都能操作，全房间跟着走。不设权限 —— 一个房间就是几个已经在说话的人，为了暂停一下还要请示更难受 |
| **打字聊天** | 下面那个输入框，回车发送。每条消息带发言时的播放时间 |
| **语音** | 点「开麦」，浏览器会要麦克风权限。之后音频是和每个人直连的，不过中转 |
| **静音自己** | 开麦之后出现。按住不放那种不做，就是个开关 |
| **退出** | 点「退出」，或者直接关页面 |

成员列表里会显示谁是房主、谁在说话、你自己偏差了多少秒。

---

# 排查

| 现象 | 大概率原因 |
|---|---|
| 状态一直是「连接中」然后「重连中」 | 地址错了，或者中转没起来。先 `curl https://你的中转/`，应该回一行说明文字 |
| 控制台报 mixed content / 被拦截 | https 页面连了 `ws://`。中转必须有 TLS，见路线 B 的三种办法 |
| 进去了但只有自己一个人 | 两个人的**房间号**不一样（大小写不敏感，但别打错），或者两个人填的**中转不是同一个** |
| 看了十几分钟突然全掉线 | 平台把实例休眠了（Render / Koyeb 免费档），或者反代的 `proxy_read_timeout` 太短 |
| 进度对不齐，一直在追 | 有人的网络在丢包。偏差超过 2.5 秒才会跳转，中间靠 ±8% 变速慢慢吃掉，是正常的 |
| 语音显示「打不通」 | 大约一成的网络（两端都是对称 NAT，或者公司网把 UDP 全丢了）建不起直连，需要 TURN，见下 |
| 语音一个人都听不见 | 麦克风权限没给；或者对方没点「开麦」——两边都开了才会建连接 |

## 关于 TURN

打不通直连的那一成需要一台 TURN 服务器，而 TURN 按定义要**转发音频**，不可能永远免费。
所以仓库里没有内置任何凭据（会过期，而且会被提交进去）。有的话填进面板里
「中转与打洞」那一栏：

```json
[{"urls":"turn:你的地址:3478","username":"u","credential":"p"}]
```

不填也能用，只是那一成的组合连不上语音。**进度同步和文字聊天不受影响** —— 那两样走
中转，和 TURN 无关。

---

# 自测

改了中转代码之后：

```bash
node tools/test-together.mjs      # 协议 + 手写的 WebSocket 帧编解码(在 npm test 里)

# Cloudflare 版,跑在真的 workerd 上
cd worker && npx wrangler dev --port 8799 --local
node tools/test-worker.mjs

# 两个真浏览器,一个按播放断言另一个跟上
node tools/test-together-ui.mjs
```

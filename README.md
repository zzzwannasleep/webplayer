# webplayer

浏览器里播放带 HDR / Dolby Vision 和软字幕的 MKV / MP4 / MOV / WebM / FLV。
零转码:容器在本地被拆开、重新封装成分片 MP4(fragmented MP4)交给 Media Source
Extensions,编码码流的字节自始至终原封不动。

```bash
npm install
npm run build      # 打包 wasm + 铺平站点 -> dist/
npm run deploy     # 在局域网起服务,打印手机能打开的地址
```

想接 Emby,**先读下面的「部署」**——决定成败的不是托管,是浏览器的两道墙。

---

## 部署

站点是纯静态的(HTML + ES 模块 + wasm),没有后端。任何支持 HTTP `Range` 的托管
都能跑。难的是它要连的那个 Emby。

### 一条铁律,先看这个

> **HTTPS 页面不能连 HTTP 的 Emby。**
>
> 把 LinWeb 放上 GitHub Pages(https),再去连局域网 `http://192.168.x.x:8096`,
> 浏览器会**直接拦掉**请求(mixed content)。症状很有迷惑性:能登录、能看封面,
> 但**视频点了没反应**,或者报一个看起来像 CORS 的错。
>
> 这不是 bug,是安全策略,没有前端绕过手段。要么给 Emby 上 https,要么把 LinWeb
> 也降到 http 放进局域网。

### 对号入座

| 你的 Emby | 用哪种 | 为什么 |
|---|---|---|
| 局域网、`http://` | **A · Docker**(或 B · 裸 Node) | 两边都是 http、同一内网,没有混合内容墙 |
| 公网、有域名和证书 `https://` | **C · Pages 托管** | 两边都是 https,浏览器放行 |
| 已经有 Caddy / nginx 在跑、想同源免掉跨域 | **D · 同源反代** | 挂进现成的站点,不多起一个容器;混合内容和 CORS 两道墙一起消失 |

### A · Docker(推荐,一条命令)

镜像由 GitHub Actions 构建后推到 Docker Hub(`linux/amd64` + `linux/arm64`),
不用克隆仓库、不用装 Node:

```bash
docker run -d --name linweb --restart unless-stopped \
  -p 23685:23685 zzzwannasleep/linweb
```

想自己构建也行:

```bash
docker compose up -d
# 或:docker build -t linweb . && docker run -d -p 23685:23685 linweb
```

打开 `http://<这台机器的IP>:23685/emby.html`。换端口改映射即可(`-p 8080:23685`),
容器内部固定 23685。

镜像是 nginx alpine-slim + 构建产物:**拉取 18.3 MB,落盘约 53 MB**;跑起来是单个
nginx worker,**常驻内存 10 MB 上下**,镜像里没有 Node、没有 npm、没有任何运行时。

> 群晖 / unraid 图形界面怎么点、多个容器的组织方式、装完拿什么自检、怎么更新、
> 怎么挂到已有的 https 反代后面 —— 都在
> **[DEPLOY.md 的 Docker 教程](DEPLOY.md#a--docker端口-23685)**。

<details>
<summary>镜像里有什么、怎么再瘦一半,以及三个容易踩的地方</summary>

**落盘那 53 MB 里,31 MB 是一个文件**:`vendor/ffmpeg-core.wasm`,给浏览器一律不解的
E-AC3 / AC-3 / DTS / TrueHD 兜底。片库里没有这些音轨的话可以整块扔掉:

```bash
docker build --build-arg WITH_FFMPEG=0 -t linweb .    # 落盘降到约 22 MB
```

视频和其他音频编码都由浏览器解,不受影响;真遇到 DTS 音轨时会解码失败而已。

镜像**不带任何缓存**(`Cache-Control: no-cache`):这个构建的文件名不带哈希,
缓存狠了等于让人一直跑上周的 JS。它仍然会存盘,只是每次回源校验,32 MB 的 wasm
命中 304 只花一个来回。

</details>

### B · 局域网自托管(不想装 Docker)

在任意一台**和 Emby 同局域网、常开机**的机器上(可以就是跑 Emby 那台):

```bash
npm ci
npm run deploy
```

它会构建并在所有网卡上开服务,打印形如 `http://192.168.1.10:8080/emby.html` 的
地址。同一 WiFi 下的手机 / 电视 / 电脑直接打开。`Ctrl+C` 停止。

- 换端口:`PORT=9000 npm run deploy`
- 已构建过、只想起服务:`node tools/deploy.mjs --no-build`
- **仍然需要在 Emby 上开 CORS**(端口不同就是跨域),见下。

### C · Pages 托管(仅限公网 https 的 Emby)

仓库自带 `.github/workflows/deploy.yml`,**push 到 `main` 即自动构建发布**。
只需在仓库 `Settings → Pages → Source` 选 **GitHub Actions**。

Cloudflare Pages / Netlify / Vercel 则填:构建命令 `npm run build`,输出目录
`dist`,Node 18+。

> 这些平台一律强制 https,所以它们**只**适合公网 https 的 Emby。

### D · 同源反代(已经有 Caddy / nginx 的话)

把 LinWeb 和 Emby 挂进你现成的 Caddy / nginx,同源、混合内容和 CORS 两道墙一起消失。

```bash
npm run build      # 产物在 dist/
```

然后交给 Caddy / nginx,配置示例见 **[DEPLOY.md](DEPLOY.md)**。

### Emby 跨域(CORS)配置

走方式 D(同源反代)的,同源,**跳过这一节**。其余情况
LinWeb 和 Emby 不同源,Emby 必须返回跨域头。在 Emby 后台
把允许来源填 `*`(或精确填 LinWeb 地址),并确认放行:

```
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Accept-Ranges, Content-Length, Content-Range
```

`Expose-Headers` 那三个是**能拖进度条的关键**。少了它们,视频要么整段拉,要么直接
报"跨域文件需要服务器返回 …"。

### 遇到问题时查这张表

| 现象 | 原因 | 处理 |
|---|---|---|
| 能登录、能看封面,**视频点了不播** | 典型混合内容:https 页面连 http Emby | 换方式 A,或给 Emby 上 https |
| 登录就报「跨域 / 不允许跨域」 | Emby 没开 CORS | 按上面配 CORS |
| 报「跨域文件需要服务器返回 Access-Control-Expose-Headers…」 | Expose-Headers 少了 Range 相关头 | 补 `Content-Range, Accept-Ranges, Content-Length` |
| **进度条拖不动**,只能从头播 | 服务器不支持 `Range`(`python -m http.server` 就不支持) | 换 `node tools/serve.mjs dist` / nginx / Caddy |
| 公网页面连**局域网 IP** 被拦 | 浏览器 Private Network Access 限制 | 别用公网托管连内网,改方式 A |
| **手机上改了半天没变化** | 浏览器缓存(本项目无 Service Worker) | 用**无痕标签页**打开,一步绕过所有缓存 |
| iPhone 上**滑动调音量没反应** | iOS 忽略网页对 `video.volume` 的写入,是系统限制 | 用手机侧边的音量键;播放器会提示 |
| iPhone 全屏后地址栏还在 | iPhone 没有 `Element.requestFullscreen`,走的是页内全屏 | 正常。这样才能保住字幕/弹幕/超分叠加层 |
| `.avi` / `.ts` / `.rmvb` 打不开 | 故意不支持,见下面的「容器」 | `ffmpeg -i in.avi -c copy out.mkv`,几秒且不重编码 |
| `.strm` 播到一半画面冻住 | S3 预签名链接中途过期(默认 1 小时,电影更长) | 已处理:自动改由服务器接管并续播 |
| 115 / 夸克 / 阿里云盘直链放不了 | 它们校验 `User-Agent`,而浏览器改不了([crbug 571722][ua]) | 纯前端无解,只能让 Emby 服务端代理 |
| 在线弹幕匹配不到 | 弹弹play / B 站接口都不给 CORS 头 | 需自建兼容端点,见「弹幕」;拖本地弹幕文件始终可用 |
| 容器起来了但**页面打不开** | 端口映射写反了 | 容器内固定 23685:`-p <外部端口>:23685` |

完整教程、Caddy/nginx 示例、常驻运行(PM2 / systemd)见 **[DEPLOY.md](DEPLOY.md)**。

[ua]: https://issues.chromium.org/issues/40447179

---

## 手机端

手势、粗指针样式和保住叠加层的全屏都在 `src/ui/touch.js`,两个播放页共用。

| 手势 | 作用 |
|---|---|
| 单击 | 唤出 / 收起控制条 |
| 左右边缘双击 | 快退 / 快进 10 秒,连点累加(10、20、30…) |
| 中间双击 | 播放 / 暂停 |
| 长按 | 按住期间 2 倍速,松手回到你在设置里选的倍速 |
| 横向拖动 | 拖进度,松手生效 |
| 左半竖向拖动 | 亮度(网页改不了背光,是一层可调的黑纱) |
| 右半竖向拖动 | 音量(iOS 上无效,见上面的排查表) |

画面里的**齿轮**是所有播放选择的入口:字幕、倍速、轨道、弹幕、响度、超分各占一栏,
点进去是一个二级面板,竖屏时从底部升起。齿轮**左边**那个方框图标是**弹幕**开关,不是字幕 ——
还没加载弹幕时按它会直接打开弹幕面板,而不是什么都不做。

浏览壳(`emby.html`)在 760px 以下换成另一种形状:68px 侧栏变成带文字的**底部标签栏**,
顶栏随滚动隐藏、上滑即回,搜索收成一个图标,一行三张海报,所有居中弹窗变成底部抽屉,
**长按**代替右键唤出卡片菜单。设置面板竖屏是底部抽屉、横屏是右侧抽屉。

播放时会申请 Wake Lock,屏幕不再中途变暗。

---

## 现状

已能工作:

- Matroska 解复用 —— 轨道、附件、cues、SimpleBlock/BlockGroup,三种 lacing 模式全支持
- ISOBMFF(mp4/mov/m4v)与 FLV 解复用,和 MKV 走同一条重封装管线,
  因此轨道选择、内嵌字幕、HDR 判定一视同仁(见下面折叠的**容器**一节)
- fMP4 重封装,视频支持 HEVC、AVC、AV1、VP9,音频支持 AAC、FLAC、Opus、MP3
- HDR 直通,包括色彩元数据**只**存在于 SPS VUI 里的文件
- Dolby Vision profile 8.x 的识别与播放
- 通过 Cues 索引 seek,在 21 GB 文件上字节级精确
- 配额感知的缓冲,自动驱逐已播放过的媒体
- 轨道压缩(`ContentEncodings`):zlib 与 header stripping
- 字幕:带内嵌字体的特效 ASS、PGS、内嵌文本轨(MKV 的 SRT / mp4 的 tx3g·wvtt),
  以及 Emby 外挂字幕 —— **一切直传,地址全部来自服务器**:视频用 MediaSource
  自报的 `DirectStreamUrl`,外挂字幕用字幕流自报的 `DeliveryUrl`,客户端不再
  拼接任何媒体 URL。外挂 ASS 整脚本交给 libass(特效保留,`[Fonts]` 内嵌
  子集字体直接生效);SRT 原文件取回后在浏览器内存转 VTT 交给 `<track>`;
  VTT 原样挂载;内嵌字幕全部本地解复用,零服务器参与
- 弹幕:B 站 XML 与弹弹play JSON 两种格式,canvas 渲染,按条目记住(设置进
  localStorage、弹幕本体进 IndexedDB;见下面折叠的**弹幕**一节)
- **一起看**:房间同步播放进度、文字聊天、浏览器之间直连的实时语音。中转自己部署,
  Cloudflare Worker 和零依赖 Node 两个版本都在仓库里;部署教程见
  **[DEPLOY-TOGETHER.md](DEPLOY-TOGETHER.md)**,原理见下面折叠的**一起看**一节
- 手机端:完整手势、底部标签栏、安全区适配(见上面的**手机端**)
- Emby 接入 —— 浏览服务器、直连播放(零转码)原盘字节、双向续看、把详情页里
  选好的音轨/字幕逐轨预选并带进专用播放器。外挂字幕(sidecar .ass/.srt/.vtt)
  按原格式直传取字节:ASS 整脚本交给 libass 渲染(特效保留,`[Fonts]` 内嵌
  子集字体直接生效),SRT/VTT 原样进浏览器 `<track>`;播放中可在字幕菜单里
  换选任意一条外挂字幕。见 `public/emby.html` + `src/emby/client.js`,
  部署说明见 **[DEPLOY.md](DEPLOY.md)**
- `.strm` 远程源(自建 S3/MinIO、alist/OpenList、302 跳板)—— 容器一个都认不出、
  服务器不肯说文件多长、不支持 Range、或干脆没有 CORS 头,这些情况都改由浏览器
  原生解码接管而不是报错。见下面折叠的 **.strm 与原生兜底**
- 没有 Cues 索引的文件里 seek,靠对 cluster 做二分查找
- E-AC3 / AC-3 / DTS / TrueHD,**仅在 `audio-eac3-ffmpeg` 分支上**:用 ffmpeg.wasm
  解码再重编码成 Opus。那个分支是 GPL-2.0-or-later(因为 `@ffmpeg/core` 是);
  `main` 保持 MIT,遇到这些文件则静音播放

尚未实现:

- VobSub 和 DVB 字幕。能识别、能上报,但不绘制(外挂也一样)

---

<details>
<summary><b>为什么是重新封装,而不是解码</b> —— canvas 装不下 PQ,所以"解码到 canvas"会丢掉 HDR</summary>

最直觉的设计——用 WebCodecs 的 `VideoDecoder` 把画面画进 canvas——经过实测被否
决。在开启系统 HDR 的 Edge 150 上:

| 能力 | 结果 |
|---|---|
| `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L150.B0"')` | **支持** |
| `canvas.getContext('2d', {colorSpace:'rec2100-pq'})` | **不支持** |
| `canvas.getContext('2d', {colorSpace:'rec2100-hlg'})` | **不支持** |
| `matchMedia('(dynamic-range: high)')` | 支持 |

这个浏览器的 canvas 装不下 PQ 色彩空间,所以任何"解码到 canvas"的管线都会丢掉
HDR——连同画中画、全屏、投屏和硬件加速呈现一起丢。把 `<video>` 喂给 MSE 则全部
保住,HEVC 的访问单元(access unit)原样穿过。

在**前台**窗口里运行 `public/probe.html` 可在任意机器上重测。无头 Chromium 不带
平台 HEVC 解码器,这里每个编码都会报"不支持",所以无头环境的数字对这个决策毫无
意义。

</details>

<details>
<summary><b>火狐(Gecko)</b> —— 实测的能力面,以及唯一两条真差异</summary>

由 `tools/probe-firefox.mjs` 在**真 Firefox 153 / Windows** 上测得,不是查表:

| 送给 `MediaSource.isTypeSupported` 的串 | 火狐 |
|---|---|
| `avc1.*` / `av01.*` / `vp09.*` | 收 |
| `hvc1.1.6.L93.B0`、`hvc1.2.4.L150.B0`(HEVC 含 Main10 HDR) | **收** |
| `mp4a.40.2` / `opus` / `flac` | 收 |
| `ac-3` / `ec-3` / `dtsc` | 拒 |
| `mp4a.6B`(MP3 装进 MP4) | **拒**(Chromium 收) |

以及 `changeType`、`requestVideoFrameCallback`、`navigator.gpu`、`VideoDecoder`/
`AudioEncoder`(opus)、module worker、wasm SIMD **全部具备**。所以"火狐播不了
HEVC"、"火狐没有 rVFC"这类说法在这个版本上都不成立——照着它们改代码只会制造 bug。

真正的差异只有两条,都已经修掉:

1. **MP3 音轨会静音。** 火狐拒收 `mp4a.6B`,而 `RAW_FORMATS` 当时没有 MPEG 音频,
   软解兜底不接管,直接掉进"playing without audio"。老 MKV rip 和几乎所有 FLV 都是
   MP3。加进 `RAW_FORMATS` 即可——MP3 帧和 AC-3 一样自带同步字与长度,现有"拼接连续
   块=合法基本流"的前提原样成立,不需要新管线。AC-3/E-AC-3/DTS/TrueHD 本来就走这条
   路,在火狐上实测出声。
2. **超分每帧抛异常。** Gecko 的 `copyExternalImageToTexture` 不接受
   `HTMLVideoElement` 作纹理源(只收 ImageBitmap/canvas),Chromium 接受。
   `navigator.gpu` 是 `true`,能力探测一路绿灯,只有真喂帧才炸。现在首次失败后转走
   画布中转,**Chromium 的直传零拷贝快路径原样保留**——它不抛,就永远不建那块画布。

杜比视界**不是**差异:`src/demux/mp4.js` 早就把 `dvh1`/`dvhe` 映射回
`V_MPEGH/ISO/HEVC`,muxer 一律输出 `hvc1`,我们从不把 `dvh1` 交给 MSE。

</details>

<details>
<summary><b>字幕</b> —— 三种渲染器、为什么不用纯 JS 的 ASS.js</summary>

| 格式 | 渲染器 | 许可证 |
|---|---|---|
| ASS / SSA | [JASSUB](https://github.com/ThaUnknown/jassub)(libass 的 wasm 版) | LGPL-2.1-or-later |
| PGS | [libpgs](https://github.com/Arcus92/libpgs-js) | MIT |
| SRT | 浏览器自带的 `<track>`,先转成 WebVTT | — |

两个渲染器都未打补丁,都只通过其公开 API 使用。功夫在于怎么喂它们,而每一个都需
要一点格式文档里说不清的东西。

**JASSUB 是 LGPL**,不同于本仓库的 MIT 代码。它被打成独立的 bundle
(`public/vendor/`),只通过公开接口使用,因此始终是一个单独授权、可替换的组件。

**为什么不换成纯 JS 的 [ASS.js](https://github.com/weizhenye/ASS)(MIT,约 34 kB,
比 wasm 小两个数量级)**:它自己的 [Differences with Specs](https://github.com/weizhenye/ASS/wiki/Differences-with-Specs)
表里,卡拉OK(`\k \kf \ko \kt \K`)标着 🚧 WIP,`\be` 退化成 `\blur`;源码里也没有
任何读取 `[Fonts]` 内嵌字体的路径(矢量绘图 `\p` 倒是支持的,它编译成 SVG
`<path>`)。动画特效字幕恰恰全在这两件事上 —— OP/ED 的逐字卡拉OK,和字幕组随片打包
的字体。所以 ASS.js 适合简单字幕和体积敏感的场合,不能替代 libass 做特效渲染;
LinWeb 继续用 JASSUB。

</details>

<details>
<summary><b>弹幕</b> —— 两种格式的字段顺序不同,在线源必须自建一层</summary>

| 来源 | 格式 | 怎么进来 |
|---|---|---|
| B 站导出 | `<d p="时间,模式,字号,颜色,…">文本</d>` | 拖进画面,或从设置面板载入 |
| 弹弹play 及兼容服务 | `{comments:[{p:"时间,模式,颜色,uid", m:"文本"}]}` | 同上,或按剧名+集数自动匹配 |

两种 `p` 的字段顺序**不一样**:颜色在 B 站是第 3 位、在弹弹play 是第 2 位。搞错
不会报错,只会让整屏弹幕变白或者用时间戳当颜色 —— 所以两个解析器分开写,
`tools/test-danmaku.mjs` 里有一条断言专门盯着这个差异。

**在线弹幕源必须自己搭一层。** 实测(不是猜):`api.dandanplay.net` 的每个
`/api/v2/*` 路由都返回 403 `Missing Authentication Headers`,响应里**没有任何**
`Access-Control-Allow-Origin`;签名还需要 AppSecret,而静态页面的任何密钥都是公开
的。B 站的 `list.so` 对 curl 返回 200,同样不带 ACAO,浏览器照样拿不到。
`danmaku-anywhere` 之所以做成浏览器扩展,就是这个原因。

因此播放页只跟**一个你自己部署的、兼容弹弹play 接口的地址**说话(在弹幕面板里填),
不配也完全能用 —— 本地文件拖进去就行。载入之后弹幕本体存进 IndexedDB,下次打开同
一集直接就在,不联网、不重新匹配。

渲染用 [danmaku](https://github.com/weizhenye/Danmaku)(MIT,9.8 kB,零依赖)的
canvas 引擎:一集三千多条弹幕,DOM 引擎就是三千多个动画节点。它自己负责防重叠和
跟随 `media.currentTime`,所以暂停、seek、倍速都不用额外接线。

**一个必须知道的坑**:这个库只在构造时媒体正在播放的情况下才会 seek 到播放头。
每次改设置都会重建渲染器,而人恰恰是暂停的时候去拖滑块的 —— 不处理的话一恢复播放,
整集的弹幕会一次性倒灌出来(实测 43800 个不透明像素 vs 修好后的 875)。
`src/danmaku/index.js` 因此给渲染器传的是一层 media 代理,拿得到它自己的 `seeking`
处理函数,重建后直接调一次。`public/dmkcheck.html` 里有这条断言。

</details>

<details>
<summary><b>一起看</b> —— 中转只搬信令,语音是浏览器之间直连</summary>

同步**片源**、播放进度、聊天、语音,四样都在播放页右侧那张「一起看」卡片里。填一个
中转地址、开个房间、把邀请链接发给朋友,就完了。

### 房间同步的是「放什么」,不是影片本身

房主打开一集,房间里其他人自动就打开同一集——**中转只搬那个描述,一个字节的影片都
不经过它**。每个人各自去 Emby 取流,和自己手点开那一集走的是同一条路。

同一台 Emby 上有账号的人,播放地址会用**他自己的 token** 重新拼(`api_key` 在发出去
之前就被摘掉了),所以各人按各人的账号播、各人报各人的进度;没有账号的客人才落到
房主那条现成的链接上。跟片源走的还有音轨、字幕轨、剧集信息,所以对面拿到的不是一个
光秃秃的地址,是和房主一模一样的那一集。

已经在看别的东西的人不会被拽走,卡片上出现一行「房间在放《…》」和一个**跟上房间**
按钮,点不点自己定;只有播放器里空空如也的人——也就是刚进来什么都没有的那个——会
直接被带过去。切过去时房间号跟着写进地址栏,所以跳转和刷新都不会把人踢出房间。

聊天记录也跟着过去(sessionStorage,按房间号存)。跟上房间是一次真的页面跳转,不存
就等于**每换一集把话都清空一次**,而那恰恰是大家正在说话的时候。用 sessionStorage
不用 localStorage:一段对话属于这个标签页、这一次坐下来看;明天开浏览器发现昨晚的
聊天还在,那不是功能。

### 全屏的时候

全屏的是画面容器不是页面,所以侧边栏那张卡整个不在屏幕上——而「谁卡住了」「刚才说
了什么」偏偏是这时候最想看的。所以画面下缘压着一条**迷你条**:最近几句、谁在缓冲、
一个输入框,别的都不要,那些在你全屏之前就已经用完了。它挂在画面容器里(不是侧边栏
里),所以能跟着一起进全屏;输入框里的按键会被拦下来,不然打一句带空格的话就顺手把
片子暂停了。

**中转地址不在仓库里,也不在代码里。** 和 Emby 服务器一样存在 localStorage,邀请
链接把它放在 URL 的 **fragment**(`#together=…&relay=…`)里,所以它连托管这些文件的
服务器都到不了。

### 中转怎么部署(挑一个)

| | 怎么跑 | 代价 |
|---|---|---|
| Cloudflare Worker | `cd worker && npx wrangler deploy` | 要一个 Cloudflare 账号。免费额度每天 10 万次请求 / 13000 GB-s,一个 8 人房间一晚上用掉的是低四位数 |
| 自建 Node | `npm run together`(问一句要不要后台跑,然后把该粘的地址框出来;默认 31614 端口) | 要一台机器。零依赖,连 `ws` 都没装 |

两边说的是同一套协议(`src/together/relay.js` 是共用的那部分逻辑),所以换一边房间
不会有任何区别;你自己再写一个也行,协议写在 `src/together/room.js` 顶部。

**https 页面只能连 `wss://`。** 自建版本自己不做 TLS —— 挂在你已有的反代或者
Cloudflare Tunnel 后面。

**Vercel 和 Netlify 当不了中转。** Vercel 的 WebSocket 连接跟着函数的最长执行时间
一起断(免费档 5 分钟,一部电影要断 24 次),而且连接被钉在单个实例上、实例之间没有
共享内存,房间里第二个人可能根本看不见第一个;Netlify Functions 干脆不支持 WebSocket。
两家托管**播放器本身**都没问题,只是别拿来当中转。完整对照(含 Railway / Render /
Koyeb / Deno Deploy / 免费 VPS 的现状和坑)在 [DEPLOY-TOGETHER.md](DEPLOY-TOGETHER.md)。

### 中转到底搬了什么

信令、进度、聊天。**语音一个字节都不经过它**:两个人交换完 SDP 之后音频就是浏览器
直连,WebRTC 强制 DTLS-SRTP 端到端加密,中转的运维者听不到。所以中转跑在免费额度上
不是带宽问题——它本来就没有带宽压力。

语音用全网状(mesh)而不是 SFU。「mesh 超过四个人就崩」说的是**视频**:一路 Opus
语音大约 30–40 kbit/s,八个人全开麦也就是每边四分之一兆,比影片本身小得多。换成
SFU 意味着多一台要维护的服务器,还要让每句话都从别人的机器上过一遍,省下的是没人
缺的那点带宽。

大约一成的网络打不通直连(两端都是对称 NAT,或者公司网络把 UDP 全丢了),那种情况
需要 TURN,而 TURN 按定义要转发音频、不可能永远免费。所以仓库里**没有**内置任何
TURN 凭据(它们会过期,而且会被提交进仓库);面板里有一个 `iceServers` 输入框,有就
填,没有就接受十分之一的连不上。

### 进度是怎么对齐的

房间里只有一个共享事实:最后一次有人明确按下的操作,盖上中转的时间戳。

```
target = paused ? pos : pos + (relayNow - at) / 1000 * rate
```

时钟对齐用 NTP 那套 ping/pong,保留 8 个样本、**取 RTT 最小的那个**而不是取平均:
一个被排队的包只在一个方向上被延迟,均值会把这份不对称原样吃进去。

漂移纠正的阈值是**为这个播放器改过的**。Jellyfin 的 SyncPlay 超过 400 ms 就直接
seek,那是假设 seek 很便宜;在这里 seek 意味着从最近的关键帧重新解复用、重新灌
MSE 缓冲,是好几秒的黑屏,比差 800 ms 难受得多。所以:

| 偏差 | 动作 |
|---|---|
| < 80 ms | 什么都不做,那是测量噪声 |
| 80 ms ~ 2.5 s | 微调 `playbackRate`,幅度封顶 ±8%(再大对白就能听出来) |
| > 2.5 s | 才 seek —— 这是「有人跳去了另一段」,不是「我们飘了」 |

谁都可以播放/暂停/seek,不设权限:一个房间就是两到八个已经在说话的人,为了暂停一下
还要请示,比偶尔被暂停两次更难受。房主只干两件需要唯一声音的事——每 5 秒用自己真实
的播放头重新校准房间,以及在等完缓冲之后按下播放。

谁卡了,所有人一起等(Jellyfin 的 GroupWait 那一套)。不这么做的话,网络最差的那个
人一晚上会落后一分钟,而唯一的补救是手动 seek,那又会把其他所有人一起拽走。**但只等
20 秒**——等一个正在缓冲的人是对的,等一个永远不会好的人就是整个房间莫名其妙冻在那里
没有任何解释。超时之后房间不再算他,他一报「好了」就重新回到锁步里。

### 走掉了但没说一声的人

**`socket.setTimeout` 抓不到这种人**,因为它被「写」也算作活动(实测:一个每 120 ms
被写一次的 socket,400 ms 的超时永远不触发),而房主每 5 秒就要给每个成员广播一次锚点。
所以一个合上笔记本走人的成员会被一直写下去、永远不空闲、赖在成员列表里,**还可能被
选成房主**——那之后就没人再给房间定锚了。

判定因此放在中转的应用层:每收到一帧就记一次 `seen`,超过 70 秒(客户端 25 秒一个
ping,两次没到加余量)没听见就请出房间。裸 Node 版用 `setInterval` 扫,Cloudflare 版
用 **Durable Object alarm** ——休眠会把 `setInterval` 一起蒸发掉,而 alarm 是运行时
存着的,不管有没有人醒着都会响,这正好就是最需要它的那种情况:房间里只剩一个已经不
存在的成员。

### 房间密码

**平时没有密码框。** 想加才有(灰字里的「加个密码」),或者被中转挡回来时才出现——
那时它已经拿着你刚填的房间号,你要做的下一件事就是打字,而不是先找框在哪。

六位房间号是九亿分之一,没人会拿 WebSocket 去爆破它;密码真正的用处是让**一个你能
记住、能念出口的房间号**(比如「我们家」)可以反复用,而上周听见的人这周进不来。
房间空了密码就忘掉,所以同一个号下周能配一个新的。

密码跟着邀请链接走。这不是漏洞:**邀请链接本身就是凭证**,而且它在 URL 的 fragment
里、连托管这些文件的服务器都收不到;要是还得另外口头念一遍密码,那就又回到了「念一
串没人记得住的东西」。密码不对是唯一**不重连**的断开——重连一个错密码只是每秒重连
一次错密码。

### 只有手里真有影片的人说话

一个从来没加载成功的 `<video>`,`paused` 是 true、`currentTime` 是 0。这两个数不是
关于影片的事实,是**没有影片**这件事本身。以前它们照样会被当成「有人按了暂停」广播
出去,于是打不开片源的那个人——换了账号、链接过期、浏览器不认这个编码——每次
`play()` 失败都会把整个房间拽回开头暂停掉,房主看起来就是在随机自己暂停。所以现在
`readyState < HAVE_METADATA` 的成员只听不说:它照样知道房间放到哪了(面板上看得见),
但它不往外发状态、也不能让全房间等它。

同一条链子上还有两处:纠偏每 500 ms 写一次 `playbackRate`,以前每次都变成一个状态帧
广播出去,于是一个只是慢了 200 毫秒的人一秒钟给全房间重新定两次锚——现在 `ratechange`
干脆不监听了,观众自己选的倍速走 `setRate()`,那才是人的意思。回声抑制也从「一个
`setTimeout(…, 0)` 清掉的布尔」换成了**按事件分开的时间窗**:媒体元素的事件排在自己
的任务源上,规范里没有任何一条保证它排在定时器后面,所以那个布尔本来就赢不了这场竞态。

`tools/test-together.mjs` 用假连接把协议逻辑跑一遍,再拿一个真 TCP socket 打自己
手写的帧编解码;`tools/test-worker.mjs` 把 Cloudflare 那版跑在真的 workerd 上
(`wrangler dev`),验 Durable Object 寻址、休眠回调、迟到成员补状态、房主交接;
`tools/test-together-ui.mjs` 开**两个真浏览器进程**(不是两个标签页——后台标签页的
媒体加载会被节流,第二个成员会永远停在 readyState 0),一个按播放,断言另一个跟上,
并且把上面那个故障原样摆出来:给第二个浏览器一个**存在但打不开**的片源(不是「没有
片源」——那种情况 `play()` 只是一直挂着,什么都不会发生,复现不出任何东西),然后断言
房主既没被拽回开头、也没被暂停、也没被冻在缓冲等待里。

</details>

<details>
<summary><b>容器:哪些能放,走的是哪条腿</b> —— 三个 demuxer 一套下游;avi/ts 是故意不做</summary>

播放器有两条腿:自己拆封装再重封装成 fMP4 交给 MSE,或者整条流丢给 `<video>`。
走哪条**不是配置出来的,是试出来的**——`src/demux/open.js` 只看头 16 个字节,
不看扩展名也不看 Emby 的 `Container` 字段(`.strm` 场景里这两个都经常在撒谎)。

| 容器 | 走哪条腿 | 轨道切换 / 内嵌字幕 / HDR 判定 |
|---|---|---|
| `.mkv` `.webm` | 重封装 → MSE | 全都有 |
| `.mp4` `.m4v` `.mov` | 重封装 → MSE | 全都有 |
| `.flv` | 重封装 → MSE | 有(FLV 本来就没有字幕轨) |
| 分片 mp4(moof) | 浏览器原生 | 都没有 |
| `.avi` `.ts` `.wmv` `.rmvb` … | 两条腿都不行 | — |

**三个 demuxer,一套下游。** `Mp4Demuxer` 和 `FlvDemuxer` 对外的形状和
`MatroskaDemuxer` 一模一样:track 用的是 **Matroska 的 codecId**,
`readBlocks(pos, max, state)` / `seekTo(sec, track)` 签名一致。所以重封装器、
HDR/DV 扫描、字幕管线、两个页面的轨道选择器**一行没改**。翻译只发生在边界上。
代价是 stsd 里明明写着 `avc1` 却要转成 `V_MPEG4/ISO/AVC` ——换来的是下游只有
一套词汇表。

- **mp4/mov**:只支持非分片(sample table 在 `moov` 里)。分片 mp4 的索引散在每个
  `moof` 里,是完全另一种东西,所以**检测出来直接拒绝**(`FRAGMENTED_MP4`)转原生腿,
  而不是解析一半播错。`ctts`(B 帧的 composition offset)、`elst`(编辑列表偏移)、
  `colr`(HDR 色彩)、`tx3g`/`wvtt`(内嵌文本字幕)都读。
- **flv**:AVC(codec 7)/ HEVC(codec 12 与 enhanced-RTMP FourCC)、AAC / MP3。
  载荷本来就是 MSE 要的形状——序列头就是 `avcC`,后续 NAL 已经是长度前缀——
  所以这里的"转码"是零,纯换盒子。`onMetaData` 里的 keyframes 索引用于 seek;
  没有索引时退回到"读到哪记到哪",而不是扫全文件把播放卡住。
- **avi/ts/wmv/rmvb 是故意不做**:浏览器不解这些容器,各写一个 demuxer 换来的
  只是"能放",而 `ffmpeg -i in.avi -c copy out.mkv` 几秒就转完且不重编码。
  代码里只留 `Player.NO_DEMUXER`,把报错换成一句能照做的话。在这之前它们报的是
  `not a Matroska file (no EBML header)`——对一个 `.avi` 来说这句话完全正确,
  也完全没用。

**内嵌字幕不是"已经嵌在画面里"。** 它是容器里一条独立轨道,要显示就得拆出来、
解出来、再叠回去。MKV 里的 SRT 一直被 demux 出来然后丢掉("no renderer yet"),
所以一个只带 SRT 轨的 MKV 看起来像是没有字幕。现在 `src/subs/text.js` 把它和
mp4 的 tx3g/wvtt 一起送进浏览器自己的 `<track>` 渲染器——不自己画:`<track>`
已经会排版、定位、跟随系统字幕设置,并且在全屏和画中画里继续工作。

**本地文件曾经根本走不到第二条腿。** 原生兜底要给 `<video>` 一个 URL,而拖进来
或选进来的 `File` 没有 URL,`load()` 于是直接抛出——文件选择器里明明写着接受
`.mp4`,选一个 mp4 进来却报"不是 Matroska"。现在 objectURL 在**失败路径里**才铸
(成功走 MSE 时不会白造一个),名字和大小仍取自 `File` 本身而不是 blob uuid,
生命周期交给 `_teardown()`。同源 blob 的 canvas 不被污染,所以超分与增益保留。

验证分两层,因为它们能证明的事不一样:

- `tools/test-containers.mjs`(在 `npm test` 里)—— 结构层,**ground truth 全部来自
  ffprobe**:轨道数、codec、时长、分辨率、语言、帧数逐条对齐。mp4 的 sample table
  正是那种"错一位仍然算得出一堆合理数字、但画面没法看"的索引,自洽的断言在这里
  一文不值。
- `public/formatcheck.html`(真机 Edge,65 条断言)—— 行为层:每个容器 × URL/本地
  File 两种入口各落在**预期的那条腿**上、MSE 真的接受了 demux 出来的每条轨、
  画面真的解出了帧且时钟在走、第二条音轨切得动、mp4 的 HDR 判定成立、
  SRT 与 tx3g 的字幕真的进了 TextTrack 且 `{\an8}` 被翻译成 cue 设置而不是当文字印出来。

</details>

<details>
<summary><b>.strm 与原生兜底</b> —— 远程源的三处形状不同;直连与经服务器并不等价</summary>

**客户端从来看不到 `.strm` 文件。** 它是一行文本,里面存一个 URL;Emby 在服务端就
把它解析掉了。所以这里要处理的不是"解析 STRM",而是**它产出的那种 MediaSource 的
形状**——和本地文件相比,它有三处不一样,而且三处都会打断原来的假设:

| 字段 | 本地文件 | `.strm` | 原来会怎样 |
|---|---|---|---|
| `Container` | `mkv` | `strm` 或缺失 | 拼出 `/stream.strm` 这个不存在的容器 |
| `Size` | 字节数 | `null` | `HttpSource.open()` 因为拿不到总长度直接抛 |
| `MediaStreams` | 完整轨道表 | `[]`(首播才 ffprobe) | 前置选择器一片空白,像是条目坏了 |

识别用 `isRemoteSource()`(`Protocol === 'Http'` / `IsRemote` / URL 形状的 `Path`)。
取流地址一律用 PlaybackInfo 里服务器自报的 `DirectStreamUrl` —— 客户端不再
自己拼路由(旧版按容器猜后缀的 `containerExt()` 已随"拼接"一并移除)。总长度
则从 `_followRedirect()` 那个本来就要发的无 Range GET 上顺手取 `Content-Length` ——
那是唯一一个 `Content-Length` 就等于整个文件的响应。

**播放器因此长出了第二条腿。** `Player.load()` 先走重封装,以下失败改走
`<video src>` 原生解码:容器一个 demuxer 都不认(`UNKNOWN_CONTAINER`)、
是分片 mp4(`FRAGMENTED_MP4`)、结构读不通(`NOT_MP4` / `NOT_FLV` /
`NOT_MATROSKA`)、服务器不说总长度(`NO_SIZE`)或不支持 Range(`NO_RANGE`)——
这些 fetch 都成功了,说明 CORS 是通的;再加上 fetch 根本没完成(多半就是
对方没给 CORS 头)。写这一节时 `.strm` 指向的 mp4 只能走这条腿,现在它走重封装了,
兜底剩下的是真正拆不开的东西。

**这条腿上有个必须联动的降级,它不在需求里但会静默坏掉。** 不带 `crossorigin`
的 `<video>` 不需要 CORS 就能播,代价是 canvas 被污染:Anime4K 读不到像素会抛
`SecurityError`,而 `createMediaElementSource()` 会让声音永久消失——WebAudio 没有
撤销它的办法(见 `src/audio/gain.js`)。所以前三种失败进原生腿时先试
`crossorigin="anonymous"`(CORS 已被证明可用,超分与增益保留);第四种直接裸载,
并把超分和响度两栏一起从菜单里撤掉。`info.nativeCors` 就是这一位。

**做不到的事,列清楚。** 115 / 夸克 / 阿里云盘那类直链靠校验 `Referer` 与
`User-Agent` 放行,浏览器改不了 `User-Agent`([crbug 571722][ua]),这类源在纯前端
无解,只能让 Emby 服务端代理。S3 预签名链接过期时返回 403 **且不带 CORS 头**,
浏览器只能报成一个没有信息的 `TypeError`——所以 `play.html` 的错误文案把"没放行
CORS / 签名过期 / 对方校验 Referer"三种可能一起列出来,而不是笼统说"跨域失败"。

### 直连:字节可以不经过服务器

`.strm` 的内容 Emby 会原样放在 `MediaSources[].Path` 里返回给**任何**能看到该媒体
库的用户(不限管理员),所以拿到它不花额外一次请求。于是同一个条目有两个取字节的
地方,而它们并不等价:

| | 直连远程存储 | 经 Emby 代理 |
|---|---|---|
| 服务器出网流量 | 0 | 每字节两遍 |
| 要求对方放行 CORS | 是 | 否 |
| 要求对方不校验 Referer/UA | 是 | 否 |
| 签名过期风险 | 直接暴露给浏览器 | 由服务端承担 |

`Player.loadAny()` 按顺序试候选,第一个能打开的胜出——所以一个拒绝浏览器的远程
只损失一次探测,而不是一次播放失败。**顺序里有个不显然的点**:除最后一个以外的
候选都禁用原生兜底(`allowNative: false`)。把直链降级成原生播放会丢掉轨道选择、
客户端 ASS/PGS 和 HDR 判定,而把**同一份内容**经服务器重封装能三样全保住——所以
一个"能播但没法重封装"的直链必须让位给下一个候选,而不是将就。

候选**绝不能在跳转前解析**。`emby.html` 只把原始 URL 作为 `direct=` 带过去,由
`play.html` 在加载那一刻才试:预解析赛过 CDN 链接 TTL 曾经造成过"播放时 CORS"那个
bug(见 `public/emby.html` 里 `play()` 的注释),对签名链接只会更糟。

签名在**播放中途**过期是直连独有的风险(S3 预签名默认 1 小时,而电影更长)。原先
`fill()` 只把读失败写进日志,画面就那么冻住;现在它 `postMessage('stalled')`,
`play.html` 丢掉直链候选、按当前播放位置改由服务器接管——和切线路走同一套
`armResume` + 重新打开的路子。设置面板里的**线路 → 字节来源**可以手动切,并被记住
(哪边快是部署的属性,不是某部片子的属性)。

验证:`public/strmcheck.html`(`run-page.ps1` 跑)覆盖 mp4→原生、无 CORS 跨源→裸载
且超分/响度被撤、MKV 仍然走 MSE 不回归,以及候选阶梯的四种走法(退到下一个 /
非末位不将就原生 / 末位允许原生 / 全挂时抛错)。

</details>

<details>
<summary><b>塑造了这些代码的发现</b> —— 十几条"看起来能照抄、其实不能"的实测结论</summary>

**Chromium 在普通窗口里把 JASSUB 的 worker canvas 合成为一个不透明的四边形。**
在窗口模式下开启特效 ASS 轨道,只剩下字幕文字 —— 整幅画面变黑 —— 而全屏却正常。
`<video>` 全程都在解码实时画面(用 `tools/shot-page.ps1` 截取真实桌面合成图证明,
而不是 JS 读像素,后者无论什么到达屏幕都能看到已解码的帧)。JASSUB 2.5.7 无条件
`transferControlToOffscreen()` 并在 worker 里用 WebGL 渲染;Edge 把那个
OffscreenCanvas 合成为不透明的 DirectComposition 四边形,无视它 `alpha:true` 的
帧缓冲,于是透明区域在视频上涂成黑色。在 video、canvas 或 `#stage` 上加
`translateZ`/`opacity`/`will-change` 都不起作用(它们仍然会被提升成 DC 覆盖层)。

`mix-blend-mode:screen` 曾经修好了黑屏,**但它是个错的修法**:screen 是只提亮的
混合,于是暗色的字幕填充被整个擦掉,只剩下亮色描边,深色填充的特效行直接消失。
最终用的是 `filter: opacity(0.996)` —— filter 会强制这个 canvas 落到一个真正的
渲染面上(而不是 DC 覆盖四边形),走普通的 source-over 合成,**不改变任何颜色**,
所以填充和描边都还原。0.996 的透明度肉眼不可见且开销极低。全屏路径本来就正确处理
alpha,所以那里把 filter 去掉,省下 4K 下每帧一次的全画面处理。PGS 用主线程的 2D
canvas,从没撞上这个,所以修复只作用于 `.JASSUB`。几种候选修法的对比留在
`public/assdiag.html` 里。

**MSE 元素之上的增益级必须惰性构建。** 为了 >1.0 的响度提升而把 `<video>` 接进
`createMediaElementSource()`,会让音频脱离元素的播放时钟;两个时钟漂移,浏览器
靠重新 seek 掩盖 —— 表现为卡顿,叠加繁重的字幕渲染时还会看到画面不同步。第一版
在构造函数里为每个文件都建了那张图,所以连一个安静、无字幕的文件都会卡。
`src/audio/gain.js` 现在直到真正请求提升前什么都不建(已验证:houshi 24 fps、
0 丢帧、默认 `engaged=false`)。因此响度是可选项;菜单默认「原始音量」。带前瞻的
`DynamicsCompressor` 被换成了无状态的 `WaveShaper` 软削波。

**容器里的色彩元数据不可靠。** `houshi.mkv` 根本没有 Matroska `Colour` 元素;
它的 BT.2020 / PQ 信令只存在于 HEVC 的 SPS VUI 里。`src/demux/hevc.js` 解析 SPS
把它恢复出来,并写一个 `colr` box 进 MP4。若信任容器,就会产出一个被标成 SDR 的
HDR 文件。

**Dolby Vision profile 8.1 不需要任何 Dolby 专用代码。** 它的基础层本身就是合法
的 HDR10,RPU 作为一个带内 NAL(type 62)随行,解码器直接忽略。声明成 `hvc1` 而
非 `dvh1` 就能正确播放 —— `dvh1.08.06` 在这里反而被 MSE 拒绝。Profile 7(双层,
存在 NAL 63)和 profile 5(IPT-PQ-c2 基础层,不施加 RPU 就不可用)能识别、能上报,
但不播放。

**Matroska 的 block 时间戳是解码顺序下的 PTS。** 有 B 帧时它们不单调,而 MP4 要求
一条单调的解码时间线外加合成偏移(composition offset)。把一个分片里的 PTS 排序
就能精确恢复 DTS。在处理这点之前,ffmpeg 在一个 24 fps 文件的头两秒里数出 22 帧
而不是 45 帧。

**ffmpeg 太宽容,不能用来验证 MP4。** 它读进了一个 `tkhd` 短了两个字节的 init
段(本该四个 16 位字段,那里只有三个)。Chrome 则用静默地断开 MediaSource、且元素
上不报任何错的方式拒绝了同一个段。`tools/test-boxes.mjs` 现在对照规范、并对照
ffmpeg 产出的参考文件来检查 box 尺寸。

**Matroska 的轨道数据可能是压缩的,忽略它会静默失败。** `qinyinshaonvpgs.mkv`
里的 PGS 轨道通过 `ContentEncodings` 做了 zlib 压缩,而解复用器没读这个。什么都
不报错:block 出来是一堆看着挺像样、实则不是 PGS 的字节。这影响所有轨道类型 ——
header stripping(算法 3)在音频上很常见 —— 所以在读取路径里对所有轨道都做解压,
用的是 `DecompressionStream` 而非内置的 inflate。

**一个 .sup 文件就是裸的 PGS 段,每段外加 10 个字节。** Matroska 存的段不带
.sup 文件里的 `PG` 魔数、PTS 和 DTS,而 npm 上每个 PGS 解码器读的都是 .sup。
每段重建那 10 个字节 —— PTS 来自 block 时间戳 —— 正是让 libpgs 无需改动即可使用
的关键,省去了重新实现 RLE 解码和窗口合成。

**ASS 事件不是以 `Dialogue:` 行的形式到达的。** Matroska 把一个 ASS 脚本拆开:
`[Script Info]` 和 `[V4+ Styles]` 存在 CodecPrivate 里,而每个事件是一个 block,
装着 `ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text` —— 字段
顺序不同,且 Start 和 End 被 block 的时间戳与时长取代。事件是一条一条地推给
libass,而不是重建整个脚本,因为重新加载一条轨道会在播放中途重置 libass。

**播放中途开启字幕需要一次回填(backfill)。** 字幕包和视频由同一次顺序读取产出,
所以当一条轨道被打开时,已缓冲区间早已被读过、其字幕包也已被丢弃。不重新读一遍,
字幕就要等到缓冲耗尽才出现 —— 最长可达 20 秒,看起来和渲染器坏了一模一样。

**两个看着能照抄的配置记录其实不能。** Matroska 的 `OpusHead` 和 MP4 的 `dOps`
带的字段相同,但 OpusHead 是小端、从版本 1 起算,而 dOps 是大端、且必须是版本 0。
剥掉 8 字节魔数、用剩下的部分 —— 代码当初就是这么干的 —— 把 pre-skip 从 312 变成
了 14337,采样率从 48000 变成了 2159738880。同理 VP9 在 Matroska 里根本没有
CodecPrivate,所以 profile 和位深必须从关键帧头里取;一个写死的编码字符串把 8-bit
Profile 0 的内容声明成了 10-bit Profile 2。

两者都是同样被发现、同样失败的:ffmpeg 接受了输出,而 Chrome 静默断开
MediaSource、元素上不报任何错。这是本项目里那条一模一样的签名的第三次出现,前两次
是那个短的 `tkhd`。

**libpgs 没有增量 API,这让播放卡顿。** `loadFromBuffer()` 会重新解析整个 `.sup`
并重新解码里面每一张位图。喂入端保留了影片的每一个 display set,并每 100 ms 把它们
全部重载一遍,于是显示一条字幕的代价随着影片播得越久而越大 —— 而这里一个 display
set 约 20 KB,所以一部两小时的片子意味着每秒重新解析十次、每次几十兆。它还完全不
去重,而 seek 和 `enableSubtitle()` 的回填都会合理地重新投递字幕包,所以每次访问
一个区间都会再追加一份拷贝。一个 PGS display set 是自包含的,所以喂入端现在只在
播放头周围保留一个窗口:无论影片多长,保留的 set 从 3600 个降到 76 个。

**一部安静的片子不等于解码器坏了。** `houshi.mkv` 测得 -25.9 LUFS,而原生播放的
测试文件是 -18.2、网络流媒体是 -16..-14,且它的中置声道和下混一样安静 —— 所以
E-AC3 路径没丢任何东西,这片子只是按影院标准做的母带。功放靠放大器余量把它补回来;
而 `video.volume` 被钳在 1.0,没有余量。`src/audio/gain.js` 测量节目响度并在限制器
后施加补偿增益,把这两个文件从相差 7.7 LU 拉到相差 0.1 dB。它挂在元素上而不是在
转码路径里,因为 FLAC 和 AAC 的片子也安静。

**无上限的字幕栅格会和视频解码器抢资源。** JASSUB 把 `maxRenderHeight` 默认设为
0,于是 libass 按显示高度乘 `devicePixelRatio` 栅格化 —— 4K 面板上 2160 行,全屏
的 HiDPI 面板上更多 —— 并在每一个视频帧上重新合成。它被封顶到 1080。

**Chromium 在 `document.hidden` 期间推迟媒体加载。** 后台窗口会让 `MediaSource`
永远停在 `closed`、`networkState` 永远停在 `LOADING`。播放器选择等待可见,而不是
失败;测试框架则强制把窗口置于前台。

**一个作者样式里的 `display` 会盖掉浏览器对 `[hidden]` 的处理。** 控制条标了
`hidden` 直到 `loadedmetadata`,但 `.vctl { display:flex }` 赢了 UA 样式表,所以
它一直画在"拖入文件"的占位文字上面 —— 两个播放页、所有尺寸、从来如此。
`.vctl[hidden]`(0,2,0)压过 `.vctl`(0,1,0),不需要 `!important`。

**`scroll-snap-align:start` 对齐的是滚动视口边缘,不是内容盒。** 所以每条片单的
第一张卡会紧贴屏幕边,把自己的 gutter 吃掉 —— 桌面端同样如此。需要
`scroll-padding-left`。

**没有 `viewport-fit=cover`,`env(safe-area-inset-*)` 恒等于 0。** 刘海和手势条的
边距会安静地全部失效,而 CSS 本身完全合法。

</details>

<details>
<summary><b>目录结构</b></summary>

    src/demux/ebml.js       EBML 原语
    src/demux/open.js       按头 16 字节挑 demuxer(不看扩展名)
    src/demux/mp4.js        ISOBMFF (mp4/mov/m4v) demuxer
    src/demux/flv.js        FLV demuxer
    src/demux/matroska.js   解复用器,HTTP/File 数据源
    src/demux/hevc.js       hvcC + SPS 解析、编码字符串、DV NAL 扫描
    src/remux/mp4.js        fMP4 写入器
    src/remux/tracks.js     Matroska 编码 -> MP4 sample entry
    src/player.js           MSE 引擎
    src/subs/index.js       为每条轨道挑渲染器,持续喂入
    src/subs/ass.js         JASSUB 接线,Matroska ASS 包解析
    src/subs/pgs.js         Matroska PGS 包 -> 供 libpgs 用的 .sup
    src/subs/srt.js         SRT -> WebVTT
    src/danmaku/parse.js    B 站 XML / 弹弹play JSON -> 统一弹幕结构
    src/danmaku/store.js    设置(localStorage)+ 按条目的弹幕缓存(IndexedDB)
    src/danmaku/index.js    弹幕叠加层 + 弹弹play 接口格式的客户端
    src/ui/menu.js          画面内两级设置面板(两个播放页共用)
    src/ui/touch.js         手机层:手势、粗指针样式、保住叠加层的全屏
    src/audio/gain.js       响度测量 + 补偿增益
    src/emby/client.js      Emby API 客户端:鉴权、PlaybackInfo、图片、续看
    public/index.html       播放器 UI(本地文件 / 直链)
    public/emby.html        Emby 浏览 + 详情 UI
    public/play.html        专用 Emby 播放器(复用 src/player.js)
    public/vendor/          打包好的 JASSUB + libpgs(构建产物,不入库)

    tools/serve.mjs         带 Range 支持的开发服务器
    tools/build-site.mjs    把 public/ + src/ + vendor/ 铺平进 dist/
    tools/deploy.mjs        一键局域网构建 + 起服务
    tools/run-page.ps1      在干净的 Edge 里跑一个页面,捕获其 POST 回来的结果
    tools/shot-page.ps1     跑一个页面并截取真实桌面合成图
    tools/test-touch.mjs    手机手势:CDP 派发合成触摸(可无头)
    tools/test-controls.mjs 画面内设置菜单:字幕 / 倍速 / 弹幕键(可无头)
    tools/test-emby-ui.mjs  Emby 浏览页:对着假服务器跑真浏览器(可无头)
    tools/firefox-bidi.mjs  火狐驱动:WebDriver BiDi(火狐已移除 CDP,没有别的路)
    tools/probe-firefox.mjs 问真火狐它到底收哪些 codec,而不是查支持表
    tools/test-firefox.mjs  火狐端到端:容器 / 音频兜底 / 字幕 / 超分 / play.html

    public/probe.html       浏览器能力探测
    public/autotest.html    浏览器验收测试
    public/perfdiag.html    帧率与叠加层诊断
    public/gaindiag.html    响度诊断
    public/assdiag.html     窗口化 ASS 叠加层 / 解码存活性诊断
    public/dmkcheck.html    弹幕渲染 / 持久化 / 设置面板的浏览器断言
    public/bootcheck.html   两个播放页能否干净地完成模块求值
    public/strmcheck.html   .strm/远程源:原生 <video> 兜底、无 CORS 降级、MKV 不回归
    public/formatcheck.html 容器矩阵:URL/本地 File 各自落在哪条腿 + 轨道/字幕/HDR
    public/tgpreview.html   一起看面板的全部状态并排:挂的是真组件,房间是假的

`npm run build` 会先把 `src/` 下每个模块 `node --check` 一遍,不过就拒绝构建。这里
没有打包器(**发出去的就是测过的那份**),代价是从来没有任何东西读过源码——一个语法
错误会被原样拷进 `dist/`,而构建照样打印 "built";浏览器则死在模块求值上,那会杀掉
它之后的每一行,页面看起来还八九不离十。

</details>

---

## 运行与测试

```bash
npm install
node tools/build-vendor.mjs       # 把 JASSUB + libpgs 打包进 public/vendor
npm run serve                     # http://localhost:8080/

npm run build                     # -> dist/(build-vendor + build-site)
npm run deploy                    # 构建后,把 dist/ 在局域网上起服务

npm test                          # 全部 Node 测试套件
node tools/test-touch.mjs         # 手机手势:合成触摸事件打在播放器上
node tools/test-controls.mjs      # 设置菜单:字幕选择、倍速、弹幕键的真实点击
node tools/test-emby-ui.mjs       # Emby 浏览页:返回键 / 账户卡 / 继续观看的取数
node tools/test-together-ui.mjs   # 一起看:开两个真浏览器,一个按播放另一个跟上
node tools/test-worker.mjs        # 一起看:Cloudflare 中转跑在真 workerd 上(先 wrangler dev)

node tools/probe-firefox.mjs      # 火狐真实能力面(codec 矩阵 + API 面)
node tools/test-firefox.mjs       # 火狐端到端播放(必须有窗口,见下)
```

火狐这两个脚本默认用 `FirefoxPortable/`,换一个装好的火狐就设 `FIREFOX=<firefox.exe 路径>`。

单跑某一个:

```bash
node tools/test-demux.mjs         # 解复用器 vs ffprobe 基准真值
node tools/test-containers.mjs    # 容器结构 vs ffprobe
node tools/test-boxes.mjs         # MP4 box 布局 vs 规范 + ffmpeg
node tools/test-remux.mjs         # 重封装后,让 ffprobe 再读回来
node tools/test-pgs.mjs           # 合成 .sup,由 ffmpeg 解码
node tools/test-pgsfeed.mjs       # 字幕窗口边界与去重
node tools/test-srt.mjs           # SRT -> VTT,由 ffprobe 解析回来
node tools/test-danmaku.mjs       # 两种弹幕格式的字段顺序差异
node tools/test-together.mjs      # 一起看:房间协议 + 手写的 WebSocket 帧编解码
node tools/test-httpsource.mjs    # Range / 重定向 / 无长度
```

浏览器套件(需要真机 Edge,`run-page.ps1` 跑):

```
powershell -File tools/run-page.ps1 -Page public/autotest.html    # 验收
powershell -File tools/run-page.ps1 -Page public/formatcheck.html # 容器矩阵
powershell -File tools/run-page.ps1 -Page public/strmcheck.html   # 原生兜底/远程源
powershell -File tools/run-page.ps1 -Page public/perfdiag.html    # 帧率
powershell -File tools/run-page.ps1 -Page public/gaindiag.html    # 响度
```

各测试套件引用的测试文件放在仓库根目录,不入库。

<details>
<summary><b>测试框架自身的坑</b> —— 三次"框架在骗你"的经历</summary>

只有浏览器套件能证明字幕真的到达了屏幕:它把叠加层 canvas 读回来并数被涂上的像素。
它同时也采样 `<video>` 元素本身,因为"字幕被画上了"和"影片仍然可见"是两个不同的
论断,只断言前者曾让一个后者存疑的构建蒙混过关。

`test-emby-ui.mjs` 是第三个可以无头的:它压根不碰播放,只把 `emby.html` 装在一个**假
Emby** 上(`Page.addScriptToEvaluateOnNewDocument` 在页面脚本之前换掉 `fetch` 和
`localStorage`),然后驱动真实交互。它盯的三件事都是单元测试结构上够不着的:①模块顶层
的 `$('#x').onclick` 如果元素被删了会抛异常并**静默**吃掉后面每一行——页面照常渲染,
点下去才发现;②系统返回键必须关掉最上面那层覆盖层、而**不是**离开整个应用,这个论断
没有真实 history 栈就无从断言;③"继续观看按库分别查"是一个关于**发出了哪些 URL**的
论断。

`test-touch.mjs` 和 `test-controls.mjs` 是另外两个允许跑无头的浏览器测试:前者一帧
都不解码,后者只喂 `samples/subs-srt.mkv`(H.264 + SRT),所以无头 Chromium 缺少 HEVC
解码器这件事与"一次长按有没有把倍速推到 2×"、"字幕那栏里有没有那条轨"都无关。两者
都自己拉起 serve.mjs 和无头 Edge。截图能证明控制条是 46px,只有派发出去的触摸能证明
手势接住了它 —— 两者缺一不可。

**火狐反过来:它一定要有窗口。** `test-firefox.mjs` 默认开真窗口,因为无头火狐在
Windows 上起不来 RDD/Media Foundation 解码进程,每个走 MSE 的视频都会失败在
`RemoteMediaManager is not available` —— 这句话读起来和"这个编码被拒了"一模一样,
而它根本不是。曾经据此把 HEVC 判成"火狐不支持",实测 headful 下 HEVC Main10 一次过。
关掉 `media.rdd-process.enabled` 只会把它推进 Media Foundation Media Engine 那条路,
连 H.264 都一起挂 —— 换个参数不叫换方案。`HEADLESS=1` 只留给不解码的 DOM 断言。

火狐不说 CDP(remote agent 已移除),所以它走 WebDriver BiDi。对照表在
`tools/firefox-bidi.mjs` 顶部:`Runtime.evaluate`→`script.evaluate`、
`DOM.setFileInputFiles`→`input.setFiles`(要 sharedId 不是 nodeId)、
`Runtime.exceptionThrown`→`log.entryAdded`。Node 22+ 自带全局 `WebSocket`,
所以**没有引入 `ws` 或 Playwright**。

`test-controls.mjs` 盯的是**关掉菜单就不存在**的那部分状态。最要紧的一条是倍速要熬过
一次轨道切换:每次换轨都重载 `<video>` 的 src,而 media load algorithm 会把
`playbackRate` 重置成 `defaultPlaybackRate` —— 只写前者的话,倍速会在下一次动别的东西
时悄悄弹回 1×,而且直到有人在 1.5× 下切了音轨才看得见。

它还把**两条全屏路径都走一遍**。正常路径断言进入全屏的是 `#stage` 而不是
`<video>`,并且视频和每一层叠加(字幕/弹幕/超分)都还在里面。WebKit 路径靠删掉
`Element.requestFullscreen` 复现 —— iPhone 上每个浏览器都是 WKWebView,所以那台
设备上的 Chrome 和 Firefox 也走这条 —— 断言页内全屏铺满视口、叠加层一个不少、
且**没有**退化去调 `video.webkitEnterFullscreen`(那会把画面交给系统播放器,
所有叠加层当场消失)。同理,`video.volume` 在 iOS 上只读且无从查询,所以
`attachTouch` 靠写一个值再读回来判断;测试用 `Object.defineProperty` 把它真的变成
只读来验证探测没瞎猜 —— 这是唯一一个错了也不会看起来坏掉的手势。

**CDP 截图会渲染上一次的构建。** 只有 `#hash` 不同的跳转属于同文档导航,页面根本
不重载,于是截图显示的是改动之前的 CSS —— 我因此"修"了一条本来就正确的规则。
必须先 `Page.navigate` 到 `about:blank` 并设 `Network.setCacheDisabled`。

**device metrics 撑不过第二次 `Page.navigate`。** 页面会悄悄退回默认窗口宽度,
于是"手机"断言实际跑在 693px 上 —— 而 693 仍然小于 760px 断点,所以它看起来全绿,
测的却不是手机。每次导航后重新 apply,并断言 `innerWidth`。

**用 `height` 模拟全屏,在带 `aspect-ratio` 的元素上是错的。** `#stage` 是 16/9,
设 390px 高会算出 693px 宽,stage 溢出视口,合成触摸落到错误的一半(症状:滑音量
报出"亮度")。应该驱动真实的状态类,而不是自造一个 mock。

`run-page.ps1` 启动一个用完即弃的 `--user-data-dir`。没有它,Edge 会随意恢复它想
恢复的标签页,一个陈旧的 `autotest` 标签会和被测页面赛跑、抢先 POST 自己的结果 ——
于是框架报告了一次根本没发生的运行。`-DeviceScale 2` 强制 `devicePixelRatio`,这
正是一个小测试窗口如何复现 4K 面板对字幕栅格器提出的要求。

`perfdiag.html` 把播放器钉住,并在旁边滚动它的日志。把日志行追加到 iframe 上方会
把它往页面下方挤,而 Chromium 会停止为一个它没在合成的 video 元素产帧 —— 在把布局
列为嫌疑之前,这在三次独立运行里都表现为彻底的播放卡死。

</details>

<details>
<summary><b>测试素材</b> —— 为什么 DTS/TrueHD 是合成的,以及两样故意不合成的东西</summary>

    node tools/make-samples.mjs       # 写入 samples/(不入库)

DTS、TrueHD、AC-3 和 E-AC3 无法从任何流媒体服务获取 —— 它们是蓝光和广播格式,服务
会把它们转码掉。于是改用 ffmpeg 合成,这也更契合这些路径要做的事:播放器识别出这些
编码、判定它们需要软件解码器、并如实上报。一个 20 秒的生成文件就能完整地演练这条
路径,又小到可以随时重新生成。`samples/audio-multi.mkv` 把四种装在一个文件里,这也
是这里唯一的多音轨测试素材。

有两样东西故意**不**合成,因为现有工具没法诚实地产出它们:真正的双层 Dolby Vision
profile 7,以及真实的 HDR Vivid / CUVA 调色内容。因此它们的识别路径未曾对照真实
码流验证过 —— 代码写了、否定用例也断言了,但从没有一个样本演练过肯定用例。

</details>

---

许可证 MIT(`audio-eac3-ffmpeg` 分支除外,见「现状」)。

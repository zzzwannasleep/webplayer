# webplayer

浏览器里播放带 HDR / Dolby Vision 和软字幕的 MKV。
零转码:Matroska 被重新封装成分片 MP4(fragmented MP4)交给 Media Source
Extensions,编码码流的字节自始至终原封不动。

## 为什么是重新封装,而不是解码

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

## 现状

已能工作:
- Matroska 解复用 —— 轨道、附件、cues、SimpleBlock/BlockGroup,三种 lacing 模式全支持
- fMP4 重封装,视频支持 HEVC、AVC、AV1、VP9,音频支持 AAC、FLAC、Opus
- HDR 直通,包括色彩元数据**只**存在于 SPS VUI 里的文件(见下)
- Dolby Vision profile 8.x 的识别与播放
- 通过 Cues 索引 seek,在 21 GB 文件上字节级精确
- 配额感知的缓冲,自动驱逐已播放过的媒体
- 轨道压缩(`ContentEncodings`):zlib 与 header stripping
- 字幕:带内嵌字体的特效 ASS、PGS、以及外挂 SRT
- Emby 接入 —— 浏览服务器、直连播放(零转码)原盘字节、双向续看、把详情页里
  选好的音轨/字幕逐轨预选并带进专用播放器。见 `public/emby.html` +
  `src/emby/client.js`,部署到本地或远程 Emby 的完整说明见 **[DEPLOY.md](DEPLOY.md)**。

- E-AC3 / AC-3 / DTS / TrueHD,仅在 `audio-eac3-ffmpeg` 分支上:用 ffmpeg.wasm
  解码再重编码成 Opus,让浏览器仍能做 A/V 同步。那个分支是 GPL-2.0-or-later,
  因为 `@ffmpeg/core` 是;`main` 保持 MIT,遇到这些文件则静音播放。
- 没有 Cues 索引的文件里 seek,靠对 cluster 做二分查找

尚未实现:
- 外挂 ASS 脚本。内嵌的能用;外挂的得在系统里找到它的字体,那是另一个问题。
- VobSub 和 DVB 字幕。能识别、能上报,但不绘制。

## 部署

站点是纯静态的;任何支持 HTTP `Range` 请求的托管都能跑。真正决定**用哪种**托管
的,是它要连的那个 Emby —— 浏览器不允许 **https** 页面去访问 **http** 的局域网
Emby(混合内容),所以:

- **本地 / http 的 Emby** → 在同一局域网内用 http 自托管 LinWeb。一条命令:
  `npm run deploy` 构建 `dist/` 并在所有网卡上提供服务,打印出
  `http://<局域网IP>:8080/emby.html` 供手机/电视打开。
- **公网 / https 的 Emby** → GitHub Pages(CI 在 `.github/workflows/deploy.yml`,
  push 到 `main` 自动部署)或 Cloudflare Pages / Netlify(构建 `npm run build`,
  输出 `dist`)。
- **把 LinWeb 和 Emby 反代到同一个 host 下** → 同源,一次性消掉混合内容和 CORS
  两道墙。

除同源外的每一种情况,还都需要在 Emby 上开启 CORS。完整教程、Caddy/nginx 示例、
以及排查表见 **[DEPLOY.md](DEPLOY.md)**。

## 字幕

| 格式 | 渲染器 | 许可证 |
|---|---|---|
| ASS / SSA | [JASSUB](https://github.com/ThaUnknown/jassub)(libass 的 wasm 版) | LGPL-2.1-or-later |
| PGS | [libpgs](https://github.com/Arcus92/libpgs-js) | MIT |
| SRT | 浏览器自带的 `<track>`,先转成 WebVTT | — |

两个渲染器都未打补丁,都只通过其公开 API 使用。功夫在于怎么喂它们,而每一个都需
要一点格式文档里说不清的东西 —— 见下。

**JASSUB 是 LGPL**,不同于本仓库的 MIT 代码。它被打成独立的 bundle
(`public/vendor/`),只通过公开接口使用,因此始终是一个单独授权、可替换的组件。

## 塑造了这些代码的发现

**Chromium 在普通窗口里把 JASSUB 的 worker canvas 合成为一个不透明的四边形。**
在窗口模式下开启特效 ASS 轨道,只剩下字幕文字 —— 整幅画面变黑 —— 而全屏却正常。
`<video>` 全程都在解码实时画面(用 `tools/shot-page.ps1` 截取真实桌面合成图证明,
而不是 JS 读像素,后者无论什么到达屏幕都能看到已解码的帧)。JASSUB 2.5.7 无条件
`transferControlToOffscreen()` 并在 worker 里用 WebGL 渲染;Edge 把那个
OffscreenCanvas 合成为不透明的 DirectComposition 四边形,无视它 `alpha:true` 的
帧缓冲,于是透明区域在视频上涂成黑色。在 video、canvas 或 `#stage` 上加
`translateZ`/`opacity`/`will-change` 都不起作用。在 `.JASSUB` canvas 上加
`mix-blend-mode:screen` 强制它与视频混合;这一属性在 `:fullscreen` 下被丢弃,而
那里 alpha 本就被正确处理,所以特效字幕在全屏下依旧完美。PGS 用主线程的 2D
canvas,从没撞上这个,所以修复只作用于 `.JASSUB`。

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

## 目录结构

    src/demux/ebml.js       EBML 原语
    src/demux/matroska.js   解复用器,HTTP/File 数据源
    src/demux/hevc.js       hvcC + SPS 解析、编码字符串、DV NAL 扫描
    src/remux/mp4.js        fMP4 写入器
    src/remux/tracks.js     Matroska 编码 -> MP4 sample entry
    src/player.js           MSE 引擎
    src/subs/index.js       为每条轨道挑渲染器,持续喂入
    src/subs/ass.js         JASSUB 接线,Matroska ASS 包解析
    src/subs/pgs.js         Matroska PGS 包 -> 供 libpgs 用的 .sup
    src/subs/srt.js         SRT -> WebVTT
    src/audio/gain.js       响度测量 + 补偿增益
    src/emby/client.js      Emby API 客户端:鉴权、PlaybackInfo、图片、续看
    public/emby.html        Emby 浏览 + 详情 UI
    public/play.html        专用 Emby 播放器(复用 src/player.js)
    tools/build-site.mjs    把 public/ + src/ + vendor/ 铺平进 dist/
    tools/deploy.mjs        一键局域网构建 + 起服务
    public/perfdiag.html    帧率与叠加层诊断
    public/gaindiag.html    响度诊断
    public/assdiag.html     窗口化 ASS 叠加层 / 解码存活性诊断
    public/index.html       播放器 UI
    public/probe.html       浏览器能力探测
    public/autotest.html    浏览器验收测试
    public/vendor/          打包好的 JASSUB + libpgs(构建产物,不入库)
    tools/serve.mjs         带 Range 支持的开发服务器
    tools/run-page.ps1      在干净的 Edge 里跑一个页面,捕获其 POST 回来的结果
    tools/shot-page.ps1     跑一个页面并截取真实桌面合成图

## 运行

    npm install
    node tools/build-vendor.mjs       # 把 JASSUB + libpgs 打包进 public/vendor
    npm run serve                     # http://localhost:8080/

构建可部署站点,或一键局域网部署(见 DEPLOY.md):

    npm run build                     # -> dist/（build-vendor + build-site）
    npm run deploy                    # 构建后,把 dist/ 在局域网上起服务

测试:

    npm test                          # 全部 Node 测试套件
    node tools/test-demux.mjs         # 解复用器 vs ffprobe 基准真值
    node tools/test-boxes.mjs         # MP4 box 布局 vs 规范 + ffmpeg
    node tools/test-remux.mjs         # 重封装后,让 ffprobe 再读回来
    node tools/test-pgs.mjs           # 合成 .sup,由 ffmpeg 解码
    node tools/test-pgsfeed.mjs       # 字幕窗口边界与去重
    node tools/test-srt.mjs           # SRT -> VTT,由 ffprobe 解析回来

    powershell -File tools/run-page.ps1 -Page public/autotest.html   # 验收
    powershell -File tools/run-page.ps1 -Page public/perfdiag.html   # 帧率
    powershell -File tools/run-page.ps1 -Page public/gaindiag.html   # 响度

只有浏览器套件能证明字幕真的到达了屏幕:它把叠加层 canvas 读回来并数被涂上的像素。
它同时也采样 `<video>` 元素本身,因为"字幕被画上了"和"影片仍然可见"是两个不同的
论断,只断言前者曾让一个后者存疑的构建蒙混过关。

`run-page.ps1` 启动一个用完即弃的 `--user-data-dir`。没有它,Edge 会随意恢复它想
恢复的标签页,一个陈旧的 `autotest` 标签会和被测页面赛跑、抢先 POST 自己的结果 ——
于是框架报告了一次根本没发生的运行。`-DeviceScale 2` 强制 `devicePixelRatio`,这
正是一个小测试窗口如何复现 4K 面板对字幕栅格器提出的要求。

`perfdiag.html` 把播放器钉住,并在旁边滚动它的日志。把日志行追加到 iframe 上方会
把它往页面下方挤,而 Chromium 会停止为一个它没在合成的 video 元素产帧 —— 在把布局
列为嫌疑之前,这在三次独立运行里都表现为彻底的播放卡死。

各测试套件引用的测试文件放在仓库根目录,不入库。

## 测试素材

    node tools/make-samples.mjs       # 写入 samples/（不入库）

DTS、TrueHD、AC-3 和 E-AC3 无法从任何流媒体服务获取 —— 它们是蓝光和广播格式,服务
会把它们转码掉。于是改用 ffmpeg 合成,这也更契合这些路径要做的事:播放器识别出这些
编码、判定它们需要软件解码器、并如实上报。一个 20 秒的生成文件就能完整地演练这条
路径,又小到可以随时重新生成。`samples/audio-multi.mkv` 把四种装在一个文件里,这也
是这里唯一的多音轨测试素材。

有两样东西故意**不**合成,因为现有工具没法诚实地产出它们:真正的双层 Dolby Vision
profile 7,以及真实的 HDR Vivid / CUVA 调色内容。因此它们的识别路径未曾对照真实
码流验证过 —— 代码写了、否定用例也断言了,但从没有一个样本演练过肯定用例。

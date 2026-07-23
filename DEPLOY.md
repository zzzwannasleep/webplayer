# LinWeb 部署教程

LinWeb 是**纯静态站点**(HTML + ES 模块 + wasm),没有后端。任何能托管静态文件、
且支持 HTTP `Range` 请求的服务器都能跑。难点不在托管本身,而在**它要连的 Emby**——
浏览器的跨域(CORS)和混合内容(mixed content)两道墙,决定了你该选哪种部署方式。

## 先做一个选择(最重要)

先看你的 Emby 是什么形态,直接对号入座:

| 你的 Emby | 选哪种部署 | 为什么 |
|---|---|---|
| **想常驻、开机自启、少折腾** | **方式零:Docker**(端口 23685) | 一条命令;顺带能把 Emby 反代到同源,免掉 CORS |
| **局域网内、http://** (如 `http://192.168.1.10:8096`) | **方式一:局域网 HTTP 自托管**(一键脚本) | LinWeb 也走 http,同处局域网,没有混合内容墙 |
| **公网、有域名和 HTTPS 证书** (如 `https://emby.example.com`) | **方式二:Pages(GitHub / Cloudflare)** | 两边都是 https,浏览器放行 |
| 想一劳永逸、常驻、还想免掉跨域 | **方式三:同源反代**(nginx / Caddy) | LinWeb 和 Emby 同一个域名,连 CORS 都不用配 |

> ⚠️ **一条铁律:HTTPS 页面不能连 HTTP 的 Emby。**
> 如果你把 LinWeb 部署到 GitHub Pages(https),却去连局域网 `http://192.168.x.x:8096` 的 Emby,
> 浏览器会**直接拦截**(mixed content),表现为"能登录/能看封面,但视频点了没反应"或干脆报跨域。
> 这不是 bug,是浏览器安全策略。解决办法只有两个:要么给 Emby 上 https(方式二/三),
> 要么把 LinWeb 也降到 http 并放进局域网(方式一)。

---

## 方式零:Docker(端口 23685)

镜像是 **nginx alpine-slim + 构建产物**:拉取 18.3 MB、落盘约 53 MB,跑起来单个
worker、常驻内存 10 MB 上下。镜像里没有 Node、没有 npm,构建阶段用完就丢。

### 起服务

镜像由 GitHub Actions 构建并推到 Docker Hub,同时提供 `linux/amd64` 和
`linux/arm64`(x86 的 NAS 和 ARM 的树莓派/新款群晖都能直接跑):

```bash
docker run -d --name linweb --restart unless-stopped \
  -p 23685:23685 zzzwannasleep/linweb
```

想从源码构建:

```bash
git clone <本仓库> && cd webplayer
docker compose up -d
# 或:docker build -t linweb . && docker run -d -p 23685:23685 linweb
```

打开 `http://<这台机器的IP>:23685/emby.html`。

**容器内部端口固定 23685**,对外想换就改映射(`-p 8080:23685`)。固定它是有意的:
端口只在容器外面变,配置文件和健康检查就不会各说各话。

### 顺手把 CORS 问题一起解决(可选,但强烈建议)

设一个环境变量,容器就把 Emby 反代到**自己的 `/emby` 路径**下:

```yaml
# docker-compose.yml
services:
  linweb:
    environment:
      EMBY_UPSTREAM: http://192.168.1.10:8096     # 结尾不要带 /
```

或者 `docker run -e EMBY_UPSTREAM=http://192.168.1.10:8096 …`。

然后在 LinWeb 的服务器地址栏里填:

```
http://<这台机器的IP>:23685/emby
```

此刻页面和 Emby API **同源**,于是:

- **不用**在 Emby 上配任何 CORS(包括那三个 `Expose-Headers`);
- **不会**有混合内容拦截,因为两边共用同一个 scheme;
- 拖进度条要的 `Range`、Emby 的 WebSocket,都原样透传。

不设这个变量,反代就是关着的,`/emby/*` 会返回 **503 并写明原因**——是 503 不是
404,看到就知道是没配,而不是路径写错。

### 再瘦一半

落盘那 53 MB 里有 **31 MB 是单个文件**:`vendor/ffmpeg-core.wasm`,浏览器一律不解的
E-AC3 / AC-3 / DTS / TrueHD 的软解兜底。片库里没有这些音轨就整块扔掉:

```bash
docker build --build-arg WITH_FFMPEG=0 -t linweb .     # 落盘约 22 MB
```

```yaml
# 或者在 compose 里
build:
  context: .
  args:
    WITH_FFMPEG: "0"
```

视频、以及浏览器原生支持的音频编码都不受影响;真碰上 DTS 音轨时是那条音轨解不出来。

### 这个镜像里做了什么决定

| 决定 | 为什么 |
|---|---|
| `nginx:1-alpine-slim` 而不是 `nginx:alpine` | 同一个 nginx,少了从来用不到的 njs / geoip 模块 |
| 构建阶段用 `node:22-slim`(Debian) | 它一个字节都不会进最终镜像,glibc 省掉"某个预编译二进制有没有 musl 版"的整类问题 |
| `worker_processes 1` | 默认按核数起 worker;16 核的 NAS 上就是 16 个进程伺候几个静态文件 |
| `Cache-Control: no-cache` | 这个构建的文件名不带哈希,缓存狠了等于让人一直跑上周的 JS。它照样存盘,只是每次回源校验,304 一个来回 |
| 反代**按请求**解析域名 | 写死解析会让 nginx 在启动时就去查 Emby 主机名;Emby 容器晚起一秒,这个容器就崩溃重启循环 |
| `.dockerignore` 用白名单 | 仓库根目录有测试片源,其中一个 21 GB;`docker build` 会先把整个上下文传给 daemon。漏一条黑名单不是构建变慢,是构建根本起不来。顺带保证 `*.env` 和带 token 的 `public/_*.html` 不可能进镜像 |

### Docker 部分的排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `/emby/…` 全部 503 | 没设 `EMBY_UPSTREAM` | 设上,或不用反代直接填 Emby 地址 |
| 反代后登录**像密码错误** | `EMBY_UPSTREAM` 结尾带了 `/`,拼成 `//Users/…`,Emby 回 404 | 去掉结尾斜杠 |
| 容器起来了但打不开页面 | 端口映射写反 | 容器内固定 23685:`-p <外部>:23685` |
| 反代通了但视频卡顿/拖不动 | 反代已关缓冲(`proxy_buffering off`),若仍异常多半是 Emby 本身 | 先用 `http://<Emby>:8096` 直连对比一次 |
| 改了代码但页面没变 | 静态文件在镜像里,不是挂载的 | `docker compose up -d --build` 重新构建 |

---

## 方式一:局域网 HTTP 自托管(推荐给本地 Emby)

在**任意一台和 Emby 同局域网、且常开机的机器**上跑(可以就是跑 Emby 的那台 NAS/主机)。

### 前置

- Node.js 18 或更高(`node -v` 确认)
- 拉下本仓库后,先装依赖:
  ```bash
  npm ci        # 或 npm install
  ```

### 一键启动

```bash
npm run deploy
```

脚本会自动:构建 wasm 与静态站 → `dist/` → 在局域网所有网卡上开 HTTP 服务,并打印出可直接打开的地址,例如:

```
    http://192.168.1.10:8080/emby.html
```

在**同一局域网**的手机、电视、电脑浏览器里打开这个地址即可。`Ctrl+C` 停止。

- 换端口:`PORT=9000 npm run deploy`
- 已经构建过、只想重新开服务:`node tools/deploy.mjs --no-build`
- 想让它开机自启/后台常驻:见文末「常驻运行」。

### 别忘了给 Emby 开跨域

LinWeb(`:8080`)和 Emby(`:8096`)端口不同 = 跨域。**必须**在 Emby 开 CORS,否则登录就报"跨域"。见下方 [Emby 跨域配置](#emby-跨域cors配置必做)。

---

## 方式二:Pages 托管(公网 HTTPS)

**仅当你的 Emby 也是 HTTPS**(有域名+证书)时才适用。

### GitHub Pages(仓库已配好 CI)

仓库自带 `.github/workflows/deploy.yml`:**push 到 `main` 分支即自动构建并发布**。
只需在仓库 `Settings → Pages → Source` 选 **GitHub Actions**,之后每次 push 自动上线,
地址形如 `https://<用户名>.github.io/<仓库名>/emby.html`。

### Cloudflare Pages / Netlify / Vercel

连接仓库后填:

| 字段 | 值 |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | 18+ |

> 这些平台**一律强制 https**(无法部署纯 http 版)。所以它们只适合公网 https 的 Emby;
> 连局域网 http Emby 会撞混合内容墙。

---

## 方式三:同源反代(常驻 + 免跨域,最省心)

把 LinWeb 和 Emby 挂到**同一个域名/主机**的不同路径下,浏览器视为同源——
**混合内容和 CORS 两道墙一起消失**。适合放在 NAS 或小服务器上长期跑。

先构建出 `dist/`:

```bash
npm run build      # 产物在 dist/
```

然后把 `dist/` 交给任意静态服务器。三个最小示例:

**Caddy(推荐,自动 HTTPS + 反代一步到位):**
```caddyfile
emby.example.com {
    handle /emby/* {
        uri strip_prefix /emby
        reverse_proxy 127.0.0.1:8096   # 你的 Emby
    }
    handle {
        root * /path/to/dist
        file_server
    }
}
```
这样 `https://emby.example.com/` 是 LinWeb,`/emby/*` 是 Emby,同源、同证书,零 CORS。
(此时在 LinWeb 登录框里把 Emby 地址填成 `https://emby.example.com/emby` 即可。)

**nginx:**
```nginx
server {
    listen 80;
    root /path/to/dist;
    location /emby/ {
        proxy_pass http://127.0.0.1:8096/;
        proxy_set_header Host $host;
    }
    location / { try_files $uri $uri/ /index.html; }
}
```

**只是想临时开个 http 静态服务(不反代):**
```bash
cd dist && python -m http.server 8080     # 或 npx serve dist
```
注意:`python -m http.server` **不支持 Range 分段**,拖动进度条会失败;正式用请选
`node tools/serve.mjs dist`(带 Range)、nginx 或 Caddy。

---

## Emby 跨域(CORS)配置(必做)

除了「方式三同源反代」,其余方式里 LinWeb 和 Emby 都是**不同源**,Emby 必须返回跨域头。

在 Emby 后台设置里找到跨域/CORS 相关项(不同版本位置不同,常在 `网络` 或高级设置),
把**允许的来源填 `*`**(或精确填 LinWeb 的地址)。需要放行的响应头:

```
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Accept-Ranges, Content-Length, Content-Range
```

`Expose-Headers` 里的 `Content-Range / Accept-Ranges / Content-Length` 是**能拖进度条的关键**——
少了它们,视频要么整段拉、要么直接报"跨域文件需要服务器返回 …"。

> 若用反向代理(方式三)把 Emby 包在同源下,则**不需要**配 CORS。

---

## 常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 登录报「跨域 / 不允许跨域」 | Emby 没开 CORS,或用了 https 页面连 http Emby | 开 Emby CORS;确认页面与 Emby 协议一致(见铁律) |
| 「无法读取该地址。跨域文件需要服务器返回 Access-Control-Expose-Headers…」 | Emby 没在 Expose-Headers 放行 Range 相关头 | 按上方 CORS 配置补 `Content-Range, Accept-Ranges, Content-Length` |
| 能登录、能看封面,但**视频点了不播** | 典型混合内容:https 页面 + http Emby 视频流被拦 | 改用方式一(http 局域网)或给 Emby 上 https |
| 公网页面连**局域网 IP** 被拦 | 浏览器 Private Network Access:公网站点访问 192.168.x.x 受限 | 别用公网托管连内网;把 LinWeb 也放局域网(方式一) |
| 打开根地址 `/` 空白/404 | 用旧版 `serve.mjs` 服务 dist 时的根路由问题 | 已修复;或直接打开 `…/emby.html` |
| 字幕/音轨在详情页选了,播放器没预选 | 已修复(play.html 会带上选择) | 更新到最新代码 |

---

## 常驻运行(NAS / 服务器)

`npm run deploy` 前台运行,关终端就停。要长期跑,任选:

- **PM2**:`pm2 start "node tools/serve.mjs dist" --name linweb`(先 `npm run build` 一次)
- **systemd**(Linux):写一个 `ExecStart=/usr/bin/node /path/to/tools/serve.mjs /path/to/dist` 的 service,`Environment=PORT=8080`
- **Docker**:见上面的[方式零](#方式零docker端口-23685)——仓库自带 `Dockerfile` 和 `docker-compose.yml`,`restart: unless-stopped` 就是开机自启
- **方式三的 nginx/Caddy** 本身就是常驻服务,构建一次 `dist/` 后交给它即可

> 常驻的机器建议就是跑 Emby 的那台——反正常开,局域网内延迟最低,也最容易做同源反代。

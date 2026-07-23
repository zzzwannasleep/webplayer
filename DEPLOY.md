# LinWeb 部署教程

LinWeb 是**纯静态站点**(HTML + ES 模块 + wasm),没有后端。任何能托管静态文件、
且支持 HTTP `Range` 请求的服务器都能跑。难点不在托管本身,而在**它要连的 Emby**——
浏览器的跨域(CORS)和混合内容(mixed content)两道墙,决定了你该选哪种部署方式。

> 编号和 [README](README.md) 里的 A / B / C / D 一一对应,不用来回换算。

## 先做一个选择(最重要)

| 你的情况 | 选哪种 | 为什么 |
|---|---|---|
| 想常驻、开机自启、少折腾 | **[A · Docker](#a--docker端口-23685)**(端口 23685) | 一条命令;顺带能把 Emby 反代到同源,免掉 CORS |
| 不想装 Docker,局域网 `http://` 的 Emby | **[B · 局域网自托管](#b--局域网自托管不想装-docker)** | 两边都是 http、同一内网,没有混合内容墙 |
| 公网、有域名和 HTTPS 证书 | **[C · Pages 托管](#c--pages-托管公网-https)** | 两边都是 https,浏览器放行 |
| 已经有 Caddy / nginx 在跑 | **[D · 同源反代](#d--同源反代挂进现成的站点)** | 挂进现成站点,不多起一个容器 |

> ⚠️ **一条铁律:HTTPS 页面不能连 HTTP 的 Emby。**
>
> 把 LinWeb 部署到 GitHub Pages(https),却去连局域网 `http://192.168.x.x:8096`,
> 浏览器会**直接拦截**(mixed content)。症状很有迷惑性:能登录、能看封面,
> 但**视频点了没反应**,或者报一个看起来像跨域的错。
>
> 这不是 bug,是安全策略,前端没有绕过手段。三条出路:给 Emby 上 https;把 LinWeb
> 也降到 http 放进局域网;或者**让 http 那一跳发生在服务器上**——方式 A 的反代就是
> 干这个的,详见[放在已有的 HTTPS 站点后面](#7-放在已有的-https-反代后面)。

---

# A · Docker(端口 23685)

镜像是 **nginx alpine-slim + 构建产物**:拉取 18.3 MB、落盘约 53 MB,跑起来单个
worker、常驻内存 10 MB 上下。镜像里没有 Node、没有 npm——构建阶段用完就丢。

同时提供 `linux/amd64` 和 `linux/arm64`,x86 的 NAS 和 ARM 的树莓派 / 新款群晖
都能直接拉。

## 1. 最快的一条命令

```bash
docker run -d --name linweb --restart unless-stopped \
  -p 23685:23685 zzzwannasleep/linweb
```

打开 `http://<这台机器的IP>:23685/emby.html`,填上 Emby 地址就能用了。

**容器内部端口固定 23685**,对外想换就改映射(`-p 8080:23685`)。固定是有意的:
端口只在容器外面变,配置文件和健康检查就不会各说各话。

## 2. 推荐:用 compose,顺手把 CORS 问题一起解决

新建一个 `docker-compose.yml`:

```yaml
services:
  linweb:
    image: zzzwannasleep/linweb
    container_name: linweb
    restart: unless-stopped
    ports:
      - "23685:23685"
    environment:
      # 填上它,容器就把 Emby 反代到自己的 /emby 路径下。结尾不要带 /
      EMBY_UPSTREAM: http://192.168.1.10:8096
    mem_limit: 128m
```

```bash
docker compose up -d
```

然后在 LinWeb 的**服务器地址**栏里填:

```
http://<这台机器的IP>:23685/emby
```

注意填的是 `/emby`,**不是** Emby 的真实地址。此刻页面和 Emby API **同源**,于是:

- **不用**在 Emby 上配任何 CORS(包括那三个 `Expose-Headers`);
- **不会**有混合内容拦截,因为两边共用同一个 scheme;
- 拖进度条要的 `Range`、Emby 的 WebSocket,都原样透传。

不设 `EMBY_UPSTREAM` 也能用,只是反代关着——这时你在地址栏里填 Emby 的真实地址,
并且**要按下面的 [Emby 跨域配置](#emby-跨域cors配置)去开 CORS**。

## 3. 和 Emby 装在同一台机器上

Emby 本身也是容器的话,让它们同网络,直接用**容器名**当 upstream,连 IP 都不用查:

```yaml
services:
  emby:
    image: emby/embyserver
    container_name: emby
    restart: unless-stopped
    ports:
      - "8096:8096"
    volumes:
      - ./emby-config:/config
      - /path/to/media:/media

  linweb:
    image: zzzwannasleep/linweb
    container_name: linweb
    restart: unless-stopped
    ports:
      - "23685:23685"
    environment:
      EMBY_UPSTREAM: http://emby:8096      # 容器名,不是 IP
    depends_on:
      - emby
```

`depends_on` 只保证启动顺序,不保证 Emby 已经准备好——**这不要紧**:反代是按请求
解析域名的,Emby 晚起来几十秒也只是那几秒内的请求失败,容器不会崩。

## 4. 装完先自检

三条命令,把 IP 换成你的:

```bash
# ① 站点在不在
curl -sI http://192.168.1.10:23685/emby.html | head -1
# 期望:HTTP/1.1 200 OK

# ② Range 支不支持(拖不动进度条的根因就在这)
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Range: bytes=0-99' http://192.168.1.10:23685/vendor/jassub.js
# 期望:206

# ③ 反代通没通(设了 EMBY_UPSTREAM 才需要看这条)
curl -s http://192.168.1.10:23685/emby/System/Info/Public
# 期望:一段 Emby 的 JSON,含 ServerName / Version
# 得到 503 = 没设 EMBY_UPSTREAM;得到 404 = 地址结尾多了 /
```

再看一眼容器状态,`STATUS` 里应该有 `(healthy)`:

```bash
docker ps --filter name=linweb
```

启动日志能确认配置模板渲染过了:

```bash
docker logs linweb | head -20
# 会看到 Sourcing /docker-entrypoint.d/05-emby-upstream.envsh
#        Running envsubst on /etc/nginx/templates/default.conf.template
```

## 5. 在 NAS 的图形界面里装

> 各家面板版本差异很大,下面是路径大意,措辞以你机器上的为准。

**群晖 DSM 7.2+(Container Manager)**——最省事的是走「项目」:

1. Container Manager → **项目** → 新增
2. 路径随便选一个文件夹,来源选**创建 docker-compose.yml**
3. 把上面第 2 节那段 compose **原样粘进去**,改掉 `EMBY_UPSTREAM` 的 IP
4. 下一步到底 → 完成。之后升级也在这里点「构建」

**群晖 DSM 7.0 / 7.1(Docker 套件,没有项目功能)**:

1. 注册表 → 搜索 `zzzwannasleep/linweb` → 下载 `latest`
2. 映像 → 启动 → 高级设置
3. **端口设置**:本地端口填 `23685`(或你想要的),容器端口 `23685`
4. **环境**:新增变量 `EMBY_UPSTREAM` = `http://192.168.1.10:8096`
5. 勾上「启用自动重新启动」

**unraid**:Docker → Add Container,Repository 填 `zzzwannasleep/linweb`,
加一个 Port(Container 23685)和一个 Variable(`EMBY_UPSTREAM`)。

**威联通 QTS(Container Station)**:创建应用程序,同样粘 compose。

## 6. 更新

```bash
docker compose pull && docker compose up -d     # compose
# 或
docker pull zzzwannasleep/linweb && docker rm -f linweb && docker run -d …
```

镜像跟着 `main` 分支走,每次提交都会重新构建并推上去。想钉死版本就用
`zzzwannasleep/linweb:sha-xxxxxxx`(每次构建都有一个)。

嫌手动麻烦可以挂个 [watchtower](https://github.com/containrrr/watchtower) 自动更新——
这个容器无状态,更新不会丢任何东西。

## 7. 放在已有的 HTTPS 反代后面

已经有 Caddy / nginx 在跑 https 的话,把这个容器挂到某个域名下:

```caddyfile
linweb.example.com {
    reverse_proxy 127.0.0.1:23685
}
```

这么做有个**不太显然但很实用的后果**:浏览器全程只看到 https,而容器到 Emby 的
那一跳是**在服务器上发生的**——所以即使 Emby 只有 http、只在局域网里,
也照样不撞混合内容墙。等于用一层反代把铁律绕开了,而且是合法地绕。

⚠️ 但这也意味着**你把 Emby 暴露到公网了**,挡在前面的只有 Emby 自己的账号密码。
公网可达就一定要开强密码,最好再加一层 basic auth 或者只放行特定 IP。

## 8. 再瘦一半

落盘那 53 MB 里有 **31 MB 是单个文件**:`vendor/ffmpeg-core.wasm`,给浏览器一律
不解的 E-AC3 / AC-3 / DTS / TrueHD 做软解兜底。片库里没有这些音轨就整块扔掉——
这需要自己构建一次:

```bash
git clone <本仓库> && cd webplayer
docker build --build-arg WITH_FFMPEG=0 -t linweb .     # 落盘约 22 MB
docker run -d --name linweb --restart unless-stopped -p 23685:23685 linweb
```

```yaml
# 或者在 compose 里
build:
  context: .
  args:
    WITH_FFMPEG: "0"
```

视频、以及浏览器原生支持的音频编码都不受影响;真碰上 DTS 音轨时,是那一条音轨
解不出来,不是整个播放器坏掉。

## 9. 卸载

```bash
docker compose down                  # 或 docker rm -f linweb
docker rmi zzzwannasleep/linweb
```

容器无状态,没有卷、没有配置文件落盘,删干净不留东西。你的观看记录在 Emby 上,
播放器设置在浏览器的 localStorage 里,都不在容器里。

## Docker 部分的排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `/emby/…` 全部 **503** | 没设 `EMBY_UPSTREAM`,反代是关着的 | 设上它;或者不用反代,地址栏直接填 Emby 真实地址 + 开 CORS |
| 反代后登录**像密码错误** | `EMBY_UPSTREAM` 结尾带了 `/`,拼成 `//Users/…`,Emby 回 404 | 去掉结尾斜杠 |
| 容器起来了但**页面打不开** | 端口映射写反 | 容器内固定 23685:`-p <外部端口>:23685` |
| 页面能开,但**登录一直转圈** | `EMBY_UPSTREAM` 填的 IP 从**容器里**不可达 | 用 `docker exec linweb wget -qO- http://<IP>:8096/System/Info/Public` 验一下 |
| 同一 compose 里写了容器名却连不上 | 两个服务不在同一个网络 | 写在同一个 compose 文件里即可(默认同网络);跨文件要显式 `networks:` |
| 反代通了但**视频卡顿 / 拖不动** | 反代已关缓冲(`proxy_buffering off`),仍异常多半是 Emby 侧 | 先用 `http://<Emby>:8096` 直连对比一次,分清是谁的问题 |
| 改了代码但**页面没变** | 静态文件烤在镜像里,不是挂载的 | `docker compose up -d --build` 重新构建 |
| 手机上打开还是老样子 | 浏览器缓存 | 用**无痕标签页**,一步绕过所有缓存 |
| `docker ps` 里显示 `(unhealthy)` | 健康检查打的是容器内 23685 | 看 `docker logs linweb`;若是配置错误 nginx 会在日志里明说 |

<details>
<summary><b>这个镜像里做了哪些决定,以及为什么</b>——每条都对应一个踩过或差点踩的坑</summary>

| 决定 | 为什么 |
|---|---|
| `nginx:1-alpine-slim` 而不是 `nginx:alpine` | 同一个 nginx,少了从来用不到的 njs / geoip 模块 |
| 构建阶段用 `node:22-slim`(Debian) | 它一个字节都不会进最终镜像,glibc 省掉"某个预编译二进制有没有 musl 版"的整类问题 |
| 构建阶段钉 `--platform=$BUILDPLATFORM` | 产物是 HTML / ES 模块 / wasm,在哪个架构上都是同一份字节。不钉住,做 arm64 镜像就要在 QEMU 里重跑一遍 `npm ci` 和 esbuild,几分钟模拟换一个一模一样的结果 |
| `worker_processes 1` | 默认按核数起 worker;16 核的 NAS 上就是 16 个进程伺候几个静态文件 |
| `Cache-Control: no-cache` | 这个构建的文件名不带哈希,缓存狠了等于让人一直跑上周的 JS。它照样存盘,只是每次回源校验,32 MB 的 wasm 命中 304 只花一个来回 |
| 反代**按请求**解析域名 | 写死解析会让 nginx 在启动时就去查 Emby 主机名;Emby 容器晚起一秒,这个容器就进崩溃重启循环,而报错("host not found in upstream")长得像拼写错误 |
| `proxy_pass` 保留 URI 部分 | `$upstream/$1` 而不是 `$upstream$1`:`$1` 为空时 proxy_pass 就没有 URI 了,nginx 会退回转发**原始** URI,于是 Emby 收到 `/emby` 并回 404。用真 nginx 复现过 |
| `NGINX_ENVSUBST_FILTER` 限定变量名 | envsubst 分不清 nginx 的 `$host` 和 shell 变量,不过滤会把它们吃掉——而那样的配置**能正常启动**,只是代理到错的地方 |
| `.dockerignore` 用白名单 | 仓库根目录有测试片源,其中一个 21 GB;`docker build` 会先把整个上下文传给 daemon,漏一条黑名单不是构建变慢,是构建根本起不来。顺带保证 `*.env` 和带 token 的 `public/_*.html` 不可能进镜像 |
| `.gitattributes` 强制 LF | Windows 检出的 CRLF 会让 Alpine 的 sh source 到带 `\r` 的行,**镜像构建完全正常**,启动时报一个没人写过的命令 |

以上每一条都由 `tools/test-docker.mjs` 钉住,已并入 `npm test`。

</details>

---

# B · 局域网自托管(不想装 Docker)

在**任意一台和 Emby 同局域网、且常开机的机器**上跑(可以就是跑 Emby 的那台 NAS / 主机)。

### 前置

- Node.js 18 或更高(`node -v` 确认)
- 拉下本仓库后先装依赖:
  ```bash
  npm ci        # 或 npm install
  ```

### 一键启动

```bash
npm run deploy
```

脚本会自动:构建 wasm 与静态站 → `dist/` → 在局域网所有网卡上开 HTTP 服务,并打印
可直接打开的地址,例如:

```
    http://192.168.1.10:8080/emby.html
```

在**同一局域网**的手机 / 电视 / 电脑浏览器里打开即可。`Ctrl+C` 停止。

- 换端口:`PORT=9000 npm run deploy`
- 已经构建过、只想重新开服务:`node tools/deploy.mjs --no-build`
- 想开机自启 / 后台常驻:见文末[常驻运行](#常驻运行nas--服务器)

### 别忘了给 Emby 开跨域

LinWeb(`:8080`)和 Emby(`:8096`)端口不同 = 跨域,**必须**在 Emby 开 CORS,
否则登录就报"跨域"。见 [Emby 跨域配置](#emby-跨域cors配置)。

---

# C · Pages 托管(公网 HTTPS)

**仅当你的 Emby 也是 HTTPS**(有域名 + 证书)时才适用。

### GitHub Pages(仓库已配好 CI)

仓库自带 `.github/workflows/deploy.yml`:**push 到 `main` 即自动构建并发布**。
只需在仓库 `Settings → Pages → Source` 选 **GitHub Actions**,之后每次 push 自动上线,
地址形如 `https://<用户名>.github.io/<仓库名>/emby.html`。

### Cloudflare Pages / Netlify / Vercel

连接仓库后填:

| 字段 | 值 |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | 18+ |

> 这些平台**一律强制 https**(没法部署纯 http 版),所以只适合公网 https 的 Emby;
> 连局域网 http Emby 会撞混合内容墙。

---

# D · 同源反代(挂进现成的站点)

和方式 A 开 `EMBY_UPSTREAM` 是同一个道理,只是挂进你已经在跑的 Caddy / nginx,
不多起一个容器。**混合内容和 CORS 两道墙一起消失。**

先构建出 `dist/`:

```bash
npm run build      # 产物在 dist/
```

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

`https://emby.example.com/` 是 LinWeb,`/emby/*` 是 Emby,同源、同证书、零 CORS。
在 LinWeb 登录框里填 `https://emby.example.com/emby` 即可。

**nginx:**

```nginx
server {
    listen 80;
    root /path/to/dist;
    location /emby/ {
        proxy_pass http://127.0.0.1:8096/;
        proxy_set_header Host $host;
        proxy_buffering off;          # 视频是主要负载,别让它在磁盘上过一手
    }
    location / { try_files $uri $uri/ /index.html; }
}
```

**只是想临时开个 http 静态服务(不反代):**

```bash
node tools/serve.mjs dist            # 带 Range
```

⚠️ 别用 `python -m http.server`:它**不支持 Range 分段**,表现为进度条拖不动。

---

# Emby 跨域(CORS)配置

**方式 A 开了 `EMBY_UPSTREAM`、或者走方式 D 的,同源,跳过这一节。**

其余情况 LinWeb 和 Emby 不同源,Emby 必须返回跨域头。在 Emby 后台找到跨域 / CORS
相关项(不同版本位置不同,常在「网络」或高级设置),把**允许来源填 `*`**
(或精确填 LinWeb 的地址)。需要放行的响应头:

```
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Accept-Ranges, Content-Length, Content-Range
```

`Expose-Headers` 里那三个是**能拖进度条的关键**——少了它们,视频要么整段拉,
要么直接报"跨域文件需要服务器返回 …"。

---

# 通用排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 能登录、能看封面,但**视频点了不播** | 典型混合内容:https 页面连 http Emby | 换方式 A(局域网 http),或[让 http 那跳发生在服务器上](#7-放在已有的-https-反代后面) |
| 登录报「跨域 / 不允许跨域」 | Emby 没开 CORS | 按上面配 CORS;或改用方式 A 的反代,一劳永逸 |
| 报「跨域文件需要服务器返回 Access-Control-Expose-Headers…」 | Expose-Headers 少了 Range 相关头 | 补 `Content-Range, Accept-Ranges, Content-Length` |
| **进度条拖不动**,只能从头播 | 服务器不支持 `Range` | 换带 Range 的:本镜像 / `node tools/serve.mjs dist` / nginx / Caddy |
| 公网页面连**局域网 IP** 被拦 | 浏览器 Private Network Access 限制 | 别用公网托管连内网,改方式 A |
| **手机上改了半天没变化** | 浏览器缓存(本项目无 Service Worker) | 用**无痕标签页**打开,一步绕过所有缓存 |
| iPhone 上**滑动调音量没反应** | iOS 忽略网页对 `video.volume` 的写入,系统限制 | 用手机侧边的音量键;播放器会提示 |
| `.avi` / `.ts` / `.rmvb` 打不开 | 故意不支持 | `ffmpeg -i in.avi -c copy out.mkv`,几秒且不重编码 |
| `.strm` 播到一半画面冻住 | S3 预签名链接中途过期 | 已处理:自动改由服务器接管并续播 |
| 115 / 夸克 / 阿里云盘直链放不了 | 它们校验 `User-Agent`,浏览器改不了 | 纯前端无解,只能让 Emby 服务端代理 |
| 在线弹幕匹配不到 | 弹弹play / B 站接口都不给 CORS 头 | 需自建兼容端点;拖本地弹幕文件始终可用 |

---

# 常驻运行(NAS / 服务器)

**方式 A 的容器本身就是常驻**(`restart: unless-stopped` 即开机自启),不用看这节。

方式 B 的 `npm run deploy` 是前台运行的,关终端就停。要长期跑:

- **PM2**:`pm2 start "node tools/serve.mjs dist" --name linweb`(先 `npm run build` 一次)
- **systemd**(Linux):写一个 `ExecStart=/usr/bin/node /path/to/tools/serve.mjs /path/to/dist`
  的 service,加 `Environment=PORT=8080`
- **方式 D 的 nginx / Caddy** 本身就是常驻服务,构建一次 `dist/` 后交给它即可

> 常驻的机器建议就是跑 Emby 的那台——反正常开,局域网内延迟最低,做同源反代也最容易。

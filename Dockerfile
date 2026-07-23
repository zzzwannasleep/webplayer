# syntax=docker/dockerfile:1
#
# LinWeb is a static site, so the shipped image is a static file server and
# nothing else: no Node, no npm, no toolchain. Node exists only in the build
# stage and is thrown away with it.

# ---- build stage: produces dist/ ------------------------------------------
# Debian-slim rather than alpine on purpose. Nothing from this stage ships, so
# its size is irrelevant, and glibc removes any question about whether every
# prebuilt binary in the tree (esbuild's, notably) has a musl variant.
#
# --platform=$BUILDPLATFORM pins this stage to the machine doing the building,
# never the target. What it produces -- HTML, ES modules, wasm -- is the same
# bytes on every architecture, so running npm ci and esbuild under QEMU to make
# an arm64 image would be minutes of emulation for an identical result. Only
# the runtime stage below is built per-architecture, and all it does is COPY.
FROM --platform=$BUILDPLATFORM node:22-slim AS build
WORKDIR /app

# Manifests first so editing a source file reuses the cached npm layer instead
# of re-downloading ~250 MB of dependencies.
COPY package.json package-lock.json ./
# Not --omit=dev: esbuild is a devDependency and build-vendor.mjs is what needs
# it. All of this stays behind in the build stage.
RUN npm ci --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY tools ./tools
RUN node tools/build-vendor.mjs && node tools/build-site.mjs

# ffmpeg.wasm is 32 MB of the 40 MB build -- and it is the software decoder for
# the codecs no browser will touch: E-AC3, AC-3, DTS, TrueHD. Dropping it makes
# the image ~8 MB + nginx, at the cost of those audio tracks failing to decode
# (video and every browser-native codec are unaffected). Build with
# `--build-arg WITH_FFMPEG=0` if your library is AAC/Opus/FLAC only.
ARG WITH_FFMPEG=1
RUN [ "$WITH_FFMPEG" = "1" ] || rm -f dist/vendor/ffmpeg*.js dist/vendor/ffmpeg-core.wasm

# ---- runtime stage ---------------------------------------------------------
# alpine-slim, not alpine: same nginx, without the njs and geoip modules this
# never loads. ~12 MB.
FROM nginx:1-alpine-slim

# The filter is load-bearing, not tidiness: it stops envsubst from substituting
# nginx's own $host / $uri / $is_args, which are indistinguishable from shell
# variables to a text-substitution tool.
ENV EMBY_UPSTREAM="" \
    NGINX_ENVSUBST_FILTER="^(EMBY_|NGINX_)"

COPY docker/nginx.conf.template     /etc/nginx/templates/default.conf.template
COPY docker/05-emby-upstream.envsh  /docker-entrypoint.d/05-emby-upstream.envsh

# The entrypoint skips anything in /docker-entrypoint.d without the executable
# bit -- silently, with one line on stdout. Windows checkouts never carry it.
#
# worker_processes auto spawns one worker per core; on a 16-core NAS that is 16
# processes to serve a handful of static files. One worker holds thousands of
# idle connections and keeps the container around 10 MB resident.
RUN chmod +x /docker-entrypoint.d/05-emby-upstream.envsh \
 && sed -i 's/^worker_processes.*/worker_processes 1;/' /etc/nginx/nginx.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 23685
HEALTHCHECK --interval=60s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:23685/index.html || exit 1

// Bundles the third-party subtitle renderers into public/vendor/.
//
// Both libraries are used as published -- nothing here patches them. The only
// reason a build step exists at all is module resolution: JASSUB ships bare
// ESM imports (abslink, lfa-ponyfill, throughput) in BOTH the main module and
// its worker, so a browser cannot load it from node_modules without resolving
// a transitive dependency graph by hand in an import map. Bundling once is
// smaller, faster and far less fragile than maintaining that map.
//
// The wasm blobs and the fallback font are copied verbatim; JASSUB is told
// where they are through explicit URLs rather than import.meta.url, because
// after bundling the module no longer sits next to them.
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

// Relative to the repo root (npm scripts run there), so it works on any machine
// and in CI -- not a hardcoded absolute path.
const OUT = 'public/vendor';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: {
    'jassub': 'node_modules/jassub/dist/jassub.js',
    'jassub-worker': 'node_modules/jassub/dist/worker/worker.js',
  },
  outdir: OUT,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  // Keeping the wasm external means the worker fetches it at runtime from the
  // URL we pass in, instead of esbuild trying to inline a megabyte of binary.
  external: ['*.wasm'],
  logLevel: 'warning',
});

for (const f of ['wasm/jassub-worker.wasm', 'wasm/jassub-worker-modern.wasm', 'default.woff2']) {
  copyFileSync(`node_modules/jassub/dist/${f}`, `${OUT}/${f.split('/').pop()}`);
}

// libpgs is already a self-contained bundle with no bare imports, so it is
// copied rather than rebuilt. Its worker is loaded by URL at runtime.
for (const f of ['libpgs.js', 'libpgs.worker.js']) {
  copyFileSync(`node_modules/libpgs/dist/${f}`, `${OUT}/${f}`);
}

// danmaku (MIT, no dependencies): the flying-comment renderer. The published
// ESM build is already a single self-contained file with no bare imports, so
// it is copied, not bundled. The full build carries both engines; we drive the
// canvas one (thousands of comments an episode is too many DOM nodes).
copyFileSync('node_modules/danmaku/dist/esm/danmaku.min.js', `${OUT}/danmaku.js`);

// anime4k-webgpu (MIT): optional SDR-only GPU upscaler for anime. It ships as a
// webpack CJS bundle whose exports are attached via Object.defineProperty, which
// esbuild cannot hoist into ES named bindings -- so src/video/anime4k.js imports
// the namespace (`import * as A4K`) and reads pipeline classes off it at runtime.
await build({
  entryPoints: { 'anime4k': 'node_modules/anime4k-webgpu/lib/index.js' },
  outdir: OUT,
  bundle: true, format: 'esm', target: 'es2022', logLevel: 'warning',
});

// ffmpeg.wasm, for the codecs no browser decodes: E-AC3, AC-3, DTS, TrueHD.
//
// The single-threaded core is deliberate. The multi-threaded one needs
// SharedArrayBuffer, which needs COOP/COEP, which would break the plain
// <video> and blob-URL paths this player is built on -- and the probe
// measured crossOriginIsolated as false here.
//
// This core is GPL-2.0-or-later, unlike everything else in the repository,
// which is why it lives on its own branch. See README.
await build({
  entryPoints: { 'ffmpeg': 'node_modules/@ffmpeg/ffmpeg/dist/esm/index.js' },
  outdir: OUT,
  bundle: true, format: 'esm', target: 'es2022', logLevel: 'warning',
});
// Its worker is loaded by URL, so it is bundled separately rather than inlined.
await build({
  entryPoints: { 'ffmpeg-worker': 'node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js' },
  outdir: OUT,
  bundle: true, format: 'esm', target: 'es2022', logLevel: 'warning',
});
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  copyFileSync(`node_modules/@ffmpeg/core/dist/esm/${f}`, `${OUT}/${f}`);
}

console.log(`vendor bundles written to ${OUT}`);

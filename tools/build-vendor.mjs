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

const OUT = 'D:/xiaochengxu/webplayer/public/vendor';
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

console.log(`vendor bundles written to ${OUT}`);

// Assembles a deployable static site into dist/.
//
// The app is unbundled ES modules: public/index.html imports ../src/*.js and
// resolves the wasm vendor bundle relative to the page. That layout is right
// for the repo but wrong for a host, where index.html should sit at the site
// root. This flattens it: index.html at dist/, its sibling src/ and vendor/
// beside it, with the one ../src/ prefix rewritten to src/. No bundler -- the
// browser loads the modules directly, exactly as in development, so what ships
// is what was tested.
//
// Run AFTER tools/build-vendor.mjs (which produces public/vendor/).
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const ROOT = process.argv[2] || '.';
const OUT = `${ROOT}/dist`;

if (!existsSync(`${ROOT}/public/vendor/jassub.js`)) {
  console.error('public/vendor/ is missing — run `node tools/build-vendor.mjs` first.');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// The application code and the built wasm bundle.
cpSync(`${ROOT}/src`, `${OUT}/src`, { recursive: true });
cpSync(`${ROOT}/public/vendor`, `${OUT}/vendor`, { recursive: true });

// index.html at the root, with ../src/ -> ./src/. It MUST stay ./src/, not
// src/: a bare specifier (no leading ./) is a module name, not a path, and
// fails to resolve without an import map. The diagnostic pages
// (autotest/playdiag/perfdiag/...) are deliberately NOT shipped.
let html = readFileSync(`${ROOT}/public/index.html`, 'utf8').replace(/\.\.\/src\//g, './src/');
writeFileSync(`${OUT}/index.html`, html);

// A no-store-free host may cache aggressively; a tiny 404 fallback keeps deep
// links from breaking on SPAs. This app has one page, so 404 -> index.
writeFileSync(`${OUT}/404.html`, html);

console.log(`built ${OUT}/ (index.html + src/ + vendor/)`);

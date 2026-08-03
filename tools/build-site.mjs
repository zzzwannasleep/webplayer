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
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = process.argv[2] || '.';
const OUT = `${ROOT}/dist`;

if (!existsSync(`${ROOT}/public/vendor/jassub.js`)) {
  console.error('public/vendor/ is missing — run `node tools/build-vendor.mjs` first.');
  process.exit(1);
}

/**
 * Parse everything before shipping it.
 *
 * There is no bundler here, which is the point -- what ships is what was
 * tested. The price is that nothing ever reads the source: a syntax error in
 * any module used to be copied into dist/ and the build still printed
 * "built". The browser then fails at module evaluation, which kills every line
 * after it and still renders a page that looks nearly fine.
 *
 * `node --check` detects module syntax on its own, costs a few milliseconds a
 * file, and needs no dependency. (Two real ones this caught: a backtick inside
 * a CSS comment inside a styles template literal, which ends the string and
 * turns the rest of the rule into code. Twice.)
 */
function checkSyntax(dir) {
  const bad = [];
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
        if (r.status !== 0) bad.push(`${p}\n${(r.stderr || '').trim().split('\n').slice(0, 4).join('\n')}`);
      }
    }
  };
  walk(dir);
  return bad;
}

const broken = checkSyntax(`${ROOT}/src`);
if (broken.length) {
  console.error(`refusing to build — ${broken.length} module(s) do not parse:\n\n${broken.join('\n\n')}`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// The application code and the built wasm bundle.
cpSync(`${ROOT}/src`, `${OUT}/src`, { recursive: true });
cpSync(`${ROOT}/public/vendor`, `${OUT}/vendor`, { recursive: true });
// The favicons every page links as ./icon*.png -- same relative path in public/
// and at the site root, so nothing needs rewriting. Two of them: the black glyph
// is invisible on a dark tab strip, so a white twin is served under
// prefers-color-scheme: dark (Edge/Chrome honour `media` on rel=icon).
for (const f of ['icon.png', 'icon-white.png']) cpSync(`${ROOT}/public/${f}`, `${OUT}/${f}`);

// index.html at the root, with ../src/ -> ./src/. It MUST stay ./src/, not
// src/: a bare specifier (no leading ./) is a module name, not a path, and
// fails to resolve without an import map. The diagnostic pages
// (autotest/playdiag/perfdiag/...) are deliberately NOT shipped.
let html = readFileSync(`${ROOT}/public/index.html`, 'utf8').replace(/\.\.\/src\//g, './src/');
writeFileSync(`${OUT}/index.html`, html);

// The Emby browse client (public/emby.html) and the dedicated Emby player
// (public/play.html) are the other two entry points. Same relative-path rewrite
// so their `import ../src/...` resolves at the site root. emby.html hands
// playback off to play.html?url=&sub=&aud=..., so all three must ship.
for (const page of ['emby.html', 'play.html']) {
  const html = readFileSync(`${ROOT}/public/${page}`, 'utf8').replace(/\.\.\/src\//g, './src/');
  writeFileSync(`${OUT}/${page}`, html);
}

// A no-store-free host may cache aggressively; a tiny 404 fallback keeps deep
// links from breaking on SPAs. This app has one page, so 404 -> index.
writeFileSync(`${OUT}/404.html`, html);

console.log(`built ${OUT}/ (index.html + src/ + vendor/)`);

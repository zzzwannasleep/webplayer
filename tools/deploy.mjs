// One-command LAN deploy. Builds the static site and serves dist/ over plain
// HTTP on every interface, printing the URLs to open from a phone / TV / laptop
// on the same network.
//
// This is the right shape for a LOCAL Emby: an HTTP page on the LAN reaches an
// HTTP Emby with no mixed-content wall. An HTTPS Pages deploy (npm run build ->
// GitHub/Cloudflare) cannot talk to an http:// LAN Emby -- the browser blocks
// it. See DEPLOY.md for the full decision.
//
//   node tools/deploy.mjs            build, then serve
//   node tools/deploy.mjs --no-build serve an existing dist/ (skip the rebuild)
//   PORT=9000 node tools/deploy.mjs  serve on a different port
import { networkInterfaces } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const PORT = process.env.PORT ?? '8080';
const noBuild = process.argv.includes('--no-build');

if (!existsSync('node_modules')) {
  console.error('依赖未安装。先运行:  npm ci   (或 npm install)');
  process.exit(1);
}

if (!noBuild) {
  // build-vendor (wasm bundle) then build-site (flatten into dist/). Blocking:
  // both must finish before we serve. execFileSync throws on non-zero exit, so
  // a failed build aborts here rather than serving a stale dist.
  execFileSync(process.execPath, ['tools/build-vendor.mjs'], { stdio: 'inherit' });
  execFileSync(process.execPath, ['tools/build-site.mjs'], { stdio: 'inherit' });
} else if (!existsSync('dist/index.html')) {
  console.error('dist/ 不存在。去掉 --no-build 先构建一次。');
  process.exit(1);
}

const lans = Object.values(networkInterfaces()).flat()
  .filter(n => n && n.family === 'IPv4' && !n.internal)
  .map(n => n.address);

console.log('\n────────────────────────────────────────────');
console.log('  LinWeb 已在局域网启动。浏览器打开下面任一地址:');
console.log('────────────────────────────────────────────');
for (const ip of lans) console.log(`    http://${ip}:${PORT}/emby.html`);
if (!lans.length) console.log(`    http://localhost:${PORT}/emby.html   (未检测到局域网网卡)`);
console.log('\n  · 手机/电视/电脑需与本机在同一局域网。');
console.log('  · Emby 后台必须已开启跨域(CORS 填 *),否则登录会报"跨域"。');
console.log('  · Ctrl+C 停止服务。详见 DEPLOY.md。');
console.log('────────────────────────────────────────────\n');

// serve.mjs is the same Range-capable static server the dev workflow uses; it
// serves dist/ flat now that its root handler no longer forces /public/.
spawn(process.execPath, ['tools/serve.mjs', 'dist'], {
  stdio: 'inherit',
  env: { ...process.env, PORT },
});

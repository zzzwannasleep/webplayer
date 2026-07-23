// Dev server with HTTP Range support. Range is not optional here:
// the test files are 300MB..21GB and the player seeks by byte offset.
import { createServer } from 'node:http';
import { createReadStream, statSync, writeFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

// resolve(), not the argument as given: the containment check below compares
// against join()'s output, which on Windows uses backslashes. Passing a root
// with forward slashes (or a trailing separator) therefore failed that compare
// for EVERY request, and the whole site answered "forbidden" -- a path bug
// wearing a permissions error's clothes.
const ROOT = resolve(process.argv[2] ?? process.cwd());
const PORT = Number(process.env.PORT ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  // The other containers a viewer actually drops on the page. Served with the
  // right type so a <video> gets the same Content-Type a real host would send
  // -- and so a Blob built from one carries a type, as a picked File does.
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.srt': 'text/plain; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  // probe.html POSTs its results here so a headful browser run can be captured
  // from the shell. Headless reports no HEVC/HDR, so headful is the only truth.
  if (req.method === 'POST' && url === '/collect') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      writeFileSync(join(ROOT, 'probe-result.txt'), Buffer.concat(chunks));
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }).end('ok');
    });
    return;
  }

  // In the REPO layout the app lives in public/, so '/' redirects there:
  // serving index.html at '/' would make document.baseURI '/', and the subtitle
  // renderers resolve their wasm bundles against it -- so every one 404s and
  // subtitles silently never appear. A built dist/ is already flat (index.html
  // and vendor/ at the root), where baseURI '/' is correct -- so serve it in
  // place. Deciding by which layout is on disk keeps `serve dist` from
  // redirecting to a /public/ that does not exist (a blank 404 on the homepage).
  if (url === '/' || url === '/public') {
    if (existsSync(join(ROOT, 'public', 'index.html'))) { res.writeHead(302, { Location: '/public/' }).end(); return; }
  }
  // TEST AFFORDANCE: /nocors/<path> serves the same bytes with NO
  // Access-Control-Allow-Origin. Fetched from the other spelling of this host
  // (127.0.0.1 vs localhost -- different origins, same process) it reproduces
  // exactly what an S3 bucket with no CORS config does to a browser, which is
  // the one condition public/strmcheck.html cannot otherwise create and the one
  // the native <video> fallback exists for. Dev server only.
  const noCors = url.startsWith('/nocors/');

  let path = join(ROOT, normalize(noCors ? url.slice('/nocors'.length) : url));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  let st;
  try { st = statSync(path); } catch { res.writeHead(404).end('not found'); return; }
  // A directory request serves its index.html rather than 404ing. Browsers
  // and humans both write /public/ far more often than /public/index.html.
  if (st.isDirectory()) {
    const idx = join(path, 'index.html');
    try { st = statSync(idx); path = idx; }
    catch { res.writeHead(404).end('not found'); return; }
  }

  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
  // COOP/COEP kept OFF by default: turning them on breaks any cross-origin
  // embed and buys us nothing until we actually need SharedArrayBuffer threads.
  const base = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    ...(noCors ? {} : { 'Access-Control-Allow-Origin': '*' }),
  };

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) { res.writeHead(416, { ...base, 'Content-Range': `bytes */${st.size}` }).end(); return; }
    let start = m[1] === '' ? null : Number(m[1]);
    let end = m[2] === '' ? null : Number(m[2]);
    if (start === null) {                    // suffix range: last N bytes
      if (end === null || end === 0) { res.writeHead(416, { ...base, 'Content-Range': `bytes */${st.size}` }).end(); return; }
      start = Math.max(0, st.size - end);
      end = st.size - 1;
    } else {
      end = end === null ? st.size - 1 : Math.min(end, st.size - 1);
    }
    if (start > end || start >= st.size) { res.writeHead(416, { ...base, 'Content-Range': `bytes */${st.size}` }).end(); return; }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(path, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...base, 'Content-Length': st.size });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(path).pipe(res);
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));

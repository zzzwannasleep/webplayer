// The container's nginx config is generated, not written: the entrypoint runs
// envsubst over docker/nginx.conf.template at startup. Both halves of that have
// failure modes that produce a config which loads cleanly and behaves wrong,
// so neither `nginx -t` nor "it started" is evidence.
//
// This checks the two that actually bit, plus the invariants holding them:
//
//   1. envsubst cannot tell nginx's $host from a shell variable. Without
//      NGINX_ENVSUBST_FILTER it eats them and the proxy silently misroutes.
//   2. `proxy_pass $upstream$1` looks right until the URI is bare /emby. $1 is
//      then empty, proxy_pass is left with no URI component, and nginx falls
//      back to forwarding the ORIGINAL uri -- so Emby is asked for /emby and
//      answers 404. Verified against a real nginx: it forwarded "/emby".
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tpl = readFileSync(join(ROOT, 'docker/nginx.conf.template'), 'utf8');
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');

let bad = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
  if (!ok) bad++;
};

// The filter the Dockerfile sets, applied the way the entrypoint applies it.
const filter = new RegExp(/NGINX_ENVSUBST_FILTER="([^"]+)"/.exec(dockerfile)?.[1] ?? '(?!)');
const render = env => tpl.replace(/\$\{(\w+)\}/g, (m, n) => (filter.test(n) ? (env[n] ?? '') : m));

check('Dockerfile sets NGINX_ENVSUBST_FILTER', filter.source !== '(?!)',
  'without it envsubst substitutes nginx’s own $host/$uri/$is_args');

for (const v of ['EMBY_UPSTREAM', 'NGINX_LOCAL_RESOLVERS'])
  check(`\${${v}} passes the filter`, filter.test(v), filter.source);

const out = render({ EMBY_UPSTREAM: 'http://emby:8096', NGINX_LOCAL_RESOLVERS: '127.0.0.11 ' });

check('nginx’s own variables survive rendering',
  ['$host', '$is_args', '$args', '$http_upgrade', '$remote_addr', '$scheme'].every(v => out.includes(v)));
check('nothing is left unrendered', !/\$\{\w+\}/.test(out), out.match(/\$\{\w+\}/g)?.join(', '));

// The bug this file exists for.
const pass = /proxy_pass\s+(\S+);/.exec(out)?.[1] ?? '';
check('proxy_pass keeps a URI component even when the capture is empty',
  /^\$\w+\/.*/.test(pass),
  `${pass} -- with an empty $1 nginx forwards the original /emby instead`);

// A literal upstream would be resolved at startup: an Emby container that comes
// up a second later turns this one into a crash loop.
check('upstream goes through a variable, not a literal host',
  out.includes('set $emby_upstream') && /resolver\s+\S/.test(out));

// Unset must be a diagnosable 503, not a config error and not a 404.
check('unset EMBY_UPSTREAM renders a 503 guard, not a broken proxy_pass',
  /if\s*\(\$emby_upstream\s*=\s*""\)\s*\{\s*return 503/.test(render({ NGINX_LOCAL_RESOLVERS: '127.0.0.11 ' })));

// /emby.html and /embything must not be swallowed by the proxy location.
const loc = /location\s+~\s+(\S+)\s*\{/.exec(out)?.[1] ?? '';
const re = new RegExp(loc);
check('the proxy location matches /emby and /emby/... only',
  re.test('/emby') && re.test('/emby/Users') && !re.test('/emby.html') && !re.test('/embything'), loc);

check('the container listens on 23685', /listen\s+23685;/.test(out));
check('EXPOSE agrees with the listen directive', /EXPOSE\s+23685/.test(dockerfile));

// The build context is an allowlist because the repo root holds the test
// media -- 21 GB of it -- plus *.env and token-carrying public/_*.html.
check('.dockerignore starts from a bare * (allowlist, not blocklist)',
  /^\*$/m.test(ignore.split('\n').find(l => l.trim() === '*') ?? ''));

// The allowlist and the COPY lines have to be kept in agreement by hand, and
// they drift silently: the Dockerfile itself reaches the daemon separately, so
// a directory it COPYs but the allowlist forgets fails at that COPY and nowhere
// earlier. Derive the requirement from the Dockerfile instead of listing it.
const allowed = new Set(ignore.split('\n').filter(l => l.startsWith('!')).map(l => l.slice(1).trim()));
const copied = [...dockerfile.matchAll(/^COPY\s+(?!--from=)(?:--\S+\s+)*(.+)$/gm)]
  .flatMap(m => m[1].trim().split(/\s+/).slice(0, -1))   // last token is the destination
  .filter(p => p !== '.' && !p.startsWith('/'));
for (const src of new Set(copied))
  check(`.dockerignore lets COPY ${src} through`, allowed.has(src.split('/')[0]),
    `add !${src.split('/')[0]} -- the build context has no ${src}`);
for (const dropped of ['public/vendor', 'public/_*.html'])
  check(`.dockerignore withholds ${dropped}`, new RegExp(`^${dropped.replace(/[.*]/g, '\\$&')}$`, 'm').test(ignore));

// A Windows checkout without .gitattributes hands /bin/sh a script whose lines
// end in \r. The image builds, then the entrypoint dies naming a command nobody
// wrote. Checked here because the failure is three layers away from the cause.
check('the entrypoint script has unix line endings',
  !readFileSync(join(ROOT, 'docker/05-emby-upstream.envsh'), 'latin1').includes('\r'),
  'CRLF -- check .gitattributes took effect on this checkout');

console.log(bad ? `\n${bad} problem(s) in the container config` : '\ncontainer config holds');
process.exit(bad ? 1 : 0);

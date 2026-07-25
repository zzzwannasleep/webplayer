// What this file is really guarding, in one sentence: the image must start with
// NO environment set.
//
// It did not. The config carried `resolver ${NGINX_LOCAL_RESOLVERS}` for an Emby
// reverse proxy, and nothing ever set that variable. The nginx image's entrypoint
// substitutes only variables that actually exist in the environment, so the
// placeholder survived verbatim into /etc/nginx/conf.d/default.conf and nginx
// died at parse time -- `[emerg] host not found in resolver "${...}"`, exit 1.
// `resolver` is read when the config LOADS, so this happened even to people who
// never touched the proxy. The old test here missed it by simulating envsubst as
// "replace every ${VAR} with env[VAR] ?? ''", which is exactly the substitution
// the real entrypoint refuses to make for an unset variable.
//
// The proxy is gone (users put LinWeb behind their own), so the two checks that
// matter now are: no placeholder survives anywhere in the config, and the config
// does not go through envsubst at all.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tpl = readFileSync(join(ROOT, 'docker/nginx.conf'), 'utf8');
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');

let bad = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
  if (!ok) bad++;
};

// Directives only. The header comment names the dead variables on purpose --
// that is the scar tissue explaining why none of this is here any more -- so
// every check below reads the config with its comments stripped.
const conf = tpl.replace(/^\s*#.*$/gm, '');

// The bug this file exists for. An unset one of these is fatal at startup, and
// nothing guarantees any given deployment sets it.
check('the nginx config carries no ${...} placeholders',
  !/\$\{\w+\}/.test(conf),
  conf.match(/\$\{\w+\}/g)?.join(', '));

// Belt to that brace: a config under /etc/nginx/templates is fed to envsubst,
// which cannot tell nginx's own $uri from a shell variable. Copy to conf.d and
// the question never arises.
check('the config is copied to conf.d, not templates/ (no envsubst in the path)',
  /COPY\s+docker\/nginx\.conf\s+\/etc\/nginx\/conf\.d\/default\.conf/.test(dockerfile),
  'a *.template under /etc/nginx/templates would be substituted at startup');

// The proxy is gone; nothing may quietly reintroduce a knob that has to be set.
for (const dead of ['EMBY_UPSTREAM', 'NGINX_LOCAL_RESOLVERS', 'NGINX_ENVSUBST_FILTER'])
  check(`${dead} is gone from the image`,
    !dockerfile.replace(/^\s*#.*$/gm, '').includes(dead) && !conf.includes(dead),
    'the container must start with no environment set');

// A Windows checkout without a .gitattributes rule hands nginx a config whose
// lines end in \r. Checked against the WORKING COPY on purpose -- that is the
// byte stream `docker build` uploads, and the failure is two layers from the
// cause. The rule used to be keyed on `*.template`; renaming the file to
// nginx.conf took it out of scope silently, which is why this check is keyed on
// the file rather than on the pattern that is supposed to cover it.
check('the nginx config has unix line endings',
  !readFileSync(join(ROOT, 'docker/nginx.conf'), 'latin1').includes('\r'),
  'CRLF -- check .gitattributes covers docker/ on this checkout');

check('the container listens on 23685', /listen\s+23685;/.test(conf));
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

console.log(bad ? `\n${bad} problem(s) in the container config` : '\ncontainer config holds');
process.exit(bad ? 1 : 0);

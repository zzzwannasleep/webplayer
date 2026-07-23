// Drives Firefox over WebDriver BiDi. Firefox removed its CDP remote agent, so
// the CDP harness in test-touch.mjs / test-controls.mjs cannot reach it at all
// -- BiDi is the only protocol Firefox still speaks.
//
// No new dependency: Node 22+ has a global WebSocket, which is the only thing
// `ws` would have bought us.
//
// The mapping from the CDP harness, for whoever ports the next test:
//   Runtime.evaluate       -> script.evaluate  (result is typed, not a raw value)
//   Page.navigate          -> browsingContext.navigate
//   DOM.setFileInputFiles  -> input.setFiles   (takes a sharedId, not a nodeId)
//   Runtime.exceptionThrown-> log.entryAdded   (level 'error')

import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo-relative, not absolute: the portable build is gitignored, so anyone
// else supplies their own via FIREFOX=<path to firefox.exe>.
const PORTABLE = fileURLToPath(new URL('../FirefoxPortable/App/Firefox64/firefox.exe', import.meta.url));
export const FIREFOX = process.env.FIREFOX
  || (existsSync(PORTABLE) ? PORTABLE : 'C:\\Program Files\\Mozilla Firefox\\firefox.exe');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Kill Firefoxes left behind by an earlier run of ours, and only those. */
function reapStrays() {
  if (process.platform !== 'win32') { try { execSync(`pkill -f linweb-ff-`); } catch {} return; }
  try {
    execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'firefox.exe\'\\" | '
      + 'Where-Object { $_.CommandLine -like \'*linweb-ff-*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"',
      { stdio: 'ignore' });
  } catch {}
}

/**
 * Boot a headless Firefox with a throwaway profile and open a BiDi session.
 * @returns {Promise<{send, evalJS, navigate, setFiles, errors, context, kill}>}
 */
export async function launchFirefox({ port = 9225, prefs = {}, headless = process.env.HEADLESS === '1' } = {}) {
  if (!existsSync(FIREFOX)) throw new Error(`no Firefox at ${FIREFOX} -- set FIREFOX`);
  // A headful Firefox outlives a crashed run and then answers on the port with
  // "Maximum number of active sessions", which looks like a protocol failure.
  // Matched on our own profile prefix so the developer's own Firefox is safe.
  reapStrays();

  const profile = mkdtempSync(join(tmpdir(), 'linweb-ff-'));
  // Autoplay is the one that bites: without it play() rejects and every
  // playback assertion below fails for a reason that has nothing to do with us.
  const defaults = {
    'media.autoplay.default': 0,
    'media.autoplay.blocking_policy': 0,
    'browser.shell.checkDefaultBrowser': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'app.update.auto': false,
    'toolkit.telemetry.enabled': false,
  };
  const all = { ...defaults, ...prefs };
  writeFileSync(join(profile, 'user.js'),
    Object.entries(all).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));

  // Headful by default. Headless Firefox on Windows cannot start the RDD /
  // Media Foundation decode processes, so every MSE video fails with
  // "RemoteMediaManager is not available" -- which reads exactly like a codec
  // rejection and is not one. HEADLESS=1 is available for DOM-only checks.
  const kid = spawn(FIREFOX, [...(headless ? ['--headless'] : []), '--no-remote', '--profile', profile,
    `--remote-debugging-port=${port}`, '--width=1280', '--height=800', 'about:blank'], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(500);
    ws = await new Promise(ok => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/session`);
      s.onopen = () => ok(s);
      s.onerror = () => ok(null);
    });
  }
  if (!ws) { kid.kill(); throw new Error(`Firefox never opened a BiDi endpoint on ${port}`); }

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id != null) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    // A page that throws while evaluating a module still renders its HTML, so
    // without this a TDZ mistake passes every DOM assertion.
    if (m.method === 'log.entryAdded' && m.params.level === 'error') {
      errors.push(m.params.text || m.params.message || JSON.stringify(m.params));
    }
  };
  const send = (method, params = {}) => new Promise((ok, no) => {
    const n = ++id;
    pending.set(n, r => r.error ? no(new Error(`${method}: ${r.error} ${r.message || ''}`)) : ok(r.result));
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('session.new', { capabilities: {} });
  const tree = await send('browsingContext.getTree', {});
  const context = tree.contexts[0].context;
  await send('session.subscribe', { events: ['log.entryAdded'] });

  /** Evaluate and unwrap to a plain value. Only primitives survive -- return
   *  JSON.stringify(...) from the page for anything structured. */
  const evalJS = async expression => {
    const r = await send('script.evaluate', {
      expression, target: { context }, awaitPromise: true, userActivation: true,
    });
    if (r.type === 'exception') throw new Error(r.exceptionDetails?.text || 'page threw');
    return r.result?.value;
  };
  // Promise.resolve first: stringifying an async IIFE serialises the Promise
  // itself ("{}"), which reads as "the browser said no" and is a lie.
  const evalJSON = async expression =>
    JSON.parse(await evalJS(`Promise.resolve(${expression}).then(v => JSON.stringify(v))`));

  const navigate = url => send('browsingContext.navigate', { context, url, wait: 'complete' });

  /** BiDi wants the node's sharedId, which only comes back from a node result. */
  const setFiles = async (selector, files) => {
    const r = await send('script.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      target: { context }, awaitPromise: false,
    });
    const sharedId = r.result?.sharedId;
    if (!sharedId) throw new Error(`no element for ${selector}`);
    await send('input.setFiles', { context, element: { sharedId }, files });
  };

  const kill = () => { try { ws.close(); } catch {} try { kid.kill(); } catch {} };
  return { send, evalJS, evalJSON, navigate, setFiles, errors, context, kill, profile };
}

// The Cloudflare relay, running for real on workerd. Run it with:
//   cd worker && npx wrangler dev --port 8799 --local
//   node tools/test-worker.mjs
//
// Not part of `npm test`: it needs wrangler, which downloads workerd and wants
// the network. But the Worker is one of the two relays people are told to
// deploy, and tools/test-together.mjs only exercises the shared logic through
// fake connections -- everything specific to this runtime (the Durable Object
// binding, addressing an object by room name, the WebSocket Hibernation
// callbacks, serializeAttachment) is unproven until workerd runs it.
//
// Node's built-in WebSocket is the client here, so there is no dependency.
import assert from 'node:assert/strict';

const PORT = Number(process.env.WORKER_PORT ?? 8799);
const base = `http://127.0.0.1:${PORT}`;

let n = 0, bad = 0;
const check = (label, fn) => {
  try { fn(); n++; console.log(`  PASS  ${label}`); }
  catch (e) { bad++; console.log(`  FAIL  ${label}\n        ${e.message}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  const hello = await fetch(base).then(r => r.text());
  assert.match(hello, /一起看 relay/);
} catch (e) {
  console.error(`no worker on ${base} — start it with:\n  cd worker && npx wrangler dev --port ${PORT} --local\n(${e.message})`);
  process.exit(2);
}
console.log('=== worker (workerd) ===');
check('a plain GET explains what the address is', () => {});

/** One member: a WebSocket plus everything it has been told. */
async function member(code, name, pass) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/room/${code}`);
  const got = [];
  let shut = null;
  ws.addEventListener('message', e => got.push(JSON.parse(e.data)));
  ws.addEventListener('close', e => { shut = e.code ?? 1005; });
  await new Promise((ok, no) => { ws.addEventListener('open', ok); ws.addEventListener('error', no); });
  const api = {
    ws, got,
    get closed() { return shut !== null; },
    send: m => ws.send(JSON.stringify(m)),
    last: t => [...got].reverse().find(x => x.t === t),
  };
  api.send({ t: 'hello', name, pass });
  return api;
}
const settle = () => sleep(250);

const a = await member('WD001', '甲');
await settle();
check('the upgrade is accepted and a welcome comes back', () => assert.ok(a.last('welcome')?.you));
check('the first member is the host', () => assert.equal(a.last('welcome').host, a.last('welcome').you));

// Lower case: the Worker folds the code before addressing the object, so this
// must land in the SAME Durable Object rather than a second, empty one.
const b = await member('wd001', '乙');
await settle();
check('the room code is folded before the object is addressed',
  () => assert.equal(b.last('welcome').members.length, 2));
check('the second member is told about the first host',
  () => assert.equal(b.last('welcome').host, a.last('welcome').you));
check('the first member was told somebody joined',
  () => assert.equal(a.last('join')?.member?.name, '乙'));

// A different code must be a different object, or every room in the world is
// one room.
const c = await member('WD002', '丙');
await settle();
check('a different code is a different room', () => assert.equal(c.last('welcome').members.length, 1));

b.send({ t: 'state', paused: false, pos: 61.5, rate: 1, seq: 1 });
await settle();
check('state crosses the object', () => assert.equal(a.last('state')?.pos, 61.5));
check('the object stamps it with its own clock', () => assert.ok(a.last('state').s > 0));
check('it does not leak into the other room', () => assert.equal(c.last('state'), undefined));

a.send({ t: 'ping', c: 4242 });
await settle();
check('ping is answered', () => assert.equal(a.last('pong')?.c, 4242));

a.send({ t: 'signal', to: b.last('welcome').you, data: { sdp: 'x'.repeat(4000) } });
await settle();
check('a 4 KB signal reaches its addressee', () => assert.equal(b.last('signal')?.data?.sdp?.length, 4000));

b.send({ t: 'wait', waiting: true });
await settle();
check('the wait lockstep works through the object',
  () => assert.deepEqual(a.last('wait')?.waiters, [b.last('welcome').you]));

// A late joiner must be handed the room's position by the object, which is the
// one piece of state that has to survive between two separate requests.
b.send({ t: 'wait', waiting: false });
b.send({ t: 'state', paused: false, pos: 99, rate: 1, seq: 2 });
await settle();
const d = await member('WD001', '丁');
await settle();
check('a late joiner is seeded with the room state', () => assert.equal(d.last('welcome')?.state?.pos, 99));
check('and sees all three members', () => assert.equal(d.last('welcome').members.length, 3));

// Closing must reach webSocketClose and shrink the room.
a.ws.close();
await settle();
check('a closed socket leaves the room', () => assert.equal(b.last('leave')?.members?.length, 2));
check('the host seat moved off the member that left',
  () => assert.notEqual(b.last('leave').host, a.last('welcome').you));
check('the new host is one of the members still here',
  () => assert.ok(b.last('leave').members.some(m => m.id === b.last('leave').host)));

for (const m of [b, c, d]) m.ws.close();
await settle();

// A room with a password, through the real object. This is the path that
// changed most: the Worker used to special-case a rejected hello itself
// (ws.close(1013)), and now the relay turns the socket away through
// conn.close() -- so whether a Hibernation-accepted WebSocket actually closes
// when the shared logic asks it to is a workerd question, not a logic one.
const lockA = await member('WDPASS', '甲', 'kaimen');
await settle();
check('a passworded room opens through the object', () => assert.ok(lockA.last('welcome')?.you));

const lockBad = await member('WDPASS', '贼', 'nope');
await settle();
check('a wrong password is told why', () => assert.equal(lockBad.last('denied')?.why, 'pass'));
check('and gets no welcome', () => assert.equal(lockBad.last('welcome'), undefined));
check('and workerd really closes the socket', () => assert.equal(lockBad.closed, true));
check('and the room did not grow', () => assert.equal(lockA.last('join'), undefined));

const lockB = await member('WDPASS', '乙', 'kaimen');
await settle();
check('the right password gets in through the object', () => assert.equal(lockB.last('welcome').members.length, 2));

for (const m of [lockA, lockB]) m.ws.close();
await settle();

console.log(bad ? `\n${bad} WORKER CHECK(S) FAILED` : `\nALL WORKER CHECKS PASSED (${n})`);
process.exit(bad ? 1 : 0);

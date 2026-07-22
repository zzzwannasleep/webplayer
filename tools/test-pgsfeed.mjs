// PgsFeed bookkeeping: the part that made 4K playback stutter.
//
// The original class kept every display set of the film and handed all of them
// back to libpgs every 100 ms, so the cost of showing one subtitle grew with
// how long the film had run. It also had no de-duplication, and both a seek and
// enableSubtitle()'s backfill legitimately re-deliver packets, so the list grew
// a second copy of a region on every visit. Neither is visible in a short test
// run, which is exactly why they need asserting rather than eyeballing.

import { PgsFeed, packetsToSup, splitSegments, PGS_TIMEBASE } from '../src/subs/pgs.js';

let failures = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
};

/** A minimal but structurally valid display set: END is type 0x80, length 0. */
const set = (n = 0) => {
  const body = new Uint8Array(n);
  const ods = new Uint8Array(3 + n);
  ods[0] = 0x15; ods[1] = (n >> 8) & 0xff; ods[2] = n & 0xff;
  ods.set(body, 3);
  const end = Uint8Array.of(0x80, 0, 0);
  const out = new Uint8Array(ods.length + end.length);
  out.set(ods, 0); out.set(end, ods.length);
  return out;
};
const pkt = (time, n = 8) => ({ time, data: set(n) });

console.log('=== PgsFeed ===');

// The fixture has to be something the rest of the pipeline accepts, or the
// test proves nothing about real packets.
check('fixture splits into segments', splitSegments(set(8))?.length, 2);

{
  const feed = new PgsFeed(() => {});
  for (let t = 0; t < 20; t++) feed.push(pkt(t));
  check('all distinct packets kept', feed.packets.length, 20);
  // A seek back re-reads the region; the backfill re-reads it again.
  for (let t = 0; t < 20; t++) feed.push(pkt(t));
  for (let t = 0; t < 20; t++) feed.push(pkt(t));
  check('re-delivered packets are not duplicated', feed.packets.length, 20);
}

{
  // Two display sets can share a timestamp -- a clear and its replacement --
  // so time alone must not be the identity.
  const feed = new PgsFeed(() => {});
  feed.push(pkt(5, 8));
  feed.push(pkt(5, 40));
  check('same timestamp, different set, both kept', feed.packets.length, 2);
}

{
  const feed = new PgsFeed(() => {}, { behind: 30, ahead: 120 });
  for (let t = 0; t < 7200; t += 2) feed.push(pkt(t));   // a two-hour film
  const unbounded = feed.packets.length;
  feed.setTime(3600);
  check('unbounded before trimming', unbounded, 3600);
  // 30s behind + 120s ahead at one set every 2s = 76 inclusive.
  check('window bounded around the playhead', feed.packets.length, 76);
  check('oldest kept is not before the window', feed.packets[0].time >= 3570, true);
  check('newest kept is not past the window', feed.packets.at(-1).time <= 3720, true);

  // The whole point: what libpgs re-parses must not depend on film length.
  const bytes = packetsToSup(feed.packets).length;
  check('reload stays small', bytes < 4096, true);
}

{
  // Trimming must free the dedup keys too, or seeking back into a trimmed
  // region would silently refuse to re-add its packets and the subtitles
  // would simply stop appearing.
  const feed = new PgsFeed(() => {}, { behind: 10, ahead: 10 });
  feed.push(pkt(100));
  feed.setTime(500);
  check('far packet trimmed', feed.packets.length, 0);
  feed.setTime(100);
  feed.push(pkt(100));
  check('trimmed packet can be re-added after seeking back', feed.packets.length, 1);
}

{
  // Reloads are what cost; they must be driven by change, not by the clock.
  let reloads = 0;
  const feed = new PgsFeed(() => { reloads++; }, { behind: 30, ahead: 120 });
  for (let t = 0; t < 40; t++) feed.push(pkt(t));
  feed.flush();
  check('one reload for a burst', reloads, 1);
  feed.flush();
  feed.flush();
  check('no reload when nothing changed', reloads, 1);
  feed.setTime(10);            // inside the window: nothing leaves
  feed.flush();
  check('no reload when the window did not move anything', reloads, 1);
}

{
  // PTS must survive the round trip, or subtitles appear at the wrong moment.
  const sup = packetsToSup([pkt(12.5)]);
  const pts = (sup[2] << 24 | sup[3] << 16 | sup[4] << 8 | sup[5]) >>> 0;
  check('PTS written at 90 kHz', pts, Math.round(12.5 * PGS_TIMEBASE));
}

console.log(failures === 0 ? '\nPgsFeed OK' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);

// Dumps the raw subtitle packets out of the test files.
//
// This exists because "what exactly is in an S_HDMV/PGS block inside MKV" is
// the one fact that decides how a PGS renderer gets fed, and it is documented
// inconsistently. A .sup file wraps every segment in a 10-byte header
// ("PG" magic + 32-bit PTS + 32-bit DTS); the Matroska muxer strips that and
// stores only the segment bodies. Guessing wrong here means feeding a decoder
// bytes it will silently discard, so the bytes get printed and read.
import { openSync, readSync, statSync, closeSync, writeFileSync } from 'node:fs';
import { MatroskaDemuxer, TRACK_SUBTITLE } from '../src/demux/matroska.js';

class NodeSource {
  constructor(path) { this.fd = openSync(path, 'r'); this.size = statSync(path).size; this.name = path; }
  async read(offset, length) {
    const len = Math.min(length, this.size - offset);
    if (len <= 0) return new Uint8Array(0);
    const buf = Buffer.allocUnsafe(len);
    readSync(this.fd, buf, 0, len, offset);
    return new Uint8Array(buf.buffer, buf.byteOffset, len);
  }
  close() { closeSync(this.fd); }
}

const SEG = {
  0x14: 'PDS palette', 0x15: 'ODS object', 0x16: 'PCS presentation',
  0x17: 'WDS window', 0x80: 'END',
};

const hex = (b, n = 24) => [...b.slice(0, n)].map(x => x.toString(16).padStart(2, '0')).join(' ');
const text = b => new TextDecoder().decode(b);

/** Walk a PGS payload as bare segments: u8 type, u16 length, body. */
function walkSegments(data) {
  const out = [];
  let p = 0;
  while (p + 3 <= data.length) {
    const type = data[p];
    const len = (data[p + 1] << 8) | data[p + 2];
    if (!SEG[type] || p + 3 + len > data.length) return { ok: false, out };
    out.push(`${SEG[type]}(${len})`);
    p += 3 + len;
  }
  return { ok: p === data.length, out };
}

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node tools/dump-subs.mjs <file.mkv>...'); process.exit(1); }

for (const path of files) {
  console.log(`\n=== ${path} ===`);
  const src = new NodeSource(path);
  const dx = new MatroskaDemuxer(src);
  await dx.parseHeader();

  const subs = dx.tracks.filter(t => t.type === TRACK_SUBTITLE);
  for (const t of subs) {
    console.log(`\n  track ${t.number}  ${t.codecId}  lang=${t.language}  name=${t.name ?? '-'}  default=${t.flagDefault}`);
    if (t.codecPrivate?.length) {
      console.log(`  codecPrivate ${t.codecPrivate.length}B`);
      if (/S_TEXT/.test(t.codecId)) {
        // The ASS header (Script Info + V4+ Styles) lives here, not in the blocks.
        console.log(text(t.codecPrivate).split('\n').slice(0, 40).map(l => `    | ${l}`).join('\n'));
        writeFileSync(`${path}.header.ass`, t.codecPrivate);
        console.log(`    -> wrote ${path}.header.ass`);
      } else {
        console.log(`    ${hex(t.codecPrivate, 48)}`);
      }
    } else {
      console.log('  codecPrivate: none');
    }
  }
  if (!subs.length) { src.close(); continue; }

  const want = new Set(subs.map(t => t.number));
  const seen = new Map(subs.map(t => [t.number, []]));
  const LIMIT = 6;

  // Subtitle packets are sparse; scan from the start until every track has a
  // few, or we have read enough of the file to conclude it never will.
  let pos = dx.seekPosition(0, subs[0].number), scanned = 0;
  while (scanned < (192 << 20) && [...seen.values()].some(v => v.length < LIMIT)) {
    const state = {};
    for await (const b of dx.readBlocks(pos, 8 << 20, state)) {
      if (!want.has(b.track)) continue;
      const list = seen.get(b.track);
      if (list.length < LIMIT) list.push(b);
    }
    if (state.atEnd || state.parseError || state.nextPos <= pos) break;
    scanned += state.nextPos - pos;
    pos = state.nextPos;
  }

  for (const t of subs) {
    const list = seen.get(t.number);
    console.log(`\n  --- track ${t.number} (${t.codecId}): ${list.length} packet(s) in first ${(scanned / 1048576) | 0}MB ---`);
    for (const b of list) {
      console.log(`  t=${b.time.toFixed(3)}s dur=${b.duration ?? '-'} ${b.data.length}B`);
      if (/S_TEXT/.test(t.codecId)) {
        console.log(`    ${JSON.stringify(text(b.data).slice(0, 160))}`);
      } else if (t.codecId === 'S_HDMV/PGS') {
        console.log(`    ${hex(b.data)}`);
        const bare = walkSegments(b.data);
        const wrapped = b.data.length > 10 && b.data[0] === 0x50 && b.data[1] === 0x47;
        console.log(`    starts with "PG" magic: ${wrapped}`);
        console.log(`    parses as bare segments: ${bare.ok} [${bare.out.join(' ')}]`);
      } else {
        console.log(`    ${hex(b.data)}`);
      }
    }
  }
  src.close();
}

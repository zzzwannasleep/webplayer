// Structural validation of the fMP4 init segment.
//
// ffprobe is too permissive to be an oracle here: it happily read an init
// segment whose tkhd was two bytes short, which Chrome rejected outright by
// detaching the MediaSource with no error message. So this checks the box tree
// against the spec's fixed sizes AND against a reference produced by ffmpeg.
import { openSync, readSync, statSync, closeSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { MatroskaDemuxer, TRACK_VIDEO, TRACK_AUDIO } from '../src/demux/matroska.js';
import { buildRemuxer } from '../src/remux/tracks.js';

class NodeSource {
  constructor(p) { this.fd = openSync(p, 'r'); this.size = statSync(p).size; }
  async read(o, l) {
    const n = Math.min(l, this.size - o);
    if (n <= 0) return new Uint8Array(0);
    const b = Buffer.allocUnsafe(n); readSync(this.fd, b, 0, n, o);
    return new Uint8Array(b.buffer, b.byteOffset, n);
  }
  close() { closeSync(this.fd); }
}

const TMP = 'C:/Users/65282/AppData/Local/Temp/claude/D--xiaochengxu-webplayer/29280b8b-7e47-4fb7-9b0c-0d3494dc33fb/scratchpad/boxes';
mkdirSync(TMP, { recursive: true });

let failures = 0;
const check = (l, a, e) => { const ok = a === e; if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}: ${a}${ok ? '' : `  (expected ${e})`}`); };

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'mvex', 'moof', 'traf', 'edts']);

/** Walk a box tree; throws if any box's declared size does not tile its parent. */
function parseBoxes(buf, start = 0, end = buf.length, path = '') {
  const out = [];
  let p = start;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (p + 8 <= end) {
    const size = dv.getUint32(p);
    const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
    if (size < 8) throw new Error(`${path}/${type}: declared size ${size} < 8`);
    if (p + size > end) throw new Error(`${path}/${type}: size ${size} overruns parent (${end - p} left)`);
    const node = { type, size, offset: p, path: `${path}/${type}` };
    if (CONTAINERS.has(type)) node.children = parseBoxes(buf, p + 8, p + size, node.path);
    out.push(node);
    p += size;
  }
  if (p !== end) throw new Error(`${path}: ${end - p} trailing bytes do not form a box`);
  return out;
}

const flatten = nodes => nodes.flatMap(n => [n, ...(n.children ? flatten(n.children) : [])]);
const find = (nodes, type) => flatten(nodes).find(n => n.type === type);

// Fixed sizes straight out of ISO/IEC 14496-12 for the version-0 boxes we emit.
const FIXED = { mvhd: 108, tkhd: 92, mdhd: 32, vmhd: 20, smhd: 16, trex: 32, dref: 28, 'url ': 12 };

for (const file of ['houshi.mkv', 'mozahngtantexiaoass.mkv', 'qinyinshaonvpgs.mkv']) {
  console.log(`\n=== ${file} ===`);
  const src = new NodeSource(`D:/xiaochengxu/webplayer/${file}`);
  const dx = await new MatroskaDemuxer(src).parseHeader();

  for (const [label, type] of [['video', TRACK_VIDEO], ['audio', TRACK_AUDIO]]) {
    const track = dx.tracks.find(t => t.type === type);
    if (!track) continue;
    const rx = buildRemuxer(track, dx.duration);
    if (!rx) continue;

    const init = rx.initSegment();
    let tree;
    try {
      tree = parseBoxes(init);
    } catch (e) { failures++; console.log(`  FAIL  ${label} init segment box tree: ${e.message}`); continue; }

    const types = flatten(tree).map(n => n.type);
    console.log(`  ${label} (${rx.mime})`);
    console.log(`       ${init.length}B: ${types.join(' ')}`);

    check(`${label} has ftyp`, types[0], 'ftyp');
    check(`${label} has moov`, types.includes('moov'), true);
    check(`${label} has mvex/trex (fragmented)`, types.includes('trex'), true);
    check(`${label} has exactly one trak`, types.filter(t => t === 'trak').length, 1);
    check(`${label} stsd present`, types.includes('stsd'), true);

    for (const [boxType, size] of Object.entries(FIXED)) {
      const node = find(tree, boxType);
      if (node) check(`${label} ${boxType} size`, node.size, size);
    }

    writeFileSync(`${TMP}/${file.replace('.mkv', '')}-${label}-init.mp4`, Buffer.from(init));
  }

  // --- cross-check against ffmpeg's own fMP4 for the same source -----------
  const ref = `${TMP}/${file.replace('.mkv', '')}-ref.mp4`;
  try {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', `D:/xiaochengxu/webplayer/${file}`,
      '-map', '0:v:0', '-c', 'copy', '-t', '2',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', ref], { encoding: 'utf8' });
    const refTree = parseBoxes(new Uint8Array(readFileSync(ref)));
    const mine = parseBoxes(buildRemuxer(dx.tracks.find(t => t.type === TRACK_VIDEO), dx.duration).initSegment());
    for (const t of ['mvhd', 'tkhd', 'mdhd', 'vmhd', 'trex']) {
      const a = find(mine, t), b = find(refTree, t);
      if (a && b) check(`${t} size matches ffmpeg's reference`, a.size, b.size);
    }
    const refHvcC = find(refTree, 'hvcC'), myHvcC = find(mine, 'hvcC');
    if (refHvcC && myHvcC) check('hvcC size matches ffmpeg', myHvcC.size, refHvcC.size);
  } catch (e) {
    console.log(`  --   ffmpeg reference unavailable: ${String(e.message).slice(0, 120)}`);
  }

  src.close();
}


/** Byte offset of a box by fourcc, or -1. Naive scan is fine for an init segment. */
function findBox(buf, fourcc) {
  const t = [...fourcc].map(c => c.charCodeAt(0));
  for (let i = 0; i + 8 <= buf.length; i++) {
    if (buf[i+4]===t[0] && buf[i+5]===t[1] && buf[i+6]===t[2] && buf[i+7]===t[3]) return i;
  }
  return -1;
}

// --- dOps: Matroska OpusHead is little-endian, MP4 dOps is big-endian ------
// Copying the bytes across produces a box ffmpeg reads happily and Chrome
// rejects by silently detaching the MediaSource. Assert the values, not the
// presence of the box.
{
  const { buildRemuxer } = await import('../src/remux/tracks.js');
  const src = new NodeSource('D:/xiaochengxu/webplayer/samples/video-avc.mkv');
  const dx = await new MatroskaDemuxer(src).parseHeader();
  const t = dx.tracks.find(x => x.codecId === 'A_OPUS');
  if (t) {
    const init = buildRemuxer(t, dx.duration).initSegment();
    const at = findBox(init, 'dOps');
    const ok = at >= 0;
    if (!ok) { failures++; console.log('  FAIL  dOps box present: false'); }
    else {
      const b = init.subarray(at + 8);
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const cp = new DataView(t.codecPrivate.buffer, t.codecPrivate.byteOffset, t.codecPrivate.byteLength);
      check('dOps Version is 0 (OpusHead is 1)', b[0], 0);
      check('dOps OutputChannelCount', b[1], t.codecPrivate[9]);
      check('dOps PreSkip is byte-swapped', dv.getUint16(2, false), cp.getUint16(10, true));
      check('dOps InputSampleRate is byte-swapped', dv.getUint32(4, false), cp.getUint32(12, true));
      check('dOps InputSampleRate is sane', dv.getUint32(4, false) === 48000, true);
    }
  }
  src.close();
}

console.log(`\n${failures === 0 ? 'ALL BOX CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

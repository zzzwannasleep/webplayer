// Self-check for the Matroska demuxer against the real test files.
// Asserts against ground truth taken from ffprobe, so a regression fails loudly.
import { openSync, readSync, statSync, closeSync } from 'node:fs';
import { MatroskaDemuxer, TRACK_VIDEO, TRACK_AUDIO, TRACK_SUBTITLE } from '../src/demux/matroska.js';
import { colourFromTrack, hevcCodecString, parseHvcC, isHdr, TRANSFER_NAMES, PRIMARY_NAMES, scanDolbyVisionNals } from '../src/demux/hevc.js';

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

const TYPE = { [TRACK_VIDEO]: 'video', [TRACK_AUDIO]: 'audio', [TRACK_SUBTITLE]: 'sub' };

/** True if the buffer is an exact sequence of PGS segments (type, u16 len, body). */
function walksAsPgs(data) {
  const TYPES = new Set([0x14, 0x15, 0x16, 0x17, 0x80]);
  let p = 0;
  while (p + 3 <= data.length) {
    if (!TYPES.has(data[p])) return false;
    p += 3 + ((data[p + 1] << 8) | data[p + 2]);
    if (p > data.length) return false;
  }
  return p === data.length;
}

/** First block of one track. Subtitles are sparse, so this may scan a while. */
async function firstBlockOf(dx, trackNumber, budget = 64 << 20) {
  let pos = dx.seekPosition(0, trackNumber), scanned = 0;
  while (scanned < budget) {
    const state = {};
    for await (const b of dx.readBlocks(pos, 8 << 20, state)) {
      if (b.track === trackNumber) return b;
    }
    if (state.atEnd || state.parseError || state.nextPos <= pos) return null;
    scanned += state.nextPos - pos;
    pos = state.nextPos;
  }
  return null;
}
let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
};

// Ground truth from: ffprobe -show_streams
const EXPECT = {
  'houshi.mkv': {
    duration: 6628.796, video: 1, audio: 1, sub: 4, attachments: 0,
    vcodec: 'V_MPEGH/ISO/HEVC', w: 3840, h: 2160,
    acodec: 'A_EAC3', subCodec: 'S_HDMV/PGS',
    // This file carries NO container Colour element -- PQ/BT.2020 is signalled
    // only in the SPS VUI, which is exactly why colourFromTrack() exists.
    containerColour: null,
    transfer: 16 /* SMPTE 2084 PQ */, primaries: 9 /* BT.2020 */, matrix: 9,
    colourSource: 'sps-vui', hdr: true, bitDepth: 10,
    level: 153, dvRpu: true,   // level/profile cross-checked against ffprobe
  },
  'mozahngtantexiaoass.mkv': {
    duration: 1426.098, video: 1, audio: 1, sub: 2, attachments: 28,
    vcodec: 'V_MPEGH/ISO/HEVC', w: 1920, h: 1080,
    acodec: 'A_AAC', subCodec: 'S_TEXT/ASS',
    transfer: 1 /* BT.709 */, primaries: 1, matrix: 1,
    colourSource: 'sps-vui', hdr: false, bitDepth: 10, level: 120, dvRpu: false,
  },
  'qinyinshaonvpgs.mkv': {
    duration: 1451.66, video: 1, audio: 1, sub: 3, attachments: 0,
    vcodec: 'V_MPEGH/ISO/HEVC', w: 1920, h: 1080,
    acodec: 'A_FLAC', subCodec: 'S_HDMV/PGS',
    subCompression: '0',   // zlib -- these tracks are stored compressed
    // ffprobe reports color_space=unknown: this SPS has a VUI but no colour
    // description, so 2 ("unspecified") is the correct answer, not a parse failure.
    transfer: 2, primaries: 2, matrix: 2,
    colourSource: 'sps-nocolour', hdr: false, bitDepth: 10, level: 150, dvRpu: false,
  },
};

for (const [file, exp] of Object.entries(EXPECT)) {
  console.log(`\n=== ${file} ===`);
  const src = new NodeSource(`D:/xiaochengxu/webplayer/${file}`);
  const t0 = Date.now();
  const dx = await new MatroskaDemuxer(src).parseHeader();
  const parseMs = Date.now() - t0;

  const by = t => dx.tracks.filter(x => x.type === t);
  const v = by(TRACK_VIDEO)[0], a = by(TRACK_AUDIO)[0], s = by(TRACK_SUBTITLE)[0];

  check('duration(s)', Math.round(dx.duration * 1000) / 1000, exp.duration);
  check('video tracks', by(TRACK_VIDEO).length, exp.video);
  check('audio tracks', by(TRACK_AUDIO).length, exp.audio);
  check('subtitle tracks', by(TRACK_SUBTITLE).length, exp.sub);
  check('attachments', dx.attachments.length, exp.attachments);
  check('video codec', v?.codecId, exp.vcodec);
  check('video size', `${v?.video?.width}x${v?.video?.height}`, `${exp.w}x${exp.h}`);
  check('audio codec', a?.codecId, exp.acodec);
  check('subtitle codec', s?.codecId, exp.subCodec);
  check('CodecPrivate present', v?.codecPrivate?.length > 0, true);

  // Track compression. Ignoring ContentEncodings does not fail loudly: the
  // blocks come out as valid-looking bytes of the wrong shape, which is how
  // the zlib-compressed PGS tracks went unnoticed. Assert the encodings are
  // seen AND that the decoded bytes are the real thing.
  if ('subCompression' in exp) {
    const algos = (s?.encodings ?? []).map(e => e.algo);
    check('subtitle track compression', algos.join(',') || 'none', exp.subCompression);
  }
  if (s) {
    const first = await firstBlockOf(dx, s.number);
    if (!first) { check(`decoded a ${s.codecId} packet`, false, true); }
    else if (s.codecId === 'S_HDMV/PGS') {
      // A PGS payload is a run of segments: u8 type, u16 big-endian length,
      // body. If decompression were skipped this walk fails on the first byte.
      check('PGS payload walks as whole segments', walksAsPgs(first.data), true);
      check('PGS first segment is PCS (0x16)', first.data[0], 0x16);
    } else if (/S_TEXT/.test(s.codecId)) {
      // MKV stores ASS lines without Start/End: "ReadOrder,Layer,Style,...".
      check('ASS packet starts with a ReadOrder field', /^\d+,\d+,/.test(new TextDecoder().decode(first.data)), true);
    }
  }

  if ('containerColour' in exp) check('container Colour element', v?.video?.colour, exp.containerColour);
  const col = colourFromTrack(v);
  if (exp.transfer !== undefined) {
    check('colour.transfer', col?.transfer, exp.transfer);
    check('colour.primaries', col?.primaries, exp.primaries);
    check('colour.matrix', col?.matrix, exp.matrix);
  }
  if (exp.colourSource) check('colour source', col?.source, exp.colourSource);
  if (exp.bitDepth) check('bit depth (from SPS)', col?.bitDepth, exp.bitDepth);
  if ('hdr' in exp) check('isHdr', isHdr(col), exp.hdr);
  console.log(`        colour: ${PRIMARY_NAMES[col?.primaries] ?? col?.primaries} / ${TRANSFER_NAMES[col?.transfer] ?? col?.transfer} / ${col?.bitDepth}bit  [${col?.source}]`);

  const codecStr = hevcCodecString(v.codecPrivate);
  console.log(`        codec string: ${codecStr}`);
  if (exp.level) {
    check('level matches ffprobe', Number(/\.[LH](\d+)/.exec(codecStr)?.[1]), exp.level);
    check('profile_idc 2 (Main10) in codec string', /^hvc1\.2\./.test(codecStr), true);
  }

  // hvcC sanity: CodecPrivate for V_MPEGH/ISO/HEVC is a raw hvcC record.
  const cp = v.codecPrivate;
  check('hvcC configurationVersion', cp[0], 1);
  const generalProfileIdc = cp[1] & 0x1f;
  check('hvcC general_profile_idc (2=Main10)', generalProfileIdc, 2);
  const lengthSizeMinusOne = cp[21] & 0x03;
  console.log(`        NAL length prefix = ${lengthSizeMinusOne + 1} bytes, hvcC ${cp.length} bytes`);

  console.log(`  tracks:`);
  for (const t of dx.tracks) {
    const extra = t.video ? `${t.video.width}x${t.video.height}`
                : t.audio ? `${t.audio.sampleRate}Hz ${t.audio.channels}ch`
                : '';
    console.log(`    #${t.number} ${TYPE[t.type] ?? t.type}\t${t.codecId}\t${t.language}\t${JSON.stringify(t.name)}\t${extra}`);
  }
  if (dx.attachments.length) {
    const fonts = dx.attachments.filter(f => /font|sfnt|ttf|otf/i.test(f.mime) || /\.(ttf|otf|ttc)$/i.test(f.name));
    console.log(`  attachments: ${dx.attachments.length} (${fonts.length} fonts), total ${(dx.attachments.reduce((n, f) => n + f.data.length, 0) / 1048576).toFixed(1)} MB`);
    console.log(`    e.g. ${fonts.slice(0, 3).map(f => f.name).join(', ')}`);
  }
  console.log(`  cues: ${dx.cues.length} entries, header parsed in ${parseMs}ms`);

  // --- block reading: pull real packets and validate them -------------------
  const vTrack = v.number;
  const counts = {}; let firstKey = null, lastTime = -1, monotonic = true, bytes = 0;
  const startPos = dx.seekPosition(0, vTrack);
  for await (const b of dx.readBlocks(startPos, 6 << 20)) {
    counts[b.track] = (counts[b.track] ?? 0) + 1;
    bytes += b.data.length;
    if (b.track === vTrack) {
      if (b.keyframe && firstKey === null) firstKey = b.time;
      if (b.time < lastTime - 0.5) monotonic = false;
      lastTime = b.time;
    }
  }
  console.log(`  blocks read: ${JSON.stringify(counts)} (${(bytes / 1048576).toFixed(1)} MB)`);
  check('got video blocks', (counts[vTrack] ?? 0) > 0, true);
  check('first video block is a keyframe at t=0', firstKey !== null && firstKey < 1, true);
  check('video timestamps roughly monotonic', monotonic, true);

  // First video NAL must be length-prefixed (MKV stores HEVC exactly as MP4 does).
  for await (const b of dx.readBlocks(startPos, 1 << 20)) {
    if (b.track !== vTrack) continue;
    const dv = new DataView(b.data.buffer, b.data.byteOffset);
    const nalLen = dv.getUint32(0);
    check('first NAL length prefix is sane', nalLen > 0 && nalLen <= b.data.length - 4, true);
    const nalType = (b.data[4] >> 1) & 0x3f;
    console.log(`        first NAL type = ${nalType} (32=VPS 33=SPS 34=PPS 19/20=IDR 39=prefix-SEI)`);
    break;
  }

  // Dolby Vision rides in unspecified NAL 62 (RPU) / 63 (EL) inside the AU.
  {
    const lenSize = (parseHvcC(v.codecPrivate)?.lengthSizeMinusOne ?? 3) + 1;
    let rpu = false, el = false, scanned = 0;
    for await (const b of dx.readBlocks(startPos, 3 << 20)) {
      if (b.track !== vTrack) continue;
      const r = scanDolbyVisionNals(b.data, lenSize);
      rpu ||= r.rpu; el ||= r.el;
      if (++scanned > 40) break;
    }
    if ('dvRpu' in exp) check('Dolby Vision RPU NAL (type 62) present', rpu, exp.dvRpu);
    if (rpu) console.log(`        DV: RPU=yes EL=${el ? 'yes (profile 7, dual layer)' : 'no (single layer -> profile 8.x)'}`);
  }

  // --- regression: chained reads must resume from state.nextPos ------------
  // Advancing by maxBytes instead lands mid-cluster, yields nothing, and used
  // to be misread as end-of-stream (which killed playback after one fragment).
  {
    let pos = startPos, passes = 0, maxReorder = 0;
    const times = [];
    while (passes < 4) {
      const state = {};
      let inPass = 0;
      for await (const b of dx.readBlocks(pos, 1 << 20, state)) {
        if (b.track !== vTrack) continue;
        times.push(b.time); inPass++;
      }
      check(`chained read pass ${passes + 1} produced blocks`, inPass > 0, true);
      check(`pass ${passes + 1} advanced nextPos`, state.nextPos > pos, true);
      pos = state.nextPos;
      passes++;
    }
    // PTS is NOT monotonic in decode order when the stream has B-frames. What
    // must hold is that reordering is bounded (a real GOP, not a desync) and
    // that the sorted timeline has no duplicates or gaps.
    let running = -Infinity;
    for (let i = 0; i < times.length; i++) {
      if (times[i] < running) {
        let back = 0;
        for (let j = i - 1; j >= 0 && times[j] > times[i]; j--) back++;
        maxReorder = Math.max(maxReorder, back);
      } else running = times[i];
    }
    const sorted = [...times].sort((a, b) => a - b);
    let dupes = 0;
    for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) dupes++;
    check('B-frame reorder depth is bounded (<16)', maxReorder < 16, true);
    check('no duplicate timestamps on the sorted decode timeline', dupes, 0);
    console.log(`        4 chained passes -> ${times.length} video blocks, ended at byte ${pos}, max reorder depth ${maxReorder}`);
  }

  // --- seek: jump to 60% and confirm we land on a keyframe near that time ---
  if (dx.cues.length > 1) {
    const target = dx.duration * 0.6;
    const pos = dx.seekPosition(target, vTrack);
    let landed = null;
    for await (const b of dx.readBlocks(pos, 4 << 20)) {
      if (b.track === vTrack && b.keyframe) { landed = b.time; break; }
    }
    check(`seek to ${target.toFixed(1)}s lands on keyframe within 15s`,
          landed !== null && Math.abs(landed - target) < 15, true);
    console.log(`        landed at ${landed?.toFixed(3)}s (byte ${pos})`);
  }

  src.close();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

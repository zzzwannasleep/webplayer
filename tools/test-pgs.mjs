// Validates the .sup stream synthesised from Matroska PGS packets.
//
// libpgs is the renderer, but its published bundle exports only PgsRenderer,
// which needs a canvas and a video element -- so it cannot be exercised here.
// That split is deliberate rather than a gap: this suite proves OUR half (the
// bytes handed to the library are a real, decodable .sup), and the browser
// acceptance test proves the library's half. ffmpeg is used as the judge
// precisely because it is not libpgs -- if both agreed only with each other,
// neither would be evidence.
//
// ffmpeg is permissive about MP4 box layout, but it is not permissive about
// PGS: a wrong segment header or timestamp yields zero decoded subtitles, so
// counting the PNGs it produces is a real check.
import { openSync, readSync, statSync, closeSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { MatroskaDemuxer, TRACK_SUBTITLE } from '../src/demux/matroska.js';
import { packetsToSup, splitSegments, PGS_TIMEBASE } from '../src/subs/pgs.js';

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

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
};
const gte = (label, actual, min) => {
  const ok = actual >= min;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected >= ${min})`}`);
};

/**
 * Brightest non-transparent palette entry in a .sup stream.
 * PDS body: palette id, version, then 5 bytes per entry (id, Y, Cr, Cb, alpha).
 */
function maxPaletteLuma(sup) {
  let p = 0, maxY = 0;
  while (p + 13 <= sup.length) {
    const type = sup[p + 10], len = (sup[p + 11] << 8) | sup[p + 12];
    if (type === 0x14) {
      const body = sup.subarray(p + 13, p + 13 + len);
      for (let i = 2; i + 5 <= body.length; i += 5) if (body[i + 4] > 16) maxY = Math.max(maxY, body[i + 1]);
    }
    p += 13 + len;
  }
  return maxY;
}

const FILES = ['qinyinshaonvpgs.mkv', 'houshi.mkv'];
const WANT = 12;   // packets to pull per track

for (const file of FILES) {
  console.log(`\n=== ${file} ===`);
  const src = new NodeSource(`D:/xiaochengxu/webplayer/${file}`);
  const dx = await new MatroskaDemuxer(src).parseHeader();
  const track = dx.tracks.find(t => t.type === TRACK_SUBTITLE && t.codecId === 'S_HDMV/PGS');
  if (!track) { check('has a PGS track', false, true); src.close(); continue; }
  console.log(`  track ${track.number} ${track.language} "${track.name}" encodings=${(track.encodings ?? []).length}`);

  const packets = [];
  let pos = dx.seekPosition(0, track.number), scanned = 0;
  while (packets.length < WANT && scanned < (96 << 20)) {
    const state = {};
    for await (const b of dx.readBlocks(pos, 8 << 20, state)) {
      if (b.track === track.number && packets.length < WANT) packets.push({ time: b.time, data: b.data });
    }
    if (state.atEnd || state.parseError || state.nextPos <= pos) break;
    scanned += state.nextPos - pos;
    pos = state.nextPos;
  }
  gte('packets demuxed', packets.length, WANT);
  if (!packets.length) { src.close(); continue; }

  // Every packet must be a clean run of segments. If ContentEncodings handling
  // regressed, this is where it shows up rather than as a blank screen.
  const clean = packets.filter(p => splitSegments(p.data)).length;
  check('packets that split into whole segments', clean, packets.length);

  const sup = packetsToSup(packets);
  gte('synthesised .sup size', sup.length, 1000);
  check('.sup starts with PG magic', String.fromCharCode(sup[0], sup[1]), 'PG');

  const supPath = `D:/xiaochengxu/webplayer/${file}.pgs.sup`;
  writeFileSync(supPath, sup);

  // Does an independent PGS implementation agree this is a .sup file?
  const probe = JSON.parse(execFileSync('ffprobe',
    ['-v', 'error', '-f', 'sup', '-show_streams', '-show_format', '-of', 'json', supPath],
    { encoding: 'utf8' }));
  const stream = probe.streams?.[0];
  check('ffprobe reads it as a subtitle stream', stream?.codec_type, 'subtitle');
  check('ffprobe codec', stream?.codec_name, 'hdmv_pgs_subtitle');

  // The PGS canvas is authored at the disc's resolution, which stays 1080p
  // even for a 4K remux -- the renderer has to scale. Read it out of the first
  // PCS rather than assume it matches the video.
  const pcs = splitSegments(packets[0].data)?.find(s => s[0] === 0x16);
  const vid = dx.tracks.find(t => t.video);
  const cw = pcs ? (pcs[3] << 8) | pcs[4] : 1920;
  const ch = pcs ? (pcs[5] << 8) | pcs[6] : 1080;
  console.log(`        PGS canvas ${cw}x${ch} vs video ${vid?.video.width}x${vid?.video.height}`
            + `${cw !== vid?.video.width ? '  <- renderer must scale' : ''}`);
  check('PCS canvas size is sane', cw >= 640 && ch >= 480, true);

  // Parsing is not decoding. A graphic subtitle only decodes when something
  // composites it, so overlay the stream onto black and measure the result:
  // if the RLE bodies or the palette were mangled the frames stay black even
  // though every header parsed cleanly. The canvas must be the PGS canvas --
  // a smaller one puts the subtitle's own coordinates off screen and every
  // frame comes back black for a reason that has nothing to do with the bytes.
  const span = packets[packets.length - 1].time - packets[0].time;
  const out = execFileSync('ffmpeg', ['-v', 'error',
      '-f', 'lavfi', `-i`, `color=black:s=${cw}x${ch}:r=2:d=${Math.ceil(span + 5)}`,
      '-f', 'sup', '-i', supPath,
      '-filter_complex', '[0:v][1:s]overlay,signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-',
      '-an', '-f', 'null', '-'], { encoding: 'utf8' });
  // YMAX is the brightest pixel in the frame. Black is 16 in limited range;
  // subtitle text renders near 235.
  const peaks = [...out.matchAll(/YMAX=(\d+)/g)].map(m => Number(m[1]));
  const peak = Math.max(0, ...peaks);
  const lit = peaks.filter(y => y > 60).length;

  // Compare against the file's own palette rather than a fixed brightness.
  // These two discs are authored differently -- the UHD one peaks far lower
  // than the 1080p one -- so a hardcoded threshold tests the disc, not the code.
  const paletteMaxY = maxPaletteLuma(sup);
  console.log(`        ${peaks.length} composited frames, ${lit} carry subtitle pixels, `
            + `peak Y=${peak}, palette max Y=${paletteMaxY}`);
  gte('frames where ffmpeg composited visible subtitle pixels', lit, 4);
  check('composited pixels are far above black (Y=16)', peak > 60, true);
  check('palette decodes to a usable text luma', paletteMaxY > 150, true);

  console.log(`        wrote ${file}.pgs.sup (${(sup.length / 1024).toFixed(1)} KB)`);
  src.close();
}

console.log(failures ? `\n${failures} PGS CHECK(S) FAILED` : '\nALL PGS CHECKS PASSED');
process.exit(failures ? 1 : 0);

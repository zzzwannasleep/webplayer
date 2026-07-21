// Every codec path the remuxer claims to support, against generated samples.
//
// This suite exists because the README claimed AVC, AV1 and VP9 support that
// no test had ever exercised -- all three real test files are HEVC. A claim
// with nothing behind it is worse than a missing feature, because nobody goes
// looking for the bug.
//
// It found one immediately: VP9 was reporting a hardcoded vp09.02.10.10 for
// every stream, so 8-bit Profile 0 content was declared as 10-bit Profile 2.
//
// Run `node tools/make-samples.mjs` first.
import { openSync, readSync, statSync, closeSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { MatroskaDemuxer, TRACK_VIDEO, TRACK_AUDIO } from '../src/demux/matroska.js';
import { buildRemuxer, audioNote } from '../src/remux/tracks.js';
import { parseVp9Keyframe } from '../src/demux/vp9.js';

class NodeSource {
  constructor(p) { this.fd = openSync(p, 'r'); this.size = statSync(p).size; this.name = p; }
  async read(o, l) {
    const n = Math.min(l, this.size - o);
    if (n <= 0) return new Uint8Array(0);
    const b = Buffer.allocUnsafe(n); readSync(this.fd, b, 0, n, o);
    return new Uint8Array(b.buffer, b.byteOffset, n);
  }
  close() { closeSync(this.fd); }
}

const SAMPLES = 'D:/xiaochengxu/webplayer/samples';
const OUT = 'C:/Users/65282/AppData/Local/Temp/claude/D--xiaochengxu-webplayer/29280b8b-7e47-4fb7-9b0c-0d3494dc33fb/scratchpad/codecs';
mkdirSync(OUT, { recursive: true });

if (!existsSync(`${SAMPLES}/video-avc.mkv`)) {
  console.error('samples/ missing — run `node tools/make-samples.mjs` first');
  process.exit(1);
}

let failures = 0;
const check = (l, a, e) => {
  const ok = a === e; if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}: ${a}${ok ? '' : `  (expected ${e})`}`);
};

// Ground truth from ffprobe on the generated files. The codec string is the
// thing under test: it is what MSE is asked to accept, and every field in it
// (profile, level, bit depth) has to come from the bitstream rather than a guess.
const VIDEO = [
  { file: 'video-avc.mkv',       codecId: 'V_MPEG4/ISO/AVC', ffcodec: 'h264', codecString: 'avc1.42c01e' },
  { file: 'video-av1.mkv',       codecId: 'V_AV1',           ffcodec: 'av1',  codecString: 'av01.0.01M.08' },
  { file: 'video-vp9.mkv',       codecId: 'V_VP9',           ffcodec: 'vp9',  codecString: 'vp09.00.21.08',
    vp9: { profile: 0, bitDepth: 8 } },
  { file: 'video-vp9-10bit.mkv', codecId: 'V_VP9',           ffcodec: 'vp9',  codecString: 'vp09.02.21.10',
    vp9: { profile: 2, bitDepth: 10 } },
];

console.log('=== video codec paths ===');
for (const exp of VIDEO) {
  console.log(`\n  --- ${exp.file} ---`);
  const src = new NodeSource(`${SAMPLES}/${exp.file}`);
  const dx = await new MatroskaDemuxer(src).parseHeader();
  const track = dx.tracks.find(t => t.type === TRACK_VIDEO);
  check('codec id', track.codecId, exp.codecId);

  // VP9 carries nothing in the container; the player probes a keyframe first.
  if (track.codecId === 'V_VP9') {
    for await (const b of dx.readBlocks(dx.seekPosition(0, track.number), 2 << 20)) {
      if (b.track !== track.number) continue;
      const cfg = parseVp9Keyframe(b.data);
      if (cfg) { track.vp9 = cfg; break; }
    }
    check('VP9 profile from the keyframe header', track.vp9?.profile, exp.vp9.profile);
    check('VP9 bit depth from the keyframe header', track.vp9?.bitDepth, exp.vp9.bitDepth);
    check('VP9 dimensions agree with the container', `${track.vp9?.width}x${track.vp9?.height}`,
          `${track.video.width}x${track.video.height}`);
  }

  const rx = buildRemuxer(track, dx.duration);
  if (!rx) { failures++; console.log('  FAIL  no remuxer built'); src.close(); continue; }
  check('codec string', rx.codecString ?? rx.mime.match(/codecs="([^"]+)"/)?.[1], exp.codecString);

  const parts = [rx.initSegment()];
  let n = 0, t0 = null;
  for await (const b of dx.readBlocks(dx.seekPosition(0, track.number), 24 << 20)) {
    if (b.track !== track.number) continue;
    if (t0 === null) { if (!b.keyframe) continue; t0 = b.time; }
    if (b.time - t0 > 4) break;
    rx.push(b); n++;
  }
  const tail = rx.flush(); if (tail) parts.push(tail);
  let total = 0; for (const p of parts) total += p.length;
  const path = `${OUT}/${exp.file.replace('.mkv', '')}.mp4`;
  writeFileSync(path, Buffer.concat(parts.map(Buffer.from), total));

  // The independent oracle: does another demuxer read back what went in, and
  // does a decoder produce frames from it?
  try {
    const s = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', '0',
      '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'json', path],
      { encoding: 'utf8' })).streams?.[0];
    check('ffprobe codec', s?.codec_name, exp.ffcodec);
    check('ffprobe size', `${s?.width}x${s?.height}`, `${track.video.width}x${track.video.height}`);
    const frames = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', '0',
      '-show_entries', 'stream=nb_read_frames', '-read_intervals', '%+2', '-of', 'csv=p=0', path],
      { encoding: 'utf8' }).trim().replace(/,+$/, '');
    check('decodes frames from the fragment', Number(frames) > 0, true);
    console.log(`        ${n} samples -> ${(total / 1024).toFixed(0)} KB, ${frames} frames decoded`);
  } catch (e) {
    failures++; console.log(`  FAIL  ffprobe rejected it: ${String(e.stderr ?? e).slice(0, 200)}`);
  }
  src.close();
}

console.log('\n=== audio codecs that need a software decoder ===');
{
  const src = new NodeSource(`${SAMPLES}/audio-multi.mkv`);
  const dx = await new MatroskaDemuxer(src).parseHeader();
  const tracks = dx.tracks.filter(t => t.type === TRACK_AUDIO);
  check('four audio tracks', tracks.length, 4);
  check('codec ids', tracks.map(t => t.codecId).join(','), 'A_DTS,A_TRUEHD,A_EAC3,A_AC3');
  for (const t of tracks) {
    const note = audioNote(t, t.audio.channels);
    // Every unplayable codec has to say what it is and what it would take.
    // A generic "unsupported" was the old behaviour and told a user nothing.
    check(`${t.codecId} is named`, note.name.length > 2, true);
    check(`${t.codecId} explains the route`, /decoder/i.test(note.route), true);
    check(`${t.codecId} warns about downmix`, !!note.downmix, true);
  }
  src.close();
}

console.log('\n=== awkward containers ===');
{
  const src = new NodeSource(`${SAMPLES}/no-cues.mkv`);
  const dx = await new MatroskaDemuxer(src).parseHeader();
  console.log(`  no-cues.mkv: ${dx.cues.length} cue point(s), duration ${dx.duration.toFixed(2)}s`);
  check('the file really has no Cues', dx.cues.length, 0);
  // Without an index the only way to find a position is to look at the
  // clusters. The old Cues-only path returned the start of the file for every
  // target, so seeking appeared to work and did nothing.
  const start = dx.firstCluster ?? dx.segmentStart;
  const pos = await dx.seekTo(20, dx.tracks[0].number);
  check('seek lands past the start of the file', pos > start, true);
  check('seek offset is inside the file', Number.isFinite(pos) && pos < src.size, true);

  // The landing cluster's own timestamp is the check that matters: it must be
  // at or before the target (never past it, or the frames asked for are gone)
  // and close to it, or the search found a cluster but not the right one.
  let firstTime = null, got = 0;
  for await (const b of dx.readBlocks(pos, 4 << 20)) {
    if (b.track !== dx.tracks[0].number) continue;
    firstTime ??= b.time;
    got++;
  }
  check('blocks readable from that offset', got > 0, true);
  check('lands at or before the requested time', firstTime !== null && firstTime <= 20.001, true);
  check('lands within 5s of the target', firstTime !== null && firstTime > 15, true);
  console.log(`        seek(20s) -> byte ${pos}, first block t=${firstTime?.toFixed(3)}s, ${got} blocks`);

  // A second seek must reuse what the first discovered rather than re-scan.
  const before = dx.cues.length;
  await dx.seekTo(10, dx.tracks[0].number);
  check('the search built an index as it went', before > 0, true);
  console.log(`        discovered ${dx.cues.length} cluster position(s)`);
  src.close();
}
{
  const src = new NodeSource(`${SAMPLES}/video-multi.mkv`);
  const dx = await new MatroskaDemuxer(src).parseHeader();
  const vids = dx.tracks.filter(t => t.type === TRACK_VIDEO);
  check('two video tracks found', vids.length, 2);
  check('they have different sizes', vids[0].video.width !== vids[1].video.width, true);
  for (const v of vids) check(`track ${v.number} builds a remuxer`, !!buildRemuxer(v, dx.duration), true);
  src.close();
}

console.log(failures ? `\n${failures} CODEC CHECK(S) FAILED` : '\nALL CODEC CHECKS PASSED');
process.exit(failures ? 1 : 0);

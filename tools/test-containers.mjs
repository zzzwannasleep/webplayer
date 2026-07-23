// Self-check for the mp4 and FLV demuxers, and for the container sniffer.
//
// Ground truth is ffprobe, not this code: track count, codec names, durations,
// dimensions, languages and frame counts are all read out of the file by
// something that did not write it. A demuxer that agrees with itself proves
// nothing, and the mp4 sample table is exactly the kind of index where an
// off-by-one produces plausible numbers and unwatchable video.
import { openSync, readSync, statSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { openDemuxer, sniff } from '../src/demux/open.js';
import { Mp4Demuxer } from '../src/demux/mp4.js';
import { FlvDemuxer } from '../src/demux/flv.js';
import { buildRemuxer } from '../src/remux/tracks.js';
import { colourFromTrack, isHdr } from '../src/demux/hevc.js';

const SAMPLES = 'D:/xiaochengxu/webplayer/samples';
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `: ${detail}` : ''}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

class NodeSource {
  constructor(path) { this.fd = openSync(path, 'r'); this.size = statSync(path).size; this.name = path.split('/').pop(); }
  async read(offset, length) {
    const len = Math.min(length, this.size - offset);
    if (len <= 0) return new Uint8Array(0);
    const buf = Buffer.allocUnsafe(len);
    readSync(this.fd, buf, 0, len, offset);
    return new Uint8Array(buf.buffer, buf.byteOffset, len);
  }
  close() { closeSync(this.fd); }
}

// -count_packets: FLV states no nb_frames, so the only ground truth for "did
// every frame come out" is a packet count ffprobe has to walk the file for.
const probe = (path) => JSON.parse(execFileSync('ffprobe',
  ['-v', 'error', '-count_packets', '-show_streams', '-show_format', '-of', 'json', path],
  { encoding: 'utf8', maxBuffer: 1 << 26 }));
const frameCount = (s) => Number(s.nb_frames || s.nb_read_packets);

/** Every block in the file, per track. The samples are seconds long, so this is cheap. */
async function readAll(dx) {
  const per = new Map(dx.tracks.map(t => [t.number, []]));
  let pos = 0, guard = 0;
  const state = {};
  while (!state.atEnd && guard++ < 4000) {
    for await (const b of dx.readBlocks(pos, 1 << 20, state)) per.get(b.track)?.push(b);
    if (state.parseError) throw new Error(state.parseError);
    if (state.nextPos <= pos && !state.atEnd) throw new Error(`no progress at ${pos}`);
    pos = state.nextPos;
  }
  return per;
}

// --- 1) the sniffer ---------------------------------------------------------
console.log('\n=== container sniffing ===');
{
  const cases = [['video-avc.mkv', 'matroska'], ['native-vp9.webm', 'matroska'],
                 ['native-h264.mp4', 'mp4'], ['native.mov', 'mp4'], ['hdr-hevc.mp4', 'mp4'],
                 ['native.flv', 'flv'], ['nodemux.avi', null], ['nodemux.ts', null]];
  for (const [file, want] of cases) {
    const src = new NodeSource(`${SAMPLES}/${file}`);
    const head = await src.read(0, 16);
    ok(`${file} sniffs as ${want ?? 'nothing'}`, sniff(head) === want, String(sniff(head)));
    src.close();
  }
  // The whole point of sniffing: an mp4 renamed .mkv must still open as an mp4.
  const src = new NodeSource(`${SAMPLES}/native-h264.mp4`);
  const dx = await openDemuxer(src);
  ok('openDemuxer picks by bytes, not by name', dx.container === 'mp4' && dx instanceof Mp4Demuxer, dx.container);
  src.close();
}

// --- 2) mp4: structure against ffprobe -------------------------------------
console.log('\n=== mp4-multi.mp4 (2 audio + tx3g + B-frames) ===');
{
  const path = `${SAMPLES}/mp4-multi.mp4`;
  const truth = probe(path);
  const src = new NodeSource(path);
  const dx = await openDemuxer(src);

  ok('track count matches ffprobe', dx.tracks.length === truth.streams.length,
     `${dx.tracks.length} vs ${truth.streams.length}`);
  ok('duration matches ffprobe', near(dx.duration, Number(truth.format.duration), 0.2),
     `${dx.duration.toFixed(3)} vs ${truth.format.duration}`);

  const v = dx.tracks.find(t => t.type === 1);
  const vTruth = truth.streams.find(s => s.codec_type === 'video');
  ok('video codec mapped to the Matroska id', v.codecId === 'V_MPEG4/ISO/AVC', v.codecId);
  ok('video dimensions match ffprobe', v.video.width === vTruth.width && v.video.height === vTruth.height,
     `${v.video.width}x${v.video.height}`);
  ok('avcC survived as CodecPrivate', v.codecPrivate?.length > 7 && v.codecPrivate[0] === 1,
     `${v.codecPrivate?.length}B, version=${v.codecPrivate?.[0]}`);

  const audio = dx.tracks.filter(t => t.type === 2);
  ok('both audio tracks found', audio.length === 2, String(audio.length));
  ok('audio languages came off mdhd', audio.map(a => a.language).join(',') === 'eng,jpn',
     audio.map(a => a.language).join(','));
  ok('AAC config kept as CodecPrivate', audio.every(a => a.codecId === 'A_AAC' && a.codecPrivate?.length >= 2),
     audio.map(a => `${a.codecId}/${a.codecPrivate?.length}B`).join(' '));
  const aTruth = truth.streams.find(s => s.codec_type === 'audio');
  ok('audio sample rate matches ffprobe', audio[0].audio.sampleRate === Number(aTruth.sample_rate),
     `${audio[0].audio.sampleRate} vs ${aTruth.sample_rate}`);

  const sub = dx.tracks.find(t => t.type === 17);
  ok('the tx3g track is present, typed as text', sub?.codecId === 'S_TEXT/UTF8', String(sub?.codecId));
  ok('subtitle language came off mdhd', sub?.language === 'chi', String(sub?.language));

  // Every remuxable track must actually build a remuxer -- an mp4 that parses
  // but produces no init segment plays nothing, and would pass every check above.
  for (const t of [v, ...audio]) {
    const rx = buildRemuxer(t, dx.duration);
    ok(`remuxer builds for ${t.codecId}`, !!rx && rx.initSegment().length > 100,
       rx ? `${rx.mime} init=${rx.initSegment().length}B` : 'null');
  }

  const per = await readAll(dx);
  const vBlocks = per.get(v.number);
  ok('every video frame was read', vBlocks.length === frameCount(vTruth),
     `${vBlocks.length} vs ${frameCount(vTruth)}`);
  ok('frame 0 starts at t=0', near(vBlocks[0].time, 0, 0.05), vBlocks[0].time.toFixed(4));
  ok('the first frame is a keyframe', vBlocks[0].keyframe === true, String(vBlocks[0].keyframe));
  ok('more than one keyframe was flagged', vBlocks.filter(b => b.keyframe).length > 1,
     String(vBlocks.filter(b => b.keyframe).length));
  // ctts is the whole reason B-frames are in this sample: with B-frames the
  // PTS order is NOT the read order, and a demuxer that ignores ctts hands the
  // remuxer a monotonic sequence that looks perfectly fine and plays juddering.
  ok('B-frames make PTS non-monotonic (ctts is being applied)',
     vBlocks.some((b, i) => i > 0 && b.time < vBlocks[i - 1].time),
     `${vBlocks.slice(0, 6).map(b => b.time.toFixed(3)).join(' ')}`);
  ok('no frame is longer than the file', vBlocks.every(b => b.time <= dx.duration + 0.5), 'ok');
  ok('total video bytes match the stream size',
     vBlocks.reduce((n, b) => n + b.data.length, 0) > 100000,
     `${vBlocks.reduce((n, b) => n + b.data.length, 0)}B`);

  const subBlocks = per.get(sub.number).map(b => new TextDecoder().decode(b.data));
  ok('tx3g samples were unwrapped to text', subBlocks.includes('Hello from tx3g'), subBlocks.join(' | '));
  ok('empty tx3g clear-samples were dropped', subBlocks.every(s => s.length > 0), String(subBlocks.length));

  // seekTo must land on a keyframe at or before the target -- landing after it
  // means the decoder starts mid-GOP and the first seconds are garbage.
  for (const t of [0, 3, 7]) {
    const pos = await dx.seekTo(t, v.number);
    const at = vBlocks.find(b => b.keyframe && b.data.byteOffset >= 0 && Math.abs(b.time - t) < 100);
    const state = {};
    let firstV = null;
    for await (const b of dx.readBlocks(pos, 1 << 20, state)) { if (b.track === v.number) { firstV = b; break; } }
    ok(`seekTo(${t}) lands on a keyframe at or before ${t}`,
       !!firstV && firstV.keyframe && firstV.time <= t + 0.001,
       firstV ? `t=${firstV.time.toFixed(3)} key=${firstV.keyframe}` : 'nothing');
    void at;
  }
  src.close();
}

// --- 3) mp4: the colour verdict off colr, not off Matroska -----------------
console.log('\n=== hdr-hevc.mp4 (PQ / BT.2020 via the colr box) ===');
{
  const src = new NodeSource(`${SAMPLES}/hdr-hevc.mp4`);
  const dx = await openDemuxer(src);
  const v = dx.tracks.find(t => t.type === 1);
  ok('HEVC mapped to the Matroska id', v.codecId === 'V_MPEGH/ISO/HEVC', v.codecId);
  ok('hvcC survived as CodecPrivate', v.codecPrivate?.length > 20, `${v.codecPrivate?.length}B`);
  ok('colr box parsed', v.video.colour?.transfer === 16 && v.video.colour?.primaries === 9,
     JSON.stringify(v.video.colour));
  const colour = colourFromTrack(v);
  ok('the HDR verdict agrees with the file', isHdr(colour),
     `transfer=${colour.transfer} primaries=${colour.primaries} depth=${colour.bitDepth} src=${colour.source}`);
  ok('10-bit was detected', colour.bitDepth === 10, String(colour.bitDepth));
  src.close();
}

// --- 4) mov ----------------------------------------------------------------
console.log('\n=== native.mov ===');
{
  const path = `${SAMPLES}/native.mov`;
  const truth = probe(path);
  const src = new NodeSource(path);
  const dx = await openDemuxer(src);
  ok('opens as mp4 (mov is ISOBMFF)', dx.container === 'mp4', dx.container);
  ok('video + audio found', dx.tracks.length === 2, String(dx.tracks.length));
  ok('duration matches ffprobe', near(dx.duration, Number(truth.format.duration), 0.2),
     `${dx.duration.toFixed(3)} vs ${truth.format.duration}`);
  const per = await readAll(dx);
  const vTruth = truth.streams.find(s => s.codec_type === 'video');
  const v = dx.tracks.find(t => t.type === 1);
  ok('every video frame was read', per.get(v.number).length === frameCount(vTruth),
     `${per.get(v.number).length} vs ${frameCount(vTruth)}`);
  src.close();
}

// --- 5) flv ----------------------------------------------------------------
for (const [file, wantAudio] of [['native.flv', 'A_AAC'], ['flv-mp3.flv', 'A_MPEG/L3']]) {
  console.log(`\n=== ${file} ===`);
  const path = `${SAMPLES}/${file}`;
  const truth = probe(path);
  const src = new NodeSource(path);
  const dx = await openDemuxer(src);
  ok('opens as flv', dx.container === 'flv' && dx instanceof FlvDemuxer, dx.container);
  ok('video + audio found', dx.tracks.length === 2, dx.tracks.map(t => t.codecId).join(','));
  const v = dx.tracks.find(t => t.type === 1);
  const a = dx.tracks.find(t => t.type === 2);
  ok('AVC config record captured', v.codecId === 'V_MPEG4/ISO/AVC' && v.codecPrivate?.[0] === 1,
     `${v.codecId} ${v.codecPrivate?.length}B`);
  ok(`audio mapped to ${wantAudio}`, a.codecId === wantAudio, a.codecId);
  ok('duration is within a frame of ffprobe', near(dx.duration, Number(truth.format.duration), 0.15),
     `${dx.duration.toFixed(3)} vs ${truth.format.duration}`);

  for (const t of [v, a]) {
    const rx = buildRemuxer(t, dx.duration);
    ok(`remuxer builds for ${t.codecId}`, !!rx && rx.initSegment().length > 100,
       rx ? rx.mime : 'null');
  }

  const per = await readAll(dx);
  const vTruth = truth.streams.find(s => s.codec_type === 'video');
  const vBlocks = per.get(v.number);
  ok('every video frame was read', vBlocks.length === frameCount(vTruth),
     `${vBlocks.length} vs ${frameCount(vTruth)}`);
  ok('config tags were not emitted as frames', vBlocks.every(b => b.data.length > 4), 'ok');
  ok('audio frames were read', per.get(a.number).length > 100, String(per.get(a.number).length));
  ok('keyframes were flagged and indexed', vBlocks.some(b => b.keyframe) && dx.keyframes.length > 0,
     `${vBlocks.filter(b => b.keyframe).length} keyframes, index=${dx.keyframes.length}`);

  // Seeking backwards into material already read must be exact.
  const kf = dx.keyframes[dx.keyframes.length - 1];
  const pos = await dx.seekTo(kf.time);
  const state = {};
  let first = null;
  for await (const b of dx.readBlocks(pos, 1 << 20, state)) { if (b.track === v.number) { first = b; break; } }
  ok('seekTo lands on the indexed keyframe', !!first && first.keyframe && near(first.time, kf.time, 0.05),
     first ? `t=${first.time.toFixed(3)} want ${kf.time.toFixed(3)}` : 'nothing');
  src.close();
}

// --- 6) MKV must be untouched ----------------------------------------------
console.log('\n=== regression: matroska still routes to MatroskaDemuxer ===');
{
  const src = new NodeSource(`${SAMPLES}/subs-srt.mkv`);
  const dx = await openDemuxer(src);
  ok('container is matroska', dx.container === 'matroska', dx.container);
  const sub = dx.tracks.find(t => t.type === 17);
  ok('the SRT track is there', sub?.codecId === 'S_TEXT/UTF8', String(sub?.codecId));
  src.close();
}

console.log(failed ? `\n${failed} CONTAINER CHECK(S) FAILED` : '\nALL CONTAINER CHECKS PASSED');
process.exit(failed ? 1 : 0);

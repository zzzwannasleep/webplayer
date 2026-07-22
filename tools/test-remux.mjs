// Remuxes a slice of each test MKV into fMP4 and hands it to ffprobe.
// ffprobe is the independent oracle here: if it reads back the same codec,
// resolution and colour that went in, the box layout is correct.
import { openSync, readSync, statSync, closeSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { MatroskaDemuxer, TRACK_VIDEO, TRACK_AUDIO } from '../src/demux/matroska.js';
import { buildRemuxer } from '../src/remux/tracks.js';
import { colourFromTrack, parseHvcC, scanAccessUnit } from '../src/demux/hevc.js';

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

const OUT = 'C:/Users/65282/AppData/Local/Temp/claude/D--xiaochengxu-webplayer/29280b8b-7e47-4fb7-9b0c-0d3494dc33fb/scratchpad/remux';
mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (l, a, e) => {
  const ok = a === e; if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}: ${a}${ok ? '' : `  (expected ${e})`}`);
};

const probe = (file, entries) => {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', '0',
    '-show_entries', entries, '-of', 'json', file], { encoding: 'utf8' });
  return JSON.parse(out);
};

const FILES = {
  'houshi.mkv':              { w: 3840, h: 2160, vcodec: 'hevc', transfer: 'smpte2084', primaries: 'bt2020', space: 'bt2020nc' },
  'mozahngtantexiaoass.mkv': { w: 1920, h: 1080, vcodec: 'hevc', transfer: 'bt709',     primaries: 'bt709',  space: 'bt709'    },
  'qinyinshaonvpgs.mkv':     { w: 1920, h: 1080, vcodec: 'hevc', transfer: undefined,   primaries: undefined, space: undefined },
};

for (const [file, exp] of Object.entries(FILES)) {
  console.log(`\n=== ${file} ===`);
  const src = new NodeSource(`D:/xiaochengxu/webplayer/${file}`);
  const dx = await new MatroskaDemuxer(src).parseHeader();
  const v = dx.tracks.find(t => t.type === TRACK_VIDEO);
  const a = dx.tracks.find(t => t.type === TRACK_AUDIO);

  for (const [label, track] of [['video', v], ['audio', a]]) {
    if (!track) continue;
    const rx = buildRemuxer(track, dx.duration);
    if (!rx) { console.log(`  --   ${label}: no repackaging path for ${track.codecId} (needs software decode)`); continue; }
    console.log(`  ${label}: ${track.codecId} -> ${rx.mime}`);

    // The player recovers static HDR metadata from SEI and hangs it on the
    // track before building the remuxer. Doing the same here is not just to
    // make the test pass: forgetting this step drops mdcv/clli silently, and
    // the assertions below are what would catch that in the player too.
    if (label === 'video' && track.codecId === 'V_MPEGH/ISO/HEVC') {
      const lenSize = (parseHvcC(track.codecPrivate)?.lengthSizeMinusOne ?? 3) + 1;
      let seen = 0;
      for await (const b of dx.readBlocks(dx.seekPosition(0, track.number), 2 << 20)) {
        if (b.track !== track.number) continue;
        const r = scanAccessUnit(b.data, lenSize);
        track.mastering ??= r.mastering;
        track.cll ??= r.cll;
        if (++seen > 30) break;
      }
    }
    const rx2 = buildRemuxer(track, dx.duration);   // rebuild now that SEI is known

    // Collect ~4s of samples starting from the first keyframe.
    const parts = [rx2.initSegment()];
    let n = 0, t0 = null;
    for await (const b of dx.readBlocks(dx.seekPosition(0, track.number), 24 << 20)) {
      if (b.track !== track.number) continue;
      if (t0 === null) { if (label === 'video' && !b.keyframe) continue; t0 = b.time; }
      if (b.time - t0 > 4) break;
      rx2.push(b); n++;
      if (rx2.pendingCount >= 120) parts.push(rx2.flush());
    }
    const tail = rx2.flush(true); if (tail) parts.push(tail);   // force-drain the trailing GOP, as the player does at EOF
    if (!n) { console.log(`  --   ${label}: no samples`); continue; }

    let total = 0; for (const p of parts) total += p.length;
    const buf = Buffer.concat(parts.map(Buffer.from), total);
    const path = `${OUT}/${file.replace('.mkv', '')}-${label}.mp4`;
    writeFileSync(path, buf);
    console.log(`       ${n} samples, ${(total / 1048576).toFixed(2)} MB -> ${path.split('/').pop()}`);

    // --- the actual assertion: can an independent demuxer read it back? ---
    let info;
    try {
      info = probe(path, 'stream=codec_name,width,height,pix_fmt,color_transfer,color_primaries,color_space,channels,sample_rate,nb_read_packets');
    } catch (e) {
      failures++; console.log(`  FAIL  ffprobe rejected the file: ${String(e.stderr ?? e).slice(0, 200)}`); continue;
    }
    const s = info.streams?.[0];
    if (!s) { failures++; console.log('  FAIL  ffprobe found no stream'); continue; }

    if (label === 'video') {
      check('ffprobe codec', s.codec_name, exp.vcodec);
      check('ffprobe size', `${s.width}x${s.height}`, `${exp.w}x${exp.h}`);
      check('ffprobe pix_fmt', s.pix_fmt, 'yuv420p10le');
      // colr box round-trip: what the SPS said should come back out of the MP4
      const col = colourFromTrack(track);
      if (col && col.primaries !== 2) {
        check('colr transfer round-trip', s.color_transfer, exp.transfer);
        check('colr primaries round-trip', s.color_primaries, exp.primaries);
        check('colr matrix round-trip', s.color_space, exp.space);
      } else {
        console.log('       (no colour description in SPS -> colr box intentionally omitted)');
      }

      // mdcv / clli round-trip. ffprobe surfaces these as frame side data, so
      // a pass here means an independent demuxer found the boxes AND parsed
      // the field order -- which is G,B,R, not R,G,B.
      if (track.mastering || track.cll) {
        const sd = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
          '-read_intervals', '%+#1', '-show_frames', '-show_entries', 'frame=side_data_list',
          '-of', 'json', path], { encoding: 'utf8' })).frames?.[0]?.side_data_list ?? [];
        const md = sd.find(d => /Mastering display/i.test(d.side_data_type));
        const cl = sd.find(d => /Content light/i.test(d.side_data_type));
        if (track.mastering) {
          check('mdcv survives into the MP4', !!md, true);
          // 34000 in units of 1/50000 is what the SEI carried for red_x.
          check('mdcv red_x round-trip', md?.red_x, `${track.mastering.red[0]}/50000`);
          check('mdcv green_y round-trip', md?.green_y, `${track.mastering.green[1]}/50000`);
          check('mdcv max luminance round-trip', md?.max_luminance, `${track.mastering.maxLuminance}/10000`);
        }
        if (track.cll) {
          check('clli survives into the MP4', !!cl, true);
          check('clli MaxCLL round-trip', cl?.max_content, track.cll.maxCLL);
          check('clli MaxFALL round-trip', cl?.max_average, track.cll.maxFALL);
        }
      } else if (exp.transfer === 'smpte2084') {
        // An HDR file with no static metadata recovered means the SEI scan
        // silently found nothing -- exactly the failure this guards against.
        failures++;
        console.log('  FAIL  HDR file yielded no mastering/CLL metadata from SEI');
      }
    } else {
      check('ffprobe channels', s.channels, track.audio.channels);
      check('ffprobe sample_rate', Number(s.sample_rate), Math.round(track.audio.outputSampleRate || track.audio.sampleRate));
    }

    // Decode a couple of frames for real: proves the samples, not just the boxes.
    try {
      const cnt = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', '0',
        '-show_entries', 'stream=nb_read_frames', '-read_intervals', '%+2', '-of', 'csv=p=0', path],
        { encoding: 'utf8' }).trim().replace(/,+$/, '');   // csv=p=0 emits a trailing separator
      check('ffmpeg decodes frames from the fragment', Number(cnt) > 0, true);
      console.log(`       decoded ${cnt} frames in first 2s`);
    } catch (e) {
      failures++; console.log(`  FAIL  decode failed: ${String(e.stderr ?? e).slice(0, 300)}`);
    }
  }
  src.close();
}

console.log(`\n${failures === 0 ? 'ALL REMUX CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

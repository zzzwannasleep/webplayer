// Builds the test material the project is missing.
//
// The codecs this player still has to account for -- DTS, TrueHD, AC-3, E-AC3,
// HDR Vivid, dual-layer Dolby Vision -- are not obtainable from any streaming
// service: they are Blu-ray and broadcast formats, and the services transcode
// them away. Buying discs to test a codec-detection path is absurd, and real
// films cannot be committed to the repository anyway.
//
// Synthesised samples are strictly better for what these paths actually do.
// The player does not decode this audio; it identifies it, decides it needs a
// software decoder, and says so. A 20-second generated file exercises that
// completely, is small enough to commit, and is redistributable.
//
// What this cannot synthesise is listed at the bottom, honestly, rather than
// faked into looking covered.
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';

const OUT = 'D:/xiaochengxu/webplayer/samples';
mkdirSync(OUT, { recursive: true });

const run = (args) => execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args],
                                   { encoding: 'utf8' });
const size = p => `${(statSync(p).size / 1048576).toFixed(2)} MB`;

// A 5.1 bed with a different tone per channel, so a downmix or a channel-order
// bug is audible rather than merely "sounds like audio".
const TONES = [220, 277, 330, 55, 440, 554];
const bed = TONES.map((f, i) => `sine=frequency=${f}:duration=20[a${i}]`).join(';')
          + ';' + TONES.map((_, i) => `[a${i}]`).join('') + 'amerge=inputs=6,'
          + 'aformat=channel_layouts=5.1[a]';

const AUDIO = [
  { name: 'dts',    codec: 'dca',    label: 'DTS 5.1',     extra: ['-strict', '-2'] },
  { name: 'truehd', codec: 'truehd', label: 'TrueHD 5.1',  extra: ['-strict', '-2'] },
  { name: 'eac3',   codec: 'eac3',   label: 'E-AC3 5.1',   extra: [] },
  { name: 'ac3',    codec: 'ac3',    label: 'AC-3 5.1',    extra: [] },
];

console.log('=== audio codecs the browser cannot decode ===');
for (const a of AUDIO) {
  const path = `${OUT}/audio-${a.name}.mkv`;
  run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=20',
       '-filter_complex', bed, '-map', '0:v', '-map', '[a]',
       '-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '35', '-tag:v', 'hvc1',
       '-c:a', a.codec, ...a.extra, '-b:a', '768k',
       '-metadata:s:a:0', `title=${a.label}`, path]);
  console.log(`  ${a.label.padEnd(14)} -> ${path.split('/').pop()}  ${size(path)}`);
}

// One file carrying all four at once: the track-selection UI has never been
// tested against a file with more than one audio track.
const multi = `${OUT}/audio-multi.mkv`;
// A filter output can only be consumed once, so the bed is split per track.
const split = bed.replace('[a]', '') + `,asplit=${AUDIO.length}`
            + AUDIO.map((_, i) => `[m${i}]`).join('');
run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=20',
     '-filter_complex', split, '-map', '0:v',
     ...AUDIO.flatMap((_, i) => ['-map', `[m${i}]`]),
     '-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '35', '-tag:v', 'hvc1',
     ...AUDIO.flatMap((a, i) => [`-c:a:${i}`, a.codec, `-b:a:${i}`, '768k',
                                 `-metadata:s:a:${i}`, `title=${a.label}`]),
     '-strict', '-2', multi]);
console.log(`  all four in one file -> ${multi.split('/').pop()}  ${size(multi)}`);

// Video codecs the remuxer claims to handle. Until now every test file was
// HEVC, so the AVC, AV1 and VP9 sample entries had never been built from real
// CodecPrivate, let alone accepted by a browser -- a claim in the README with
// nothing behind it. Each is generated at two bit depths where the format
// allows, because the bit depth is what the codec string has to report.
const VIDEO = [
  { name: 'avc',      args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
                             '-pix_fmt', 'yuv420p', '-profile:v', 'high'] },
  { name: 'av1',      args: ['-c:v', 'libsvtav1', '-preset', '10', '-crf', '50',
                             '-pix_fmt', 'yuv420p'] },
  { name: 'vp9',      args: ['-c:v', 'libvpx-vp9', '-speed', '8', '-crf', '45', '-b:v', '0',
                             '-pix_fmt', 'yuv420p'] },
  { name: 'vp9-10bit', args: ['-c:v', 'libvpx-vp9', '-speed', '8', '-crf', '45', '-b:v', '0',
                              '-pix_fmt', 'yuv420p10le'] },
];

console.log('\n=== video codecs the remuxer claims to support ===');
for (const v of VIDEO) {
  const path = `${OUT}/video-${v.name}.mkv`;
  run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=10',
       '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
       '-map', '0:v', '-map', '1:a', ...v.args, '-c:a', 'libopus', '-b:a', '96k', path]);
  const codec = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,profile,pix_fmt', '-of', 'csv=p=0', path],
    { encoding: 'utf8' }).trim();
  console.log(`  ${v.name.padEnd(10)} -> ${path.split('/').pop().padEnd(22)} ${size(path)}  [${codec}]`);
}

// Two shapes that break assumptions rather than codecs.
console.log('\n=== awkward container shapes ===');

// No Cues. Seeking currently depends entirely on the index; a file without one
// is common (anything still being written, and plenty of remuxes).
// `-live 1` is what actually produces one: the muxer omits Cues entirely and
// writes unknown-size clusters, exactly like a file still being written.
// Suppressing the index with -reserve_index_space does not work -- ffmpeg
// writes Cues anyway, which is how the first attempt at this sample passed
// while testing nothing.
const noCues = `${OUT}/no-cues.mkv`;
run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=30',
     '-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '35', '-tag:v', 'hvc1', '-an',
     '-f', 'matroska', '-live', '1', noCues]);
console.log(`  no Cues index      -> ${noCues.split('/').pop()}  ${size(noCues)}`);

// Not Matroska at all. The engine only speaks MKV, so an mp4 is what proves the
// native <video> fallback: the demuxer must reject it with NOT_MATROSKA and the
// player must hand it to the browser instead of failing. This is the shape a
// .strm on object storage most often points at, and public/strmcheck.html
// cannot run without it.
const nativeMp4 = `${OUT}/native-h264.mp4`;
run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=10',
     '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
     '-map', '0:v', '-map', '1:a',
     '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
     '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', nativeMp4]);
console.log(`  non-Matroska (mp4) -> ${nativeMp4.split('/').pop()}  ${size(nativeMp4)}`);

// A FRAGMENTED mp4. Since Mp4Demuxer indexes moov's sample tables, this one --
// whose tables live in every moof instead -- is refused with FRAGMENTED_MP4 and
// routed to <video>, which plays fMP4 perfectly well (it is what DASH ships).
// That makes it the fixture for the native fallback now that a plain mp4 is
// demuxed here: public/strmcheck.html needs a container that is playable but
// NOT indexable, and after this change an ordinary mp4 no longer qualifies.
const frag = `${OUT}/frag.mp4`;
run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=10',
     '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-map', '0:v', '-map', '1:a',
     '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
     '-c:a', 'aac', '-b:a', '96k',
     '-movflags', '+frag_keyframe+empty_moov+default_base_moof', frag]);
console.log(`  fragmented mp4 (moof)         -> ${frag.split('/').pop()}  ${size(frag)}`);

// The rest of "mainstream containers", which nothing here had ever actually
// opened. Three different verdicts are expected and all three matter:
//   .webm  is Matroska underneath -> must still take the REMUX path
//   .mov   is not -> native leg, same as mp4
//   .avi / .ts  neither leg demuxes -> must fail by NAME, not by "no EBML header"
const CONTAINERS = [
  { file: 'native.mov',     args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
                                   '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k'] },
  { file: 'native-vp9.webm', args: ['-c:v', 'libvpx-vp9', '-speed', '8', '-crf', '45', '-b:v', '0',
                                    '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '96k'] },
  { file: 'nodemux.avi',    args: ['-c:v', 'mpeg4', '-q:v', '8', '-c:a', 'libmp3lame', '-b:a', '96k'] },
  { file: 'nodemux.ts',     args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
                                   '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k'] },
];
for (const c of CONTAINERS) {
  const path = `${OUT}/${c.file}`;
  run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=10',
       '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
       '-map', '0:v', '-map', '1:a', ...c.args, path]);
  console.log(`  ${c.file.padEnd(18)} -> ${size(path)}`);
}

// Material for the mp4 and FLV demuxers. Each of these exercises something the
// Matroska path never could, so a passing Matroska suite says nothing about it.
console.log('\n=== mp4 / flv demuxer material ===');

const srtPath = `${OUT}/sample.srt`;
writeFileSync(srtPath,
  '1\n00:00:01,000 --> 00:00:03,000\nHello from tx3g\n\n'
+ '2\n00:00:04,000 --> 00:00:06,000\n{\\an8}Second line, raised\n\n'
+ '3\n00:00:07,000 --> 00:00:09,000\nThird\n');

// Two audio tracks, a text subtitle track, and B-frames -- so ctts (composition
// offsets) is non-trivial and the track pickers have something to pick.
// -preset ultrafast would silently set bframes=0 and test nothing.
const mp4Multi = `${OUT}/mp4-multi.mp4`;
run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=10',
     '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
     '-f', 'lavfi', '-i', 'sine=frequency=880:duration=10',
     '-i', srtPath,
     '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
     // -g 48: libx264's default keyint is 250, so a 240-frame clip would hold
     // exactly ONE keyframe and every seek assertion would pass by landing at 0.
     '-c:v', 'libx264', '-preset', 'fast', '-crf', '30', '-bf', '3', '-g', '48', '-pix_fmt', 'yuv420p',
     '-c:a', 'aac', '-b:a', '96k', '-c:s', 'mov_text',
     '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn',
     '-metadata:s:s:0', 'language=chi', mp4Multi]);
console.log(`  mp4 2 audio + tx3g + B-frames -> ${mp4Multi.split('/').pop()}  ${size(mp4Multi)}`);

// HEVC/PQ in an mp4. The colour verdict comes off the colr box here, not off a
// Matroska Colour element -- a completely different code path to the same claim.
const hdr = `${OUT}/hdr-hevc.mp4`;
run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6',
     // setparams stamps the colour on the FRAMES. -color_primaries/-color_trc
     // as output options do not reach the mov muxer's colr writer -- it takes
     // the values off the frames -- so those flags produce a file that says
     // "unspecified" in the container while looking correct in ffprobe's
     // encoder line. Verified by dumping the colr bytes, not by reading docs.
     '-vf', 'format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc',
     '-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '35', '-tag:v', 'hvc1',
     '-x265-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
     // ...and without +write_colr there is no colr box at all, only the SPS.
     '-movflags', '+write_colr', '-an', hdr]);
console.log(`  HEVC PQ / BT.2020 in mp4      -> ${hdr.split('/').pop()}  ${size(hdr)}`);

// SRT inside an MKV: demuxed for a long time, never rendered until now.
const subsMkv = `${OUT}/subs-srt.mkv`;
run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=10',
     '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-i', srtPath,
     '-map', '0:v', '-map', '1:a', '-map', '2:s',
     '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
     '-c:a', 'libopus', '-b:a', '96k', '-c:s', 'srt', subsMkv]);
console.log(`  MKV with an SRT track         -> ${subsMkv.split('/').pop()}  ${size(subsMkv)}`);

for (const [file, acodec] of [['native.flv', 'aac'], ['flv-mp3.flv', 'libmp3lame']]) {
  const p = `${OUT}/${file}`;
  run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=10',
       '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
       '-map', '0:v', '-map', '1:a',
       // -g 48 again: one keyframe in the whole clip makes every seek assertion
       // pass by landing at zero.
       '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-g', '48', '-pix_fmt', 'yuv420p',
       '-c:a', acodec, '-b:a', '96k', p]);
  console.log(`  FLV h264 + ${acodec.padEnd(12)}    -> ${file}  ${size(p)}`);
}

// More than one video track. The player picks video[0] and has never seen a
// file where that choice was not the only one.
const multiVideo = `${OUT}/video-multi.mkv`;
run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=10',
     '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=10',
     '-map', '0:v', '-map', '1:v',
     '-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '35', '-tag:v', 'hvc1',
     '-metadata:s:v:0', 'title=main', '-metadata:s:v:1', 'title=thumbnail', multiVideo]);
console.log(`  two video tracks   -> ${multiVideo.split('/').pop()}  ${size(multiVideo)}`);

console.log(`
Not synthesised, because nothing here can produce them honestly:

  Dolby Vision profile 7   Dual-layer needs a real RPU and enhancement layer.
                           NAL 63 can be injected to exercise the detector
                           (tools/inject-sei.mjs), but that is a detector test,
                           not a playable P7 stream.

  HDR Vivid / CUVA         The SEI can be injected the same way, which is what
                           the detection path needs. Genuine CUVA content is
                           graded material -- no encoder here produces it.

Both are covered as parser tests rather than pretended to be real samples.`);

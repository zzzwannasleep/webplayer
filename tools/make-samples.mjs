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
import { mkdirSync, statSync } from 'node:fs';

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

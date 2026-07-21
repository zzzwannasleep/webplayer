// SRT -> WebVTT conversion, checked against the real subtitle file.
//
// The browser is the consumer here, so the only thing worth asserting is that
// the output is something a browser will accept and that nothing was silently
// dropped. ffmpeg is used as an independent WebVTT parser: if it reads back
// the same number of cues with the same timings, the conversion is sound.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { srtToVtt } from '../src/subs/srt.js';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
};

console.log('=== unit ===');

// CRLF, no counter line, a comma decimal separator, and an \an override --
// all of which appear in real files.
const sample = srtToVtt('1\r\n00:00:01,500 --> 00:00:03,250\r\n{\\an8}top line\r\n\r\n'
                      + '00:00:04,000 --> 00:00:05,000\r\nsecond & <i>italic</i>\r\n');
check('starts with the WEBVTT signature', sample.startsWith('WEBVTT'), true);
check('comma becomes a dot', sample.includes('00:00:01.500 --> 00:00:03.250'), true);
check('\\an8 becomes a line setting', /00:00:01\.500 --> 00:00:03\.250 line:5%/.test(sample), true);
check('the override tag itself is gone', sample.includes('{\\an8}'), false);
check('a cue without a counter line still converts', sample.includes('00:00:04.000 --> 00:00:05.000'), true);
check('& is escaped', sample.includes('second &amp; '), true);
check('<i> survives', sample.includes('<i>italic</i>'), true);

// A cue that is only an override tag has nothing left to show; emitting an
// empty cue makes some parsers reject the whole file.
check('an empty cue body is dropped', srtToVtt('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}\n\n'
      + '2\n00:00:03,000 --> 00:00:04,000\nreal\n').split('-->').length - 1, 1);

console.log('\n=== houshisrt.srt ===');
const srt = readFileSync('D:/xiaochengxu/webplayer/houshisrt.srt', 'utf8');
const vtt = srtToVtt(srt);
const vttPath = 'D:/xiaochengxu/webplayer/houshisrt.vtt';
writeFileSync(vttPath, vtt);

// Count the cues in the source by its timing lines, which is independent of
// the converter's own idea of how many it produced.
const srtCues = (srt.match(/\d\d:\d\d:\d\d[,.]\d{1,3}\s*-->/g) ?? []).length;
const vttCues = (vtt.match(/-->/g) ?? []).length;
console.log(`  ${srtCues} timings in the SRT -> ${vttCues} cues in the VTT`);
check('every cue survived the conversion', vttCues, srtCues);
check('no comma-decimal timestamps left', /\d,\d{3}\s*-->/.test(vtt), false);
check('no ASS override tags left', /\{\\/.test(vtt), false);
check('positioned cues were produced', /line:5%/.test(vtt), true);

// Independent parse. ffmpeg rejects malformed WebVTT rather than guessing.
const probe = JSON.parse(execFileSync('ffprobe',
  ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', vttPath], { encoding: 'utf8' }));
check('ffprobe reads it as WebVTT', probe.streams?.[0]?.codec_name, 'webvtt');

const packets = JSON.parse(execFileSync('ffprobe',
  ['-v', 'error', '-show_packets', '-of', 'json', vttPath], { encoding: 'utf8' })).packets ?? [];
check('ffprobe finds every cue', packets.length, srtCues);
if (packets.length) {
  // 00:00:04,420 is the first cue in the file.
  check('first cue starts at the right time', Number(packets[0].pts_time).toFixed(3), '4.420');
}

console.log(failures ? `\n${failures} SRT CHECK(S) FAILED` : '\nALL SRT CHECKS PASSED');
process.exit(failures ? 1 : 0);

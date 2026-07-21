// Checks the assumption the whole E-AC3 plan rests on:
//
//   concatenating consecutive Matroska A_EAC3 blocks yields a valid E-AC3
//   elementary stream that a decoder will accept on its own.
//
// If that holds, decoding needs nothing but a decoder -- no container, no
// framing work, and chunks can be handed over a window at a time instead of
// requiring the whole 6600-second track up front. If it does not hold, the
// entire design changes, so it is worth proving before writing any of it.
//
// AC-3 and E-AC3 frames are self-framing: each starts with the syncword 0x0B77
// and carries its own length, which is why this should work. "Should" is not
// evidence, so ffmpeg decodes the result and the samples are counted.
import { openSync, readSync, statSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { MatroskaDemuxer, TRACK_AUDIO } from '../src/demux/matroska.js';

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

const FILE = 'D:/xiaochengxu/webplayer/houshi.mkv';
console.log(`=== ${FILE} ===`);
const src = new NodeSource(FILE);
const dx = await new MatroskaDemuxer(src).parseHeader();
const track = dx.tracks.find(t => t.type === TRACK_AUDIO);
console.log(`  track ${track.number} ${track.codecId} ${track.audio.channels}ch @ ${track.audio.sampleRate}Hz`
          + `  encodings=${(track.encodings ?? []).length}`);
check('codec is E-AC3', track.codecId, 'A_EAC3');

// One window's worth, the same way the player will collect them.
const WINDOW = 10;   // seconds
const packets = [];
let pos = dx.seekPosition(0, track.number);
let t0 = null;
outer:
for (let i = 0; i < 12; i++) {
  const state = {};
  for await (const b of dx.readBlocks(pos, 4 << 20, state)) {
    if (b.track !== track.number) continue;
    t0 ??= b.time;
    if (b.time - t0 > WINDOW) break outer;
    packets.push(b);
  }
  if (state.atEnd || state.parseError || state.nextPos <= pos) break;
  pos = state.nextPos;
}
gte('packets collected', packets.length, 100);
const span = packets[packets.length - 1].time - packets[0].time;
console.log(`        ${packets.length} packets spanning ${span.toFixed(2)}s from t=${packets[0].time.toFixed(3)}s`);

// Every packet should start with the E-AC3 syncword. If any does not, the
// blocks carry something other than bare frames and concatenation is invalid.
const synced = packets.filter(p => p.data[0] === 0x0b && p.data[1] === 0x77).length;
check('every packet starts with the 0x0B77 syncword', synced, packets.length);

// bsid lives in the last 5 bits of byte 5 for E-AC3 (>10 means E-AC3, <=10 AC-3).
const bsid = packets[0].data[5] >> 3;
console.log(`        bsid=${bsid} (${bsid > 10 ? 'E-AC3' : 'AC-3'})`);

const raw = new Uint8Array(packets.reduce((n, p) => n + p.data.length, 0));
let at = 0;
for (const p of packets) { raw.set(p.data, at); at += p.data.length; }
const rawPath = 'D:/xiaochengxu/webplayer/houshi-audio.eac3';
writeFileSync(rawPath, raw);
console.log(`        wrote ${(raw.length / 1024).toFixed(0)} KB of elementary stream`);

// Does a decoder accept it with no container at all?
const probe = JSON.parse(execFileSync('ffprobe',
  ['-v', 'error', '-show_streams', '-of', 'json', rawPath], { encoding: 'utf8' }));
const st = probe.streams?.[0];
check('ffprobe reads it as eac3', st?.codec_name, 'eac3');
check('channel count', st?.channels, track.audio.channels);
check('sample rate', Number(st?.sample_rate), Math.round(track.audio.sampleRate));

// Decode to PCM and count samples. A stream that "probes" can still fail to
// decode, and silence would pass a size check, so measure the peak too.
const pcmPath = 'D:/xiaochengxu/webplayer/houshi-audio.f32';
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', rawPath,
                        '-f', 'f32le', '-ac', '2', '-ar', '48000', pcmPath]);
const pcm = new Float32Array(new Uint8Array(readFileSync(pcmPath)).buffer);
const seconds = pcm.length / 2 / 48000;
gte('seconds of stereo PCM decoded', Number(seconds.toFixed(2)), span * 0.9);
console.log(`        decoded ${seconds.toFixed(2)}s vs ${span.toFixed(2)}s of packets`);

let peak = 0, energy = 0;
for (let i = 0; i < pcm.length; i++) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; energy += v; }
console.log(`        peak amplitude ${peak.toFixed(4)}, mean |x| ${(energy / pcm.length).toFixed(5)}`);
check('decoded audio is not silence', peak > 0.01, true);

src.close();
console.log(failures ? `\n${failures} E-AC3 CHECK(S) FAILED` : '\nALL E-AC3 CHECKS PASSED');
process.exit(failures ? 1 : 0);

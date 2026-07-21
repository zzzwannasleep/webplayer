// Maps Matroska codec IDs onto MP4 sample entries + MSE codec strings.
// Anything not listed here has no repackaging path and must fall back to a
// software decoder (or be dropped).
import { TrackRemuxer, box, fullBox, u32, u16, bytes, concat, visualSampleEntry, audioSampleEntry, esdsBox, FOURCC } from './mp4.js';
import { hevcCodecString, colourFromTrack, parseHvcC } from '../demux/hevc.js';

/** Decode an AVC configuration record enough to build "avc1.PPCCLL". */
function avcCodecString(cp) {
  if (!cp || cp.length < 4) return 'avc1';
  return `avc1.${[cp[1], cp[2], cp[3]].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

function av1CodecString(cp) {
  // av1C: marker/version, seq_profile(3)|seq_level_idx(5), high_bitdepth etc.
  if (!cp || cp.length < 4) return 'av01.0.00M.08';
  const profile = cp[1] >> 5;
  const level = cp[1] & 0x1f;
  const tier = (cp[2] >> 7) & 1;
  const highBitdepth = (cp[2] >> 6) & 1;
  const twelveBit = (cp[2] >> 5) & 1;
  const depth = twelveBit ? 12 : highBitdepth ? 10 : 8;
  return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`;
}

export function buildRemuxer(track, duration) {
  const id = track.codecId;
  const colour = track.type === 1 ? colourFromTrack(track) : null;

  // ---- video ----
  if (id === 'V_MPEGH/ISO/HEVC') {
    const cfg = parseHvcC(track.codecPrivate);
    if (!cfg) return null;
    // hvc1 (not hev1): parameter sets live in the sample entry, out of band.
    const codecString = hevcCodecString(track.codecPrivate, 'hvc1');
    const entry = visualSampleEntry('hvc1', track, colour, [box('hvcC', track.codecPrivate)]);
    return new TrackRemuxer(track, { kind: 'video', codecString, sampleEntry: entry, duration, colour });
  }
  if (id === 'V_MPEG4/ISO/AVC') {
    const entry = visualSampleEntry('avc1', track, colour, [box('avcC', track.codecPrivate)]);
    return new TrackRemuxer(track, { kind: 'video', codecString: avcCodecString(track.codecPrivate), sampleEntry: entry, duration, colour });
  }
  if (id === 'V_AV1') {
    const entry = visualSampleEntry('av01', track, colour, [box('av1C', track.codecPrivate)]);
    return new TrackRemuxer(track, { kind: 'video', codecString: av1CodecString(track.codecPrivate), sampleEntry: entry, duration, colour });
  }
  if (id === 'V_VP9') {
    const entry = visualSampleEntry('vp09', track, colour,
      [track.codecPrivate?.length ? box('vpcC', track.codecPrivate)
                                  : fullBox('vpcC', 1, 0, bytes(2, 10, (colour?.bitDepth ?? 10) << 4 | 0x01), u16(0))]);
    return new TrackRemuxer(track, { kind: 'video', codecString: 'vp09.02.10.10', sampleEntry: entry, duration, colour });
  }

  // ---- audio ----
  const a = track.audio ?? { sampleRate: 48000, channels: 2 };
  const rate = a.outputSampleRate || a.sampleRate;

  if (id === 'A_AAC') {
    const entry = audioSampleEntry('mp4a', a.channels, rate, esdsBox(track.codecPrivate ?? new Uint8Array([0x12, 0x10])));
    // profile byte 0 >> 3 gives the AudioObjectType (2 = AAC-LC)
    const aot = track.codecPrivate?.length ? (track.codecPrivate[0] >> 3) : 2;
    return new TrackRemuxer(track, { kind: 'audio', codecString: `mp4a.40.${aot || 2}`, sampleEntry: entry, duration, sampleRate: rate });
  }
  if (id === 'A_FLAC') {
    // dfLa wraps the raw STREAMINFO metadata block Matroska stores in CodecPrivate.
    const streamInfo = stripFlacHeader(track.codecPrivate);
    const entry = audioSampleEntry('fLaC', a.channels, rate, fullBox('dfLa', 0, 0, streamInfo));
    return new TrackRemuxer(track, { kind: 'audio', codecString: 'flac', sampleEntry: entry, duration, sampleRate: rate });
  }
  if (id === 'A_OPUS') {
    const entry = audioSampleEntry('Opus', a.channels, rate, box('dOps', track.codecPrivate.subarray(8)));
    return new TrackRemuxer(track, { kind: 'audio', codecString: 'opus', sampleEntry: entry, duration, sampleRate: rate });
  }
  if (id === 'A_AC3' || id === 'A_EAC3') {
    // Emitted for completeness; probe says Edge/Chrome reject ec-3 in MSE, so
    // the player is expected to route these to the software decoder instead.
    const fourcc = id === 'A_AC3' ? 'ac-3' : 'ec-3';
    const entry = audioSampleEntry(fourcc, a.channels, rate);
    return new TrackRemuxer(track, { kind: 'audio', codecString: fourcc, sampleEntry: entry, duration, sampleRate: rate });
  }

  return null;
}

/** Matroska sometimes stores the full "fLaC" stream header; MP4 wants just the blocks. */
function stripFlacHeader(cp) {
  if (!cp) return new Uint8Array(0);
  const isMagic = cp[0] === 0x66 && cp[1] === 0x4c && cp[2] === 0x61 && cp[3] === 0x43;
  return isMagic ? cp.subarray(4) : cp;
}

/**
 * Why an audio track will not play, in terms of what would fix it.
 *
 * "unsupported" on its own is useless to anyone reading the UI: it does not
 * distinguish a codec no browser will ever take from one that merely needs a
 * decoder wired up, and it hides the fact that a 5.1 track will be downmixed
 * to stereo regardless of which route it takes.
 */
export const AUDIO_NOTES = {
  A_DTS: {
    name: 'DTS',
    reason: 'No browser ships a DTS decoder, and DTS is patent-encumbered.',
    route: 'Needs a wasm decoder, then re-encoding to Opus for MSE.',
  },
  A_TRUEHD: {
    name: 'Dolby TrueHD',
    reason: 'Lossless MLP. No browser decodes it; it is a Blu-ray format.',
    route: 'Needs a wasm decoder. Most discs also carry an AC-3 core track — prefer that if present.',
  },
  A_MLP: {
    name: 'MLP',
    reason: 'The lossless packing TrueHD is built on. Not decoded by any browser.',
    route: 'Needs a wasm decoder.',
  },
  A_EAC3: {
    name: 'Dolby Digital Plus (E-AC3)',
    reason: 'MSE and WebCodecs both reject ec-3 here; support depends on an OS decoder that this platform does not expose.',
    route: 'Needs a wasm decoder, then re-encoding to Opus for MSE.',
  },
  A_AC3: {
    name: 'Dolby Digital (AC-3)',
    reason: 'MSE and WebCodecs both reject ac-3 here.',
    route: 'Needs a wasm decoder, then re-encoding to Opus for MSE.',
  },
  A_DTS_HD: { name: 'DTS-HD', reason: 'Extension of DTS; no browser decodes it.', route: 'Needs a wasm decoder.' },
};

/** What is known about an audio track the player cannot hand to MSE. */
export function audioNote(track, channels) {
  const n = AUDIO_NOTES[track.codecId]
    ?? { name: track.codecId.replace(/^A_/, ''), reason: 'No repackaging path for this codec.', route: 'Unhandled.' };
  return channels > 2
    ? { ...n, downmix: `${channels} channels will be downmixed to stereo — WebAudio reports maxChannelCount 2.` }
    : n;
}

export const SUBTITLE_CODECS = {
  'S_TEXT/ASS': 'ass', 'S_TEXT/SSA': 'ssa',
  'S_TEXT/UTF8': 'srt', 'S_TEXT/WEBVTT': 'vtt',
  'S_HDMV/PGS': 'pgs', 'S_VOBSUB': 'vobsub', 'S_DVBSUB': 'dvbsub',
};

export { u32, u16, concat, FOURCC };

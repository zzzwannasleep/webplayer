# webplayer

Browser video player for MKV with HDR / Dolby Vision and soft subtitles.
Zero transcoding: Matroska is repackaged into fragmented MP4 and handed to
Media Source Extensions, so the codec payload never leaves its original bytes.

## Why repackage instead of decoding

The obvious design — WebCodecs `VideoDecoder` drawing into a canvas — was
measured and rejected. On Edge 150 with system HDR enabled:

| capability | result |
|---|---|
| `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L150.B0"')` | **yes** |
| `canvas.getContext('2d', {colorSpace:'rec2100-pq'})` | **no** |
| `canvas.getContext('2d', {colorSpace:'rec2100-hlg'})` | **no** |
| `matchMedia('(dynamic-range: high)')` | yes |

Canvas cannot hold a PQ colour space in this browser, so any decode-to-canvas
pipeline loses HDR — along with Picture-in-Picture, fullscreen, casting, and
hardware-accelerated presentation. Feeding `<video>` through MSE keeps all of
it, and the HEVC access units pass through untouched.

Run `public/probe.html` in a **foreground** window to re-measure on any machine.
Headless Chromium ships no platform HEVC decoder and reports every codec here
as unsupported, so headless numbers are meaningless for this decision.

## Status

Working:
- Matroska demuxing — tracks, attachments, cues, SimpleBlock/BlockGroup, all
  three lacing modes
- fMP4 repackaging for HEVC, AVC, AV1, VP9 video and AAC, FLAC, Opus audio
- HDR passthrough, including files whose colour metadata exists **only** in the
  SPS VUI (see below)
- Dolby Vision profile 8.x detection and playback
- Seeking via the Cues index, byte-accurate on a 21 GB file
- Quota-aware buffering with eviction of already-played media
- Track compression (`ContentEncodings`): zlib and header stripping
- Subtitles: effect-heavy ASS with embedded fonts, PGS, and external SRT

- E-AC3 / AC-3 / DTS / TrueHD, on the `audio-eac3-ffmpeg` branch only:
  decoded with ffmpeg.wasm and re-encoded to Opus so the browser still does
  A/V sync. That branch is GPL-2.0-or-later because `@ffmpeg/core` is; `main`
  stays MIT and plays those files silently.
- Seeking in files with no Cues index, by binary-searching the clusters

Not built yet:
- External ASS scripts. Embedded ones work; an external one has to find its
  fonts on the system, which is a different problem.
- VobSub and DVB subtitles. Detected and reported, not drawn.

## Subtitles

| format | renderer | licence |
|---|---|---|
| ASS / SSA | [JASSUB](https://github.com/ThaUnknown/jassub) (libass in wasm) | LGPL-2.1-or-later |
| PGS | [libpgs](https://github.com/Arcus92/libpgs-js) | MIT |
| SRT | the browser's own `<track>`, after conversion to WebVTT | — |

Neither renderer is patched; both are used through their published API. The
work is in feeding them, and each needed something the format documentation
does not make obvious — see below.

**JASSUB is LGPL**, unlike the MIT code in this repository. It is built into
its own bundle (`public/vendor/`) and used only through its public interface,
so it stays a separately-licensed, replaceable component.

## Findings that shaped the code

**Container colour metadata is not reliable.** `houshi.mkv` has no Matroska
`Colour` element at all; its BT.2020 / PQ signalling lives only in the HEVC SPS
VUI. `src/demux/hevc.js` parses the SPS to recover it and writes a `colr` box
into the MP4. Trusting the container would have produced an SDR-tagged HDR file.

**Dolby Vision profile 8.1 needs no Dolby-specific code.** Its base layer is
already valid HDR10 and the RPU rides along as an in-band NAL (type 62) that the
decoder ignores. Declaring `hvc1` rather than `dvh1` plays it correctly —
`dvh1.08.06` is in fact rejected by MSE here. Profile 7 (dual layer, NAL 63
present) and profile 5 (IPT-PQ-c2 base layer, unusable without applying the RPU)
are detected and reported, not played.

**Matroska block timestamps are PTS in decode order.** With B-frames they are
not monotonic, while MP4 requires a monotonic decode timeline plus composition
offsets. Sorting the PTS values of a fragment recovers DTS exactly. Before this
was handled, ffmpeg counted 22 frames in the first two seconds of a 24 fps file
instead of 45.

**ffmpeg is too permissive to validate an MP4.** It read an init segment whose
`tkhd` was two bytes short (three 16-bit fields where the spec has four).
Chrome rejected the same segment by silently detaching the MediaSource with no
error on the element. `tools/test-boxes.mjs` now checks box sizes against the
spec and against a reference produced by ffmpeg.

**Matroska track data can be compressed, and ignoring it fails silently.**
The PGS tracks in `qinyinshaonvpgs.mkv` are zlib-compressed via
`ContentEncodings`, which the demuxer did not read. Nothing errors: the blocks
come out as plausible-looking bytes that are not PGS. This affects every track
type — header stripping (algo 3) is common on audio — so it is undone in the
read path for all of them, using `DecompressionStream` rather than a bundled
inflate.

**A .sup file is bare PGS segments plus 10 bytes each.** Matroska stores the
segments without the `PG` magic, PTS and DTS that a .sup file carries, and
every PGS decoder on npm reads .sup. Rebuilding those 10 bytes per segment —
the PTS comes from the block timestamp — is what lets libpgs be used unmodified
instead of reimplementing RLE decoding and window composition.

**ASS events do not arrive as `Dialogue:` lines.** Matroska splits an ASS
script: `[Script Info]` and `[V4+ Styles]` live in CodecPrivate, and each event
is a block holding `ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,
Text` — a different field order, with Start and End replaced by the block's
timestamp and duration. Events are pushed to libass one at a time rather than
by rebuilding the script, because reloading a track resets libass mid-playback.

**Enabling subtitles mid-playback needs a backfill.** Subtitle packets are
produced by the same sequential read as video, so when a track is switched on
the buffered region has already been read past and its packets discarded.
Without re-reading it, subtitles do not appear until the buffer drains — up to
20 seconds that looks exactly like a broken renderer.

**Two config records that look copyable are not.** Matroska's `OpusHead` and
MP4's `dOps` carry the same fields, but OpusHead is little-endian and starts at
version 1 while dOps is big-endian and must be version 0. Stripping the 8-byte
magic and using the rest — which is what the code did — turned a pre-skip of
312 into 14337 and a sample rate of 48000 into 2159738880. Likewise VP9 has no
CodecPrivate in Matroska at all, so profile and bit depth have to come from a
keyframe header; a hardcoded codec string declared 8-bit Profile 0 content as
10-bit Profile 2.

Both were found the same way, and both failed the same way: ffmpeg accepted the
output, and Chrome silently detached the MediaSource with no error on the
element. That is the third instance of that exact signature in this project,
after the short `tkhd`.

**Chromium defers media loading while `document.hidden`.** A background window
leaves `MediaSource` at `closed` and `networkState` at `LOADING` forever. The
player waits for visibility instead of failing; the test harness forces its
window to the foreground.

## Layout

    src/demux/ebml.js       EBML primitives
    src/demux/matroska.js   demuxer, HTTP/File sources
    src/demux/hevc.js       hvcC + SPS parsing, codec strings, DV NAL scan
    src/remux/mp4.js        fMP4 writer
    src/remux/tracks.js     Matroska codec -> MP4 sample entry
    src/player.js           MSE engine
    src/subs/index.js       picks a renderer per track, keeps it fed
    src/subs/ass.js         JASSUB wiring, Matroska ASS packet parsing
    src/subs/pgs.js         Matroska PGS packets -> .sup for libpgs
    src/subs/srt.js         SRT -> WebVTT
    public/index.html       player UI
    public/probe.html       browser capability probe
    public/autotest.html    browser acceptance test
    public/vendor/          bundled JASSUB + libpgs (built, not committed)
    tools/serve.mjs         dev server with Range support

## Running

    npm install
    node tools/build-vendor.mjs       # bundles JASSUB + libpgs into public/vendor
    npm run serve                     # http://localhost:8080/

Tests:

    npm test                          # all five Node suites
    node tools/test-demux.mjs         # demuxer vs ffprobe ground truth
    node tools/test-boxes.mjs         # MP4 box layout vs spec + ffmpeg
    node tools/test-remux.mjs         # remux, then have ffprobe read it back
    node tools/test-pgs.mjs           # synthesised .sup, decoded by ffmpeg
    node tools/test-srt.mjs           # SRT -> VTT, parsed back by ffprobe
    powershell -File tools/run-browser-test.ps1   # real playback in Edge

The browser suite is the only one that proves a subtitle reached the screen: it
reads the overlay canvas back and counts painted pixels.

The test files referenced by the suites live in the repository root and are not
committed.

## Test material

    node tools/make-samples.mjs       # writes samples/ (not committed)

DTS, TrueHD, AC-3 and E-AC3 cannot be obtained from any streaming service —
they are Blu-ray and broadcast formats, and services transcode them away. They
are synthesised with ffmpeg instead, which is better suited to what these paths
do: the player identifies these codecs, decides they need a software decoder,
and reports that. A 20-second generated file exercises that completely and is
small enough to regenerate on demand. `samples/audio-multi.mkv` carries all
four in one file, which is also the only multi-audio-track test material here.

Two things are deliberately *not* synthesised, because nothing available can
produce them honestly: genuine dual-layer Dolby Vision profile 7, and real
HDR Vivid / CUVA graded content. Their detection paths are therefore
unverified against real bitstreams — the code is written and the negative case
is asserted, but no sample has ever exercised the positive case.

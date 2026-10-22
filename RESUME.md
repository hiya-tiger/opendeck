# Resume notes

The format codecs, offline transport and cue import are committed. The
following work is not done, in the order it should be picked up.

## 1. Engine cutover (phase 3 remainder)

- Add signalsmith-stretch (MIT, official `signalsmith-stretch` npm package) to a
  worklet, with key lock on by default to match the current
  `HTMLMediaElement.preservesPitch` behaviour.
- Wire `PcmSource` into `Deck` behind the existing public API. Keep the media
  element for remote/stream URLs and fall back when `decodeAudioData` fails.
- Route deck input through one gain node so either source can feed the band
  splitter. Do not change EQ/FX/mixer/analyser code.
- Move loop boundaries and DVS jumps onto the PCM transport; keep the timecode
  decoder byte-identical.
- Expose the xrun counter and measured latency in diagnostics.

## 2. Serato export UI

- Replace the zip download with a direct export into a chosen `_Serato_`
  folder, refusing while Serato is running, with a backup and an undo log.
- Add per-track "write tags" for MP3 via `writeSeratoGeoB`, using a temporary
  copy and byte verification before replacing the original.
- Add WAV/AIFF RIFF `id3 ` chunk support, FLAC `VORBIS_COMMENT` and MP4
  `----:com.serato.dj:*` atoms.
- Do not add the SQLite column-layout edit without a backup and a version check.

## 3. Test and verification

- Add a browser/Electron smoke test for `PcmSource`: load a generated WAV,
  play, seek, loop, and assert non-zero analyser RMS.
- Verify an exported crate and a tagged MP3 import into Serato DJ Pro 4 on a
  disposable library.
- Keep `npm test`, `npx tsc --noEmit` and `cargo test` green.

## Known gaps

- Key lock is not implemented in the PCM path.
- `PcmSource` is not connected to a deck, so reverse playback and sample loops
  are only proven offline.
- Serato cue import is MP3-only. The first saved loop and BeatGrid BPM/phase
  are applied; remaining loops and per-beat detail are not.
- No export UI, no WAV/FLAC/MP4 tag writing, no SQLite column layout.

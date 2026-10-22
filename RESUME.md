# Resume notes

The format codecs, offline transport and cue import are committed. The
following work is not done, in the order it should be picked up.

## 1. Engine cutover (phase 3 remainder)

- Add signalsmith-stretch (MIT, official `signalsmith-stretch` npm package) to a
  worklet, with key lock on by default to match the current
  `HTMLMediaElement.preservesPitch` behaviour.
- `PcmSource` is wired into `Deck` for local files: one deck input gain feeds
  the band splitter, and the PCM path drives transport and loops when key lock
  is off. Remote/stream URLs and decode failures stay on the media element.
- Still to do: key lock inside the PCM path (signalsmith-stretch), exact DVS
  jump handoff, and an xrun/latency diagnostic.

## 2. Serato export UI

The library panel writes `database V2`, `neworder.pref` and each crate into a
chosen `_Serato_` folder, with a zip fallback. WAV/AIFF tag reading and RIFF
`id3 ` writing are implemented.

- Refuse the folder export while Serato is running. A timestamped backup is
  written, but there is no undo command yet.
- Add per-track "write tags" for MP3/WAV/AIFF, using a temporary copy and byte
  verification before replacing the original.
- Add FLAC `VORBIS_COMMENT` and MP4 `----:com.serato.dj:*` atoms.
- Do not add the SQLite column-layout edit without a backup and a version check.

## 3. Test and verification

- `npm run smoke:audio` builds and runs `PcmSource` in a hidden Electron
  window: generated tone, play, seek, sample loop and analyser RMS assertion;
  the same run loads a real `Deck`, disables key lock and asserts the PCM engine,
  audible output and sample-loop bounds.
- Verify an exported crate and a tagged MP3 import into Serato DJ Pro 4 on a
  disposable library.
- Keep `npm test`, `npx tsc --noEmit` and `cargo test` green.

## Known gaps

- Key lock is not implemented in the PCM path; disabling key lock switches a
  local track to `PcmSource`, enabling it switches back to the media element.
- The PCM path passes the Electron smoke test and Node worklet tests, but has
  not been checked against a physical audio interface and real DJ hardware.
- Serato cue import covers MP3, WAV and AIFF. The first saved loop and
  BeatGrid BPM/phase are applied; remaining loops and per-beat detail are not.
- Folder export backs up existing files but has no undo command and does not
  detect a running Serato instance.
- No in-app tag writing, no FLAC/MP4 tag writing, no SQLite column layout.

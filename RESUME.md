# Resume notes

The format codecs, offline transport and cue import are committed. The
following work is not done, in the order it should be picked up.

## 1. Engine cutover (phase 3 remainder)

- Signalsmith Stretch 1.3.2 is in `PcmSource` with key lock, signed rate,
  reverse, loop scheduling and latency/underrun reporting. Local files decode
  once and use the PCM path; remote streams and decode failures keep the media
  element. The legacy raw worklet remains only as a load-failure fallback.
- Diagnostics show engine, latency, xruns and pitch-hold state. Platter torque,
  friction and inertia drive scratch and DVS.
- DVS now hands rate and a sample-rounded target to `PcmSource` in one
  scheduled transport segment; jumps and drift over 90 ms align exactly.
- Rust now has transport atomics, a lock-free stereo SPSC ring, a tested
  render thread and an optional cpal output stream at the exact source rate.
  Still to do: native decode and selecting the Rust path in a shell;
  sample-accurate reverse-loop correction on external jumps.

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
  window: generated tone, play, seek, sample loop and analyser RMS assertion.
  It then loads a real `Deck` with key lock on and asserts PCM engine, audible
  output, latency under 10 ms, loop bounds, pitch hold and reverse playback.
- Verify an exported crate and a tagged MP3 import into Serato DJ Pro 4 on a
  disposable library.
- Keep `npm test`, `npx tsc --noEmit` and `cargo test` green.

## Known gaps

- The Rust live render thread and cpal output are tested, but native decode is
  missing and neither shell selects them; JS `PcmSource` still owns playback.
  The JS DVS handoff uses one scheduled segment, not shared-memory atomics.
- Reverse-loop correction after an external jump is coarse in the JS path, not
  sample-accurate.
- The PCM path passes the Electron smoke test and Node worklet tests, but has
  not been checked against a physical audio interface and real DJ hardware.
- Serato cue import covers MP3, WAV and AIFF. The first saved loop and
  BeatGrid BPM/phase are applied; remaining loops and per-beat detail are not.
- Folder export backs up existing files but has no undo command and does not
  detect a running Serato instance.
- No in-app tag writing, no FLAC/MP4 tag writing, no SQLite column layout.

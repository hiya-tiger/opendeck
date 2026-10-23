# Resume notes

The format codecs, offline transport and cue import are committed. The
following work is not done, in the order it should be picked up.

## 1. Engine hardening (P1 complete)

- P1 exit criteria are met: reverse with key lock, ten-minute sample-exact
  loops, PCM ownership for local files and a smoke test that asserts the PCM
  engine. Signalsmith Stretch 1.3.2 is in `PcmSource` with key lock, signed
  rate, reverse, loop scheduling and latency/underrun reporting. Local files
  decode once and use the PCM path; remote streams and decode failures keep the
  media element. The legacy raw worklet remains only as a load-failure fallback.
- Diagnostics show engine, latency, xruns and pitch-hold state. Platter torque,
  friction and inertia drive scratch and DVS.
- DVS now hands rate and a sample-rounded target to `PcmSource` in one
  scheduled transport segment; jumps and drift over 90 ms align exactly.
- Rust now has native decode (MP3, AAC/M4A, FLAC, Vorbis, WAV, AIFF, ADPCM),
  transport atomics, a lock-free stereo SPSC ring, a tested render thread and
  an optional cpal output stream at the exact source rate. The Tauri shell uses
  native decode for analysis. Still to do: selecting the Rust live render path
  in a shell (it needs a shared-memory/worklet seam so EQ/FX and key lock are
  not bypassed); sample-accurate reverse-loop correction on external jumps.

## 2. Serato export and tag UI

The library panel writes `database V2`, `neworder.pref` and each crate into a
chosen `_Serato_` folder, with a zip fallback.

- `Write tags` embeds both marker frames and a BeatGrid into MP3, WAV, AIFF,
  FLAC and MP4/M4A. `Undo tags` restores the files from the last write.
- Writes are refused while Serato DJ is running. Each file is backed up, written
  through a temporary file, and accepted only when its audio payload is
  byte-identical.
- Cues come from the live deck or the saved cue list, including names and the
  18-colour palette. All saved loops for the track are embedded. Embedded
  key/BPM tags are still open.
- FLAC `VORBIS_COMMENT` and MP4 `----:com.serato.dj:*` atoms are wired. Serato
  MP4 `Markers_` uses 19-byte slots, so the MP4 reader/writer now selects that
  layout while MP3/WAV/AIFF/FLAC keep the 22-byte layout.
- Do not add the SQLite column-layout edit without a backup and a version check.

## 3. P3 feature wall (started)

- Hot cues: right-click renames, Alt+click cycles the 18-colour palette,
  Shift+right-click clears. Names and colours persist per track and are written
  into the Serato marker payload.
- Saved loops: up to eight per track, persisted, renamable, lockable as
  metadata, deletable, and applied with one click. Imported Serato loops appear
  in the same panel.
- Library UX: search covers title, path, crate and key; sort covers title, BPM,
  key, length and crate; a scratchpad view and a persisted played log with CSV
  export are wired. Pure logic lives in `media/library-ux.ts` and
  `media/cue-store.ts` with node tests.
- Still open: beat-grid editor with lock, playlist creation/reordering, track
  colour and play count, preview, display modes, four decks, deck clone,
  repeat/autoplay, eject/load lock, nudge/tempo-range cycling and the remaining
  P3 mixer, performance and UI items.

## 3a. P4 pad modes and sampler (started)

- `engine/pad-modes.ts` defines the ten-mode pad framework, cue-loop and
  slice-range helpers, rolling release position, pitch-play ratios and a
  timestamped sequence recorder for pad press/release actions.
- Deck pads now switch modes from the UI. Hot Cue, Cue Loop, Loop Roll, Slicer,
  Beat Jump, Transport, Pitch Play, Scratch, Sequence and Part FX are wired.
  Sequence records mode/index/phase events and loops them until stopped; Part FX
  has four per-band filters and four per-band mutes.
- Scratch pads (`engine/scratch-bank.ts`) hold a copy of the current local track.
  Shift+click loads the track into `S1`-`S8`; holding a loaded pad scratches it
  through an independent `ScratchVoice`.
- The sampler exposes 32 slots across banks A-D; NumPad 1-8 triggers the current
  bank and the bank buttons switch the visible eight.
- Tests are in `test/pad-modes.test.ts`. Still open: user sample import,
  per-slot controls and hardware verification of the hold and scratch pads.

## 3b. P5 source separation (implemented)

- `src/main/separation.ts` runs `onnxruntime-node` 1.20.1 (1.30 crashes on
  model load) with `htdemucs_fp16weights.onnx`. The model is downloaded on
  demand, SHA-256 checked and stored in user data; `OPENDECK_STEM_MODEL` can
  point at a local model for development.
- Audio is resampled to 44.1 kHz, run in overlapping 343,980-frame chunks,
  overlap-added and written as four Int16 stems plus a manifest. The cache path
  is `.opendeck-stems/<content-hash>-<model-version>/` beside the track, with
  a user-data fallback.
- `src/renderer/engine/parts.ts` defines four parts, mixes and chunk/window/
  Int16 helpers. `Deck` loads the four stems into independent `PcmSource`
  voices with per-part filter/gain, vocals-only and instrumental, part roll and part scratch.
  The Parts row and true Part FX pad mode are wired; the old band row is now
  labelled Bands.
- Still open: cancellation and a separation queue, long-track throughput,
  checking the visual progress and install flow in a packaged build, and a real
  track/headphone pass.

## 4. Test and verification

- `npm run smoke:audio` builds and runs `PcmSource` in a hidden Electron
  window: generated tone, play, seek, sample loop and analyser RMS assertion.
  It then loads a real `Deck` with key lock on and asserts PCM engine, audible
  output, latency under 10 ms, loop bounds, pitch hold and reverse playback.
  Finally it loads four synthetic stem buffers and asserts part playback and
  part scratch.
- Verify an exported crate and a tagged MP3 import into Serato DJ Pro 4 on a
  disposable library.
- Keep `npm test`, `npx tsc --noEmit` and `cargo test` green.

## Known gaps

- The Rust live render thread and cpal output are tested, and native decode is
  wired into the Tauri shell for analysis. No shell selects native playback yet;
  JS `PcmSource` still owns deck playback so EQ/FX and key lock stay in one
  graph. The JS DVS handoff uses one scheduled segment, not shared-memory atomics.
- Reverse-loop correction after an external jump is coarse in the JS path, not
  sample-accurate.
- The PCM path passes the Electron smoke test and Node worklet tests, but has
  not been checked against a physical audio interface and real DJ hardware.
- Serato cue import covers MP3, WAV, AIFF, FLAC and MP4/M4A. Reads were checked
  against Serato DJ Pro 2.3.7 for a real MP3 and M4A. Tag writing is wired for
  the same formats and an M4A temp-copy write/read preserves its audio payload. Cue names, colours and eight saved loops are in
  the UI and tag payload. Beat-grid BPM/phase is applied; per-beat grid editing
  with a lock flag is still open.
- Folder export backs up existing files but has no undo command and does not
  detect a running Serato instance. Embedded tag writes do both.
- No SQLite column layout yet. Full playlist and `database V2` read/write are
  still open. Real Serato DJ Pro import/edit/re-import is not verified.

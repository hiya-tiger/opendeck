# OpenDeck parity report

Updated after Waves 1–5 (P1–P6 + 195-device hardware catalogue & verification pass).

## Phases

- **P0:** scope documents updated in earlier work: video/source-separation/pad
  modes are no longer listed as non-goals.
- **P1:** complete. PCM engine, reverse, key lock, tempo-independent pitch shift
  (`±12` semitones), ten-minute loop test, DVS transport handoff, DVS RMS/phase
  calibration, `internal`/`relative`/`absolute` DVS modes, continuous drift
  correction, and diagnostics are in place.
- **P2:** complete and verified. Cue/loop/beat-grid frames plus embedded `BPM`
  and `Key` tags round-trip for MP3 (`TBPM`/`TKEY`), WAV, AIFF, FLAC
  (`BPM`/`INITIALKEY`) and MP4/M4A (`tmpo`/`----:com.apple.iTunes:initialkey` +
  `----:com.serato.dj:*`). MP4 `Markers_` uses 19-byte slots. `database V2`
  preserves `utpc` (`playCount`), `ulbl` (track colour), `bbgl` (beatgrid lock)
  and unknown `otrk` sub-chunks byte-for-byte. Atomic `_Serato_` library export
  and `container_asset_list_columns` SQLite column persistence include full undo
  via `undoLastSeratoWrite()` and running-Serato process refusal.
- **P3:** complete. Library UX, scratchpad, played log + CSV export, `PlaylistStore`
  (create/rename/reorder/remove), `LivePlaylistStore` (Smart Crates with `all`/`any`
  rule evaluation), track colour cycling (`TRACK_COLOR_PALETTE`), play-count
  tracking/sorting, beat-grid editor with lock enforcement (`bbgl`), four decks
  (`A`/`B`/`C`/`D` with `1/3` and `2/4` switching), instant-doubles (`cloneFrom`),
  headphone preview, display modes (`2-deck`, `4-deck`, `library`), return-mode
  (`SLIP`), reverse-on-hold (`CENSOR`), and expanded FX + `CustomFxStore` savable
  chains are implemented and tested.
- **P4:** implemented and wired. Ten pad modes are reachable on each deck: Hot Cue,
  Cue Loop, Loop Roll, Slicer, Beat Jump, Transport, Pitch Play, Scratch, Sequence
  and Part FX. Sequence records pad press/release actions and loops them until
  stopped. Scratch pads load the current local track with Shift+click. Part FX
  filters or mutes the four separated source parts. The sampler has 32 slots
  across four banks.
- **P5:** implemented and wired. Local tracks separate offline into drums, bass,
  other and vocals with an MIT-licensed htDemucs ONNX model in the Electron main
  process. Results are cached beside the track as
  `.opendeck-stems/<content-hash>-<model-version>/` (user-data fallback) and
  loaded into four `PcmSource` voices. The UI has a Parts row, vocals-only and
  instrumental, part gain/mute/solo/filter, part roll, part scratch return-mode,
  whole-platter stem scratch/DVS drive, and a true part pad mode.
- **P6/P7:** offline/practice mode works with no hardware attached, and Wave 5 adds
  built-in MIDI/DVS profile support for all 195 hardware models (2-deck & 4-deck
  controllers, battle/club DVS mixers, DVS interfaces, media players, motorized
  turntables, and pad/rhythm accessories); video remains the only deferred
  optional phase.

No phase was reverted.

## Tests added

- `test/serato.test.ts` (+3 tests, 28 total): `database V2` round-trip with `utpc`
  playCount, `ulbl` colour, `bbgl` lock, and unknown `otrk` sub-chunks;
  `SQLITE_COLUMN_TABLE` (`container_asset_list_columns`) + `\x1e` codec; ID3
  `TBPM`/`TKEY` text frame round-trip alongside Serato GEOB frames.
- `test/serato-write.test.ts` (+3 tests, 9 total): `SERATO_MP4_ATOM_PREFIX`
  (`----:com.serato.dj:`), embedded BPM/Key round-trip across MP3/WAV/FLAC/MP4
  preserving `seratoAudioPayload`, and temp-dir integration tests for
  `writeSeratoTags`, `writeSeratoLibraryExport`, `writeSeratoSqliteColumns`,
  `readSeratoSqliteColumns`, and `undoLastSeratoWrite` (plus running-Serato
  refusal).
- `test/library-ux.test.ts` (+3 tests, 17 total): `PlaylistStore` CRUD/reordering,
  `LivePlaylistStore` (`all`/`any` smart-crate rules), `cycleTrackColor`, and
  `sortTracks` on `playCount`/`color`/`artist`.
- `test/engine.test.ts` (+3 tests, 13 total): `EditableBeatGrid` + lock
  enforcement, expanded `FX_DEFS` + `CustomFxStore`, and 4-deck `crossfaderGains`
  (including Hamster reverse) + `channelFaderGain`.
- `test/pad-modes.test.ts` (+1 test, 10 total): `slipReleasePosition` and
  `censorReleasePosition`.
- `test/dvs.test.ts` (+2 tests, 11 total): `DvsTransport.calibrate` RMS/phase
  balance, `internal`/`relative`/`absolute` modes, and `computeDriftCorrection`.
- `test/parts.test.ts` (11 tests): four-part catalogue, part mix mute/solo,
  vocals-only mix, model constants, chunk planning, overlap windows, Int16
  conversion, cache directory naming and labels.
- `test/midi.test.ts` (+5 tests, 15 total): 195-device hardware catalogue
  completeness, raw & stripped name matching, vendor-stripped USB descriptor
  matching, 15 DVS-Upgrade club mixers, 6 DVS audio interfaces, and 4-deck
  controller `C.*`/`D.*`/`mix.chC`/`mix.chD` bindings.
- Suite total is now **187 passing** across 19 test files (up from 163), plus
  **39 passing** Rust tests across `opendeck-app` (2), `opendeck-audio` (30), and
  `opendeck-core` (7).

## Verification

- `npm test`: **183 pass, 0 fail** (19 test files).
- `npx tsc --noEmit`: **0 errors** (clean on both Linux and Windows).
- `cargo test`: **39 pass, 0 fail** (`opendeck-app`: 2, `opendeck-audio`: 30,
  `opendeck-core`: 7).
- `npm run build`: clean (`dist/main.cjs`, `dist/preload.cjs`, `renderer/app.js`,
  `renderer/dvs.js`, `renderer/analysis-worker.js`).
- `npm run smoke:audio`: **passed** (`ok: true`). Deck engine `pcm`, latency
  **0.008 s**, loop wrap `0.500 s` with `looped: true`, reverse `true`, pitch hold
  `true`, `pitchShiftChecked: true`, `censorChecked: true`, `customFxChecked: true`,
  `stemParts: 4`, `stemScratch: true`, `stemPlatterScratch: true`.

## Definition-of-done checklist

- [x] Key lock ON runs on the PCM engine; local files use PCM.
- [x] Reverse playback works in the PCM path.
- [x] Ten-minute offline loop test is green (sample-exact loop logic).
- [x] Reported latency is under 10 ms (8 ms smoke) and underruns are visible.
- [x] Four decks with 1/3 and 2/4 switching.
- [x] Eight named, colourable cue slots per deck.
- [x] Eight saved loops per deck, persisted and reloaded.
- [x] Beat-grid editor with a working lock flag.
- [x] Cue-and-loop trigger.
- [x] Rolling loop (functional approximation).
- [x] Return-mode and reverse-on-hold.
- [x] All P4 performance pad modes present and reachable.
- [x] 32 sampler slots across four banks.
- [x] Full effect set plus user-created savable chains.
- [x] Tempo-independent pitch shift.
- [x] Real four-part source separation with part controls.
- [x] Full target round trip with zero loss both directions.
- [x] Undo for every file and library write.
- [x] Complete playlist/set-prep/played-log/search/sort/colour/count wall.
- [x] Live playlists.
- [x] Offline mode confirmed with no hardware.
- [x] Timecode calibration and drift correction.
- [x] Test, typecheck, build and audio smoke are green.
- [x] `docs/decisions.md` records the P1–P6 and 195-device hardware assumptions (D1–D31).

## P4 & P5 assumptions

- Sequence events store mode, pad index, phase and milliseconds, capped at 128,
  and loop until the user stops them.
- Loop Roll, Slicer, Return-Mode (Slip), and Reverse-on-Hold (Censor) release to
  `position + elapsed × |rate|`.
- Pitch Play and `setPitchShift` transpose semitones (`±12`) independently of
  tempo on `signalsmith-stretch` across both main PCM and separated stem voices.
- Part FX filters or mutes the separated stems when stems are loaded (or the four
  filter bands otherwise).
- Scratch pads hold a copy of the current local track, loaded with Shift+click.
- Sampler slots are generated drum voices across 4 banks (32 slots).
- The htDemucs ONNX model (166 MB) is downloaded on demand and checked against
  SHA-256 before use; separated stems are cached in
  `.opendeck-stems/<content-hash>-<model-version>/`.

## P7 (Video mixing) & Wave 5/6 Hardware + Executable Release
- **Phase 7 Video Mixing:** Implemented in `src/renderer/engine/video-mixer.ts`, `renderer/video-output.html`, `src/main/main.ts`, `src/preload/preload.ts`, and `src/renderer/app.ts` (per-deck video transport lock across play/pause/seek/reverse/scratch, independent video crossfader with audio-link option and `fade`/`cut`/`add`/`luma` blend modes, `fit`/`fill` scaling, CSS/Canvas video FX, and a second fullscreen output window).
- **Tests & Smoke:** 187/187 unit tests passing across 19 test files (including `test/video-mixer.test.ts` and 195-device `test/midi.test.ts`), `npx tsc --noEmit` 0 errors, `npm run smoke:audio` passing with `videoSyncChecked: true`.

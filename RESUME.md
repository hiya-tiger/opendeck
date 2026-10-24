# Resume notes

All P1–P6 and Wave 1–5 parity items (including the 195-device hardware catalogue) are implemented, wired, and verified.

## 1. Engine hardening & DVS (complete)

- Reverse with key lock, tempo-independent pitch shift (`±12` semitones),
  ten-minute sample-exact loops, PCM ownership for local files, and an Electron
  smoke test that asserts the PCM engine, pitch shift, censor/return-mode,
  custom FX chains, and 4-stem playback/scratch are all green.
- `DvsTransport` supports `calibrate(left, right)` (RMS gain + phase balance),
  `internal` / `relative` / `absolute` modes, and `computeDriftCorrection` for
  continuous phase lock without pitch warble.
- Rust native decode (`opendeck-audio`, `opendeck-core`, `opendeck-app`) passes
  all 39 unit tests.

## 2. Serato export, embedded tags, SQLite columns, and full undo (complete)

- `Write tags` (`writeSeratoTags`) embeds `Serato Markers2`, `Serato Markers_`,
  `Serato BeatGrid`, and `BPM`/`Key` metadata into MP3 (`TBPM`/`TKEY`), WAV, AIFF,
  FLAC (`BPM`/`INITIALKEY`), and MP4/M4A (`tmpo`/`initialkey` +
  `----:com.serato.dj:*`), verifying byte-identical audio payloads before
  committing.
- `decodeDatabaseTracks` and `encodeDatabase` round-trip `database V2` tracks
  with zero loss, preserving `utpc` (`playCount`), `ulbl` (track colour), `bbgl`
  (beatgrid lock), and unknown `otrk` sub-chunks (`extraChunks`).
- `writeSeratoLibraryExport` atomically writes `_Serato_/database V2`,
  `neworder.pref`, and `Subcrates/*.crate` while refusing when Serato DJ is
  running and recording both overwritten and newly created files in the undo
  manifest so `undoLastSeratoWrite()` restores or removes them cleanly.
- `writeSeratoSqliteColumns` and `readSeratoSqliteColumns` validate the SQLite 3
  header, back up the database into `serato-undo`, and persist `\x1e`-separated
  column lists in `container_asset_list_columns` (`usage=1`).

## 3. P3/P6 feature wall: 4 decks, BeatGrid editor, Playlists, Smart Crates, FX (complete)

- **Four decks & Mixer:** Decks `A`, `B`, `C`, `D` with `1/3` and `2/4` switching,
  per-deck crossfader assignment (`A`/`B`/`THRU`), crossfader reverse (Hamster),
  channel fader curves (`linear`/`log`/`sharp`), booth output gain, and
  instant-doubles (`cloneFrom`).
- **BeatGrid editor:** `beatgrid.ts` + `Deck` methods (`setGridDownbeatHere`,
  `shiftGrid`, `adjustGridBpm`, `scaleGridBpm`, `setBeatGridLocked`,
  `toggleBeatGridLocked`, `tapGridBpm`) with lock enforcement (`bbgl`).
- **Return-Mode & Reverse-on-Hold:** `setReturnMode` (`SLIP`) and
  `beginReverseOnHold` / `endReverseOnHold` (`CENSOR`) backed by virtual timeline
  helpers `slipReleasePosition` and `censorReleasePosition`.
- **Library wall:** `PlaylistStore` (create/rename/reorder/remove),
  `LivePlaylistStore` (`all`/`any` rule evaluation across text/numeric/boolean
  fields), 6-colour Serato track colour cycling, `playCount` increment/sort,
  scratchpad, played log + CSV export, and headphone preview.
- **Expanded FX & Custom FX chains:** 15 FX definitions (`filter`, `echo`,
  `reverb`, `flanger`, `phaser`, `crusher`, `delay`, `gate`, `tremolo`,
  `autopan`, `tape-stop`, `brake`, `combo-filter-echo`, etc.) plus
  `CustomFxStore` savable multi-slot presets.

## 4. Verification summary

- `npm test`: **187/187 passing** across 19 test files (including 195-device hardware catalogue tests in `test/midi.test.ts`).
- `npx tsc --noEmit`: **0 errors**.
- `cargo test`: **39/39 passing** (`opendeck-app` 2, `opendeck-audio` 30,
  `opendeck-core` 7).
- `npm run build`: clean (`dist/main.cjs`, `dist/preload.cjs`, `renderer/app.js`,
  `renderer/dvs.js`, `renderer/analysis-worker.js`).
- `npm run smoke:audio`: `ok: true` (`deckEngine: "pcm"`, `deckLatency: 0.008`,
  `pitchShiftChecked: true`, `censorChecked: true`, `customFxChecked: true`,
  `reversed: true`, `stemParts: 4`, `stemScratch: true`,
  `stemPlatterScratch: true`).

## Phase 7 — Video Mixing (Completed)
- `src/renderer/engine/video-mixer.ts`: 4-deck (`A`/`B`/`C`/`D`) position-locked video mixer following play, pause, seek, reverse, and scratch; independent video crossfader (`fade`, `cut`, `add`, `luma`) with optional audio crossfader link; `fit` (letterbox/pillarbox) and `fill` (crop) scaling; brightness/contrast/saturation/B&W/invert FX.
- `renderer/video-output.html` + `src/main/main.ts`: Secondary fullscreen video output window synced via `BroadcastChannel("opendeck-video-output")` and Electron IPC (`video:open-output`, `video:fullscreen-output`, `video:sync-output`).
- Verified by `test/video-mixer.test.ts` (187/187 total Node tests passing) and `scripts/audio-smoke-entry.ts` (`videoSyncChecked: true`).

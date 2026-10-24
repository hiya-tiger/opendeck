# OpenDeck Technical Refactoring & Suite Parity Plan (`REFACTOR_PLAN.md`)

## 1. Architecture & Repository Relationship (`opendeck` vs `opendeck-desktop`)
- **`opendeck`**: Zero-dependency, zero-build browser prototype (`index.html`, `styles.css`, `js/{app,audio,analysis,library,serato,waveform}.js`, 2 CommonJS tests in `test/`). It does **not** import from or link to `opendeck-desktop` at build or runtime.
- **`opendeck-desktop`**: The main TypeScript + Electron + Tauri + Rust DSP application.
  - **Renderer (`src/renderer/`)**: Bundled via `esbuild` (`scripts/build.mjs`) into `renderer/app.js`, `renderer/dvs.js`, and `renderer/analysis-worker.js`. Shared identically between the Electron shell and the Tauri shell (`renderer/tauri-bridge.js`).
  - **Main & Preload (`src/main/`, `src/preload/`)**: Electron main process (`dist/main.cjs`) and preload bridge (`dist/preload.cjs`) exposing `window.opendeckDesktop`.
  - **DVS & Timecode (`src/dvs/`, `src/timecode/`)**: Timecode LFSR decoder (frozen per D6) and `DvsTransport` carrier/speed/position tracker.
  - **Rust Workspace (`rust/crates/{opendeck-audio,opendeck-core,opendeck-app}`)**: PCM transport, lock-free SPSC ring, live render thread, Symphonia native decode, and Tauri host.

---

## 2. Gap Analysis: Unchecked Definition of Done Items (Section 15 of Manifest & `REPORT.md`)

| DoD Checklist Item | Current Status | Target Files to Refactor / Extend |
|---|---|---|
| **Four decks with 1/3 and 2/4 switching** | 2 decks (`"A" \| "B"`), 2 mixer strips, no deck clone | `src/renderer/engine/deck.ts`, `src/renderer/engine/mixer.ts`, `src/renderer/app.ts`, `src/renderer/dvs-panel.ts`, `renderer/index.html`, `renderer/styles.css` |
| **Beat-grid editor with a working lock flag** | BPM/phase import only; no editor or lock enforcement | `src/renderer/engine/beatgrid.ts`, `src/renderer/engine/deck.ts`, `src/renderer/app.ts`, `renderer/index.html` |
| **Return-mode (Slip) and reverse-on-hold (Censor)** | Not implemented on `Deck` or UI | `src/renderer/engine/deck.ts`, `src/renderer/engine/pad-modes.ts`, `src/renderer/app.ts`, `renderer/index.html` |
| **Full effect set plus user-created savable chains** | 7 fixed effects; no custom savable multi-effect chains | `src/renderer/engine/fx.ts`, `src/renderer/engine/deck.ts`, `src/renderer/app.ts`, `renderer/index.html` |
| **Tempo-independent pitch shift** | `PcmSource.semitones()` only does `0` (keylock) or `12*log2(rate)` | `src/renderer/engine/pcm-source.ts`, `src/renderer/engine/deck.ts`, `src/renderer/app.ts`, `renderer/index.html` |
| **Round trip: write library, import into target, edit, re-import, zero loss** | Missing embedded Key/BPM tags (`TBPM`/`TKEY`, FLAC/MP4 equivalents), missing full `database V2` / `.crate` round-trip reader into `Library`, missing opt-in SQLite `container_asset_list_columns` | `src/renderer/media/serato-id3.ts`, `src/renderer/media/serato-extra.ts`, `src/renderer/media/serato-write.ts`, `src/renderer/media/serato-file.ts`, `src/renderer/media/serato-codec.ts`, `src/main/serato-files.ts` |
| **Undo for every file and library write** | Tag writes have undo + Serato-running check; `_Serato_` library folder export and SQLite column layout lack unified undo and running-Serato refusal | `src/main/serato-files.ts`, `src/main/main.ts`, `src/preload/preload.ts`, `src/renderer/app.ts` |
| **Complete playlist / set-prep / played-log / search / sort / colour / play count wall** | Scratchpad & played-log exist; missing in-app playlist CRUD/reordering, track colour picker, play count column/increment, preview player, list/album-grid modes, column layout, light theme, setup/analysis panel | `src/renderer/media/library-ux.ts`, `src/renderer/media/library.ts`, `src/renderer/app.ts`, `renderer/index.html`, `renderer/styles.css` |
| **Live playlists (Smart Crates)** | None | `src/renderer/media/library-ux.ts`, `src/renderer/media/library.ts`, `src/renderer/app.ts` |
| **Offline mode works with no hardware** | Works implicitly, but lacks explicit Offline/Practice mode toggle, 1/2/4-deck layout switcher, and verification tests | `src/renderer/engine/deck.ts`, `src/renderer/app.ts`, `renderer/index.html` |
| **Timecode control with calibration and drift correction** | Basic offset only; lacks signal RMS/carrier calibration, relative/absolute/internal mode behavior, and continuous drift correction | `src/dvs/transport.ts`, `src/renderer/dvs-panel.ts`, `renderer/index.html` |

---

## 3. Detailed Modular Refactoring Specifications

### Module A: `src/renderer/engine/pcm-source.ts` & `src/renderer/engine/deck.ts` (4 Decks, Pitch Shift, Slip/Return-Mode, Censor/Reverse-on-Hold, Deck Clone, P3 Deck Controls)
1. **Widen `DeckId` Union (`src/renderer/engine/deck.ts`)**:
   - `export type DeckId = "A" | "B" | "C" | "D";`
   - `export const DECK_IDS: readonly DeckId[] = ["A", "B", "C", "D"] as const;`
   - `export type PlaybackMode = "internal" | "relative" | "absolute";`
2. **Tempo-Independent Pitch Shift (`src/renderer/engine/pcm-source.ts` & `deck.ts`)**:
   - In `PcmSource`:
     - `setPitchShift(semitones: number): void` (clamped to `[-12, 12]`)
     - `get pitchShift(): number`
     - Update `private semitones(): number`:
       ```ts
       private semitones(): number {
         const base = this.keylock ? 0 : 12 * Math.log2(Math.max(0.01, Math.abs(this.rate)));
         return base + this.pitchShiftSemitones;
       }
       ```
   - In `Deck`:
     - `setPitchShift(semitones: number): void` / `get pitchShift(): number` — updates `this.pcm` and all `this.stemVoices[id]`, updates `DeckState.pitchShift`.
     - Pure helper `transposeMusicalKey(key: string, semitones: number): { key: string; camelot: string }` for harmonic key display when pitch-shifted.
3. **Return-Mode (`Slip`) & Reverse-on-Hold (`Censor`) (`src/renderer/engine/deck.ts` & `src/renderer/engine/pad-modes.ts`)**:
   - Pure helper in `src/renderer/engine/pad-modes.ts`:
     ```ts
     export function slipReleasePosition(
       anchorPosition: number,
       startedAtMs: number,
       releasedAtMs: number,
       rate: number,
       duration: number,
       loop?: { start: number; end: number } | null,
     ): number
     ```
   - In `Deck`:
     - `setReturnMode(enabled: boolean): void`, `get returnMode(): boolean`, `get slipActive(): boolean`, `get shadowCurrentTime(): number`
     - `beginSlipAction(nowMs?: number): void` / `endSlipAction(nowMs?: number): number | null` — called automatically by `beginScratch`/`endScratch`, `jumpHotCue` (when held), loop rolls, and `beginReverseOnHold`/`endReverseOnHold`.
     - `beginReverseOnHold(nowMs?: number): void` / `endReverseOnHold(nowMs?: number): void` / `get reverseOnHold(): boolean` — engages reverse playback (`-Math.abs(this.rate)`) while held and snaps to the forward shadow position (`slipReleasePosition`) upon release.
4. **Deck Clone (`Instant Doubles`) & P3 Deck Features (`src/renderer/engine/deck.ts`)**:
   - `async cloneFrom(source: Deck): Promise<void>`: copies `pcmBuffer`, `pcmHash`, `info`, `hotCues`, `cuePoint`, `loopStart`, `loopEnd`, `loopBeats`, `loopActive`, `rate`, `tempoPercent`, `keylock`, `pitchShift`, `currentTime`, and `playing` state from `source` to `this` deck.
   - `eject(): boolean` (refuses when `this.loadLocked && this.playing`, clears deck otherwise).
   - `setLoadLock(locked: boolean): void` / `get loadLocked(): boolean` (blocks `load()` and `eject()` while playing).
   - `setRepeat(enabled: boolean): void` / `get repeat(): boolean` (restarts at `0` on track end in `tick()`).
   - `setAutoplay(enabled: boolean): void` / `get autoplay(): boolean` (triggers `onTrackEnd` callback so library/queue loads next track).
   - `nudge(deltaRate: number, durationMs?: number): void` (momentary pitch bend).
   - `cyclePitchRange(): 8 | 16 | 50` (cycles `8 -> 16 -> 50 -> 8`).
   - `setTrackGainDb(db: number): void` / `get trackGainDb(): number` / `autoGainDb(): number` (computes RMS-based auto-gain toward `-12 dBFS` target).
   - `setStartStopRamp(startSeconds: number, stopSeconds: number): void` (turntable start/brake ramp).
   - `setPlaybackMode(mode: PlaybackMode): void` / `get playbackMode(): PlaybackMode`.
   - `setTimeDisplayMode(mode: "elapsed" | "remaining"): void` / `get timeDisplayMode(): "elapsed" | "remaining"`.
   - `get trackEndWarning(): boolean` (true when playing and remaining time is `<= 30` seconds).
   - `setIsolatorMode(enabled: boolean): void` / `get isolatorMode(): boolean` (switches EQ low/mid/high to full kill at minimum).

### Module B: `src/renderer/engine/mixer.ts` (4-Deck Mixer, Isolator/Crossfader Reverse/Channel Curve/Booth/Limiter/Record Formats)
- Extend `Mixer`:
  - `setCrossfader(value: number, curve?: CrossfaderCurve)` applies `gains.a` to Decks `A` and `C` (left bus) and `gains.b` to Decks `B` and `D` (right bus), or swaps `gains.a`/`gains.b` when `crossfaderReverse` is `true`.
  - `setCrossfaderReverse(reversed: boolean): void` / `get crossfaderReversed(): boolean` (Hamster switch).
  - `export type ChannelFaderCurve = "linear" | "steep" | "cut";`
  - `export function channelFaderGain(value: number, curve: ChannelFaderCurve = "linear"): number`
  - `setChannelCurve(curve: ChannelFaderCurve): void` / `get channelCurve(): ChannelFaderCurve`
  - `readonly booth: GainNode` — independent booth output bus (`setBoothGain(value: number): void`, `get boothGain(): number`).
  - `get limiterWarning(): boolean` — returns `true` when `this.limiter.reduction < -0.5` or master level `> 0.92`.
  - `setPreferredRecordFormat(mime: string): void` / `get preferredRecordFormat(): string` — supports `"audio/webm;codecs=opus"`, `"audio/webm"`, `"audio/ogg;codecs=opus"`, `"audio/wav"`.

### Module C: `src/renderer/engine/beatgrid.ts` (Beat-Grid Editor with Working Lock Flag)
- Add structured beat-grid editing API in `src/renderer/engine/beatgrid.ts`:
  ```ts
  export interface EditableBeatGrid {
    bpm: number;
    firstBeatSeconds: number;
    locked: boolean;
    markers: BeatGridMarker[];
  }
  export function createBeatGrid(bpm: number, firstBeatSeconds?: number, locked?: boolean, markers?: BeatGridMarker[]): EditableBeatGrid;
  export function setGridDownbeat(grid: EditableBeatGrid, downbeatSeconds: number): EditableBeatGrid;
  export function shiftBeatGrid(grid: EditableBeatGrid, deltaSeconds: number): EditableBeatGrid;
  export function scaleBeatGridBpm(grid: EditableBeatGrid, factor: number): EditableBeatGrid;
  export function adjustBeatGridBpm(grid: EditableBeatGrid, deltaBpm: number): EditableBeatGrid;
  export function setBeatGridLock(grid: EditableBeatGrid, locked: boolean): EditableBeatGrid;
  export function toSeratoBeatGridMarkers(grid: EditableBeatGrid): BeatGridMarker[];
  ```
- Every mutating function (`setGridDownbeat`, `shiftBeatGrid`, `scaleBeatGridBpm`, `adjustBeatGridBpm`) checks `if (grid.locked) return grid;` so a locked beat grid cannot be overwritten until unlocked.
- Wire Beat-Grid Editor bar into `deckTemplate` (`renderer/index.html` & `src/renderer/app.ts`) with buttons: `SET 1` (downbeat at playhead), `SLIP ◀`, `SLIP ▶`, `BPM −`, `BPM +`, `÷2`, `×2`, and `LOCK` toggle (`aria-pressed`).

### Module D: `src/renderer/engine/fx.ts` & `src/renderer/engine/deck.ts` (Full Effect Set + User-Created Savable Chains)
- Expand `FxType` in `src/renderer/engine/fx.ts`:
  - Add `"tremolo" | "gate" | "tape-echo" | "hpf" | "lpf" | "custom"` alongside `"off" | "echo" | "delay" | "reverb" | "filter" | "flanger" | "phaser" | "crush"`.
- Add user-created savable FX chains (`CustomFxChain`, `CustomFxStore`):
  ```ts
  export type SingleFxType = Exclude<FxType, "off" | "custom">;
  export interface CustomFxChain {
    id: string;
    name: string;
    effects: SingleFxType[];
    amount: number;
    wet: number;
    division: Division;
  }
  export class CustomFxStore {
    constructor(initial?: CustomFxChain[]);
    list(): CustomFxChain[];
    save(chain: Omit<CustomFxChain, "id"> & { id?: string }): CustomFxChain;
    remove(id: string): boolean;
    get(id: string): CustomFxChain | undefined;
  }
  ```
- Update `Deck.buildChain()` and `Deck.setCustomFxChain(effects: SingleFxType[])` so a chain of 1–3 effects is wired in series in Web Audio (`input -> stage1 -> stage2 -> stage3 -> wet -> output`).

### Module E: `src/renderer/media/serato-*.ts` & `src/main/serato-files.ts` (Full Round-Trip + Key/BPM Tags + SQLite Column Layout + Unified Undo)
1. **Embedded Key & BPM Tag Read/Write**:
   - `src/renderer/media/serato-id3.ts`:
     - Add `readId3TextFrames(bytes: Uint8Array): { bpm?: number; key?: string; title?: string; artist?: string }` reading `TBPM` and `TKEY`.
     - Extend `writeSeratoGeoB(bytes, updates, padding, textUpdates?: { TBPM?: string; TKEY?: string })` to write/update `TBPM` and `TKEY` ID3v2 text frames while preserving unknown frames in original order.
   - `src/renderer/media/serato-extra.ts`:
     - Read/write `BPM` and `INITIALKEY` in FLAC `VORBIS_COMMENT`, and `tmpo` / freeform `initialkey` (plus `----:com.serato.dj:`) in MP4 `ilst`.
   - `src/renderer/media/serato-write.ts` & `src/renderer/media/serato-file.ts`:
     - Pass optional `bpm` and `key` through `seratoTagUpdates` / `rewriteSeratoTags` and return them in `readSeratoTagsFromFile`.
2. **Full Library & File Write Undo + Running-Serato Check + SQLite `container_asset_list_columns`**:
   - In `src/main/serato-files.ts`:
     - `writeSeratoLibraryExport(request: { rootDir: string; files: Record<string, Uint8Array> }): Promise<SeratoWriteResult>`:
       - Refuses if `await isSeratoRunning()` is true.
       - Backs up existing `_Serato_/database V2`, `_Serato_/neworder.pref`, and `_Serato_/Subcrates/*.crate` into the `serato-undo/<id>` manifest (recording newly created paths as `created: true` so `undoLastSeratoWrite()` removes newly created files and restores overwritten files byte-for-byte).
     - `writeSeratoSqliteColumns(request: { sqlitePath: string; columns: Array<{ name: string; width?: number }> }): Promise<SeratoWriteResult>`:
       - Opt-in helper for Serato DJ Pro 4's `Serato Library.sqlite` table `container_asset_list_columns` (literal string `container_asset_list_columns`, usage `1`, ASCII `0x1e` separator).
       - Refuses if `await isSeratoRunning()` is true, verifies SQLite magic header (`SQLite format 3\0`), backs up the file into `serato-undo/<id>`, and updates/records the column layout with full undo support.
   - Expose `serato:export-library` and `serato:sqlite-columns` in `src/main/main.ts` and `src/preload/preload.ts`.

### Module F: `src/renderer/media/library-ux.ts` & `src/renderer/media/library.ts` (Playlists, Live Playlists / Smart Crates, Track Colour, Play Count, Preview, Display Modes)
- In `src/renderer/media/library-ux.ts`:
  - **Track Colour & Play Count**:
    - Extend `TrackLike` and `TrackSortKey` (`"title" | "bpm" | "key" | "duration" | "crate" | "playCount" | "color"`).
    - `incrementPlayCount<T extends { playCount?: number }>(track: T): number`
  - **Playlists (`PlaylistManager`)**:
    - Create, rename, delete, reorder playlists (`createPlaylist`, `deletePlaylist`, `renamePlaylist`, `addTrackToPlaylist`, `removeTrackFromPlaylist`, `movePlaylistTrack`), plus per-playlist search vs global search.
  - **Live Playlists (`LivePlaylist` / Smart Crates)**:
    - Rule-based playlists (`field: "bpm" | "key" | "title" | "crate" | "color" | "playCount" | "duration"`, `operator: "contains" | "equals" | "gt" | "lt" | "between"`, `value: string | number`, `valueTo?: number`, `match: "all" | "any"`).
    - `evaluateLivePlaylist<T extends TrackLike>(playlist: LivePlaylist, tracks: readonly T[]): T[]` — pure, deterministic filter that updates automatically when tracks or rules change.
- In `src/renderer/media/library.ts` & `src/renderer/app.ts`:
  - Add Track Colour cell (18-colour palette dot/cycle button), Play Count column (`plays`), Load buttons for active decks (`A`/`B`/`C`/`D`), Preview button (`▶` audition via preview `Audio` / `PcmSource` node without loading a deck), List vs Album-Grid view mode toggle, Playlist & Live Playlist sidebar/bar, Light Theme (`Day Mode`) toggle, CPU/Engine meter, and Setup/Analysis settings modal.

### Module G: `src/dvs/transport.ts` & `src/renderer/dvs-panel.ts` (Timecode Calibration, Drift Correction, Playback Modes, Offline Mode)
- In `src/dvs/transport.ts`:
  - Add `DvsCalibration`:
    ```ts
    export interface DvsCalibration {
      referenceRms: number;
      gainScale: number;
      noiseFloor: number;
      carrierHz: number;
      calibratedAt: number;
    }
    ```
  - Add `calibrate(left: Float32Array, right: Float32Array): DvsCalibration` to `DvsTransport`.
  - Add `computeDriftCorrection(desiredSeconds: number, actualSeconds: number, baseRate: number, maxCorrection?: number): { correctedRate: number; driftSeconds: number; shouldSnap: boolean }` to smoothly correct clock/platter drift (`0.005s` to `0.09s` error) via proportional rate adjustment while snapping on errors `> 0.09s`.
  - Support `"internal" | "relative" | "absolute"` modes in `DvsTransport` and `dvs-panel.ts` (in `"relative"` mode, needle drops adjust offset instead of jumping track position; in `"absolute"` mode, track position follows absolute timecode position + calibrated offset; in `"internal"` mode, timecode is ignored and deck runs on internal transport).

---

## 4. Execution & Verification Order
1. **Step 1**: Implement engine upgrades (`pcm-source.ts`, `beatgrid.ts`, `fx.ts`, `pad-modes.ts`, `mixer.ts`, `deck.ts`) and verify all existing tests + new unit tests pass.
2. **Step 2**: Implement DVS calibration, drift correction, and playback modes (`src/dvs/transport.ts`, `src/renderer/dvs-panel.ts`).
3. **Step 3**: Implement Serato round-trip completion (Key/BPM tags in `serato-id3.ts`/`serato-extra.ts`/`serato-write.ts`/`serato-file.ts`, library folder export + SQLite `container_asset_list_columns` + unified undo in `src/main/serato-files.ts`, `src/main/main.ts`, `src/preload/preload.ts`).
4. **Step 4**: Implement Library UX wall + Playlists + Live Playlists + Track Colour + Play Count (`src/renderer/media/library-ux.ts`, `src/renderer/media/library.ts`).
5. **Step 5**: Wire 4-deck UI (`1/3` and `2/4` switching), Beat-Grid Editor, Slip/Censor, Custom FX, Pitch Shift, Offline Mode, Light Theme, Preview Player, and Setup Panel in `renderer/index.html`, `renderer/styles.css`, and `src/renderer/app.ts`.
6. **Step 6**: Update `docs/serato-parity.md`, `docs/decisions.md`, `RESUME.md`, and `REPORT.md`, sync to Windows (`C:\Users\Donie\OpenBot\Agents\agent-a13f24f0-b510-4bf3-b444-26727c89bc34\opendeck-desktop`), and run `npm test`, `npx tsc --noEmit`, `npm run build`, and `cargo test`.

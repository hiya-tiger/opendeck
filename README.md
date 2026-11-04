# OpenDecks (Desktop)

Open-source 4-deck DJ application with sample-accurate PCM transport, real DVS timecode control, 4-part htDemucs stem separation, 10 performance pad modes, a 32-slot sampler, 15 built-in FX with savable custom chains, a 195-device MIDI/HID/DVS hardware catalogue, zero-loss Serato library interoperability, and Phase 7 deck-locked Video Mixing. Built with a TypeScript UI running inside an Electron shell or a native Rust/Tauri shell (`OpenDecks.exe` / `bin/opendeck-app.exe`), MIT licensed, with zero telemetry.

---

## Screenshots

### 2-Deck Performance, DVS Timecode & Library / Smart Crates
![OpenDecks 2-Deck Performance, Stems, DVS & Library](screenshots/opendeck-p7-performance.png)

### 4-Deck Performance Mode (Decks A, B, C & D + 4-Channel Mixer)
![OpenDecks 4-Deck Performance Mode](screenshots/opendeck-p7-four-decks.png)

### Phase 7 Video Mixing (Deck-Locked Transport, Video Crossfader & 2nd Fullscreen Output)
![OpenDecks Phase 7 Video Mixer](screenshots/opendeck-p7-video-mixer.png)

### Vertical Waveforms & Serato-style Library Management
![OpenDecks Vertical Waveforms & Library](screenshots/opendeck-p7-vertical-library.png)

---

## Features (Phases P0–P7 Complete)

### P0 & P1 — Sample-Accurate PCM Audio Engine, 4 Decks & Transport
- **PCM AudioWorklet & Rust Engine:** Decodes tracks into linear PCM (`PcmSource` / `opendeck-audio`), with true reverse playback and key-lock pitch-time stretching (`signalsmith-stretch` + tempo-independent semitone pitch shift `±12 st`).
  Latency, measured on Windows 10 / Intel i7-4720HQ / 48 kHz with `npm run smoke:audio`: **8 ms** engine block latency (`signalsmith` `latency()`, the D18 figure), **10 ms** `AudioContext.baseLatency`, **39 ms** `outputLatency` — so roughly **57 ms** from `play()` to the speaker on that machine, not 10 ms. The 8 ms figure is engine-only and deliberately excludes device latency.
  Loop wrap is handled inside the stretch node's schedule; reverse-loop correction runs in `tick()` and is **coarse, about one UI frame**, not sample-accurate. A `<1 sample` claim is not supported and has been removed.
- **4 Decks (`A`, `B`, `C`, `D`) & Instant Doubles:** Switch between 2-deck (`A/B`) and 4-deck (`A/B/C/D`) layouts (`1/3` and `2/4` deck switching), 4-channel mixer (`C`, `A`, `MASTER`, `B`, `D`), crossfader curve selector (`Smooth`, `Fast`, `Cut`) with Hamster reverse (`HAM`), and one-click **Instant Doubles (`2×`)** cloning track, playhead, BPM, loop, and hot cues across decks.
- **Editable Beatgrids & Slip / Censor Modes:** Slide beatgrid markers (`◀` / `▶`), set downbeat at playhead (`SET 1`), halve/double BPM (`÷2` / `×2`), tap BPM (`TAP`), lock beatgrids (`LOCK`), **Return-Mode (`SLIP`)** (underlying timeline continues while scratching, looping, or triggering hot cues), and **Reverse-on-Hold (`CENSOR`)** (plays backward while held and snaps back to the forward timeline on release).
- **Frequency-Coloured Waveforms & Vinyl Platter Scratch:** Scrolling overview and zoom waveforms coloured by bass/mid/high energy bands (or active 4-part stems), spinning vinyl artwork (`ID3v2 APIC`, MP4 `covr`, or automatic iTunes cover lookup), and pointer-drag vinyl scratching.

### P2 — 10 Performance Pad Modes, 32-Slot Sampler & 15 FX + Custom Chains
- **10 Pad Modes per Deck:**
  1. `Hot Cue` (8 color-coded slots per deck)
  2. `Cue Loop` (triggers hot cue + activates beat loop; Shift halves/doubles loop length)
  3. `Saved Loop` (8 persistent saved loop slots per track)
  4. `Roll` (momentary loop rolls `1/32`–`4` beats with Slip return on release)
  5. `Slicer` (non-looping 8-beat moving domain)
  6. `Slicer Loop` (looping 8-beat domain)
  7. `Sampler` (triggers the currently selected Sampler bank)
  8. `Scratch Bank` (8 rapid-switch scratch samples/tracks with instant return)
  9. `Pitch Play` (chromatic semitone pad grid around the active hot cue with Up/Mid/Down ranges)
  10. `Stems` (Pads 1–4 toggle Vocal/Melodic/Bass/Drums mute; Pads 5–8 trigger Stem FX: Vocal Echo, Instrumental, Drums Echo-Out, Stem Roll)
- **32-Slot, 4-Bank Sampler (`Banks A–D × 8 Pads`):** Per-slot playback mode (`Trigger`, `Hold`, `On/Off`, `Repeat`), group/choke assignments, per-slot gain & mute, synthesized default kit + custom sample drop, and `Numpad 1–8` shortcuts.
- **15 Built-in FX + Savable Multi-FX Chains:** `echo`, `delay`, `reverb`, `filter`, `flanger`, `phaser`, `bitcrush`, `tremolo`, `autofilter`, `tape-delay`, `ping-pong`, `noise-sweep`, `spiral-echo`, `trans-gate`, and `combo-filter-echo`, plus `CustomFxStore` for saving, recalling, and exporting multi-FX chains.

### P3 — 4-Part Stem Separation (`htDemucs`)
- **4-Part Offline & Real-Time Stems (`Drums`, `Bass`, `Other`, `Vocals`):** Local `htDemucs` ONNX separation cached in `.opendeck-stems/` by track hash, per-stem level sliders, Mute (`M`), Solo (`S`), Filter (`F`), and Stem FX (`X`) controls, quick **Acapella (`VOCALS`)** and **Instrumental (`INST`)** isolation buttons, and full stem voice tracking during platter and DVS scratching.

### P4 & P5 — Zero-Loss Serato Library Interoperability, Smart Crates & Day Mode
- **Zero-Loss Serato Round-Trip:** Reads and writes `_Serato_/database V2`, `_Serato_/Subcrates/*.crate`, `GEOB`/`covr`/`APIC` embedded markers (`Serato Markers_`, `Serato Markers2`, `Serato Autotags`, `Serato BeatGrid`, `Serato Overview`), and Serato 4.x `master.sqlite` (`container_asset_list_columns`) while preserving unknown `otrk` sub-chunks and `utpc` play counts byte-for-byte.
- **Unified Undo Backup:** Every embedded tag write and `_Serato_` library export creates an automatic backup snapshot that can be restored in one click (`Undo tags` / `restoreLibraryBackup`).
- **Smart Crates, Scratchpad & History:** Rule-based Smart Crates (`contains`, `equals`, `>=`, `<=`, `inRange` across BPM, key, crate, title, and play count), Prepare Scratchpad, Played History with CSV export, high-contrast **Day Mode**, and **Offline / Practice Mode**.

### Streaming sources (in-deck, partner APIs; see [D42](docs/decisions.md) and [setup](docs/streaming-setup.md))
- **What it is:** a pluggable `StreamSource` interface (`src/renderer/streaming/`) with adapters for **Beatport LINK**, **Beatsource LINK**, **TIDAL** and **SoundCloud**, written against their official APIs. Streamed tracks sit in the library and load onto decks A–D like local files. Nothing opens a separate player window.
- **Needs partner API keys.** OpenDecks ships no service credentials. Until you paste a key from the service's developer or partner programme, each source says "needs partner API key" and does nothing else. Beatport/Beatsource LINK keys are issued only to licensed DJ-software partners, and each DJ also needs their own subscription.
- **Full deck features only for audio the service hands out unencrypted** (for example SoundCloud's public-API MP3 streams). That audio is decoded once and gets BPM/key analysis, waveform, stems and FX.
- **DRM services are monitor-only.** When a service only allows its own Widevine player (most of TIDAL, Spotify, Apple Music, Deezer), OpenDecks embeds that official player in the deck panel and labels it monitor-only: DRM audio cannot reach Web Audio, so no EQ, FX, waveform, sync or analysis. Mix it in with System audio capture. Stock Electron has no Widevine CDM, so in this build those players show previews only; full tracks need a Widevine-enabled Electron (castlabs ECS).
- **Not verified against live partner accounts yet.** The OAuth flows and API calls follow the public docs and are covered by unit tests with recorded response shapes, but have not run against real partner keys. OpenDecks never decrypts streams, scrapes service pages or uses yt-dlp.

### P6 — DVS Timecode Control & 195 Supported Hardware Devices
- **Real DVS Timecode Decoder (`src/timecode`, `src/dvs`):** Supports **Serato CV02 Vinyl (Side A/B, 1 kHz)**, **Serato Control CD**, **Traktor Scratch MK2 (2 kHz)**, **MixVibes V2 / 7" (1.3 kHz)**, and **Pioneer rekordbox DVS (1 kHz)** with Absolute (`ABS`), Relative (`REL`), and Internal (`INT`) modes, needle-drop seeking, 1-second reference level & phase calibration (`Set needle position`), drift correction, and circular X-Y scope display.
- **195 Supported Hardware Devices (`src/renderer/midi/profiles.ts`, [`docs/hardware.md`](docs/hardware.md)):** Built-in plug-and-play device recognition, auto-presets, 4-deck MIDI Learn (`mix.chA`–`mix.chD`, Decks `A–D`), and DVS audio interface auto-binding across **195 controllers, mixers, DVS interfaces, CDJs, motorized turntables, and accessories** from AlphaTheta, Pioneer DJ, Rane, Denon DJ, Numark, Hercules, Roland, Native Instruments, Reloop, Allen & Heath, DJ TechTools, Korg, Akai, Novation, Vestax, Gemini, Mixars, Stanton, Sony, Behringer, and Monster.

### P7 — Deck-Locked Video Mixing & Fullscreen Secondary Output
- **Per-Deck Video Slots (`Decks A–D`):** Load a video file (`MP4`, `WebM`, `MOV`, `M4V`, `MKV`, `OGV`) onto any deck or automatically attach video when loading a video track; video playback is position-locked to deck transport across `play`, `pause`, `seek`, `loop`, `reverse` (`Censor`), and platter/DVS `scratch`.
- **Independent Video Crossfader & Blend/Scale Modes:** Dedicated video crossfader (`-1..1`) that operates independently or linked to the audio crossfader (`Link Audio XF`), 4 blend modes (`Fade`, `Cut`, `Add`, `Luma`), `Fit (Letterbox)` and `Fill (Crop)` aspect-ratio scaling, and per-deck video FX (`Brightness`, `Contrast`, `Saturation`, `Monochrome B&W`, `Invert`).
- **Second Fullscreen Output Window (`renderer/video-output.html`):** Open a dedicated secondary output window (`Open 2nd Output Window` / `Fullscreen Output`) synced at 60 fps via `BroadcastChannel` and Electron IPC for external projectors, monitors, or OBS capture.

---

## Quick Start & Windows `.exe` Executable

### Run the Prebuilt Windows Executable
- Release artifact: **`OpenDecks.exe`** (standalone, no installer).
- From this tree: `npm run package:win` produces **`release/OpenDecks-win32-x64/OpenDecks.exe`** (Electron bundle) plus a small **`OpenDecks.exe`** launcher at the repo root.
- **`bin/opendeck-app.exe`** is the Rust/Tauri build. It is a development and probe harness, not the product shell — see `docs/mobile/ADR-D38.md`.
- The file still checked in at the repo root as `OpenDeck-win64.zip` → `OpenDeck.exe` is the **previous** build (pre-rename, 0.1.6 era) and is kept only so existing links do not break. Prefer a release asset over the in-tree copy.

### Build & Run from Source
```bash
npm install
npm start          # builds dist/ + renderer/ bundles and launches OpenDecks Desktop
npm run build      # builds dist/main.cjs, dist/preload.cjs, renderer/app.js, renderer/dvs.js, renderer/analysis-worker.js
npm test           # runs all 19 TypeScript unit & integration test suites (190 tests)
npm run smoke:audio # headless Electron: PCM playback, stems, video transport, and the deck graph transfer function
npm run smoke:link  # headless: two Link nodes converge on tempo/beat/phase over multicast UDP
npm run smoke:ui    # headless: boots the real renderer and fails on any renderer error
npm run package:win # builds standalone Windows bundle + OpenDecks.exe launcher
```

### Rust / Tauri Workspace (`rust/`)
```bash
cd rust
cargo test                         # runs all 39 Rust unit tests across opendeck-core, opendeck-audio, opendeck-app
cargo build --release -p opendeck-app
```

---

## Verification Status

- **TypeScript Typecheck (`npx tsc --noEmit`):** `0 errors`
- **Node Unit & Integration Tests (`npm test`):** `270/270 passing` across 26 test files (see the `test` script in `package.json`; `stream-sources` covers the streaming adapters)
- **Rust Workspace Tests (`cargo test`):** `39/39 passing` (`opendeck-core`: 7, `opendeck-audio`: 30, `opendeck-app`: 2)
- **Headless Electron Audio + Stems + Video Smoke Test (`npm run smoke:audio`):**
  ```json
  {"ok":true,"deckEngine":"pcm","looped":true,"deckPitch":true,"pitchShiftChecked":true,"censorChecked":true,"customFxChecked":true,"reversed":true,"deckPlaying":true,"stemParts":4,"stemScratch":true,"stemPlatterScratch":true,"stemPlaying":true,"stemEngine":"pcm","videoSyncChecked":true}
  ```

---

## Documentation

- [Serato Parity Matrix (P0–P7)](docs/serato-parity.md): Full phase status and feature matrix.
- [Hardware Controllers & 195-Device Catalogue](docs/hardware.md): Supported controllers, DVS mixers/interfaces, media players, and MIDI Learn targets.
- [Library Interoperability](docs/interop.md): Serato crate, database V2, SQLite, and tag formats.
- [Audio Engine](docs/engine.md): PCM AudioWorklet & Rust transport architecture and latency budget.
- [Architecture Decisions (D1–D32)](docs/decisions.md): Design records across Phases P0–P7.
- [Streaming Setup](docs/streaming-setup.md) & [Third-Party Notices](NOTICE).

---

## Legal

OpenDecks is licensed under the MIT License. It is an independent project and is not affiliated with, sponsored by, or endorsed by Serato, AlphaTheta (rekordbox), Native Instruments (Traktor), or any other DJ vendor. Product names are used solely to describe file-format and hardware compatibility. Third-party dependencies and their licenses are listed in [NOTICE](NOTICE).

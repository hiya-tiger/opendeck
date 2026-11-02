# MyGo + Rust vs Electron/TypeScript: benchmark

Question (Donovan, 2026-11-01): would rewriting OpenDecks as a MyGo shell
(github.com/egoist/mygo, MIT, OS webview) with a Rust core (+ ONNX Runtime
for stems) be *clearly* faster than today's Electron/TypeScript build on
Windows, macOS and Flatpak Linux? It does not need to be 4x; the bar is in
`Hark-decisions.md` (verdict rule).

This is a **benchmark prototype**, not a port of the app. Everything lives
under `bench/` and nothing in `src/` changed.

## What was built

| Piece | Where | What it is |
|---|---|---|
| Fixtures | `bench/fixtures/gen.ts` | Seeded, byte-identical on every runner: 6 synthetic 120 s stereo tracks (44.1 kHz f32, 120-174 BPM, major/minor chords), a Serato `database V2` with 20 000 tracks, 100 crates x 200 paths, 2 000 Markers2 + BeatGrid tag blobs, an `export.pdb` with 20 000 tracks / 2 000 artists / 200 playlists / 20 000 entries (via `test/helpers/pdb-builder.ts`), 2 000 ANLZ `.EXT` files with PCO2 cues. |
| Today (TS) | `bench/ts/*.ts` | The app's own functions (`analyzeBuffer`, `decodeDatabase`, `decodeCrate`, `decodeMarkers2`, `decodeBeatGrid`, `parsePdb` + `playlistPaths`, `parseAnlzCues`, streamed SHA-256 as in `separation.ts`), bundled with esbuild and run in **Electron 44's own V8** (`ELECTRON_RUN_AS_NODE=1`). Analysis goes through `defaultPoolSize(cpus)` workers, like the app's `AnalysisScheduler`. Stems use `providerPlans()` / `cpuSessionOptions()` from `src/main/stems/core.ts` with onnxruntime-node 1.20.1. |
| Rust core | `bench/rs` (crate `od-bench`) | Line-by-line ports. `analysis.rs` keeps JS numerics exactly (f64 locals, f32 stores where TS writes a `Float32Array`, JS `Math.round` semantics); the four passes of `analyzeBuffer` run on separate cores with `rayon::join`, tracks run on a pool of the same size as the app's. `library.rs` ports the Serato, PDB and ANLZ parsers; parsing is spread over cores, file reads are not. Hashing uses `ring` (the same BoringSSL/OpenSSL assembly Node uses), files in parallel. |
| Rust stems | `bench/rs/src/bin/od-stems.rs` | `ort` 2.0.0-rc.9 with `load-dynamic`, loading **the same onnxruntime 1.20.1 library** that onnxruntime-node ships on that platform, the same htdemucs model (sha256 d05c269d...), the same chunk plan (343 980 frames, 1/4 overlap) and session options (CPU: graph optimisation disabled, sequential, mem pattern on, no arena; GPU EP: optimisation "all", DirectML on Windows, CoreML on macOS). Variants for the stems fallback: logical-core threads, optimisation "all" on CPU, two sessions in parallel. |
| MyGo shell | `bench/shell/main.go` | MyGo webview window (WebView2 / WKWebView / WebKitGTK 4.1) loading the existing `renderer/` (index.html + app.js) as its frontend. Playback test pages are served from a loopback HTTP server (WebKitGTK cannot play media from custom schemes). |
| Harness | `bench/harness/` | `run.sh` runs every leg on a runner; `shell.py` measures cold start (spawn to the second animation frame after the renderer's scripts ran), idle RAM (process tree RSS 8 s after first frame; on macOS plus the WebKit XPC processes), installed payload size, and the playback test; `summarize.py` builds the tables and `verdict.json`. |
| CI | `.github/workflows/bench-mygo-rust.yml` | windows-latest, macos-latest (arm64), ubuntu-latest. On Linux **both** sides run inside one Flatpak (`dev.opendecks.Bench`, org.gnome.Platform 47, built with flatpak-builder). |

## Method

* Same fixtures, same runner, today vs prototype back to back.
* Every CPU workload: 1 warm-up run (JIT / file cache, discarded) + 5 timed
  runs; the table shows medians. Cold start: 1 warm-up + 5 launches.
* Stems: chunk 0 timed on its own (includes first-run setup, the app's time
  to first stems), then 5 chunks; full-track time = session create + chunk 0
  + (chunks - 1) x median chunk, for the 120 s fixture track (21 chunks).
  Quality: SDR of each candidate's stems for chunk 1 against today's CPU
  output; >= 60 dB counts as "the same separation".
* Output equivalence (`bench/equivalence.mjs`, runs on every runner): BPM,
  key and Camelot must be identical; beat phase within 1e-9 s; confidences
  within 1e-6; every waveform peak / band value within 1e-6; the canonical
  text of the whole library scan must have an identical SHA-256; file hashes
  identical.
* Playback glitch test (`bench/ts/playback.ts`): 4 decks of the app's own
  `PcmSource` (AudioWorklet engine; decks C and D with keylock at +3%) looping
  for 300 s. Glitches = the app's own xrun counter (`PcmSource.underruns`) +
  50 ms windows in which `AudioContext.currentTime` advanced less than half
  of wall-clock time.
* Smokes: `npm test`, `tsc --noEmit`, `smoke:ui`, `smoke:audio`, `smoke:link`
  on today's app; `cargo test`; output equivalence; and the renderer loaded
  in the MyGo shell must raise no script errors (the smoke:ui criterion).

## Results

Filled in from the CI run; see the sections below.

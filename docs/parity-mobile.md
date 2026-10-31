# Parity: desktop vs iPadOS vs iOS — Run 1

This is the scoreboard, not a plan. It records what the desktop code does today
and what each mobile surface is *allowed* to do, with the evidence tier of each
claim stated separately.

**Read the tiers literally.** SPECIFIED / SOURCE / COMPILED / UNIT / INTEGRATION
/ SIMULATOR / DEVICE / HARDWARE. No tier implies the next one. A row that is
UNIT is not "almost INTEGRATION"; a row that is SPECIFIED is a decision, not a
partly-built feature.

**Snapshot:** working tree at HEAD `9035f2c` plus uncommitted m1–m3 work, read on
2026-10-30. Desktop cells cite the file that implements the behaviour. Where a
test file is cited, the citation is the test's *existence*; whether it passes on
this machine is BASELINE.md's business, not this table's. Line numbers are given
only for files no other phase is editing; `app.ts`, `deck.ts` and `pcm-source.ts`
are being modified concurrently, so they are cited by file, not by line.

**Why almost every mobile cell is `SPECIFIED`:** no mobile code exists. Run 1
produces decisions, measurements and tests. A mobile cell that said anything
higher would be a claim about code that has not been written, let alone compiled,
run in a simulator or seen a device. The correct honest value is SPECIFIED, and
`no` / `deferred` where the decision was to refuse.

---

## Scoreboard

| # | Feature | Desktop | iPadOS | iOS | Evidence tier (desktop / mobile) | Gap | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Local-file playback (PCM) | yes — `src/renderer/engine/pcm-source.ts` (682), `deck.ts` | SPECIFIED — native surface over Rust core (D36 C) | SPECIFIED | INTEGRATION / SPECIFIED | WKWebView AudioWorklet `[verify]` decides whether the *desktop* worklet code is reusable at all | `npm run smoke:audio` is the desktop evidence; its pass state belongs to BASELINE.md |
| 2 | Transport state machine (one, all surfaces) | yes — `deck.ts` (`tick`, slip, censor, loops) | SPECIFIED — one machine, native | SPECIFIED — same | UNIT / SPECIFIED | Rust `Transport` must become the single owner; a WebView-side copy would be a second machine | Constraint from A4 and D36 §8 |
| 3 | Pitch hold / key lock | yes — `pcm-source.ts` + `signalsmith-stretch` 1.3.2 (D16) | SPECIFIED | SPECIFIED | UNIT / SPECIFIED | `signalsmith-stretch` is a JS/WASM package; the native equivalent is `[verify]` | Reimplementing this is part of D36's 4,639 lines |
| 4 | Independent pitch shift ±12 st | yes — `deck.setPitchShift` (D27) | SPECIFIED | SPECIFIED | UNIT / SPECIFIED | — | Same stretch engine as row 3 |
| 5 | Reverse / censor | yes — `deck.beginReverseOnHold` (D28) | SPECIFIED | SPECIFIED | UNIT / SPECIFIED | Negative rate on a media element is impossible; PCM only | This is why streaming cannot be a deck (D17) |
| 6 | Slip / return mode | yes — `slipEntryPos` in `deck.ts` (D28) | SPECIFIED | SPECIFIED | UNIT / SPECIFIED | — | Ghost timeline is transport state; must live with the one machine |
| 7 | Exact loops (forward and reverse) | yes — `pcm-transport.ts` (189), `deck.ts`; bound measured by m1 H2 | SPECIFIED | SPECIFIED | UNIT / SPECIFIED | The desktop *bound* is a measurement, not a claim; see BASELINE.md | README's "<1 sample" claim is A3 row 05 and is being corrected to the measured value |
| 8 | Beatgrid + lock enforcement | yes — `beatgrid.ts` (205, D29) | SPECIFIED | SPECIFIED | UNIT / SPECIFIED | Pure functions; portable, small | — |
| 9 | Sync (`sync.ts`) | yes — `sync.ts` (58), called from `app.ts` | SPECIFIED | SPECIFIED | UNIT / SPECIFIED | Stays a calculator, never an owner (D35) | — |
| 10 | Tempo authority (one, all surfaces) | yes — `tempo-authority.ts` (194, D35) | SPECIFIED | SPECIFIED | UNIT / SPECIFIED | Moves with the boundary; never duplicated | Link, manual BPM and deck BPM are inputs to it |
| 11 | Hot cues | yes — `deck.ts`, `cue-store.ts`, `serato-tags.ts` | SPECIFIED | SPECIFIED | UNIT / SPECIFIED | Cue persistence on mobile is file-based, not `localStorage` | — |
| 12 | Pad modes (10) | yes — `pad-modes.ts` (175, D23) | SPECIFIED | SPECIFIED | UNIT / SPECIFIED | 44 pt targets vs 24 px controls is a layout rewrite, not a port | Hot Cue, Cue Loop, Loop Roll, Slicer, Beat Jump, Transport, Pitch Play, Scratch, Sequence, Part FX |
| 13 | Sampler (32 slots, 4 banks) | yes — `sampler.ts` (166) | SPECIFIED | SPECIFIED | UNIT / SPECIFIED | Generated voices today; user samples are a D23 revisit | — |
| 14 | Scratch / platter physics | yes — `platter.ts` (54), `scratch-voice.ts` (190), D19 | SPECIFIED | SPECIFIED | UNIT / SPECIFIED | Requires a sample-accurate read position — excludes streams | — |
| 15 | DVS timecode | yes — `src/dvs/transport.ts` (223), `src/timecode/decoder.ts` (240, frozen by D6), internal/relative/absolute (D26) | **no (v1)** — matrix says USB-C class-compliant input is possible; D37 §1 refuses it because of no HAL gain / no aggregate devices and D36 §4 because the decoder is frozen TypeScript | **no** | UNIT / SPECIFIED | **Blocked twice:** hardware (D37 §1) and the frozen TypeScript decoder (D36 §4) | No DEVICE or HARDWARE tier anywhere: no interface has been tested on a device |
| 16 | Mixer (4 ch, curves, hamster, booth) | yes — `mixer.ts` (283, D30) | SPECIFIED — 4 decks | SPECIFIED — 2 decks (4 landscape optional) | UNIT / SPECIFIED | Deck count is a runtime value, not a build variant | — |
| 17 | FX (14 effects + 3 presets) | yes — `fx.ts` (244) + `fx-shell.ts` (28), D30 | SPECIFIED | SPECIFIED | UNIT / SPECIFIED | Every effect is a Web Audio node graph; a native port is new DSP, not a translation | List: echo, delay, reverb, filter, flanger, phaser, crush, autopan, tremolo, gate, tape-stop, tape-stop-quick, brake, combo-filter-echo |
| 18 | Stems (4-part, offline) | yes — Electron main, `separation.ts` (352), `onnxruntime-node` 1.20.1, 165,612,636 B model (D24) | SPECIFIED — offline, opt-in, onnxruntime iOS `[verify]` | **off by default** | INTEGRATION / SPECIFIED | `onnxruntime-node` does not run on iOS (D37 §5); "proven on desktop" does not transfer | Cache: 4 × Int16 × 5 min = 211,680,000 B = 201.9 MiB per deck |
| 19 | Library (crates, playlists, smart crates, artwork) | yes — `library.ts` (549), `library-ux.ts` (555), `artwork.ts` | SPECIFIED — pane + decks + mixer at regular width | SPECIFIED — full-screen push | UNIT / SPECIFIED | `showDirectoryPicker` is Chromium-only (`app.ts`); mobile needs a native picker | — |
| 20 | Serato import (read) | yes — `serato-import.ts`, `serato-codec.ts` (401), `serato-tags.ts` (477) | SPECIFIED | SPECIFIED | UNIT / SPECIFIED | Needs a security-scoped bookmark to the volume `[verify]` (D37 §4) | 6 open `[verify]` items in `decisions.md` apply unchanged |
| 21 | Serato write (tags, crates, column layout) | yes — `serato-write.ts` (169), `serato-export.ts` (218), D8/D9/D10 | **no** | **no** | UNIT / SPECIFIED | Refused: D10's "is Serato running" check is machine-local (`serato-files.ts:85`), so a phone write has that rule unenforced | Mobile writes an export bundle instead; desktop performs the write (D37 §4) |
| 22 | Analysis (BPM, key, peaks, bands) | yes — TypeScript `analyze.ts` (397) + `analysis-worker.ts`; Rust `analyze_mono` in the Tauri harness only | SPECIFIED | SPECIFIED | UNIT / SPECIFIED | Rust analysis is the Tauri harness's only shipping consumer (D38 §6) | — |
| 23 | Waveform display | yes — `media/waveform.ts` (484) | SPECIFIED | SPECIFIED | SOURCE / SPECIFIED | Canvas density on a phone is untested | — |
| 24 | MIDI (195-entry catalogue) | yes — `midi/midi.ts`, `midi/profiles.ts` (D31) | SPECIFIED — BT + USB | SPECIFIED — BT | UNIT / SPECIFIED | 195 is a *catalogue* of name strings, not 195 verified profiles (D31) | N7 must split catalogue-matched from physically-verified |
| 25 | Recording | yes — `recording:save` (`main.ts:231`) + MediaRecorder in `app.ts` | deferred | deferred | SOURCE / SPECIFIED | Part C defers recording on mobile entirely | — |
| 26 | Broadcast (RTMP / WHIP) | yes — `rtmp:*` (`main.ts:248-316`), `broadcast/whip.ts` (124) | deferred | deferred | SOURCE / SPECIFIED | Requires ffmpeg on the host; no mobile plan | — |
| 27 | Streaming (8 providers, EME) | **unverified** — `streaming/providers.ts`, `drm.ts`, `streaming:license` (`main.ts:181`) | **no** | **no** | UNIT (logic only) / SPECIFIED | No provider has a verified PCM path or DJ-use permission (D37 §3); stock Electron has no Widevine CDM (A2) | Eight providers, zero verified. This row is the honest "degraded" one |
| 28 | Video mixing + 2nd output window | yes — `video-mixer.ts` (440), `video:*` (`main.ts:438-512`), `renderer/video-output.html` (D32) | deferred (external display via `UIScene` is capability-only in Run 1) | deferred (AirPlay mirror only) | UNIT / SPECIFIED | Part C defers video on mobile entirely | The matrix's external-display row is a capability note, not a Run 2 deliverable |
| 29 | **Ableton Link** | **in-tree protocol, not Ableton Link** — `src/main/link.ts` (408, `node:dgram`, `opendeck-link/1` on 239.255.77.88:29876), D34; authority in `tempo-authority.ts` (D35) | SPECIFIED — N10 | SPECIFIED — N10 | INTEGRATION if `smoke:link` ran, else UNIT / SPECIFIED | **The Node route does not travel** (D36 §7); needs a Rust port of the 408-line module, plus iOS local-network permission `[verify]` | Not wire-compatible with Ableton Live by design; do not describe it as Ableton Link |
| 30 | Session restore (previous crate on launch) | **absent at snapshot** — only cues, loops, played, scratchpad, fourDecks, waveMode persist (`app.ts` localStorage keys) | SPECIFIED | SPECIFIED | none yet / SPECIFIED | Priority 2 of the brief; m1 work in flight — re-check before REPORT-RUN1 | Marked `[verify]` because another phase may land it after this snapshot |
| 31 | CDJ USB discovery / auto-add | **absent at snapshot** — no `cdj` match outside `midi/profiles.ts` strings | **no** | **no** | none yet / SPECIFIED | Priority 1 of the brief; in flight — re-check before REPORT-RUN1 | Desktop-only by nature (USB mass storage); no mobile plan |
| 32 | Latency diagnostics | yes — engine `latency` (D18, `blockMs: 8`), device latency reported separately by m1 H3 | SPECIFIED | SPECIFIED | UNIT / SPECIFIED | The README's "<10 ms" figure is A3 row 04 and is being replaced with measured values | Engine latency ≠ device latency; do not merge them |
| 33 | Persistence (cues, loops) | yes — `localStorage` keys `opendeck.cues.*`, `opendeck.loops.*` | SPECIFIED | SPECIFIED | SOURCE / SPECIFIED | A WebView's `localStorage` is not a durable library store on iOS `[verify]` | — |
| 34 | Keyboard shortcuts | yes — `keyHandler` in `app.ts` | SPECIFIED — hardware keyboard, N3 | n/a (no hardware keyboard) | SOURCE / SPECIFIED | iPadOS gets pointer + keyboard; iPhone does not | — |
| 35 | Telemetry | none — no analytics calls; provider fetches only | none | none | SOURCE / SPECIFIED | Must stay true; a mobile SDK that phones home would break it | Audit is A3 row 16 |

---

## Divergences that are decisions, not gaps

These are the rows where mobile is deliberately worse and says so in the UI:

1. **Streaming** — refused in v1 (row 27). No provider has a verified PCM path or
   DJ-use permission; a media element cannot be reversed, stem-separated or
   scratched (D17).
2. **Serato writes** — refused on mobile (row 21). D10 rule 1 is unenforceable
   from a device that cannot see the laptop's process table.
3. **DVS on iPadOS** — specified but blocked on both sides: no HAL gain and no
   aggregate devices (hardware) and a frozen TypeScript decoder (software).
4. **DVS on iPhone** — no, per the matrix.
5. **Stems on iPhone** — off by default: 201.9 MiB of cache per 5-minute deck plus
   a 157.9 MiB model is the whole budget for one track.
6. **Bluetooth A2DP latency (~100–200 ms)** — not beatmatchable; the UI must say
   so rather than let a DJ discover it.
7. **Multi-window vs the desktop scene graph** — iPadOS uses `UIScene`; the
   desktop's second window is Electron IPC. Same feature name, different
   mechanism.
8. **44 pt touch targets vs 24 px desktop controls** — a layout rewrite.
9. **Link on iOS** — local-network permission prompt; denial is a normal state.
   Multicast over a hotspot may also fail. Both are states, not errors.
10. **Rust cross-compile** — SPM cannot build Rust; the XCFramework is produced
    from cargo at build time and is not committed.

## What this table is not

- It is not a promise of parity. There is no mobile code, so there is no mobile
  claim above SPECIFIED anywhere in it.
- It is not a schedule. The 4,639-line DSP figure in D36 is a size, not a
  duration.
- It does not resolve the six `[verify]` items already open in
  `docs/decisions.md`; they appear here as the same items, per row.

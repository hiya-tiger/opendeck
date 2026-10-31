# D36: Shared-core boundary for mobile

**Status:** decision, Run 1 (m4). No mobile code exists; this record exists so that
Run 2 starts from a chosen boundary instead of from a favourite technology.

**Evidence snapshot:** working tree at HEAD `9035f2c` plus the uncommitted m1–m3
work, read on 2026-10-30. Line counts below were taken in one pass
(`wc -l src/**/*.ts`) and will drift as that work lands; they are used only as
ratios and orders of magnitude, never as a schedule.

---

## Decision

**Adopt option C (hybrid) as the Run 2 target, with option A retained as the
fallback if the WKWebView `[verify]` items in §6 come back negative, and option
B explicitly rejected.**

Concretely, for Run 2:

1. **The playback state machine and the DSP stay outside the WebView.** One
   `Transport`/`TempoAuthority` pair, in one place, for every surface. On iOS the
   only place that can be is a native (Swift or Rust) module, because a WebView
   can be suspended and cannot own a real-time thread.
2. **The performance surface is native SwiftUI over the Rust core**
   (`rust/crates/opendeck-audio`), which already owns decode, transport atomics,
   the ring, the render thread and an optional output device
   (`native-output`, D21/D22).
3. **Library, set-prep and settings are hosted in a WKWebView** running the
   existing TypeScript modules that do not touch the audio thread —
   `src/renderer/media/*` (4,618 lines) and `src/renderer/streaming/*` (971
   lines). That is 5,589 of 19,289 TS lines = **29.0%**, and only if `app.ts` is
   split first (see §3).
4. **Option A is not deleted, it is ranked second**, because it reuses 90% of the
   TypeScript and every argument against it is a `[verify]`, not a measurement.

The rest of this ADR is the comparison that produced that ranking, and the five
questions the brief requires answered explicitly.

---

## 1. The four options

- **A — Swift-hosted WKWebView reusing the TypeScript app.** One
  `WKWebView`, the existing `renderer/` bundle inside it, Swift only for
  lifecycle, audio session and file access.
- **A′ — Tauri 2 mobile target.** The same web bundle inside Tauri's iOS
  WebView, with the Rust core reachable as Tauri commands.
  Repo Tauri major version, read from `rust/crates/opendeck-app/Cargo.toml`
  (`tauri = { version = "2" }`, `tauri-build = { version = "2" }`), resolved in
  `rust/Cargo.lock` to **tauri 2.12.5 / tauri-build 2.7.4 / wry 0.57.0**.
  Tauri v2 is documented (including in the project's own v2 announcement, which
  this ADR only saw through secondary sources) as supporting iOS and Android
  targets. What that support *level* means for audio, background execution and a
  feature set this dependent on WebView behaviour is **not established here —
  `[verify]`**, and the repo contains no iOS build, no `tauri ios init` output
  and no CI that would exercise one.
- **B — Native SwiftUI + Rust core, full rewrite.** Swift owns the UI and the
  performance surface; Rust owns decode and the render thread; FX, mixer, pads
  and sampler are rewritten.
- **C — Hybrid.** Native performance surface over the Rust core; WebView hosts
  library, set-prep and settings.

## 2. Comparison table

| | A: WKWebView + TS app | A′: Tauri 2 iOS | B: SwiftUI + Rust | C: Hybrid |
|---|---|---|---|---|
| **% TS reused** | **≈90%** — 17,305 of 19,289 lines (19,289 − 1,905 `src/main` − 79 `src/preload` = 17,305; 89.7%). Loaded unmodified; whether it *runs* is §6. | **90%** of the bundle, but the Tauri bridge (`renderer/tauri-bridge.js`, 61 lines) exposes no `separation`, `serato` or `video` namespace, so those three families are absent by construction. | **0%** of code. Data reuse only: the 195 hardware strings, `FX_DEFS`, pad-mode tables. | **29.0%** hosted unchanged (5,589/19,289: `media/*` + `streaming/*`). Real launch figure lower — `app.ts` is one 4,063-line file mixing performance and library UI, so the library views must be extracted first. Estimate **15–25%** `[verify]`. |
| **DSP rewritten (lines)** | **0** | **0** (Rust core already exists; Tauri command surface only) | **5,089** engine lines, of which **4,639** are genuinely new — `analyze.ts` (397) and `fft.ts` (53) are already implemented in Rust as `opendeck-core::analyze_mono` (used by `rust/crates/opendeck-app/src/main.rs`). Composition: `deck.ts` 1,873 · `pcm-source.ts` 682 · `fx.ts` 244 · `mixer.ts` 283 · `beatgrid.ts` 205 · `tempo-authority.ts` 194 · `pcm-transport.ts` 189 · `scratch-voice.ts` 190 · `pad-modes.ts` 175 · `sampler.ts` 166 · `parts.ts` 136 · `stem-bands.ts` 77 · `sync.ts` 58 · `scratch-bank.ts` 55 · `platter.ts` 54 · `scratch.ts` 30 · `fx-shell.ts` 28. | **4,639** (same surface as B). |
| **Mixer/FX parity at launch** | Full set as tested on desktop: 4 decks (`DeckId` A–D), 15 `FxType` entries in `fx.ts` (14 effects + `off`) plus 3 custom presets, 10 pad modes, 32 sampler slots — *if* AudioWorklet works (§6). | Same list, minus whatever WKWebView blocks; plus Rust decode instead of `decodeAudioData`. | **Subset.** 4,639 lines reimplemented before parity; every FX is a Web Audio node graph today (`fx.ts` builds `BiquadFilterNode`/`DelayNode`/`ConvolverNode`), so a native port is new DSP, not a translation. | **Subset** on the performance surface; library parity is the highest of the four because `media/*` is reused. |
| **Stems effort** | **High.** `src/main/separation.ts` (352 lines) is Node + `onnxruntime-node`; a WKWebView has neither. Needs `onnxruntime-web` (WASM) inside the WebView `[verify]` memory/perf, or a native bridge. | **Medium.** The Rust host can call an ONNX runtime in Rust (`ort` crate `[verify]` name, licence, iOS support) with the same MIT weights and the same SHA-256 cache key as D24. | **High.** New runtime, new cache reader, and D24's Int16-plus-manifest format re-implemented. | **High** for the runtime; **low** for the UI, which is WebView-hosted. |
| **Library/interop effort** | **Low for logic, high for I/O.** `media/*` runs unchanged, but `showDirectoryPicker` (two call sites in `app.ts`) is File System Access API and the code itself says "Folder linking needs Chromium" (`app.ts`). WKWebView gets drag-drop and `<input type=file>` only. | **Medium.** File I/O via Rust, but iOS security-scoped bookmarks and sandbox paths must be plumbed to Rust `[verify]`. | **High.** `serato*.ts` is 2,534 lines; `timecode/*` is 408 and frozen (D6). | **Medium.** `serato*.ts` reused inside the WebView; only the file-handle handoff is native. |
| **Divergence risk** | **Low for logic, high for platform.** One state machine, one tempo authority, one codebase. Risk concentrates in the native shell that has to fake Electron's main process. | **Medium–high.** Desktop ships Electron (D38); an iOS Tauri app is a second shell with a second bridge, kept in sync by hand — the bridge is already 61 lines against a 79-line preload and already lags. | **High.** Two state machines unless the Rust core is the only one; two Serato implementations; two timecode decoders. | **Medium.** Two UI technologies, but one transport if Rust owns it. |
| **Decoded audio per deck (exact)** vs ceiling (estimated) | 5 min **105,840,000 B = 100.9 MiB**; 10 min **211,680,000 B = 201.9 MiB**. 4 × 10 min = **846,720,000 B = 807.5 MiB**. Identical to desktop: same decoder, same Float32 buffer. | Same arithmetic in the WebView; **half** if the Rust core holds Int16 (D24's cache format already does): 4 × 10 min = **423,360,000 B = 403.7 MiB**. | Float32 **807.5 MiB**, or Int16 **403.7 MiB** — the boundary does not change the arithmetic, only who allocates it. | Same as B. |
| **Ceiling** | **Unknown.** Apple does not publish jetsam limits; treat every figure as an estimate and measure with `os_proc_available_memory()` / `phys_footprint`, never RSS (Part C). | Unknown, same. | Unknown, same. | Unknown, same. |

### 2.1 What the memory column does and does not prove

It is **arithmetic against an unmeasured ceiling**. It is not a fit/no-fit proof,
and it must not be quoted as one.

The arithmetic is exact and platform-independent: Float32 stereo at 44.1 kHz is
`44,100 × 2 × 4 = 352,800 B/s`, so 300 s = 105,840,000 B and 600 s = 211,680,000 B.
Four decks at ten minutes is 846,720,000 B before stems. Four parts per deck at
five minutes in Float32 is `4 × 105,840,000 = 423,360,000 B` per deck, and
`× 4 decks = 1,693,440,000 B = 1.58 GiB`. `Deck.cloneFrom` (D28) copies the
buffer, so an instant-double adds a whole deck's worth again.

The ceiling is not arithmetic. It is a per-process limit that varies by device,
by iOS version, by what else is resident, and by whether the app is foreground.
It is `[verify]` and can only be answered by measurement in Run 2 (N8).

**The one falsifiable statement this ADR will make:** if Run 2 measures
`os_proc_available_memory()` at less than **807.5 MiB** on the target iPhone with
the app foregrounded, then **no option** can hold a four-deck ten-minute set in
Float32 — the boundary does not enter into it — and the product must change
instead: stream-decode, hold Int16 (403.7 MiB), or drop to two decks. That is a
test, not a prediction, and it is a test of the *feature set*, not of the
architecture.

Note also that **every option carries this arithmetic**, because the decoded
buffer is a property of the feature set (D17 decodes whole files), not of the
language. Choosing B does not escape it; choosing B with Int16 halves it.

---

## 3. Why C, and why not the others

**Why C over A.** A reuses 90% of the TypeScript, which is a real and large
advantage, and it should not be dismissed. It loses on three structural points:

1. **A WebView cannot be the real-time owner.** The transport, the stretch, the
   scratch voice and the loop arithmetic are all worklet-side today
   (`pcm-source.ts` 682 lines). On iOS a WebView can be suspended, throttled or
   torn down; `AVAudioSession` background audio is an app-level property. Making
   the WebView the owner means the audio thread's life depends on a UI object.
2. **A needs a native bridge for everything the brief defers anyway** — files,
   Link, stems — so "pure A" does not exist; the honest description of A is
   "C with the performance surface also in the WebView".
3. **The DSP is already portable.** The Rust core exists, is tested and is used
   for analysis today (D22). C spends its effort on the seam, not on the DSP.

**Why C over B.** B rewrites 4,639 lines of DSP that currently passes tests, and
the rewrite is not a translation: the effects are Web Audio node graphs, not
sample loops. B also throws away `serato*.ts` (2,534 lines) and the frozen
timecode decoder (408 lines, D6). C keeps both in the WebView.

**Why not A′ as the primary.** A′ is the most attractive on paper — one bundle,
one Rust core, Tauri's mobile story. It is ranked second for two reasons that are
about *this* repo, not about Tauri: the desktop product is Electron (D38), so an
iOS Tauri app is a shell nobody runs on desktop, and its bridge is already
missing three feature families. If D38 had gone the other way, A′ would be first.

---

## 4. B and C cannot reach DVS or the Serato codec without porting frozen TypeScript

This is the strongest argument in the ADR and it is not a matter of effort
estimates.

- **DVS.** `src/timecode/decoder.ts` (240 lines) plus `defs.ts` (76), `lfsr.ts`
  (37) and `encoder.ts` (55) is TypeScript, and **D6 freezes it byte-identical**
  because it is tested against generated signals for five media types
  (`test/timecode.test.ts`). A Swift or Rust transport has no way to call it.
- **Serato.** `serato-codec.ts` (401) plus the other `serato*.ts` files (2,534
  total) are TypeScript and carry the D7/D8/D9/D25 format decisions.

So, plainly:

- **Option B does not reach DVS.** Not at launch, not "later for free". It
  reaches DVS only by porting the decoder to Swift and re-running the same
  vectors, or by embedding a JS engine *just* for the decoder — which is option
  A wearing a Swift coat.
- **Option B does not reach the Serato codec.** It reaches it by a second
  implementation, which is precisely the fork the brief warns about: two
  encoders, two sets of `[verify]` assumptions about `Markers_` vs `Markers2`,
  two round-trip test suites, and a library written by one and read by the other
  that nobody has tested end to end.
- **Option C does not reach DVS either** — the performance surface is native,
  and the decoder is not in it. C reaches the *Serato codec* (it lives in the
  WebView side) but not the *DVS decode path*, which has to feed the native
  transport.

**What C therefore does about DVS:** it does not ship DVS on the native
performance surface in v1, and it does not pretend to. D37 states the same
conclusion for iPadOS from the hardware side (no HAL gain, no aggregate devices,
limited rate control); this ADR adds the software side: even with a class-
compliant interface, the frozen decoder is on the wrong side of the boundary.

**If a port is ever justified**, the test-vector plan is already in the repo and
is the only acceptable form of the port:

1. Record `(media type, sample rate, buffer)` → `(position, direction, speed)`
   vectors from the current TS decoder, for every case in `test/timecode.test.ts`
   plus the five media types.
2. Port to Rust (not Swift — Rust is already in the build and is reusable by the
   MacOS and iOS targets).
3. Assert bit-identical `(position, direction, speed)` on the recorded vectors,
   and assert the Rust and TS decoders agree on a fuzz corpus before the TS one
   is retired.
4. Only then amend D6. Until then D6 stands and DVS is desktop-only.

---

## 5. Streaming: the D17 limitation travels to mobile

D17 keeps remote/stream URLs on a media element. That decision is not about the
desktop: a media element gives you `currentTime` and `playbackRate`, and nothing
else. Therefore, on every surface including mobile:

- **no reverse** through a streamed track (negative `playbackRate` is not
  supported by the element; `video-mixer.ts` already works around this by
  stepping `currentTime` per frame, which is a video path, not an audio path);
- **no stems** — you cannot run separation on samples you do not have;
- **no scratch** — the platter needs a sample-accurate read position, and
  `driveTimecode` (D20) has nothing to drive;
- **no deterministic render** — `render_offline` (D4) cannot see a stream.

This is a property of the source, so it is inherited by whichever boundary is
chosen. It also means a mobile streaming feature cannot be "the desktop feature,
smaller": it is a different, degraded surface, which is why D37 refuses in-deck
streaming on mobile in v1 rather than shipping a deck that cannot be mixed.

---

## 6. WKWebView questions — all `[verify]`, none assumed

These decide whether option A survives at all. Each has a cheapest
falsification test that a human with a phone and Xcode can run in minutes.

| Question | Status | Cheapest falsification test | What it would change |
|---|---|---|---|
| Does `AudioWorklet` exist and run in WKWebView? | **unknown — `[verify]`** | 20-line page: `new AudioContext()`, `audioWorklet.addModule(url)`, construct one `AudioWorkletNode`, have `process()` increment a counter and post it every 128 frames. Read the counter on device for 10 s. | If absent: **A and A′ are dead**, C becomes mandatory, and `pcm-source.ts` cannot be reused anywhere on iOS. |
| Is `SharedArrayBuffer` available (and does it need cross-origin isolation)? | **unknown — `[verify]`**. Already an open item in `docs/decisions.md` ("Open assumptions") for WebView2; the WKWebView case is separate and unrecorded. | Same page: `typeof SharedArrayBuffer`, then `new SharedArrayBuffer(1024)` inside a `try`. Then serve the page from a custom `WKURLSchemeHandler` with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` and repeat. | If absent: the Rust→JS lock-free ring seam (D3) cannot exist on iOS; the native core must own output entirely, which is C by definition. |
| What does audio do when the app is backgrounded or the screen locks? | **unknown — `[verify]`** | Play a 60 s tone, lock the screen, log a counter from the worklet and from a native audio callback every second; compare continuity. | If WebView audio stops but native audio continues: A cannot be the audio owner, C is confirmed. |
| Can a WKWebView read a user-picked folder and keep access across launches? | **unknown — `[verify]`**; the code already degrades: "Folder linking needs Chromium" (`app.ts`). | Pick a folder, store a security-scoped bookmark, relaunch cold, re-read a file. | If not: library I/O is native in every option, and A's "low library effort" claim is wrong. |

**Note on A′:** Tauri on iOS uses the same platform WebView, so every row above
applies to A′ unchanged. Tauri adds a Rust command surface, not a different
audio engine.

---

## 7. Ableton Link on mobile: the chosen route is Node, so it must be ported to be reachable at all

D34 chose route (c): an in-tree MIT implementation of a Link-shaped session-tempo
protocol, in `src/main/link.ts` (408 lines), using `node:dgram` on multicast
`239.255.77.88:29876`, protocol id `opendeck-link/1`. D35 then made
`TempoAuthority` (`src/renderer/engine/tempo-authority.ts`, 194 lines) the single
owner of session BPM/beat/phase.

That route is **Node**. It is reachable from exactly one of the four options:

| | Link route reachable? |
|---|---|
| A (WKWebView + TS app) | **No.** There is no `node:dgram` in a WebView, and no main process to host it. A needs a Swift multicast sidecar speaking the same JSON protocol — i.e. a second implementation of a 408-line module. |
| A′ (Tauri iOS) | **No.** Tauri's Rust host has no Node. It would need a Rust port of `link.ts` — reachable, but it is a port, not a reuse. |
| B (SwiftUI + Rust) | **Yes**, via a Rust port. Same port cost. |
| C (hybrid) | **Yes**, via a Rust port in the native host, with `TempoAuthority` still the single owner. |

**So the honest statement is: the m3 Link implementation does not travel to
mobile.** What travels is the *protocol* (`opendeck-link/1`, documented in D34
§5) and the *authority* (D35). The 408-line Node module must be re-implemented in
Rust once, and then it is reachable from C, B and A′ but never from A.

Two consequences that belong in the record now:

1. **The port must keep the authority single.** The Rust node publishes and reads
   session tempo; it must not touch position. D35 rule 5 is boundary-independent
   and applies to the ported version unchanged.
2. **iOS adds a permission and a failure mode that desktop does not have.**
   `NSLocalNetworkUsageDescription` and a user-visible local-network prompt are
   required for multicast on iOS; a denied prompt and a hotspot that blocks
   multicast are normal states, not errors (A3 row 28, Part C divergences). The
   exact entitlement and permission strings for our own UDP socket are
   `[verify]`. D37 carries this as a labelled divergence.

---

## 8. Constraints this ADR must not violate, restated for the boundary

- **Exactly one playback state machine** across all surfaces: position, loop,
  rate, reverse, slip semantics. On mobile it is the Rust `Transport`, driven by
  the same API as desktop, and the WebView never owns position — it displays it.
  A WebView-side `PcmSource` and a Rust transport in the same product would be
  two state machines; C forbids that by construction, A does not.
- **Exactly one tempo authority**: `TempoAuthority` (D35). On mobile it moves
  with the boundary: if the transport is native, the authority is native too, and
  the WebView reads it over IPC. It never becomes two objects.
- **No second output backend by default.** The M2 probe (`cpal_out` behind
  `native-output`) stays default-off and unreachable; on iOS the native output is
  the only output, so the probe's *condition* changes from "flag" to "the
  platform", and that must be written down in Run 2 rather than inherited
  silently.

---

## Rejected options

- **A as primary.** Rejected on §6 unknowns plus §7: it cannot host Link, cannot
  own a real-time thread, and its library path is Chromium-only at both `showDirectoryPicker` call sites.
  Retained as the fallback if the §6 tests come back positive *and* Run 2 decides
  a single-owner audio thread is unnecessary — which would itself contradict D3.
- **A′ as primary.** Rejected because the desktop product is Electron (D38), so
  A′ creates a second shell with a second bridge, and because Tauri's iOS audio
  story is the same WKWebView story plus a command surface.
- **B as primary.** Rejected because it rewrites 4,639 tested lines of DSP, and
  because it cannot reach DVS or the Serato codec without a frozen-decoder port
  (§4).
- **"Two cores, one per platform"** — a TypeScript core for desktop and a Rust
  core for mobile, with a shared test suite. Rejected: it is two state machines
  with a shared test suite, which is exactly the divergence the brief forbids.
- **Deferring the boundary decision to Run 2.** Rejected: Run 2's N1 phase
  ("universal skeleton") bakes the boundary in on day one, so the decision has to
  exist before N1 or it is made by accident.

## Revisit

- **If any §6 `[verify]` comes back negative**, re-rank: A drops out entirely and
  C loses its WebView tier, collapsing towards B — which is the only option left
  that reaches DVS, and only with a ported decoder.
- **If Run 2 measures `os_proc_available_memory()` below 807.5 MiB** with a
  4-deck ten-minute set, the deck count or the decode strategy changes before the
  boundary does — that is a product decision, not an architecture one.
- **If the Rust port of `link.ts` turns out to be more than a day's work**, the
  honest response is to ship mobile without Link in v1 and say so, not to put a
  second tempo authority on the device.
- **If D38 is revisited** and Tauri becomes the desktop product, A′ moves to
  first place and this table is re-scored.

## `[verify]` register raised by this ADR

1. WKWebView `AudioWorklet` availability and real-time behaviour.
2. WKWebView `SharedArrayBuffer` availability, with and without COOP/COEP.
3. WKWebView background/locked-screen audio continuity.
4. WKWebView persistent folder access (security-scoped bookmark across cold
   launch).
5. Tauri 2's actual iOS support level for audio and background execution (the
   crate versions are known: tauri 2.12.5, wry 0.57.0).
6. iOS `os_proc_available_memory()` on the target device, 4-deck ten-minute set.
7. Whether the `ort` Rust crate builds for iOS with the D24 weights.
8. `NSLocalNetworkUsageDescription` and the multicast entitlement for our own
   UDP socket.

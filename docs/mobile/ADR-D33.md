# D33: Native output stays a probe, not the live path

**Amends:** D22. **Related:** D2, D3, D4, D15, D18, D21, D36, D38.

**Status:** written after the M2 measurement in `docs/mobile/RUST-PROBE.md`. The
tier recorded there is the evidence for every claim below.

**Measured result:** the probe reached **DEVICE** tier on a Windows 10 machine
with `Speakers (Realtek High Definition Audio)` — the device opened at the
source rate, its callback advanced the transport at 47,904 frames/s over a 2.0 s
window (48 kHz, F32), and a 44.1 kHz source was refused with `UnsupportedConfig`
rather than resampled. Audibility (HARDWARE) was not tested. On a host with no
output device the ceiling would be UNIT, not DEVICE.


## Decision

1. **`cpal` output remains a probe.** It is not selected by any shell, and it is
   not on any path a user can reach by launching OpenDeck. Three independent
   locks enforce that:
   - **Compile:** `native-output` is absent from the crate's `default` features,
     and `opendeck-app` depends on `opendeck-audio` with `features = ["decode"]`
     only, so `cargo build --release -p opendeck-app` never links cpal.
   - **Target:** the only entry point is
     `rust/crates/opendeck-audio/examples/play_probe.rs`, an `[[example]]` with
     `required-features = ["native-output", "decode"]`. `cargo build`,
     `cargo test` and the release build do not build examples whose
     `required-features` are unmet.
   - **Runtime:** `cpal_out::probe_gate_from_env()` refuses unless
     `OPENDECK_NATIVE_OUTPUT_PROBE` is exactly `1`. Nothing in the application
     sets it. The rule is a pure function (`probe_gate`) with a unit test, so it
     is checkable without a device.
2. **D21 is unchanged and is still the probe's contract.** The probe opens the
   default output device at the voice's source rate. If the device offers no
   mono/stereo config at that exact rate it returns `UnsupportedConfig` and
   plays nothing. It never resamples.
3. **The probe renders one `PcmVoice` through `LiveVoice` + `TransportState`.**
   It therefore exercises the real transport state machine — play, rate, seek,
   loop, reverse — and nothing else. It bypasses EQ, FX, mixer, master limiter,
   analyser, recording, broadcast, pitch hold, time-stretch, scratch, sampler
   and stems. Those are the Web Audio graph per D2 and stay there.
4. **`PcmSource` remains the live deck source; the media element remains the
   streaming path.** No deck code changes as a result of this ADR.
5. **The probe is not a fallback.** If `PcmSource` fails to load, the existing
   media-element fallback still applies. The native output is never substituted
   automatically, because it has no pitch hold and no graph.

## Why

D22 said wiring `cpal_out` "requires a native mixer that recreates the
downstream graph first". M2 tested the premise rather than accepting it: the
question was not "should the graph move to Rust" but "can this crate put sound
on a device at all, and what is the smallest true statement about that".

A probe answers it for roughly 260 lines of example code and one runtime gate,
with zero risk to the shipping path. What it buys:

- The D21 claim ("opens at the source rate, or refuses") stops being a
  source-code claim and becomes an observed device result, including the failure
  case.
- It exposes a blocker nobody had written down: the default Windows device here
  offers **48 kHz only**, and most DJ libraries are 44.1 kHz. Under D21 the Rust
  path therefore refuses most of a real library rather than playing it slightly
  wrong. A live Rust path needs a tested sample-rate converter at load; there is
  none in the tree. That single observation does more to justify this ADR than
  any latency argument.
- The cost of the live path becomes concrete. `docs/mobile/RUST-PROBE.md`
  tabulates every stage that would have to move and what it would cost, so D36
  can price "Rust core" instead of guessing.
- The `LiveVoice`/`TransportState` seam is exercised against a real device
  callback, not only against `render_offline`. That is the seam D3 depends on.

The probe does **not** buy a latency improvement. It cannot, because it removes
the graph: any comparison of its latency against the Web Audio path measures
two different products.

## Rejected options

1. **Enable `native-output` in `opendeck-app` and route deck audio to it.**
   Rejected. It is a second output backend with different semantics — no pitch
   hold, no EQ, no FX, no recording — and D2 says the graph stays in Web Audio.
   "One transport" is satisfied in the state-machine sense (the probe reuses
   `TransportState`) but not in the audible-output sense, and shipping it would
   make the two decks behave differently depending on a flag.
2. **An N-API addon in the Electron process instead of an example target.**
   Rejected for M2, not on merit. See the delta table below: it needs
   `napi-rs`/`node-gyp`, a prebuilt binary per platform and architecture, a
   `binding.gyp`/`build.rs` path in `npm run build`, and a SharedArrayBuffer seam
   with COOP/COEP headers in the renderer. That is a packaging project, and it
   answers the same question the example already answered. It becomes the right
   choice only if the answer to "is Rust the live path" turns to yes.
3. **Port EQ/FX/mixer to Rust so the probe becomes the full path.** Rejected now.
   `docs/mobile/RUST-PROBE.md` prices it at roughly 3,200-4,400 new Rust lines
   plus a time-stretch replacement that has no in-tree Rust answer, plus a
   sample-rate strategy that does not exist yet. There is no measured problem it
   solves: the Web Audio graph is not currently the bottleneck (D2, D18).
4. **Resample to whatever the device offers when the source rate is missing.**
   Rejected. D21: a silent resample makes tempo, loop length and reported
   position wrong, which is worse than a clear startup error. The probe prints
   the device's refusal instead.

## The measured condition under which this changes

The probe becomes a candidate for the live path only if **both** of these are
observed on the product shell (Electron, per D38) with a real output device:

1. **Latency:** `AudioContext.baseLatency + AudioContext.outputLatency` plus the
   8 ms engine block (D18) exceeds **20 ms** at a 128-frame buffer, measured on
   at least two machines; **and**
2. **Stability:** the existing xrun counter is non-zero during a 10-minute,
   four-deck session at 128 frames.

Both numbers are already surfaced in diagnostics (H3 adds the split). The 20 ms
threshold is a **judgement**, stated so it can be argued with: it is the point
where manual beatmatching by ear starts to feel wrong to a working DJ, and it is
twice the under-10 ms figure D18 already targets. It is not a measurement.

If only one of the two holds, this ADR stands and the answer is "fix the Web
Audio path", not "move the graph".

A second, independent trigger: a platform where Web Audio cannot open a
low-latency output at all. That is a mobile question and belongs to D36, not
here — the probe proves the crate can reach a device on Windows only.

## Revisit

- When either condition above is measured true.
- When a Rust time-stretch of comparable quality to `signalsmith-stretch`
  exists in-tree (the blocker in the port table, not the line count).
- When D36 selects a boundary where the Web Audio graph does not exist, which
  makes the comparison moot rather than favourable.

## Delta versus the other probe route

M2 was told the target is conditional on M0. The evidence in the tree says
**Electron is the product shell**: `package.json` sets `"main": "dist/main.cjs"`
and depends on `onnxruntime-node` for stems (`src/main/separation.ts`), and the
recording, RTMP, streaming and media-fetch handlers are all `ipcMain.handle`
(`src/main/main.ts`). The Tauri binary `bin/opendeck-app.exe` is the partial
shell. Both routes are recorded here because the answer is cheap and the delta
is not.

| | **Route taken: Tauri crate + example** | **Alternative: N-API addon in Electron** |
| --- | --- | --- |
| Build system | `cargo build --example`, `required-features` | `napi-rs` or `node-gyp`, `build.rs`, prebuilds per `{win32,darwin,linux}-{x64,arm64}` |
| IPC | none — the probe is a process, not a library | renderer → preload → main → addon, or addon in renderer behind a seam |
| Shared memory | not needed | SharedArrayBuffer needs COOP/COEP headers on the WebView2 session (already an open `[verify]` in `decisions.md`) |
| Packaging | none; the artifact is not shipped | native `.node` per platform must be code-signed and notarised with the app |
| Time to first answer | one feature flag, one example, one env var | a build pipeline before the first question can be asked |
| What it proves | the crate can open a device at the source rate and its callback advances the transport | the same, plus that the seam works inside Electron |
| Cost if the answer is "no" | ~260 lines of example, deleted | a build pipeline, a prebuild matrix, and a `[verify]` item |

The route taken cannot answer "does the SharedArrayBuffer seam work in WebView2".
That remains open and is D36's problem. It is stated here so the probe's result
is not over-read.

# Rust playback probe (M2)

**Question:** can the Rust `opendeck-audio` crate put a decoded track on an audio
device on this machine, and at which evidence tier?

**Answer, one sentence:** **Yes, at DEVICE tier on this machine** — the crate
opened the default Windows output device at the source rate, its callback
advanced the transport at real time (95,808 frames in a 2.0 s window at
48 kHz), and it correctly **refused** a 44.1 kHz track with
`UnsupportedConfig` instead of resampling — but no human listened, so audibility
(HARDWARE) is not proven, and the probe is not the live path.

Everything below is the evidence for that sentence. Tiers are the project's own:
SPECIFIED / SOURCE / COMPILED / UNIT / INTEGRATION / SIMULATOR / DEVICE /
HARDWARE. No tier implies the next.

---

## 1. Where it ran

| | |
| --- | --- |
| OS | Microsoft Windows 10 Pro 10.0.19045 |
| Toolchain | `cargo 1.99.1 (5f94df478 2026-08-27)`, `rustc 1.99.1 (58cf8f9c3 2026-10-13)` |
| Shell | Git Bash (POSIX), project root `C:/Users/Donie/WorkBuddy AI/OpenDecks` |
| Default output device | `Speakers (Realtek High Definition Audio)` |
| Device rates offered | 48000 Hz only (see §3) |
| Machine identity | local developer workstation; not a CI runner, not a sandbox |

No audio hardware was added, configured or renamed for this probe. The device
list was read, not chosen.

## 2. What the probe is

`rust/crates/opendeck-audio/examples/play_probe.rs` (263 lines). It:

1. checks the runtime gate (§4) and exits 2 if it is closed;
2. builds one `PcmVoice` — either a generated 440/443 Hz stereo tone or a file
   decoded with `decode_file` (`symphonia` 0.5, already an optional dependency);
3. creates a `TransportState` with rate 1.0, `set_playing(true)`;
4. calls `NativeOutput::start(voice, state, source_rate)` — the existing
   `cpal_out` path, unmodified except for format selection (§3);
5. samples `state.position()` every 50 ms for `--seconds` and prints
   `key=value` lines;
6. stops the stream and prints the tier it actually reached.

It renders **one voice, one deck, no graph**. It is not a mixer, not a deck, and
not a fallback. It uses the real `LiveVoice`/`TransportState` seam, so play,
rate, seek, loop and reverse are exercised — through a device callback rather
than through `render_offline`.

## 3. What was observed

### 3.1 Device capabilities (D21 evidence)

```
$ OPENDECK_NATIVE_OUTPUT_PROBE=1 ./target/debug/examples/play_probe.exe --list-configs
probe=device-listed
device=Speakers (Realtek High Definition Audio)
config[0] rate=48000-48000 channels=2 format=U8
config[1] rate=48000-48000 channels=2 format=I16
config[2] rate=48000-48000 channels=2 format=I32
config[3] rate=48000-48000 channels=2 format=F32
config_count=4
```

The device is **48 kHz only**. It offers no 44.1 kHz config at all, so on this
machine a 44.1 kHz track cannot be played by the Rust path under D21.

`cpal` lists U8 first. `NativeOutput::start` used `find(eligible)` and therefore
selected **U8 — 8-bit audio** on the first run:

```
device_format=U8
position_end=98208
frames_moved=98208
callbacks_advanced=37
```

That is audible and it is not what "the device supports the source rate" should
mean, so selection now ranks F32 > I32 > I16 > U8
(`cpal_out::native::format_rank`, with a unit test). Every transcript after this
paragraph is F32. The change does not touch the rate rule.

### 3.2 A generated tone (48 kHz) — DEVICE

```
$ OPENDECK_NATIVE_OUTPUT_PROBE=1 ./target/debug/examples/play_probe.exe --tone --seconds 2
probe=starting
source=tone
source_rate=48000
source_frames=240000
probe=device-opened
device=Speakers (Realtek High Definition Audio)
device_rate=48000
device_channels=2
device_format=F32
device_buffer_size=Default
position_start=0
position_end=95808
frames_moved=95808
callbacks_advanced=25
stream_was_active=true
tier=DEVICE
note=device callbacks advanced the transport; audibility is not proven (HARDWARE needs a human)
```

95,808 frames in a 2.0 s wall-clock window is 47,904 frames/s — within 0.2 % of
48 kHz. The callback is clocked by the device, not spinning: this is a real
stream, not a busy loop.

### 3.3 A real 48 kHz file — DEVICE

```
$ OPENDECK_NATIVE_OUTPUT_PROBE=1 ./target/debug/examples/play_probe.exe --file /tmp/probe-48000.wav --seconds 2
probe=starting
source=file:C:/Users/Donie/AppData/Local/Temp/probe-48000.wav
source_rate=48000
source_frames=96000
probe=device-opened
device=Speakers (Realtek High Definition Audio)
device_rate=48000
device_channels=2
device_format=F32
device_buffer_size=Default
position_start=0
position_end=94560
frames_moved=94560
callbacks_advanced=20
stream_was_active=true
tier=DEVICE
```

Decode → voice → device, end to end, at 48 kHz. The test file was a 2 s stereo
16-bit WAV generated outside the repo; **no audio fixture exists in the tree**,
which is why one had to be generated.

### 3.4 A real 44.1 kHz file — the D21 refusal, and the finding that matters

```
$ OPENDECK_NATIVE_OUTPUT_PROBE=1 ./target/debug/examples/play_probe.exe --file /tmp/probe-44100.wav --seconds 1
probe=starting
source=file:C:/Users/Donie/AppData/Local/Temp/probe-44100.wav
source_rate=44100
source_frames=88200
probe=device-error
error=unsupported output config: the default output device offers no mono/stereo f32/i16/i32/u8 config at 44100 Hz
tier=COMPILED
```

Decode succeeded (88,200 frames = 2.0 s at 44.1 kHz). The device was then
**refused**, loudly, with no resampling. D21 behaves exactly as written.

This is the most consequential result in M2, and it is not about cpal: **a
44.1 kHz library cannot play through the Rust path on a 48 kHz-only device.**
Most DJ libraries are 44.1 kHz. Making the Rust path live therefore requires a
tested sample-rate converter at load, or per-voice rate handling — work that
does not exist in the crate today and is not in the table in §7 because it is a
prerequisite for all of it. It is the second item under "what this probe
bypasses" in the honest sense: it bypasses the problem entirely by refusing.

### 3.5 The gate is closed by default

```
$ ./target/debug/examples/play_probe.exe --tone --seconds 1
probe=gate-closed
gate_env=OPENDECK_NATIVE_OUTPUT_PROBE
gate_reason=OPENDECK_NATIVE_OUTPUT_PROBE is not set
tier=NONE
EXIT=2
```

## 4. How the probe is kept off the product path

Three locks, each independently sufficient:

| Lock | Mechanism | Where |
| --- | --- | --- |
| Compile | `native-output` is not in `default = []`; `opendeck-app` depends on `opendeck-audio` with `features = ["decode"]` only | `rust/crates/opendeck-audio/Cargo.toml`, `rust/crates/opendeck-app/Cargo.toml` |
| Target | the probe is an `[[example]]` with `required-features = ["native-output", "decode"]`; `cargo build`, `cargo test` and `cargo build --release -p opendeck-app` do not build it | `rust/crates/opendeck-audio/Cargo.toml` |
| Runtime | `probe_gate_from_env()` refuses unless `OPENDECK_NATIVE_OUTPUT_PROBE=1`; the rule is the pure function `probe_gate`, unit-tested against `""`, `"0"`, `"true"`, `"yes"`, `" 1"`, `"1 "`, `"2"` | `cpal_out.rs` |

Nothing in the application reads `OPENDECK_NATIVE_OUTPUT_PROBE`.

## 5. What a human does to hear it

Prerequisites: Rust 1.99+, a machine with an output device that offers the
track's sample rate (or a 48 kHz track on a 48 kHz device, which is the common
case on Windows).

```bash
cd rust

# 1. Confirm the device offers the rate you are about to ask for.
OPENDECK_NATIVE_OUTPUT_PROBE=1 cargo run -p opendeck-audio \
  --features native-output,decode --example play_probe -- --list-configs

# 2. Play a tone. If you hear nothing here, the problem is the device, not the
#    decoder, and step 3 will not help.
OPENDECK_NATIVE_OUTPUT_PROBE=1 cargo run --release -p opendeck-audio \
  --features native-output,decode --example play_probe -- --tone --seconds 5

# 3. Play a track whose sample rate appears in step 1.
OPENDECK_NATIVE_OUTPUT_PROBE=1 cargo run --release -p opendeck-audio \
  --features native-output,decode --example play_probe -- \
  --file "C:/Music/track.wav" --seconds 20
```

On Windows in Git Bash, set the variable inline as above; in PowerShell use
`$env:OPENDECK_NATIVE_OUTPUT_PROBE = "1"` first. In `cmd.exe`:
`set OPENDECK_NATIVE_OUTPUT_PROBE=1`.

**What you should hear:** a 440 Hz tone in the left channel and 443 Hz in the
right (a 3 Hz beat, so the image drifts), or the track, at the correct pitch and
speed. **What you should not hear:** any EQ, any FX, any gain change, any
master limiting. If the tone is distorted or gritty, check `device_format=` in
the output — U8 means 8-bit and means you are on an older build.

**What you cannot do:** seek, change rate, or loop from the keyboard. The probe
sets `playing(true)` and rate 1.0 and never changes them; `TransportState` is
wired but the probe does not drive it interactively. Reverse, seek and loop are
proven at UNIT tier by `render_offline` and `LiveVoice` tests, not by hand.

**If it refuses with `UnsupportedConfig`,** that is D21 working. Convert the
track to the device rate, or use `--tone --rate <device rate>`.

## 6. What the probe bypasses

Every one of these is in the Web Audio graph today and none of them runs in the
probe. This is D22's list, verified against the code rather than quoted.

| Bypassed | Lives in | What it does downstream of the deck source |
| --- | --- | --- |
| Key lock / time-stretch | `pcm-source.ts` (Signalsmith Stretch inside the AudioWorklet) | pitch hold independent of rate; the probe plays at rate 1.0 with no stretch at all |
| Trim, 3-band EQ | `deck.ts:237-251` (`createGain`, three `createBiquadFilter`) | the DJ EQ; absent, so the probe output is flat |
| Channel fader, crossfader | `deck.ts:253-256` (`createGain` × 2) | level and crossfade; absent |
| FX inserts | `fx.ts` (244), `fx-shell.ts` (28) | echo, filter, gate, tape-stop, brake, combo; absent |
| Stem band filters and mutes | `stem-bands.ts` (77), `deck.ts:220-235` | per-band and per-part filtering; absent |
| Deck analyser | `deck.ts:258` (`createAnalyser`) | waveform, level meters, spectrum; absent — the probe has no visual output |
| Mixer, master, booth, limiter | `mixer.ts:85-111` | four decks summed, master gain, limiter, booth out; the probe mixes one voice and clips nothing |
| Master analyser | `mixer.ts:107` | master meters; absent |
| Recording and broadcast | `mixer.ts:106` (`streamDest`), `main.ts` `recording:save` / `rtmp:*` | a `MediaStreamDestination` tap on the limiter; the probe has no tap |
| Scratch voices | `scratch-voice.ts` (190) | a second worklet for scratching; absent |
| Sampler | `sampler.ts` (166) | four banks of generated voices; absent |
| Platter / DVS drive | `platter.ts` (54), `deck.ts` `driveTimecode` | rate is a constant 1.0 in the probe |

So the probe answers "can this crate reach a device and keep time", and it
answers **nothing** about whether a DJ could use it. That distinction is the
whole reason D33 exists.

## 7. What would have to move to Rust for the probe to become the live path

Measured line counts are `grep -c ''` on this checkout. Estimates are marked
`[est]` and show their arithmetic. The Rust column is *new* code, not converted
code: the TypeScript is deleted only after the replacement passes parity tests,
so the migration cost is roughly both trees for the duration.

| # | Stage | Today (file, lines) | What moving it means | Rust `[est]` | Risk |
| --- | --- | --- | --- | --- | --- |
| 0 | **Sample-rate handling** | n/a — D21 refuses | a tested SRC at load (or per-voice rate), because the device is 48 kHz and libraries are 44.1 kHz | 250-400 + test vectors | **blocker**; no crate choice made, no `[verify]` done |
| 1 | Time-stretch / key lock | `pcm-source.ts` 682, of which ~110 is the worklet processor | `signalsmith-stretch` is not a Rust crate. A Rust stretch of equal quality has to be chosen or written | 800-1,500 | **highest risk**; quality is judged by ear, so it is not a line-count problem |
| 2 | Deck voice + transport glue | `pcm-transport.ts` 189 | already in Rust (`render.rs` 621, `transport.rs` 245) | 0 | low — this is the part M2 exercised |
| 3 | Trim, 3-band EQ, fader, cross | `deck.ts` graph portion, ~60 of 1,873 | biquads + gains in Rust, coefficient math has to match Web Audio's | 200-300 | medium — "sounds the same" needs A/B |
| 4 | FX | `fx.ts` 244 + `fx-shell.ts` 28 | 6-8 effects, each with state and modulation | 350 × 1.2 ≈ 420 | medium |
| 5 | Mixer + limiter + booth | `mixer.ts` 283 | summing, master, a limiter that matches the current one | 283 × 1.3 ≈ 370 | medium — limiter behaviour is audible |
| 6 | Stem band filters | `stem-bands.ts` 77 | per-band biquads and mutes | 77 × 1.5 ≈ 120 | low |
| 7 | Deck analyser / FFT | `fft.ts` 53 + `createAnalyser` use | FFT + peak/RMS in Rust, results over a seam to the UI | 120 | low, but the UI seam is real work |
| 8 | Scratch voices | `scratch-voice.ts` 190 | a second voice class with its own rate law | 190 × 1.4 ≈ 270 | medium |
| 9 | Sampler | `sampler.ts` 166 | voice generation + banks | 166 × 1.5 ≈ 250 | low |
| 10 | Recording / broadcast tap | `mixer.ts:106` + `main.ts` handlers | a ring tap feeding the existing Electron encoders | 150 | medium — the seam crosses processes |
| 11 | Platter / DVS rate drive | `platter.ts` 54 | the rate law must reach the Rust voice without a second state machine | 80 | medium — this is the "one transport" risk |
| 12 | Output device management | `mixer.ts` + Web Audio device handling | per-platform device selection, hot-plug, default-device change | 200-400 | medium, platform-specific |
| | **Total** | | | **≈ 3,150-4,300** | |

Arithmetic for the total: 250-400 + 800-1,500 + 0 + 200-300 + 420 + 370 + 120 +
120 + 270 + 250 + 150 + 80 + 200-400 = 3,230-4,380, rounded to
3,150-4,300 to acknowledge the coarseness of the estimates. Every `[est]` is a
judgement from the size of the TypeScript it replaces; none is measured.

Two of these dominate and neither is a coding problem:

- **#1 time-stretch.** The current quality comes from `signalsmith-stretch`
  1.3.2 (MIT, already in `NOTICE`). There is no in-tree Rust equivalent and no
  decision to write one. Without it the Rust path loses key lock, which is a
  headline feature (D16, D27).
- **#0 sample rates.** The probe proved the failure: a 44.1 kHz track is
  refused on this 48 kHz device. A live path cannot refuse most of a DJ's
  library.

## 8. The cost, honestly

- **To keep the probe:** ~260 lines of example plus ~40 lines of gate and one
  format-ranking function. Zero risk to the shipping path, because nothing in
  the application can reach it. This is the cost actually paid in M2.
- **To make it the live path:** roughly **3,200-4,400 new Rust lines**, a
  time-stretch decision, a sample-rate strategy, and a per-platform device
  layer — while the Web Audio graph keeps running, because D2 keeps EQ/FX/mixer
  there until the Rust versions pass parity. That is a multi-phase project, not
  a wiring task, and it buys nothing that is currently measured as missing.
- **What it would buy:** one render path on desktop and mobile, no
  SharedArrayBuffer seam, no worklet, and a transport that is already proven
  sample-exact. That is a real prize for D36 — it is just not free, and it is
  not justified by a latency problem nobody has measured yet.

The measured condition under which this arithmetic matters is written in
`docs/mobile/ADR-D33.md` §"The measured condition under which this changes".

## 9. Tier ledger

| Claim | Tier | Evidence |
| --- | --- | --- |
| `render_offline` returns exactly the requested frame count at 13 block sizes, incl. non-divisors | UNIT | `render::tests::render_offline_returns_exactly_the_requested_frame_count`, 19 frame counts × 13 block sizes |
| Forward loop wrap is sample-exact at every block size | UNIT | `render::tests::forward_loop_wrap_is_sample_exact_across_block_sizes` |
| Reverse loop wrap is sample-exact at every block size | UNIT | `render::tests::reverse_loop_wrap_is_sample_exact_across_block_sizes` |
| Reverse position advances exactly one frame per frame, no drift over 20 blocks | UNIT | `render::tests::reverse_position_is_exact_after_every_block` |
| A block straddling the seam wraps between samples | UNIT | `render::tests::a_block_straddling_the_loop_seam_wraps_between_samples` |
| Fractional rate keeps an exact loop period | UNIT | `render::tests::fractional_rate_keeps_exact_position_and_loop_period` |
| A voice ending mid-block keeps the exact output length | UNIT | `render::tests::a_voice_that_ends_mid_block_keeps_the_exact_output_length` |
| The probe refuses without the env gate | UNIT | `cpal_out::tests::the_probe_gate_is_closed_unless_the_variable_is_exactly_one` + observed run (§3.5) |
| F32 is preferred over U8 | UNIT | `cpal_out::tests::format_rank_prefers_f32_then_widest_integer` |
| The crate opens the default device at the source rate and its callback advances the transport in real time | **DEVICE** | §3.2, §3.3 — 47,904 frames/s over a 2.0 s window |
| A 44.1 kHz source is refused with `UnsupportedConfig` on a 48 kHz device, not resampled | **DEVICE** | §3.4 |
| The probe produces sound a human can hear | **not claimed** — HARDWARE needs ears | no listening test was performed |
| The probe is usable by a DJ | **not claimed** | no EQ, FX, mixer, analyser, recording, key lock (§6) |
| Native output on macOS, iOS or Linux | **not claimed** — unknown | only Windows was exercised; cpal backends differ per platform |
| The SharedArrayBuffer seam works in WebView2 | **not claimed** — open `[verify]` | the probe takes the example route, not the N-API route (ADR-D33 §Delta) |

## 10. What M2 did not do

- No EQ, FX, mixer, analyser, recording or stem code was moved to Rust.
- The decoder was not touched (D6).
- No dependency was added, bumped or removed. `cpal` 0.15 (Apache-2.0 OR MIT)
  and `symphonia` 0.5 (MPL-2.0) were already declared and already in `NOTICE`.
- No default was changed: `PcmSource` is still the deck source, the media
  element is still the streaming path, and `native-output` is still off.
- No `git` history was rewritten and nothing was committed.

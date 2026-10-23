# Audio engine

This document describes the playback engine as it is today and the target
architecture for sample-accurate, reverse-capable playback. It is the plan of
record for the engine phases; `docs/decisions.md` records the reasoning.

## Today

Local tracks no longer use an `HTMLAudioElement`. `Deck`
(`src/renderer/engine/deck.ts`) routes them through `PcmSource`:

- `File`, `blob:` and `file:` sources are decoded once with
  `ctx.decodeAudioData`; the same buffer feeds the scratch voice.
- `PcmSource` wraps `signalsmith-stretch` inside an AudioWorklet. Key lock,
  reverse (negative rate), loops and pitch hold are handled there.
- `tick()` reads PCM position and emits progress and end/loop events.
- `Platter` (`src/renderer/engine/platter.ts`) models torque, friction and
  inertia; DVS and on-screen scratching both drive it.
- Remote/stream URLs still use `createMediaElementSource(el)`, and the element
  remains a fallback if the Signalsmith module cannot load.
- EQ, FX, mixer, analyser, recording, broadcast, sampler and sync all remain in
  the Web Audio graph downstream of the deck source.

The PCM path supports reverse and pitch hold at about 8 ms reported engine
latency. Loops are scheduled through Signalsmith; reverse-loop correction in
`tick()` is coarse rather than sample-accurate. The media-element path still has
no reverse or deterministic render.

## Target architecture

A Rust audio engine owns decoding, transport and sample generation. The
renderer keeps the UI, Web Audio effects and analysis, and receives PCM through
an AudioWorklet.

```
file bytes ──► decoder (Rust, in-process) ──► PCM store (shared memory)
                                                   │
transport state (atomics) ──► render thread ──► SPSC PCM ring ──► PcmSource
     ▲                              │                                │
     └── command ring ◄── UI/DVS ───┘                    Web Audio graph (JS)
                                                          EQ/FX/mixer/analyser
```

### Rust crate: `rust/crates/opendeck-audio`

| Module | Responsibility |
| --- | --- |
| `decode.rs` | Container/probe and decode via Symphonia into planar float PCM; resample to the engine rate once at load |
| `store.rs` | Immutable decoded track: sample rate, channels, planar buffers, duration, peak data |
| `transport.rs` | Play/pause/seek/rate/loop state as atomics; command queue consumer |
| `stretch.rs` | Time stretch and key lock via signalsmith-stretch |
| `platter.rs` | Platter model for DVS and scratch: position, velocity, touch state |
| `voices.rs` | Multi-voice planar mixing; each voice has its own read position, rate, gain and loop window |
| `render.rs` | `render_offline(frames)` and the realtime `render(frames)`; sample-accurate loop splitting happens here |
| `ring.rs` | Lock-free SPSC ring of interleaved or planar f32 frames |
| `cpal_out.rs` | Optional `native-output` feature: default cpal device at the voice's exact source rate; not selected by a shell yet |
| `api.rs` | N-API (or Tauri command) surface: load, play, pause, seek, set rate, set loop, read meters |

The crate must not depend on UI code and must build on Windows, macOS and
Linux. It exposes `render_offline` first; every other feature is developed
against that deterministic function.

### Threading and transport

- One render thread per output device (or per offline render call).
- The UI sends commands through a lock-free SPSC command ring; commands carry a
  target sample frame so they can be applied sample-accurately.
- Continuous values (rate, gain, filter) are atomics read once per render
  block; no allocation, locks or logging on the render thread.
- Decoded PCM is shared through a `SharedArrayBuffer`; the worklet copies from
  the ring into its output. No `postMessage` per block.
- The engine publishes position and an xrun counter; the UI polls at animation
  rate, never per sample.

### Renderer seam

Replace the media element source with a `PcmSource` AudioWorklet node that
implements the same contract the rest of the graph expects:

- output channels match the deck channel count;
- `duration`, `currentTime` and `paused` are reported to the UI;
- `play()`, `pause()`, `seek()`, `setRate()` and `setLoop()` map to commands.

`Deck.el` is public and is read in `app.ts`. It becomes a compatibility object
with `duration`, `currentTime`, `paused` and the event methods actually used,
or the call sites are migrated and the field is dropped. This is audited before
the element is removed.

### Multi-voice from day one

The renderer mixes N voices per deck even though the first release uses one
normal voice plus one scratch voice. This avoids a later rewrite when stems,
scratch, and DVS all need independent read positions. A voice is a read cursor
plus rate, gain, loop window and interpolation mode; the mixer sums voices in
planar float.

### Loops

Loop boundaries are expressed in sample frames. `render()` splits a block at
loop boundaries and copies the wrapped remainder from the loop start, so the
loop is seamless at any block size and independent of JS timer jitter.

## Implemented so far

- `src/renderer/engine/pcm-transport.ts`: deterministic multi-voice transport
  with reverse playback, sample-accurate loops, rate changes and linear
  interpolation. `renderOffline(frames, blockSize)` is covered by tests that
  compare block sizes from 1 to 128 frames.
- `src/renderer/engine/pcm-source.ts`: `PcmSource` wraps Signalsmith Stretch in
  an AudioWorklet, with key lock, signed rate, loop scheduling, latency and
  underrun reporting. The legacy raw worklet remains an internal fallback.
- `src/renderer/engine/deck.ts`: local files use `PcmSource`; remote streams keep
  the media element. Scratch, key lock, reverse and diagnostics share the PCM
  path.
- `src/renderer/engine/platter.ts`: torque/friction/inertia model used by
  scratch and DVS, covered by `test/platter.test.ts`.
- `rust/crates/opendeck-audio`: the same transport in Rust with block-size
  invariance and reverse loops, plus `TransportState` atomics, a lock-free
  stereo SPSC ring (`ring.rs`) and a real-time render thread (`live.rs`). The
  live thread follows rate, seek and loop atomics and publishes position.
  `cpal_out.rs` adds an optional `native-output` stream that opens the default
  device at the source sample rate and pulls `LiveVoice` without allocating or
  locking in the callback. Native decode and selecting either native path in a
  shell are still to come.

## Latency budget

| Stage | Target |
| --- | --- |
| Output buffer | 128 frames (2.7 ms at 48 kHz) |
| Rust render block | 64-128 frames, no allocation |
| Ring depth | 2-3 blocks |
| Web Audio destination | whatever the host grants |
| Total, deck to speakers | under 10 ms where the driver allows |

The app asks for a 128-frame buffer and reports the actual value. An xrun
counter is exposed in the UI/diagnostics; it is the acceptance signal for the
latency work, not a claimed number.

## Invariants

1. The timecode decoder output is byte-identical to today's decoder. The engine
   consumes the same position/direction/speed values; it does not change
   demodulation.
2. Web Audio still performs EQ, FX, mixer, master limiting, analysis,
   recording and broadcast. The engine replaces the source, not the graph.
3. Audio callbacks never allocate, lock, log, or touch the DOM.
4. Every transport feature is testable through `render_offline`.
5. Streaming mini-players, AUX capture, recording and the sampler keep working;
   they are not routed through the new deck source.

## Migration plan

1. **Done:** JS `PcmSource` with Signalsmith Stretch, key lock, reverse, loops
   and platter; local files now use it.
2. Add the Rust crate with decode/store and the same offline render tests.
3. Put the Rust engine behind the worklet, keep the existing deck API, and
   compare output with the prototype.
4. Switch loops, cue jumps and DVS to sample-accurate transport.
5. Remove the media element from the deck path; only remote streams should keep
   it once streaming is ported.

## Test strategy

- Unit tests for ring buffer ordering, voice mixing, loop splitting, rate
  changes and platter physics.
- Golden-file tests: `render_offline` at fixed rates and loop points, compared
  with committed hashes or tolerance bounds.
- Property tests: render in arbitrary block sizes and assert the concatenated
  output is identical to one large render.
- Integration: load a generated WAV, render N frames, assert position, loop
  wrap and reverse.
- Existing `npm test`, `npx tsc --noEmit` and `cargo test` stay green after
  every phase.

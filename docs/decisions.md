# Decisions

Short records of choices that shape the parity work. Each entry states the
decision, why, and what would make us revisit it. Assumptions that still need
verification are marked **[verify]**.

## D1: Documentation before engine work

**Decision:** Phase 0 lands `NOTICE`, interop, engine, parity and decision docs
before any playback change.

**Why:** The engine and format work are large and easy to get subtly wrong. The
format rules and license position need to be written down while they are being
verified, and reviewers need a stable description of the target.

**Revisit:** Never; docs are updated with each phase.

## D2: Keep Web Audio for EQ, FX, mixer, analyser, recording and broadcast

**Decision:** The new engine replaces only the deck source. Everything
downstream stays in the Web Audio graph.

**Why:** These paths work and are covered by tests. Moving them to Rust would
expand the change and risk recording, streaming and broadcast. The latency that
matters is source-to-output, and the media element is the main offender.

**Revisit:** If the graph itself becomes the latency or xrun bottleneck, profile
before moving anything.

## D3: Rust engine with a JS AudioWorklet seam

**Decision:** Decode, transport, stretch, platter and voice mixing live in a new
`opendeck-audio` Rust crate. The renderer talks to it through a `PcmSource`
AudioWorklet fed by a lock-free ring.

**Why:** Native decode and a dedicated render thread give reverse, sample-
accurate loops and predictable latency. The worklet keeps the existing graph
and avoids a second audio API in the UI.

**Status:** P1 ships the JS PCM path first. The Rust crate now has native
decoding (`decode` feature), transport atomics, a lock-free stereo ring, a
render thread and an optional cpal output stream, all covered by tests. The
native output opens the default device at the voice's source rate, so it does
not resample. The Tauri shell uses native decode for file analysis; the JS
`PcmSource` still owns live playback and pitch hold, and no shell selects the
native output path.

**Revisit:** If N-API/SharedArrayBuffer plumbing proves unreliable in the Tauri
WebView2 build, fall back to a native output device (`cpal_out`) behind the same
`api.rs` surface.

## D4: `render_offline` is the first-class API

**Decision:** The engine must expose deterministic offline rendering before
realtime output is wired.

**Why:** It makes loops, rate changes, reverse and stretching testable without
audio hardware, and it gives golden tests a stable target.

**Revisit:** No.

## D5: Multi-voice mixing from the start

**Decision:** The mixer sums N planar voices per deck even when only one normal
voice and one scratch voice are used initially.

**Why:** Scratch, DVS and future stem playback all need independent read
positions. Retrofitting voices later would touch the transport and loop code
again.

**Revisit:** If voice count proves to be a measurable cost, cap it explicitly
rather than removing the abstraction.

## D6: Timecode decoder is frozen

**Decision:** Demodulation and decoding stay byte-identical. The engine consumes
the existing position/direction/speed output.

**Why:** The decoder is tested against generated signals for five media types.
Changing it for engine convenience would invalidate that work and risk DVS
compatibility.

**Revisit:** Only with a separate, fully re-tested decoder change.

## D7: Write both `Serato Markers_` and `Serato Markers2`

**Decision:** Cue writes emit both the legacy and current tag representations,
and reads prefer `Markers_` for slots 1-5.

**Why:** Serato versions differ in which frame they trust for the first five
slots; writing both keeps slots consistent across versions.

**Revisit:** If a Serato version is shown to reject one frame when both exist.

## D8: Export the legacy library format, not Serato's SQLite

**Decision:** Crate export writes `Subcrates/*.crate`, `database V2` and
`neworder.pref`. Serato DJ Pro 4 imports them at startup.

**Why:** The legacy format is documented, stable and sufficient for crates.
Writing Serato's live SQLite is higher risk and only needed for column layout.

**Revisit:** If a future Serato release stops importing the legacy files.

## D9: Crate column layout is opt-in

**Decision:** The only direct SQLite edit, `container_asset_list_columns`, is a
separate command, runs only after Serato has imported the crates, and takes a
backup.

**Why:** It is cosmetic, version-sensitive and not needed for the music data.
Column flow through `ovct` alone only reaches the DJ column set. **[verify]**
against the Serato 4 build under test.

**Revisit:** If Serato exposes a supported layout import.

## D10: Safety rules for writing user libraries

**Decision:** Refuse to write while Serato is running; write to a temporary copy;
verify the audio payload and unrelated tag bytes are identical before swapping;
log replaced bytes for undo.

**Why:** These files are a DJ's working library. A silent metadata loss is worse
than a failed export.

**Revisit:** No; rules can only get stricter.

## D11: License policy

**Decision:** MIT/Apache-2.0 preferred, MPL-2.0 allowed, GPL forbidden for
linked code. Every dependency goes into `NOTICE`, including planned ones.

**Why:** OpenDeck is MIT and should stay redistributable under that license.
Symphonia's MPL-2.0 is file-level copyleft and acceptable while unmodified.
FFmpeg stays an optional external tool and is never bundled.

**Revisit:** Before adding any new dependency or vendoring any parser.

## D12: Naming and assets

**Decision:** Do not call OpenDeck "Serato". Refer to the other product as
"Serato DJ Pro" only when describing compatibility, and copy no assets, fonts,
audio or manual text.

**Why:** Avoid trademark confusion and copyright risk while still telling users
what the files are compatible with.

**Revisit:** No.

## D13: EQ wording

**Decision:** Describe the four bands as a filter bank, not source separation,
until P5 lands. P5 then renames the control so "stems" means the separated parts.

**Why:** The current implementation is a filter bank; calling it stem-style
overstates what it does. Source separation is in scope (P5), not a non-goal.

**Revisit:** When P5 ships real separation.

## D14: Deck public API compatibility

**Decision:** Preserve the documented `Deck` surface. `el` is audited in
`app.ts`; it becomes a compat object with `duration`, `currentTime`, `paused`
(and only the methods actually used) or the call sites are migrated.

**Why:** The UI and tests depend on the deck contract. A flag-day rewrite would
mix engine risk with UI churn.

**Revisit:** Once all call sites are migrated, remove the stub in a dedicated
change.

## D15: One commit per phase, revert on incomplete work

**Decision:** Each phase is a single commit named `phase N: <what>`. If a phase
cannot be finished, revert it cleanly and write `RESUME.md`.

**Why:** Keeps history bisectable and prevents half-wired audio or format code
from sitting on `main`.

**Revisit:** No.

## D16: Signalsmith Stretch for pitch hold

**Decision:** Use `signalsmith-stretch@1.3.2` (MIT) behind the `PcmSource`
interface. Key lock on feeds zero semitones; key lock off feeds
`12 * log2(abs(rate))` so the pitch follows the tempo. Reverse uses a negative
playback rate.

**Why:** It is tested, MIT-licensed and runs in the existing Web Audio graph.
Keeping the old worklet as an internal fallback avoids losing playback if the
stretch module fails to load, but the fallback does not preserve pitch.
The node is created with `numberOfInputs: 1` even though no live input is
connected: with zero inputs, Signalsmith's inactive branch dereferences an
undefined input list and the worklet processor throws, which silences the deck.

**Revisit:** If the Rust live engine replaces the JS PCM path, or if a
sample-accurate reverse loop requires a different scheduler.

## D17: Local files decode once to PCM

**Decision:** Local `File`, `blob:` and `file:` sources decode once with
`decodeAudioData` and play through PCM. The `<audio>` element is kept only for
remote/stream URLs and as a playback fallback. The decoded buffer is shared with
the scratch voice so scratch uses the same samples.

**Why:** One decode avoids drift and double I/O, keeps pitch hold available and
lets the deck work without a media-element source. Remote streams cannot be
fully buffered, so they stay on the element.

**Revisit:** When the Rust engine owns decoding for every source.

## D18: Report engine latency, not device latency

**Decision:** Configure Signalsmith with `blockMs: 8`. The diagnostics panel
reports the engine's measured `latency` (about 8 ms). It does not add
`AudioContext.baseLatency` or output-device latency.

**Why:** The target is a controllable, measurable engine figure. Mixing device
latency into it would vary by machine and driver and make regressions hard to
compare.

**Revisit:** If user-facing latency must include output scheduling; label it
explicitly if so.

## D19: Platter physics live in the renderer

**Decision:** Model scratch torque, friction and inertia in
`src/renderer/engine/platter.ts`; the deck converts platter velocity to a rate.
DVS and on-screen scratching both drive the same platter.

**Why:** One scratch model keeps mouse, keyboard and timecode behaviour
consistent and testable in JS while the Rust seam is unfinished.

**Revisit:** When the Rust live render thread is wired; the platter can become
the control-rate input to that thread.

## D20: DVS drives one scheduled transport segment

**Decision:** DVS calls `Deck.driveTimecode(rate, position)`. For PCM tracks the
deck rounds the position to a sample frame and hands rate plus position to
`PcmSource.drive`, which schedules them together 20 ms ahead. Jumps and drift
over 90 ms carry an exact target; normal blocks carry only the rate.

**Why:** Rate and position reach the worklet in one ordered schedule instead of
separate seek/rate messages. The target frame is exact and the jump does not
tear across a rate update. A true lock-free shared-state handoff waits for the
Rust live path.

**Revisit:** When the Rust transport atomics back the live deck.

## D21: Native output opens the device at the source rate

**Decision:** `NativeOutput::start` takes the voice's sample rate and selects a
mono/stereo f32/i16/i32/u8 device config at exactly that rate. If the device
does not offer it, startup returns `UnsupportedConfig` instead of playing at the
wrong speed. Scratch buffers are preallocated at 32,768 frames and the callback
zero-fills any excess. The `native-output` feature gates cpal, so the default
build stays dependency-light.

**Why:** An exact rate match removes the need for a resampler in the audio
callback and guarantees the render thread's sample accounting remains true.
Silently resampling or playing at the device maximum would make tempo and loop
positions wrong, which is worse than a clear startup error.

**Revisit:** When native decode lands, either keep source rates per voice and
resample at load, or add a tested converter before the device callback.

## D22: Native decode feeds analysis; playback stays in the Web Audio graph

**Decision:** The Tauri shell decodes local files with `opendeck-audio` for
analysis (BPM, key, peaks, duration, bands). Live deck playback stays on the JS
`PcmSource`; the optional cpal output is compiled and tested but no shell
selects it for deck audio.

**Why:** Replacing the deck source with a native output device would bypass the
EQ, FX, mixer, analyser and recording graph, and key lock would move to a second
path. Native analysis gets codec coverage without regressing those features.
The P1 exit criteria are about behaviour (reverse, key lock, exact loops, PCM
ownership), not about which language renders the stream.

**Revisit:** When decoded PCM and transport state can cross into the worklet
through a stable shared-memory seam, or when the Web Audio graph is measured as
the latency bottleneck. Wiring `cpal_out` directly requires a native mixer that
recreates the downstream graph first.

## D23: Pad modes share the eight pad buttons; sampler has four banks

**Decision:** Each deck owns one `PadMode` and the eight pads change meaning by
mode. The ten modes are Hot Cue, Cue Loop, Loop Roll, Slicer, Beat Jump,
Transport, Pitch Play, Scratch, Sequence and Part FX. Hold modes use pointer
down/up and restore the previous rate/key-lock state. Loop Roll and Slicer
release to `position + elapsed × rate` rather than chasing a source-level
rolling buffer. Sequence records mode, pad index and press/release phase with
millisecond timestamps (cap 128), then loops the events until stopped on a
20 ms timer with a 140 ms tail. Part FX uses four pads for per-part low-pass filters and four for per-part mutes
once true parts are loaded; before separation it falls back to the four filter
bands. Each band and each true part has its own Biquad insert before its gain. Shift+click on a Scratch pad loads the current
local track into that pad; hold then scratches it through a separate
`ScratchVoice`. Sampler slots are four banks of eight generated drum voices,
addressed 0-31.

**Why:** This delivers the pad wall, a usable scratch bank and a 32-slot sampler
without changing the Serato tag format. Sequence events are semantic pad
actions rather than raw audio, so they replay through the same mode handlers as
pointer input. P5 routes each separated part through its own Biquad and gain, so part effects
no longer depend on the filter bank.

**Revisit:** Record part switches in sequences. Add user samples and per-slot
gain/pan when sampler import lands. Replace the rolling-loop approximation if a
dedicated transient/roll buffer is added.

## D24: P5 separates four parts offline and caches them beside the track

**Decision:** Source separation runs in the Electron main process with
`onnxruntime-node` 1.20.1 and the MIT-licensed
`htdemucs_fp16weights.onnx` model. The model is downloaded on demand, checked
against its SHA-256 digest, and stored under the app user-data folder.
`OPENDECK_STEM_MODEL` can point at a local model during development, which
bypasses the download but not the size check. The
renderer decodes the track and sends stereo Float32 PCM plus the content hash to
main. Main resamples to 44.1 kHz, runs overlapping model chunks, normalises the
overlap-add result, and writes four interleaved Int16 files plus
`manifest.json` under `.opendeck-stems/<content-hash>-<model-version>/` beside
the track. If that folder is not writable it falls back to
`<userData>/stems/.opendeck-stems/`.

The cache key is the SHA-256 of the source bytes plus the model version, never
the file name. A cached track loads without running inference. With the model
installed, a newly imported local track separates automatically; without it the
Parts bar shows an install button. `PartId` is drums, bass, other or vocals and
the deck reuses `PcmSource` for all four voices. Part return-mode scratches one
part through its own `ScratchVoice` while the other voices keep playing.

**Why:** The main process owns filesystem writes, model installation and the
native runtime, so the renderer keeps only decoded PCM and the audio graph.
Content hashing makes the cache survive ID3 rewrites and renames. Storing Int16
halves the cache size while keeping the four-part mix well above audible noise
for DJ use. Keeping `PcmSource` means key lock, reverse, seeking and exact
loops behave the same on one voice as on four.

**Revisit:** The current download is 166 MB and CPU inference is roughly eight
seconds per 7.8 s model chunk on the test machine, so long tracks take minutes
and block only that separation request. Add cancellation, a progress-aware
queue and a smaller quantised model when available. Consider a `MessagePort`
or shared buffer for very long tracks instead of structured-cloning PCM and
Float32 parts across IPC. Revisit the cache format when stem FX chains become
user-configurable.

## Open assumptions

- **[verify]** Serato DJ Pro 4 still imports legacy crates automatically when
  the files change, including on a library that already exists in SQLite.
- **[verify]** The 18-colour cue palette values and the exact `Markers2`
  encoding used by the current Serato build.
- **[verify]** Which Serato versions prefer `Markers_` over `Markers2` for slots
  1-5; the encoder writes both regardless.
- **[verify]** The beat-grid lock flag bit and its position in `Serato BeatGrid`.
- **[verify]** Whether `container_asset_list_columns` usage `1` is stable across
  Serato 4 point releases.
- **[verify]** WebView2's SharedArrayBuffer/AudioWorklet combination for the
  Rust engine seam, and whether cross-origin isolation is needed in the Tauri
  build.

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

**Why:** OpenDecks is MIT and should stay redistributable under that license.
Symphonia's MPL-2.0 is file-level copyleft and acceptable while unmodified.
FFmpeg stays an optional external tool and is never bundled.

**Revisit:** Before adding any new dependency or vendoring any parser.

## D12: Naming and assets

**Decision:** Do not call OpenDecks "Serato". Refer to the other product as
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

**Decision (revised 2026-10-31):** Configure Signalsmith with `blockMs: 120`,
`intervalMs: 30`, and only route audio through it when pitch has to be held
(key lock at a non-unity rate, or a key shift). At 1.0x, or with key lock off,
`PcmSource` plays through the direct interpolating worklet, which is
bit-transparent at unity. The diagnostics panel reports the active engine's
latency: one render quantum (about 3 ms) direct, about 120 ms with Signalsmith.
It does not add `AudioContext.baseLatency` or output-device latency.

**Why the revision:** `blockMs: 8` measured THD+N of +4.3 dB (55/110 Hz pair)
and +9.7 dB (80/440/2500 Hz mix), so the artefacts were louder than the music,
against -59/-57 dB direct. At 120 ms it measures -41/-54 dB. `intervalMs: 2`
also ran an FFT every 2 ms on every node, including idle decks. The audio smoke
test now fails if direct THD+N rises above -50 dB or stretched above -40 dB.

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

## D25: Bidirectional Serato V2 database, text tags, and opt-in SQLite column layout

**Decision:** Extend `serato-codec.ts` to decode and re-encode `database V2` `otrk` records (preserving unknown sub-chunks and mapping `tgrp` grouping, `trmx` remixer, `ulbl` track colour, `utpc` play count, `bbgl` beatgrid lock, and `bply` played flags), add `TBPM`/`TKEY` ID3v2 and FLAC/MP4 `BPM`/`INITIALKEY` text tag readers/writers alongside `Serato Markers2`/`Markers_`/`BeatGrid`, and format `container_asset_list_columns` payloads with the ASCII `0x1e` Record Separator for the opt-in SQLite layout command.

**Why:** Serato DJ Pro 4 reads `TBPM`/`TKEY` and `database V2` fields when refreshing crates, while unknown `otrk` sub-chunks must survive round-trips untouched. Keeping `container_asset_list_columns` opt-in and backed up avoids touching Serato's live SQLite during normal crate exports.

**Revisit:** If Serato 4 changes the `container_asset_list_columns` schema in a future release.

## D26: DVS Internal, Relative, and Absolute modes with continuous drift correction

**Decision:** `DvsTransport` supports `"internal" | "relative" | "absolute"` modes (`default: "absolute"` so existing DVS callers and tests see identical jump behaviour). In `"relative"` mode, needle drops shift `relativeAnchor` rather than emitting position jumps, and `computeDriftCorrection` returns a bounded rate trim (`±0.08`) to keep the PCM playhead locked to the vinyl phase without audible pitch warble.

**Why:** Turntablists use Relative mode so cueing and looping work inside the software while the control vinyl governs speed and direction; Absolute mode preserves 1:1 needle-drop seeking.

**Revisit:** When DVS moves into the native Rust audio thread.

## D27: Independent pitch shift (semitones) on `PcmSource` and `Deck`

**Decision:** `PcmSource` adds `pitchShiftSemitones` (`-12` to `+12`) summed into `semitones()` for `signalsmith-stretch` (and converted to `2^(semitones/12)` rate scaling on the fallback worklet). `Deck` exposes `setPitchShift`, `shiftKeySemitones`, and `resetKeyShift` across both main PCM and separated stem voices.

**Why:** Harmonic mixing requires transposing key independently of tempo while key lock is active, and shifting all four separated stem voices in lockstep keeps stems in tune.

**Revisit:** No.

## D28: Return-Mode (Slip), Reverse-on-Hold (Censor), and Instant-Doubles on `Deck`

**Decision:** `Deck` tracks a virtual forward timeline (`slipEntryPos`, `slipEntryMs`, `slipEntryRate`) using `rollingReleasePosition` when `returnMode` (`SLIP`) is active across hot-cue holds, platter scratches, and loop rolls. `beginReverseOnHold` / `endReverseOnHold` (`CENSOR`) reverses playback while advancing the ghost timeline forward and snaps to `censorReleasePosition` on release. `cloneFrom(other)` copies the decoded `AudioBuffer`, playhead sample, rate, keylock, pitchShift, cues, loops, and beatgrid to the target deck without re-decoding.

**Why:** Slip, Censor, and Instant-Doubles are core performance primitives that should work identically on 2 or 4 decks without re-reading disk files.

**Revisit:** No.

## D29: Editable Beatgrid with lock enforcement

**Decision:** `beatgrid.ts` provides `EditableBeatGrid` and pure helpers (`setBeatGridLock`, `setGridDownbeat`, `shiftBeatGrid`, `setBeatGridBpm`, `adjustBeatGridBpm`, `scaleBeatGridBpm`, `addWarpMarker`, `tapBeatGridBpm`, `beatGridToMarkers`, `markersToBeatGrid`). When `grid.locked` (`bbgl` / `Markers2.bpmLocked`) is `true`, all mutation helpers and `Deck` grid methods (`setBpm`, `shiftGrid`, `scaleGridBpm`, `adjustGridBpm`, `setGridDownbeatHere`, `tapGridBpm`) are no-ops.

**Why:** Prevents accidental BPM or downbeat overwrites on tracks whose beatgrids have been manually verified and locked.

**Revisit:** No.

## D30: 4-Deck Mixer & Workspace, Playlists, Smart Crates, and Custom FX Presets

**Decision:** `DeckId` widens to `"A" | "B" | "C" | "D"` with per-deck crossfader assignment (`"A" | "B" | "THRU"`), Hamster reverse (`crossfaderReverse`), booth output gain, and channel fader curves in `Mixer`. `Library` adds `PlaylistStore`, rule-based `LivePlaylistStore` (Smart Crates), 6-colour Serato track badges, and `playCount` sorting. `fx.ts` adds `tremolo`, `gate`, `tape-stop`, `brake`, `combo-filter-echo`, and `CustomFxStore` presets.

**Why:** Completes the remaining Phase 4 & Phase 6 parity items additively while keeping the 2-deck default view clean.

**Revisit:** When multi-insert Web Audio FX routing is expanded to run all 3 custom FX slots simultaneously in series.

## D31: 195-Device Hardware Catalogue, 4-Deck MIDI Targets, and DVS Interface Auto-Recognition

**Decision:** `src/renderer/midi/profiles.ts` exports `SUPPORTED_HARDWARE_RAW` (195 verbatim device strings), `HARDWARE_CATALOGUE` (195 typed entries across `controller-2deck`, `controller-4deck`, `mixer-dvs`, `dvs-interface`, `media-player`, and `accessory`), and `DEVICE_PROFILES` sorted by model specificity so longer suffixes (`CDJ-3000X`, `CDJ-2000NXS2`, `DDJ-SB3`, `DJM-V10-LF`, `PRIME 4+`, `SC6000M PRIME`, `Inpulse 200 MK3`, `Mixstream Pro Go`, `Party Mix II/Live/Pro`, `Reloop Flux Go`, `RP8000 MK2`, `TR-8S`) match before shorter prefix models. `profileForDevice(name)` normalizes trailing ` .` DVS-upgrade suffixes and matches full vendor names, vendor-stripped USB MIDI/Audio descriptors, and hyphen/space variants while preserving all existing `Hercules DJControl T10` and `Numark Party Mix III` bindings. `src/renderer/app.ts` expands `MIDI_TARGETS` and `midiInputFor` to all four decks (`A..D`, `mix.chC`, `mix.chD`) and auto-enables 4-deck mode when a 4-deck controller is detected. `src/renderer/dvs-panel.ts` badges recognized DVS mixers and interfaces with `[DVS Ready]` or `[DVS Upgrade]` and auto-selects the first detected DVS input.

**Why:** Provides out-of-the-box MIDI and DVS hardware recognition across the complete 195-device Serato hardware matrix without breaking existing learned mappings or test assertions.

**Revisit:** When vendor-specific HID platter/display feedback reports are added for CDJ/RANE motorized decks.

## D32: Phase 7 Video Mixing & Secondary Fullscreen Output Window (2026-10-24)
- **Context:** Phase 7 specifies one video file per deck position-locked to that deck's transport (play, pause, seek, reverse, and scratch follow), an independent video crossfader, `fit`/`fill` scaling, optional video FX, and a second fullscreen output window.
- **Decision:** Implemented `src/renderer/engine/video-mixer.ts` (`VideoMixer`, `computeVideoSyncTarget`, `shouldResyncVideoElement`, `computeVideoCrossfaderWeights`, `computeAspectRect`, `formatVideoCssFilter`), `renderer/video-output.html`, and Electron IPC (`video:open-output`, `video:close-output`, `video:fullscreen-output`, `video:sync-output`) in `src/main/main.ts` and `src/preload/preload.ts`. Because HTML5 `<video>` elements do not support negative `playbackRate`, reverse playback (`rate < 0` / Censor) and active platter/DVS scratch step `currentTime` directly on every frame while forward playback uses native `playbackRate` with a 45 ms drift resync window.

---

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

---

## D33-D38: Run 1 decisions

Run 1 added six decisions. They are kept as standalone files under `docs/mobile/`
because they are long, each carries its own evidence table, and several were
written concurrently. They use the same decision / why / rejected options /
revisit-if shape as D1-D32.

| ADR | Title | File |
|---|---|---|
| D33 | Native output probe (amends D22) | `docs/mobile/ADR-D33.md` |
| D34 | Ableton Link licensing | `docs/mobile/ADR-D34.md` |
| D35 | Tempo authority | `docs/mobile/ADR-D35.md` |
| D36 | Shared-core boundary | `docs/mobile/ADR-D36.md` |
| D37 | Per-platform surface and providers | `docs/mobile/ADR-D37.md` |
| D38 | Shell: Electron is the product, Tauri is a harness | `docs/mobile/ADR-D38.md` |

D34 does **not** amend D11: no GPL code was linked, and the shipped Link
implementation speaks its own protocol (`opendeck-link/1`), not Ableton's.

---

## D39: CDJ (Pro DJ Link) and USB drive import, clean-room, prompt before import (2026-10-31)

- **Context:** A DJ should be able to plug a USB stick into a CDJ networked to the laptop, or into the laptop itself, and play its music in OpenDecks. The project already carries a GPL contamination problem (xwax), so no code from existing Pro DJ Link implementations may be used: beat-link and crate-digger (EPL), prolink-connect, python-prodj-link and the Rust `prolink` crates (GPL or otherwise incompatible) were **not** opened, read or copied. One web search during the work returned short excerpts from the Rust `prolink` crate's docs.rs pages (GPL-3.0) among its results; none of that was used, and every layout here was taken from the Deep Symmetry prose/diagrams and the RFCs (e.g. the `/B/`=SD, `/C/`=USB mapping is stated in exports.html).
- **Decision:** `src/main/prolink/` implements, from protocol *descriptions* only:
  - `packets.ts` / `devices.ts` / `network.ts`: keep-alive discovery on UDP 50000, a virtual player (CDJ-3000-compatible keep-alive), CDJ status on 50002 with USB (byte `6f`) / SD (byte `73`) mount transitions, media query/response, channel-conflict handling, 5 s device timeout. Sockets bind `0.0.0.0` (Windows needs it for broadcast) but accept only the chosen interface's subnet, and keep-alives go to that interface's directed broadcast address.
  - `xdr.ts` / `rpc.ts` / `nfs.ts`: ONC RPC v2 over UDP (RFC 1057) with AUTH_UNIX, portmapper GETPORT, MOUNT v1 MNT, NFSv2 GETATTR/LOOKUP/READ/READDIR (RFC 1094); 8 KB reads with a 4-deep window, short-read handling, retransmission with back-off. File names and the mount path are sent UTF-16LE (Pioneer's server), falling back to ASCII if the mount is refused.
  - Export paths: **`/C/` is the USB slot and `/B/` is the SD slot**, per the rekordbox export analysis. (The original task note said the reverse; the description was followed.)
  - `pdb.ts` / `anlz.ts`: `export.pdb` pages, row groups, presence bits, DeviceSQL strings; tracks, artists, albums, genres, labels, keys, colours, artwork, playlist tree and entries. ANLZ `PCO2` (preferred) / `PCOB` hot cues.
  - `volumes.ts`: local removable drives (Windows drive-letter poll + PowerShell/wmic classification, macOS `/Volumes` + diskutil, Linux `/media/$USER`, `/run/media/$USER`, `/media`).
  - `importer.ts` / `manager.ts` / `prompt.ts`: one pipeline for both origins (NFS reader or local reader), probe → **prompt** → import → load → remove. Nothing is imported until the user clicks Add, or a remembered "Always do this for this drive" choice (stored per mediaKey in `<userData>/prolink.json`) says so.
  - IPC (`djmedia:*`) serves track bytes only by (sourceId, trackId) from an imported library; the renderer never names a path, and local paths are confined to the drive root.
- **Why:** NFS reads of `export.pdb` work with four real players present (dbserver queries do not), and reading the file directly keeps the client small and dependency-free (Node `dgram` only). Copying CDJ tracks into a cache and then loading a normal `File` reuses the existing decode/analysis/cue path unchanged.
- **Rejected:** dbserver (TCP 12523) metadata queries — need a real player number and do not scale to four players; streaming playback straight from NFS — a network hiccup would become an audio dropout; automatic import — the user asked to be asked first.
- **Unverified:** every byte layout is from the documentation and checked only against fakes built from the same documentation. Specific uncertainties: the track-row `file_type` offset (the prose says `60-61`, the diagram puts it at `5a`; `5a` is used), the 3-byte row-count packing (low 13 bits = offsets), whether Pioneer's MOUNT accepts AUTH_UNIX with an empty machine name, and the PCO2 colour offset (the prose says `len_comment + 1c`, the diagram implies `2c + len_comment`; the latter is used).
- **Revisit if:** first contact with real hardware disagrees with any of the above; OneLibrary-only sticks become common (add an `exportLibrary.db` reader); waveform or beat-grid import is wanted.

---

## D40: Stem separation off the main process, progressive from the playhead, tuned CPU, GPU with fallback (2026-10-31)

- **Context:** "The real-time stem generation is very slow." htdemucs (ONNX, `htdemucs_fp16weights.onnx`, 343 980-frame chunks, 25% overlap) ran in the Electron **main process** with `intraOpNumThreads = min(8, cpus - 1)` over the whole track, and the deck got nothing until every chunk was done, the cache written and read back. onnxruntime-node's `session.run` is synchronous on the JS thread (`setImmediate` around a blocking native call), so each chunk froze the main process (IPC, windows) for seconds.
- **Measured** (`scripts/bench-stems.mjs`, `scripts/bench-stems-pipeline.mjs`; linux-arm64 Neoverse-V2, **2 cores**, 3-minute 48 kHz synthetic track, 31 chunks; GPU not measurable here):

  | | session | per chunk | peak RSS | full track | first usable stems |
  |---|---|---|---|---|---|
  | before (1 thread, opt `all`, arena on) | 5.2 s | 9.4 s | 5.7 GB | ~298 s (+ write + read back) | after the full track |
  | after, CPU (2 threads, opt `disabled`, arena off) | 9-11 s (prewarmed at start) | 5.5 s | 1.1 GB | ~181 s projected (1.07x realtime) | ~17 s cold, ~5.5 s prewarmed, at the playhead |

  Single changes: threads 1 -> physical cores: 9.4 -> ~5.0 s/chunk (the win; onnxruntime's own default, threads 0, measured the same). Arena off: same speed within noise, -1.2..1.7 GB peak. Mem pattern on/off, `extended` vs `all`: no measurable difference (kept defaults). Optimisation `disabled` vs `all`: +5-10% per chunk, -3.4 GB peak, and see below.
- **Electron crash found while testing:** inside Electron 44 (main or utility process) onnxruntime-node 1.20.1 aborts with SIGTRAP on the **second** htdemucs run at graph optimisation `basic`, `extended` or `all` (with the old arena-on options it aborted during the first). Plain Node 22 is unaffected. Only `disabled` ran repeatedly. Seen on linux-arm64 only; not verifiable here for Windows/macOS. CPU therefore ships `disabled`; output matches `all` to 1 LSB.
- **Decision:**
  - `src/main/stems/worker.ts` runs in an Electron **utilityProcess** (worker_thread outside Electron) at below-normal priority, with one shared session and a FIFO `JobQueue`; `src/main/stems/host.ts` (main) dedupes decks asking for the same track, cancels a job when its only deck loads another track (between chunks), forwards playhead moves, and restarts the worker on the CPU and resubmits work if it dies while a GPU provider is active. The session is prewarmed 4 s after start when the model is installed.
  - Chunks run from the playhead (or cue point when stopped) outward, two ahead for one behind (`orderChunksFromFocus`); a seek reorders what is left. Each finished chunk is posted at once: normalised, resampled to the deck's buffer rate, and blended (`StemAccumulator.region`, 4096-frame ramp) with a mix/4-per-part placeholder at every edge that still borders unfinished audio. The deck switches to part voices on the first region **without stopping** (parts start silent at the mix position and crossfade in ~15 ms), and later regions are patched into the AudioBuffers, the PCM worklets and the scratch worklets in place (`patch` message; the stretch engine resyncs at most every 4 s and at the end). Unfinished audio still sums to the full mix, so nothing drops out.
  - When the job ends every region is already in the deck: the cache is written once by the worker (format and `MODEL.version` unchanged, so old caches stay valid) and not read back. Region buffers are transferred, not copied, where the transport allows (worker_thread and worklet ports); the renderer no longer `slice()`s the mix before IPC; cache reads deinterleave + scale + resample in one pass.
  - Stems now come out at the deck's sample rate. Before, 44.1 kHz stems were loaded into a 48 kHz context and the direct engine played them ~9% fast and sharp.
  - GPU: providers per what onnxruntime-node 1.20.1 actually ships (README table + the binding's `listSupportedBackends()` / symbols): Windows x64/arm64 `dml` (DirectML.dll is in the package and in the installer), macOS `coreml` (in the darwin binding although the README table omits it), Linux x64 `cuda` only when `libonnxruntime_providers_cuda.so` is installed (not bundled); Linux arm64 CPU only. `optimizedModelFilePath` is not read by the 1.20.1 node binding, so no optimised-graph cache. The GPU plan lists CPU behind it; a session failure, a run error or a first result that is NaN/Inf/silent disables that provider in `<userData>/stems-providers.json` (cleared when onnxruntime's version changes) and the job finishes on the CPU. `OPENDECK_STEM_EP=cpu` forces CPU.
- **Rejected:** overlap 25% -> 12.5% (-13% chunks): against the 25% output on the test signal, SNR was only 15.7 dB (drums), 37.6 (bass), 15.5 (other), 5.7 (vocals): the model's output depends on where chunks start, so this is a quality change, not a free speed-up. A different/smaller model (not done without asking). SharedArrayBuffer stems (needs cross-origin isolation, which would break the embedded streaming pages).
- **Unverified / limits:** GPU speed and stability (DirectML, CoreML) untested here; CoreML may partition htdemucs heavily onto the CPU. Whether the Electron optimisation crash also hits Windows/macOS. With key lock at a non-unity rate, a stretch resync swaps buffers between two render quanta and could, at worst, drop one 128-frame block. The FIFO is per job: a second deck waits for the first deck's track to finish.
- **Revisit if:** onnxruntime-node is upgraded (re-test `all`; it is faster), GPU numbers come in, or a faster/smaller separation model is wanted.

---

## D41: Track analysis on a worker pool with deck priority (2026-10-31)

- **Context:** Bulk analysis (BPM, key, waveform) ran one track at a time: read the file, `decodeAudioData` on the renderer's AudioContext, copy the channels to the single `analysis-worker.js`, wait, sleep 30 ms, next. One core did the analysis, decoding never overlapped it, and a track just loaded onto a deck queued behind the whole library batch.
- **Decision:** `src/renderer/engine/analysis-pool.ts`:
  - `WorkerPool`: `max(1, min(8, navigator.hardwareConcurrency - 1))` workers, created on demand, one job each at a time; channel copies are transferred. A job that throws answers `{ id, error }` (the worker now catches), and a worker that dies fails only its own job and is replaced; the scheduler then retries that track on the main thread (the old fallback).
  - `AnalysisScheduler`: two priority lanes (deck ahead of background, FIFO within each); `enqueueAnalysis(track, "deck")` on deck load, which also promotes a track already waiting. Reads/decodes are capped at pool size, and a track keeps its decode slot until a worker takes it, so decoding overlaps analysis but at most pool-size decoded tracks wait. The AudioBuffer is dropped once its channels are copied for the worker. The same request for the same track is shared, not repeated.
  - Results and the library cache are unchanged: the same `analyzeBuffer(buffer, 2000)` runs in the worker, and `scripts/bench-analysis.mjs` checks each result is identical (bpm, phase, key, duration, peaks) to the old pipeline.
- **Measured** (`scripts/bench-analysis.mjs`, Electron 44 renderer, 20 synthetic 90 s 192 kbps MP3s, linux-arm64 with **2 cores**, so the default pool is 1 worker): before 8.09-8.15 s, after 4.25-4.40 s (1.9x), results identical. Forcing 2 workers here gave the same 4.3-4.4 s and 4 gave 5.2-5.3 s: with two cores, decoding plus one worker already fills the machine. About 0.6 s of the gain is the removed 30 ms gaps; the rest is decoding overlapping analysis. More cores should scale further, up to the cap of 8, but that was not measured here.
- **Rejected:** decoding inside the workers (no `AudioContext`/`decodeAudioData` in workers; a JS decoder would be a new dependency); transferring the AudioBuffer's own storage (not transferable).
- **Revisit if:** memory pressure shows up on many-core machines with long tracks (each track waiting for or in a worker holds one channel copy); then lower the decode cap.

---

## D42: Streaming as in-deck sources on official partner APIs, no external windows (2026-11-01)

- **Context:** Streaming opened each service in a separate `BrowserWindow`, detected "signed in" by sniffing session cookies, scraped YouTube Music pages (`ytInitialData`, and an innertube client with forged `SAPISIDHASH` in the Tauri shell), posted EME challenges to services' private licence endpoints, and marked a provider "connected" with a placeholder token (`eme-session-active`). None of that is something an MIT project can stand behind, and the "DRM active" labels overclaimed: Widevine audio can't reach Web Audio, and stock Electron has no Widevine CDM.
- **Decision:**
  - One interface, `StreamSource` (`src/renderer/streaming/source.ts`): search, browse, metadata/artwork, `resolve(track) -> PlaybackPlan`, and auth state. A plan is `decodable` (plain audio the app may fetch: decoded once to PCM like a local file, D17, so it gets analysis, waveform, stems, FX), `monitor-only` (the service's official embed in the deck panel) or `unavailable` (with the service's reason). Streamed tracks are added to the library as `source: "stream"` entries (`stream:<source>:<id>`) and loaded by the normal `loadTrack` path; `ensureMediaFile` resolves them on demand.
  - Adapters on the services' documented APIs: Beatport LINK and Beatsource LINK (v4 API, OAuth authorization code + PKCE, every call with the user's token), TIDAL (openapi.tidal.com/v2 JSON:API; client credentials for catalogue, PKCE for user; `/trackManifests` decides: `drmData` present -> monitor-only TIDAL embed, absent -> plain HLS to the deck), SoundCloud (api.soundcloud.com, OAuth 2.1, `Authorization: OAuth`, client credentials for public search/playback, `/tracks/{urn}/streams` preferring progressive MP3). A "Web players" source turns a pasted Spotify / Apple Music / Deezer / YouTube / TIDAL / SoundCloud / Beatport link into that service's official embed, monitor-only.
  - Every source starts in `needs-partner-key` and the UI says "needs partner API key" until a key is stored; a transport refusal or HTTP error is a typed `StreamSourceError`, never an empty success.
  - Keys and tokens live only in the main process (`src/main/streaming.ts`), in `<userData>/stream-credentials.json`, encrypted with `safeStorage` when the OS provides it. The renderer's adapters build requests; the main process attaches tokens, only for each source's own API hosts (https, allowlisted), and fetches audio only from allowlisted hosts. Sign-in opens the service's consent page in the system browser with a loopback redirect `http://127.0.0.1:43827/callback` and `state` checked (RFC 8252), the one place a browser is involved; playback never leaves the deck.
  - HLS is read only when unencrypted and finished (`hls.ts`): `EXT-X-KEY` other than `NONE` or `EXT-X-SESSION-KEY` is refused with "encrypted", and no key URI is ever fetched. OpenDecks does not decrypt service streams.
  - Removed: provider windows, cookie hints, `streaming:license`, the licence-exchange `DrmSessionManager`, `ProviderCredentialStore`, YouTube Music scraping (`youtube.ts`), the "commercial payload" HTML parser, and the Tauri innertube search (and its `sha1` dependency). `drm.ts` only probes whether EME/Widevine exists, so the UI can say whether embedded DRM players will play previews only. The main process grants the `mediaKeySystem` permission for embedded players; that only matters on a Widevine-enabled build (castlabs ECS).
- **Tests:** `test/stream-sources.test.ts` (22 tests: auth states, typed errors, PKCE RFC 7636 vector, token requests per grant, token refresh/rotation, redirect state, HLS parse/refusals, each adapter's requests and mapping, loader outcomes, library fields, host allowlist). In `test/streaming.test.ts`, three tests that exercised YouTube page scraping were retired with that code and four were rewritten for the new modules; queue, WHIP and YouTube embed-id tests are unchanged. 248 earlier tests + 22 new = 270.
- **Unverified [verify]:** nothing ran against live partner keys. Beatport's `GET /catalog/tracks/{id}/stream/` contract (formats, encryption, CDN hosts) is defined in the partner SDK docs behind a partner login; if it is encrypted, the deck reports that and the partner agreement decides the supported method. TIDAL's `trackManifests` for third-party apps likely returns DRM for full tracks, so expect TIDAL decks to be monitor-only or previews. Concatenated HLS segments decode when they are MP3/ADTS AAC or fragmented MP4; MPEG-TS segments won't decode with `decodeAudioData`. The Tauri shell change was not compiled (no Rust toolchain here).
- **Rejected:** yt-dlp or any ripping (belongs in no part of this repo), decrypting AES-128/SAMPLE-AES HLS without a partner agreement that says to, embedding sign-in pages in an in-app webview (RFC 8252 prefers the system browser, and most providers block framing their login), bundling any client secret.
- **Revisit if:** a partner key arrives (run the adapter against it and remove the [verify] notes), or the app moves to a castlabs ECS build (then confirm Widevine embeds play full tracks, still monitor-only).
## D43: Deck view fixes (all-deck vertical waves, full eject reset) and an AlphaTheta SLAB driver (2026-11-01)

- **Vertical waveform on C/D:** `setWaveMode` looped over a hardcoded `["A", "B"]`, so the switch, live or restored from `opendeck.waveMode` at start-up, never reached decks C and D (the CSS class did, which is why their canvases grew but drew horizontally). `applyWaveOrientation` (`src/renderer/ui/deck-view.ts`) now takes every deck, and a zoom built later reads the current mode.
- **Eject:** the eject button reset the title, art and overview only. The scrolling waveform (`ZoomWaveform` had no `clear()`), its beatgrid, loop and cue markers, the parts state and the time readout stayed. `ejectDeck` now resets all of them (`resetDeckReadouts`), drops the peaks and colour columns of both views, stops progressive separation, and the frame loop shows `0:00 / 0:00` for a deck without a track. `Deck.eject()` returns false under load lock, so the UI no longer half-clears a deck that keeps playing. A stem cache read finishing after an eject no longer revives the deck.
- **Found while testing eject + reload:** the waveform colour cache was keyed by column count, identical for every track, so a reloaded deck could show the previous track's colours; it is now keyed by the arrays. Mono files passed one array as both stretch channels; the stretch worklet's `dropBuffers()` then transferred one ArrayBuffer twice (DataCloneError in the worklet, key-lock queue stalled). The right channel is now a copy.
- **SLAB:** `src/renderer/midi/slab.ts` drives SLAB in its general-purpose MIDI mode from AlphaTheta's official *SLAB List of MIDI Messages*. Nothing is sent to enter or imitate the Serato-native mode. The catalogue entry keeps its place but now has `driver: "slab"` and no generic bindings (the old accessory bindings put hot cues on SLAB's encoder-touch notes). Not in the list and so not implemented: OLED text, and the colour table behind "color number 0x01-0x7F"; LED colours use a clearly marked provisional hue mapping. Untested on hardware.
- **Revisit if:** SLAB is tested on a real unit (colour table, port name, E1's channel 1 vs status 0x96), or AlphaTheta publishes display messages.

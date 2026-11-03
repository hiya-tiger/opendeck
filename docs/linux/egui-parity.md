# OpenDecks for Linux (egui + Rust): parity with the Electron renderer

Status per feature. **Have** = built and covered by a test or a run in CI/xvfb.
**Building** = partly there; what is missing is said. **Gap** = not on Linux yet.
Nothing here has been tried on real DJ hardware or a real sound card: CI and
xvfb only. Windows and macOS stay on Electron.

## Engine (od-audio)

| Feature | Status | Notes |
|---|---|---|
| 4 decks, real-time callback with no locks/allocs | Have | rtrb command ring, atomics for status, released buffers freed on the UI thread. `tests/realtime.rs` runs every command and every FX under `assert_no_alloc`. Signalsmith's C++ allocations are outside what assert_no_alloc can see (it is configured once per deck, before the callback). |
| Output: ALSA (PipeWire/Pulse through their ALSA plugins), JACK | Have / Building | cpal ALSA is the default; `--features jack` builds the cpal JACK host, but the app does not offer a host picker yet. Falls back to a paced null driver when no device opens. |
| Key-lock / time-stretch | Have | Signalsmith Stretch (MIT) via `signalsmith-stretch` crate, same 120 ms block / 30 ms interval as `STRETCH_CONFIG`. Test: 440 Hz at +8 % stays at 440 Hz with key-lock, goes to ~475 Hz without. |
| Tempo / pitch, reverse, censor, rewind/fast-forward scan | Have | |
| EQ (3-band, kills, -60 dB kill like deck.ts) | Have | RBJ biquads with the same corner frequencies as deck.ts (180 Hz shelf, 1.2 kHz peak Q 0.9, 6 kHz shelf). Not sample-identical to Chromium's BiquadFilterNode. |
| Isolator EQ mode | Gap | deck.ts `isolatorMode` not ported. |
| FX: all 15 from fx.ts | Have (approximate) | Echo, delay, reverb, filter, flanger, phaser, crush, auto-pan, tremolo, gate, tape stop x2, brake, filter echo. Parameter maths are ported exactly (tested); the DSP is re-implemented, so the sound is close to, not identical to, the Web Audio node graphs. Custom 3-slot FX presets: data ported, chaining UI Gap. |
| Crossfader (curves, reverse, A/B/THRU assign), fader curves | Have | Maths identical to mixer.ts (tested). |
| Limiter + limiter warning | Have | Peak limiter at -3 dB standing in for the DynamicsCompressor; warning shows below -0.5 dB like `limiterWarning()`. |
| Cue / headphones | Building | Per-deck PFL and cue/master blend. A 4-channel card gets the cue mix on outputs 3-4. A *second device* for headphones is not wired yet. (Electron has no headphone cue at all.) |
| Booth output, aux input | Gap | |
| Sampler (8 slots) | Have | One-shot playback; load from the selected track. |
| Loops, hot cues (8), beat jumps, sync | Have | Sync uses the ported `syncDeck()`; quantize option. |
| Recording | Have | 32-bit float WAV via a writer thread (Electron records webm/opus). |
| Mono files | Have | One channel plays to both sides. |
| Slip mode | Gap | |
| Track-end warning | Have | Remaining time flashes red under 30 s, overview playhead turns red. |
| Formats | Building | WAV, FLAC, MP3, Ogg Vorbis. AAC/M4A/ALAC/AIFF: Gap (no permissive decoder picked yet; symphonia is MPL-2.0, ffmpeg is LGPL/GPL). |

## Analysis and library (od-core)

| Feature | Status | Notes |
|---|---|---|
| BPM, beat phase, key/Camelot, peaks, 3 bands | Have | Line-by-line port of analyze.ts/fft.ts from experiment/mygo-rust-bench; bit-identical to the TS on the benchmark fixtures (checked by `bench/equivalence.mjs` in CI). |
| Serato database V2, crates, Markers2, BeatGrid: read | Have | Same port; canonical scan output hash-identical to the TS. Crates import from `~/Music/_Serato_`. |
| Serato write-back (tags, crates) / byte-exact round trip | Gap | serato-write.ts, serato-export.ts not ported yet. |
| Pioneer export.pdb + ANLZ cues: read | Have | USB stick with a rekordbox export imports tracks and playlists. |
| USB import, always-ask prompt | Have | prompt.ts ported (Add / Not now / "Always do this for this drive", remembered per drive). Linux mount scan of /media and /run/media. |
| CDJ over Pro DJ Link (NFS) | Gap | `src/main/prolink` network/NFS not ported. |
| Hashing | Have | SHA-256 via ring. |
| Analysis cache across sessions | Gap | Analysis runs in the background each launch. |
| Library browser, crates, search, folder crates | Have | Columns: title, artist, BPM, Camelot, length. Smart crates, scratchpad/prepare, history: Gap. |

## Stems (od-stems)

| Feature | Status | Notes |
|---|---|---|
| Progressive chunking from the playhead (D40) | Have | `core.rs` port of plan/order/window/coverage, tested against the TS. |
| Multi-deck scheduler | Have | Worker threads, one session each; earliest-deadline pick across decks, playing decks first. Tested with a placeholder engine. |
| ORT engine (htdemucs, onnxruntime 1.20.1 load-dynamic) | Building | `ort_engine.rs` + `od-stems-bench`; benchmarked in CI. Not wired into the app's deck playback yet, so stem mutes / Part FX on Linux do not change the sound yet. |
| Faster engine than ORT | Not chosen | experiment/mygo-rust-bench never recorded a winner (its run produced no results), so ORT stays. |

## UI (od-app, egui on wgpu)

| Feature | Status | Notes |
|---|---|---|
| 2/4-deck layouts | Have | |
| Horizontal and vertical scrolling 3-band waveforms (GPU) | Have | One mesh per view; vertical works on all four decks (the C/D fix); eject resets everything. |
| Overview waveforms, beat grid, cue/hot-cue/loop marks | Have | |
| 10 pad modes | Have / Building | hot cue, cue loop, loop roll, slicer, beat jump, transport, pitch play: Have. Scratch: scans backward/forward from a cue (no platter scratch engine). Sequence: records pad presses and replays them, no timing. Part FX: Building (needs stems in playback). |
| Mixer, FX controls, sampler, settings | Have | |
| Keyboard: full Serato map, overlay, input-focus guard, Settings toggle | Have | The table is exported from serato-keymap.ts, not copied; every chord x modifier x repeat x text-field case matches the TS matcher (test). egui has no separate numpad keys, so Numpad sampler keys act like the digit row's codes do not: **Numpad 1-8 sampler: Gap**. |
| MIDI (midir), all 194 profiles, SLAB driver, Party Mix III | Building | Profiles are the exported TS table; device lookup matches the TS for the tested names. Note/CC bindings drive play, cue, sync, loop, pitch, trim, EQ, FX wet, pads, faders, crossfader, sampler. SLAB: decoder is byte-exact with the TS; pads, play, deck select, encoders (EQ) and strip (filter) are mapped; LED/colour feedback and the rest of SlabController: Gap. Untested on hardware. |
| MIDI learn / custom mappings UI | Gap | |
| Link (opendeck-link/1, 239.255.77.88:29876) | Have | Wire format byte-compatible with the TS node (test). Not Ableton Link. |
| Beatgrid edit mode | Gap | Shortcut shows a hint only. |
| Video, in-panel streaming embeds | Gap (by decision) | |
| Timecode / DVS | Gap (by decision) | The TS timecode tables (src/timecode/defs.ts, lfsr.ts) derive from xwax (GPL); not ported. |
| Broadcast (WHIP), artwork lookup, diagnostics screen | Gap | |

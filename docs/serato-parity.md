# Parity plan

This is the plan of record for reaching feature parity with a commercial,
closed-source professional DJ application, its paid tier and all paid
expansions. It is referred to below as "the target". The target for this work is
Serato DJ Suite. OpenDeck is independent and not affiliated with it. Features are
matched by observable behaviour; layout, assets and wording are original.

## Scope

In scope is the complete paid feature set plus every expansion:

- four decks, full transport, cues and loops
- all performance pad modes
- full mixer and effect set
- library management
- timecode control
- real source separation
- tempo-independent pitch shift
- offline/practice mode
- user-created effects
- sequence recorder

Out of scope, and only these three things:

- video mixing (P7, droppable if it would delay a release)
- exact pixel layout and animation timing
- DRM circumvention in streaming providers

A missing feature in this document is a gap. It is not a non-goal. The four-band
EQ is a filter bank, not source separation; the separation work is P5 and is in
scope.

## Principles

- Interoperate at the file-format level; do not use the target's code or assets.
- Match behaviour where DJs rely on it. Do not chase pixel-exact layout.
- One path per job. Local files use the PCM engine; the media element survives
  only for remote/stream URLs and decode failures.
- Keep every phase reversible. A phase that cannot be finished is reverted and
  recorded in `RESUME.md`; it is not shipped half-wired.
- Do not break streaming, broadcast, recording or the one-shot pad bank.
- Preserve the `Deck` public API and audit call sites instead of breaking them.
- Keep Web Audio for EQ, effects, mixer and analysis.
- Add every dependency and model weight to `NOTICE` with its licence.
- Never claim a verification that was not run.

## Literal on-disk strings

These are byte-for-byte contracts, not suggestions:

- playlist file header: `1.0/Serato ScratchLive Crate`
- embedded cue frames in ID3 GEOB: `Serato Markers2`, `Serato Markers_`,
  `Serato BeatGrid`
- MP4/M4A freeform atom prefix: `----:com.serato.dj:`
- WAV filetype value in the library index: `wave`
- SQLite table in the target database: `container_asset_list_columns`

## Feature matrix

| Area | Capability | Today | Target | Phase |
| --- | --- | --- | --- | --- |
| Engine | Key lock (pitch hold) | Media element `preservesPitch`; PCM path lacks it | Signalsmith Stretch inside the PCM engine, on by default | P1 |
| Engine | Reverse playback | Offline only | Live, including with key lock on | P1 |
| Engine | Loops | Seek-based on media element; PCM offline path only | Sample-accurate live loops, block-size independent | P1 |
| Engine | Latency and underruns | Not measured | Reported latency under 10 ms where the driver allows; visible underrun counter | P1 |
| Engine | Decode ownership | Decoded twice (playback and scratch) | Decoded once, shared by transport and scratch | P1 |
| Engine | Platter physics | Pointer delta drives scratch rate | Torque, friction and inertia model; rate from platter velocity | P1 |
| Engine | DVS handoff | JS decoder and transport | Timecode rate/direction through atomics; sample-accurate jumps | P1 |
| Engine | Render determinism | Offline JS and Rust harnesses | Same invariants in live path | P1 |
| Library | Playlist files (`.crate`) | Export works | Full read/write, including tags | P2 |
| Library | Library index (`database V2`) | Export works | Full read/write, `wave` type preserved | P2 |
| Library | Crate column layout | Not started | Opt-in `container_asset_list_columns` edit with backup | P3 |
| Metadata | Embedded cue frames | Read for MP3/WAV/AIFF; write codecs exist, not wired | Read/write both marker frames for MP3/WAV/AIFF/FLAC/MP4 | P2 |
| Metadata | Cue slots, names, colours | First five slots, fixed palette | Eight slots, names, 18-colour quantised palette | P2/P3 |
| Metadata | Saved loops | Codec only | Eight per deck, persisted, reloaded and editable | P2/P3 |
| Metadata | Beat grid and lock flag | BPM/phase import, codec | Full grid import/export with lock flag and downbeat marker | P2/P3 |
| Metadata | Key and BPM tags | Analysis and UI display | Read/write tag round trip | P2 |
| Library UX | Set-scratchpad | None | Holding area of tracks picked for the set | P3 |
| Library UX | Played-log | None | Exportable log of tracks already played | P3 |
| Library UX | Search and sort | Basic filtering | Playlist search, global search, playlist sort | P3 |
| Library UX | Playlists | Import/export files | Create, edit and reorder playlists in app | P3 |
| Library UX | Live playlists | None | Rule-driven playlist that updates itself | P3 |
| Library UX | Track colour and play count | None | Stored, displayed and exported | P3 |
| Library UX | Preview playback | None | Audition without loading a deck | P3 |
| Library UX | Display modes | List only | List and album-grid modes, column layout, waveform zoom | P3 |
| Deck | Four decks and 1/3 2/4 toggle | Two decks | Four decks, two visible at a time, two extra mixer strips | P3 |
| Deck | Deck clone | None | Copy playing track to the other deck at the same position | P3 |
| Deck | Repeat and autoplay | None | Repeat track and autoplay next | P3 |
| Deck | Eject and load lock | None | Eject control and load lock | P3 |
| Deck | Nudge and tempo range | Tempo range value only | Nudge buttons and cycling 8/16/50 percent | P3 |
| Deck | Gain and metering | Channel fader and level meter | Per-track gain, auto gain, per-deck meter | P3 |
| Deck | Track-end warning | None | Warning before the track ends | P3 |
| Deck | Time display | Elapsed only | Elapsed/remaining toggle | P3 |
| Deck | Turntable start/stop | Instant | Start/stop ramp | P3 |
| Deck | Playback mode | Internal only | Internal, relative and absolute timecode modes | P3 |
| Cues and loops | Cue-and-loop trigger | None | One button fires a cue point and a loop together | P3/P4 |
| Cues and loops | Loop tab | Basic loop controls | Loops tab for saved loops and editing | P3 |
| Cues and loops | Beat grid editor | None | Editor with working lock flag | P3 |
| Cues and loops | Beat jump | API only | Forward/back beat jump with pad UI | P3/P4 |
| Performance | Return-mode | None | Manipulate audio and return to the would-be position | P3 |
| Performance | Reverse-on-hold | None | Play backwards while held, resume on release | P3 |
| Performance | Rolling loop | None | Quantised loop that releases to the original position | P3/P4 |
| Performance | Eight-slice pad mode | None | Eight slices, each loops in time | P4 |
| Performance | Scratch-from-pad | None | Whole track loaded into a pad for scratching | P4 |
| Performance | Pitch-play | None | Cue triggered at different pitches from pads | P4 |
| Performance | Cue-and-loop pad mode | None | Pad mode built on the cue-and-loop trigger | P4 |
| Performance | Sequence recorder | None | Record pad/cue actions and replay them as a loop | P4 |
| Performance | One-shot pad bank | 16 pads | 32 slots across 4 banks | P4 |
| Mixer | Isolator EQ mode | Standard EQ | Switchable isolator behaviour | P3 |
| Mixer | Crossfader reverse | None | Reverse crossfader direction | P3 |
| Mixer | Fader curve and cut | Fixed | Channel fader curve and cut control | P3 |
| Mixer | Booth routing | None | Booth output routing | P3 |
| Mixer | Limiter warning | None | Warning light | P3 |
| Mixer | Record format options | WebM/Opus | Selectable formats | P3 |
| Effects | Full built-in set | Filter, echo, delay, reverb, flanger, phaser, crush | Wider built-in set matching the target's categories | P3/P6 |
| Effects | Custom effects | None | User-built, savable, reloadable effect chains | P6 |
| Separation | Real source separation | Four filter bands only | ONNX model, four parts, cached at import | P5 |
| Separation | Vocals-only toggle | None | Isolate vocals or everything-but-vocals | P5 |
| Separation | Parts tab and part effects | None | Part controls, part effects, part roll, part return-mode, part pad mode | P5 |
| Pitch | Tempo-independent pitch shift | None | Pitch shift with tempo unchanged, same primitive as pitch hold | P6 |
| Timecode | Calibration | Decoder only | Calibration flow | P3 |
| Timecode | Drift correction | None | Drift correction | P3 |
| Timecode | Absolute/relative/internal | Internal only | All three playback modes | P3 |
| Hardware | Wireless needle mode | None | Hardware needle-tracking device wireless mode | P6 |
| Sync | Tempo+phase sync | Tempo sync | Tempo and phase sync | P3 |
| Sync | App-to-app tempo sync | None | Tempo sync between separate music applications | P6 |
| UI | Light theme | Dark only | Light theme inversion | P3 |
| UI | Diagnostics | None | CPU meter, clock, latency and underrun display | P1/P3 |
| UI | Setup screen | None | Setup screen for audio, controller and analysis | P3 |
| UI | Analysis settings | Fixed | Analysis settings panel | P3 |
| Offline | Offline mode | Requires no controller already | Full operation with no controller, including deck-mode toggle | P6 |
| Video | Video deck | None | Video file per deck, position-locked to transport | P7 |
| Video | Video crossfader | None | Independent video crossfader | P7 |
| Video | Fit/fill and projector output | None | Scaling modes and second fullscreen window | P7 |

## Phase 0: scope and documentation

- Correct this document: full scope, full matrix, definition of done.
- Delete the old non-goals for video, source separation and stems-style pads.
- Keep only the three real non-goals: video (droppable), pixel layout, DRM.
- Record assumptions in `docs/decisions.md`.
- No behaviour change.

## Phase 1: finish the engine cutover (blocks everything)

One path for local files, built on `opendeck-audio`.

- Key lock moves inside the PCM engine using the MIT stretcher. Key lock on is
  the default and runs on the PCM engine.
- The media element survives only for remote/stream URLs and decode failures.
- Reverse, sample-accurate loops and block-size-independent render are wired
  into the live path.
- Latency and an underrun counter are visible in the UI.
- Timecode rate and direction go through transport atomics, not the command
  ring. DVS jump handoff is sample-accurate.
- The duplicate decode is deleted: one decoded track feeds transport and scratch.
- Scratch uses an angular platter model: torque, friction, inertia; rate comes
  from platter velocity, not pointer delta.

Exit: reverse works with key lock on; loop wrap error under one sample
cumulative over ten minutes offline; latency under 10 ms where the driver
allows; no local file touches the media element; `smoke:audio` asserts key lock
on uses the PCM engine.

## Phase 2: finish the library round trip (blocks adoption)

- Per-track tag writing for MP3, WAV, AIFF, FLAC and MP4: temporary copy,
  byte-verify the audio payload, then swap. Reuse the export safety contract.
- All eight cue slots, all saved loops, full beat grid with lock flag, cue names,
  cue colours quantised to the 18-value palette, key and BPM tags.
- Write both marker frames and keep them consistent. The target prefers the
  older frame for cue slots 1-5, so newer-only loses the first five cues.
- FLAC `VORBIS_COMMENT` and MP4 freeform atom writing.
- Undo command. Refuse to write while the target is running.
- Preserve every unknown frame verbatim, in original order.

Importer rules that fail silently if missed:

- Playlist header exactly `1.0/Serato ScratchLive Crate`.
- WAV typed `wave` in the library index.
- Playlist entries match tracks by path, so re-runs are idempotent.
- Beat grids have a lock flag; set it or the analyser replaces the grid. Put the
  first marker on a downbeat.

Exit: write a library from OpenDeck, import into the target on a disposable
library, edit cues there, re-import into OpenDeck, zero loss both ways. A second
identical run produces zero byte changes. Golden fixtures come from real target
output and record the version that produced them.

## Phase 3: feature wall

All items independent of the engine are wired here, using APIs that already
exist where possible: `setQuantize`, `beatJump`, `setPitchRange`, the saved-loop
codec and the beat-grid codec.

- Deck: four decks and 1/3 2/4 toggle, clone, repeat, autoplay, eject, load lock,
  nudge, tempo range cycling, original BPM display, per-track and auto gain,
  per-deck meter, track-end warning, elapsed/remaining, turntable start/stop,
  playback mode switching.
- Cues and loops: naming, 18 colours, cue-and-loop trigger, saved-loops UI,
  loops tab, beat-grid editor with lock, beat-jump pad UI.
- Performance: return-mode, reverse-on-hold, rolling loop, tempo-phase sync.
- Mixer: isolator mode, crossfader reverse, fader curve and cut, booth routing,
  limiter warning, record format options.
- Library: set-scratchpad, played-log export, playlist search, global search,
  create playlist, playlist sort, live playlists, track colour, play count,
  preview playback, analysis settings, list and album-grid modes, column layout,
  waveform zoom.
- UI: light theme, CPU meter, clock, analysis settings, setup screen.

## Phase 4: pad mode framework and modes

Build the framework once, then implement: cue-and-loop trigger, rolling loop,
transport, forward/back beat jump, eight-slice pad mode, scratch-from-pad,
pitch-play, sequence recorder, part effects, and a 32-slot sampler across four
banks.

## Phase 5: real source separation

- Separate crate and ONNX model, run offline at import, cached beside the track
  keyed by content hash plus model version.
- Reuse the multi-voice source; this is a source change, not a rewrite.
- Vocals-only toggle, parts tab, part effects, part roll, part return-mode and
  part pad mode.
- Check model-weight licences and record them in `NOTICE`.
- Rename the four-band EQ in the UI so "stems" is not overloaded.

## Phase 6: expansion features

- Pitch shift independent of tempo, using the same primitive as pitch hold with
  the ratio applied to pitch instead of time.
- Custom effects: user-built, savable chains, plus a wider built-in set.
- Offline mode with no controller, including the deck-mode toggle.
- Wireless needle mode and app-to-app tempo sync where the hardware/API allows.

## Phase 7: video (droppable)

Minimum viable, not overbuilt:

- One video file per deck, position-locked to that deck's transport. Play,
  pause, seek, reverse and scratch follow.
- A video crossfader independent of the audio crossfader.
- Fit/fill scaling and a second fullscreen output window.
- Effects optional.

If time runs out, ship it behind a flag and say so; if it alone would delay a
release, cut it.

## Definition of done

Suite parity means all of these are true:

- [ ] Key lock on runs on the PCM engine; no local file uses the media element
- [ ] Reverse playback works, including under timecode control
- [ ] Loop wrap error under one sample cumulative over ten minutes offline
- [ ] Reported latency under 10 ms; underrun counter visible
- [ ] Four decks with deck 1/3 2/4 switching
- [ ] Eight named, colourable cue slots per deck
- [ ] Eight saved loops per deck, persisted and reloaded
- [ ] Beat grid editor with a working lock flag
- [ ] Cue-and-loop trigger, rolling loop, return-mode, reverse-on-hold
- [ ] All performance pad modes present and reachable
- [ ] 32 sampler slots across four banks
- [ ] Full effect set plus user-created savable chains
- [ ] Tempo-independent pitch shift
- [ ] Real four-part source separation, cached, with part controls
- [ ] Round trip: write a library, import into the target, edit, re-import, zero
      loss both directions
- [ ] Undo for every file and library write
- [ ] Playlist, set-scratchpad, played-log, search, sort, track colour, play count
- [ ] Live playlists
- [ ] Offline mode works with no hardware
- [ ] Timecode control with calibration and drift correction
- [ ] `npm test`, `npx tsc --noEmit`, `cargo test` green; 98 pre-existing tests
      unmodified and passing
- [ ] `docs/decisions.md` lists every assumption

## Verification

Each phase records what was actually verified, with the machine and versions
used. Claims that were not tested are listed as unverified rather than implied.

### P0 - scope and documentation

Verified 2026-10-22 on Windows 10 19045, Node 24.20.0, npm 11.19.0,
Electron 44.8.0, rustc 1.99.1.

- The scope, literal strings, matrix and phase exits are in this file.
- No runtime behaviour was changed by P0.

### P1 - engine cutover (partial)

Verified with the same toolchain:

- `npm test`: 103 tests pass, including `test/platter.test.ts` and the
  ten-minute forward/reverse loop test.
- `npx tsc --noEmit`: clean.
- `cargo test --manifest-path rust/Cargo.toml`: 26 audio tests pass, including
  ten minutes of forward and reverse looping on the exact sample, transport
  atomics, the SPSC ring, the live render thread and device-free interleave
  tests.
- `cargo test -p opendeck-audio --features native-output`: 25 tests pass and
  the device test is ignored by default so a test run never claims the audio
  device. `cargo test -p opendeck-audio --features native-output -- --ignored`
  passes and opens/stops the default Windows output stream.
- `cargo check --manifest-path rust/Cargo.toml --features native-output`:
  clean, including the Tauri app and cpal 0.15.
- `npm run build`: Electron main, preload and renderer bundles build.
- `npm run smoke:audio`: passes repeatedly. It asserts PCM engine, analysed
  output above 0.05 RMS, sample loop bounds, reported latency `0.008 s`
  (`>0` and `<0.01`), pitch hold on, and reverse through the DVS transport
  driver (`driveTimecode`) with time decreasing.
- Local `File` playback no longer touches the media element; the smoke run
  removes the element source before playing.

Not verified yet:

- DVS with a physical control record and audio interface. The jump/drift target
  is rounded to a sample frame and scheduled with the rate, but the JS path is
  not backed by shared-memory atomics.
- Native decode. The cpal `native-output` backend opens the default device at
  the exact source rate and pulls the live voice, but neither shell selects it
  and loading a new track needs a fresh stream; the JS `PcmSource` remains the
  live path.
- Physical audio interfaces, real DJ hardware and driver latency.
- Reverse-loop correction after an external jump is coarse (250 ms guard);
  the Rust and JS offline transports and the Rust live state path are exact.

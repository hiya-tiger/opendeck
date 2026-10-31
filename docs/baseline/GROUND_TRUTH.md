# Ground truth — OpenDecks at `9035f2c`

What the tree does, not what it says. Every claim has a file:line and a tier.
Tiers: SPECIFIED / SOURCE / COMPILED / UNIT / INTEGRATION / SIMULATOR / DEVICE /
HARDWARE. No tier implies the next.

## 1. The real local-file audio path

```
File / blob: / file:  ──► deck.load()  deck.ts:556-571
                          fetch(url) → arrayBuffer
                          ctx.decodeAudioData → AudioBuffer        deck.ts:564
                          pcm.load(buffer, 0)                      deck.ts:567
                              ├─ stretch.addBuffers([L, R])        pcm-source.ts:472
                              │     (Float32 channels copied INTO the worklet)
                              └─ applyLoop()                       pcm-source.ts:628
                                    → scheduleStretch({loopStart, loopEnd})
```

**Live source is a Signalsmith Stretch AudioWorklet, not Rust.** `PcmSource`
constructs it at `pcm-source.ts:406-419` (`blockMs: 8`, `intervalMs: 2`,
`splitComputation: false`) and falls back to a hand-written worklet
(`WorkletPcmSource`, `pcm-source.ts:436-438`) only if that import throws. Key
lock, pitch shift, reverse (signed rate) and loop scheduling all live in the
stretch node; `semitones()` at `pcm-source.ts:386-389` implements D16
(`0` when key-locked, `12·log2|rate|` when not).

**The media element is still in the graph, always.** `deck.ts:211` creates
`ctx.createMediaElementSource(this.el)` unconditionally and connects it to
`deckInput` at `:213`; local loads merely clear its `src` (`deck.ts:569-570`).
Remote/stream URLs take the element path (`deck.ts:572-591`). So "the element is
still used for streaming" is literally true, and it is also still wired for every
deck. Tier: SOURCE.

**Downstream graph is Web Audio, unchanged by the source choice**
(`deck.ts:262-271`): `deckInput → stemBus → trim → eq(low→mid→high) → fxChain →
fader → cross → {analyser, mixer.master}`. `Mixer` adds `master → limiter →
masterAnalyser` and a `booth` tap (`mixer.ts:85-107`). Tier: SOURCE.

Two facts that are easy to get wrong:

- `pcm-transport.ts` — the deterministic TS transport with the exact-sample loop
  tests — **is imported only by its test** (`test/pcm-transport.test.ts:3`).
  Nothing in `src/` uses it. Tier: SOURCE.
- `deck.load()` classifies a source as local by
  `typeof source !== "string" || /^(blob:|file:)/i.test(source)` (`deck.ts:556-557`).
  A plain filesystem path string takes the **media element** path. Tier: SOURCE.

## 2. The real library path

Chromium File System Access API, no database, no server.

- Folder link: `showDirectoryPicker({id:"opendeck-music", mode:"read"})`
  (`app.ts:2383`), recursive scan to depth 6 (`app.ts:2388`, `collectAudio`).
  Non-Chromium fallback is drag-and-drop only (`app.ts:2377-2379`).
- Tracks are `File` objects held in memory plus metadata
  (`library.ts:17-83`, `trackFromFile` at `:57`). Nothing is copied or imported.
- Persistence is `localStorage`: playlists `library.ts:165`, live playlists `:175`,
  track meta `:185`, cues `app.ts:1572`, loops `:1597`, played log `:2146`,
  scratchpad `:2150`, MIDI map `:3342`, UI flags `:3708,3722`.
- Serato export writes through a second directory handle with
  `mode:"readwrite"` (`app.ts:2468-2473`), and SQLite columns through the main
  process (`main.ts:432-433` → `serato-files.ts:391`).

Consequence for "restore last session": the `File` handles are **not** persisted,
so a cold start cannot re-open them without a fresh picker grant. Tier: SOURCE.

## 3. What the Rust crates do and do not do

`rust/crates/opendeck-audio/src/`: `decode.rs`, `render.rs`, `ring.rs`,
`transport.rs`, `live.rs`, `cpal_out.rs`. `opendeck-app/Cargo.toml` enables
`opendeck-audio` with `features = ["decode"]` — **not** `native-output`, so cpal
is not even compiled into the shell.

**Does:** decode (Symphonia) for analysis; offline `render_offline`; a
sample-accurate transport, SPSC ring and render thread that are unit-tested but
not driven by any shell.

**Does not:** play audio in any shipped configuration. The Tauri command list
(`rust/crates/opendeck-app/src/main.rs:821-839`) is `analyze_*`, `media_fetch*`,
`recording_save*`, `streaming_*`, `rtmp_*` — there is no playback command.
Live playback is the JS `PcmSource` in both shells, because both shells load the
same `renderer/` bundle (`tauri.conf.json` `frontendDist`).

This matches D22 exactly. Tier: SOURCE. Not COMPILED here — see BASELINE.md §6.

## 4. Tempo, beat and phase authority

**There is no tempo authority today.** `sync.ts` (59 lines) is a pure-function
library with no state, no clock and no session object: `syncRate` `:22-27`,
`syncDeck` `:29-44`, `nudgeTowardPhase` `:46-54`, `tempoPercentLabel` `:56-58`.

Each **deck** owns its own BPM (`deck.info.bpm`, from analysis or tags) and its
own rate. "Sync" is a one-shot copy: `app.ts:1113-1141` `applySync()` reads the
*other* deck's BPM, calls `syncDeck()` once, applies a tempo percent and a seek,
and sets a UI flag that `applyTempo` immediately clears on the next manual tempo
change (`app.ts:1107-1108`). It is hardcoded to `A↔B` (`app.ts:1114`); C and D
have no sync path. `nudgeTowardPhase` has **no caller** — continuous phase
correction does not exist.

So D35 cannot "integrate Link with the existing authority". It must **create**
one. Link must not become a second one, and must never drive sample position.
Tier: SOURCE.

## 5. Which shell is the product

**Electron.** Three independent pieces of evidence:

1. `scripts/package-win.mjs` packages Electron (`node_modules/electron/dist` →
   `release/OpenDeck-win32-x64/OpenDeck.exe`). There is no Tauri packaging step.
2. The root `OpenDeck.exe` is a rustc launcher whose search order is packaged
   Electron → dev Electron → `bin/opendeck-app.exe`. Tauri is the **last**
   fallback.
3. Feature coverage: Electron's IPC surface (`main.ts:147-516`) includes
   `separation:*` (stems), `video:*` (second window), `serato:*` (library
   writes), `recording:*`, `rtmp:*`. Tauri's (`main.rs:821-839`) has none of
   stems, video or Serato. Tauri's unique contribution is native decode for
   analysis.

Tauri is a partial shell. Whether it is a dev artifact or a port target is D38's
decision; the evidence says Electron is what ships. Consequence for M2: the
probe target is an **N-API addon in the Electron process**, not a Tauri command.
Tier: SOURCE.

## 6. Open `[verify]` gaps

Carried from `decisions.md:349-362`, plus the ones this baseline adds.

| # | Gap | Blocks |
| --- | --- | --- |
| 1 | Serato DJ Pro 4 still auto-imports legacy crates | D8 export |
| 2 | 18-colour cue palette + `Markers2` encoding | every cue write |
| 3 | `Markers_` vs `Markers2` preference for slots 1–5 | cue read-back |
| 4 | Beat-grid lock flag bit and its position | D29 lock |
| 5 | `container_asset_list_columns` usage `1` stability | D9 |
| 6 | WebView2 SharedArrayBuffer / cross-origin isolation | the Rust seam (D3/D22) |
| 7 | Per-provider, per-shell EME negotiation | A3 row 10 |
| 8 | Provider terms permit DJ use / capture | A3 row 10 |
| 9 | Ableton Link reference implementation licence | D34 / M3 |
| 10 | Real-hardware DVS closed-loop accuracy | DVS claims |
| 11 | Live loop-wrap error in samples, fwd + rev | H2 / README `<1 sample` |
| 12 | Whether `OpenDeck-win64.zip` actually runs | distribution |
| 13 | iOS local-network permission + multicast | D37 / N10 |
| 14 | Whether root `OpenDeck.exe` and `bin/opendeck-app.exe` are distinct builds (identical byte counts) | row 11 note |

Settled by measurement in M0, for the record: **190/190 Node tests pass**;
`tsc --noEmit` is clean; the build is clean; `smoke:audio` is **red**
(`ok:false`, `rms:0`) while the deck path is audible in the same run; multicast
UDP works on this host with two co-located receivers. See BASELINE.md.

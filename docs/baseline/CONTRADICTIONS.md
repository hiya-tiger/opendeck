# A3 contradictions — confirmed, corrected, resolved

Every row below was checked against the source tree at `9035f2c` plus the M0
working tree. Line numbers are real and were read, not inferred. Nothing was
fixed: this is the record, per the M0 brief ("Do not fix anything yet").

**Format per row:** `file:line` + claim / conflicting `file:line` + claim / which
is true per A1 / resolution.

**A1 precedence used throughout:** 1 source tree + tests (WHAT EXISTS) > 2
`docs/engine.md` "Today"/"Implemented so far" (WHAT IS WIRED) > 3
`docs/decisions.md` D1–D32 (INTENT, UNVERIFIED) > 4 `REPORT.md`/`RESUME.md`
(WHAT WAS CLAIMED) > 5 `README.md` (lowest).

**Evidence tiers** (verbatim, from A4): SPECIFIED / SOURCE / COMPILED / UNIT /
INTEGRATION / SIMULATOR / DEVICE / HARDWARE. No tier implies the next.

A row marked `[verify]` means I could not settle it from this tree, and I am not
guessing.

---

## 01 — Test counts

- `README.md:81` — "runs all 19 TypeScript unit & integration test suites (**190 tests**)".
- `README.md:98` — "`npm test`: **`190/190 passing`** across 19 test files".
- `REPORT.md:79` — "Suite total is now **187 passing** across 19 test files (up from 163)".
- `REPORT.md:85` — "`npm test`: **183 pass, 0 fail** (19 test files)".
- `REPORT.md:141` — "**187/187** unit tests passing across 19 test files".
- `RESUME.md:58` — "`npm test`: **187/187 passing** across 19 test files".
- `RESUME.md:72` — "(**187/187** total Node tests passing)".

**Measured (BASELINE.md §3):** `# tests 190`, `# pass 190`, `# fail 0`,
`# skipped 0`, `# todo 0`, `# suites 2`, `1..183`, 19 files, 7.61 s.

**Which is true per A1:** the source tree and the test run. **190 tests, 190
pass, 0 fail.** `README.md` is right; `REPORT.md` and `RESUME.md` are both wrong,
and `REPORT.md` contradicts itself (187 at :79 and :141, 183 at :85).

Note on the two numbers: TAP reports `1..183` top-level blocks and `# tests 190`,
because 7 `# Subtest:` entries are nested. "183" in `REPORT.md:85` is probably a
misreading of `1..183`, not a separate measurement. That is a hypothesis about
how the error arose, not a fact I can prove.

**Resolution (H1a, docs only):** set `REPORT.md:79`, `REPORT.md:85`,
`REPORT.md:141`, `RESUME.md:58`, `RESUME.md:72` to 190/190 and state that 190 is
the TAP `# tests` count over 19 files. Leave `README.md` alone on this row.

Tier: **UNIT** (observed).

---

## 02 — Pad modes

- `README.md:32-42` — ten modes listed as: `Hot Cue`, `Cue Loop`, **`Saved Loop`**,
  **`Roll`**, `Slicer`, **`Slicer Loop`**, **`Sampler`**, **`Scratch Bank`**,
  `Pitch Play`, **`Stems`**.
- `docs/decisions.md:289-290` (D23) — "The ten modes are Hot Cue, Cue Loop, Loop
  Roll, Slicer, Beat Jump, Transport, Pitch Play, Scratch, Sequence and Part FX."
- `REPORT.md:29-32` (P4) — "Hot Cue, Cue Loop, Loop Roll, Slicer, Beat Jump,
  Transport, Pitch Play, Scratch, Sequence and Part FX."

**What the code contains** (`src/renderer/engine/pad-modes.ts:3-14`, the
`PAD_MODE_DEFS` array — this is the single source of truth; `PadMode` is derived
from it at `:16`):

| # | `id` | `label` |
| --- | --- | --- |
| 1 | `hot-cue` | Hot Cue |
| 2 | `cue-loop` | Cue Loop |
| 3 | `loop-roll` | Loop Roll |
| 4 | `slicer` | Slicer |
| 5 | `beat-jump` | Beat Jump |
| 6 | `transport` | Transport |
| 7 | `pitch-play` | Pitch Play |
| 8 | `scratch` | Scratch |
| 9 | `sequence` | Sequence |
| 10 | `part-fx` | Part FX |

Ten entries. No `Saved Loop`, no `Roll`, no `Slicer Loop`, no `Sampler`, no
`Scratch Bank`, no `Stems` pad mode.

**Which is true per A1:** `docs/decisions.md` D23 and `REPORT.md` P4. The README
list is wrong in six of ten positions.

Corroborating detail, so this is not just a list mismatch:
`pad-modes.ts:24` `LOOP_ROLL_BEATS`, `:26` `BEAT_JUMP_STEPS`, `:28`
`PITCH_PLAY_SEMITONES`, `:30-41` `PART_FX_PADS` — the parameter tables exist for
Loop Roll, Beat Jump, Pitch Play and Part FX and for nothing else. The sampler
does exist, but as a separate 32-slot instrument (`sampler.ts`), not as a pad
mode. Scratch Bank likewise exists as `scratch-bank.ts` / `scratch-voice.ts`,
not as a pad mode.

**Resolution (H1a, docs only):** replace `README.md:32-42` with the D23 list
verbatim. Where README wants to advertise the sampler and scratch bank, describe
them as separate instruments, not pad modes.

Tier: **SOURCE**.

---

## 03 — FX list (three-way disagreement)

- `README.md:46` — 15 names: `echo`, `delay`, `reverb`, `filter`, `flanger`,
  `phaser`, **`bitcrush`**, `tremolo`, **`autofilter`**, **`tape-delay`**,
  **`ping-pong`**, **`noise-sweep`**, **`spiral-echo`**, **`trans-gate`**,
  `combo-filter-echo`.
- `RESUME.md:51-54` — "15 FX definitions (`filter`, `echo`, `reverb`, `flanger`,
  `phaser`, **`crusher`**, `delay`, `gate`, `tremolo`, **`autopan`**,
  `tape-stop`, `brake`, `combo-filter-echo`, etc.)".
- `docs/decisions.md:406` (D30) — "`fx.ts` adds `tremolo`, `gate`, `tape-stop`,
  `brake`, `combo-filter-echo`".

**What the code contains.** `src/renderer/engine/fx.ts:1-16` declares the
`FxType` union; `fx.ts:25-41` is `FX_DEFS`, 15 entries:

| `id` | `label` | implemented in `deck.ts`? |
| --- | --- | --- |
| `off` | Off | n/a (not an effect) |
| `echo` | Echo | yes — `deck.ts:353` |
| `delay` | Delay (ping-pong) | yes — `deck.ts:353`, ping-pong panners at `:363-372` |
| `reverb` | Reverb | yes |
| `filter` | Filter | yes — `deck.ts:340` |
| `flanger` | Flanger | yes — `deck.ts:419` |
| `phaser` | Phaser | yes — `deck.ts:442` |
| `crush` | Crush | yes — `deck.ts:472` |
| `autopan` | Auto Pan | **no branch found in `buildChain`** |
| `tremolo` | Tremolo | yes — `deck.ts:487` |
| `gate` | Trance Gate | yes — `deck.ts:487` (square LFO, `:491`) |
| `tape-stop` | Tape Stop | yes — `deck.ts:508` |
| `tapestop` | Tape Stop (Quick) | **no branch found; only `"tape-stop"` is matched** |
| `brake` | Vinyl Brake | yes — `deck.ts:508` |
| `combo-filter-echo` | Filter Echo | yes — `deck.ts:382` |

So: **15 `FX_DEFS` entries, of which one is `off`, two (`autopan`, `tapestop`)
declare a type that `buildChain` never builds, and `tape-stop`/`tapestop` are the
same effect under two ids.** The honest count is **12 distinct audible effects
reachable from the UI**, plus a duplicate alias and one dead entry.

`buildChain` (`deck.ts:334-…`) is a chain of `if (type === …)` tests with no
`else` fallback, so an unmatched type yields a chain with no nodes — dry signal
only. That is a *reading of the code*, not a measurement; I did not load the app
and select Auto Pan. Marked SOURCE, not UNIT.

**Which is true per A1:** the code. **None of the three documents is correct.**

- README's `bitcrush` = code's `crush`; `trans-gate` = code's `gate`;
  `ping-pong` is a *hint on `delay`* (`fx.ts:28`), not a separate effect.
  `autofilter`, `tape-delay`, `noise-sweep`, `spiral-echo` **do not exist**.
- RESUME's `crusher` = code's `crush`; `autopan` exists in `FX_DEFS` but is not
  implemented. Everything else in RESUME's list is right.
- D30 is correct but only lists the five it added; it is not a full inventory.

**Resolution (H1a, docs only):** publish the 15-row table above in `README.md`
and `RESUME.md`, and state plainly which entries are unreachable. Then either
delete `autopan`/`tapestop` from `FX_DEFS` or implement them — that is a code
decision for M1, not M0, and it needs a test either way. Do not describe the
count as "15 FX" until that is settled; "12 reachable effects" is defensible
today.

Tier: **SOURCE**.

---

## 04 — Latency

- `README.md:26` — "**`<10 ms` input-to-output latency** at a 128-frame buffer
  (`48 kHz`)".
- `docs/decisions.md:212-216` (D18) — "Configure Signalsmith with `blockMs: 8`.
  The diagnostics panel reports the engine's measured `latency` (about 8 ms). It
  does **not** add `AudioContext.baseLatency` or output-device latency."
- `docs/engine.md:136` — "Total, deck to speakers | under 10 ms where the driver
  allows".

**Which is true per A1:** D18 describes what the code does; the README describes
a different quantity (input-to-output including the device).

What the code measures: `pcm-source.ts:419` configures `blockMs: 8`, `:428`
reads `this.latency = await node.latency()`, `:322-325` exposes it as
`latencySeconds`. `deck.ts:1371-1373` forwards it. `app.ts:345` prints
`Math.round(active.latencySeconds * 1000)`.

What the code does **not** measure: `baseLatency` and `outputLatency` are read
**nowhere** in `src/` (grep for `baseLatency` returns only
`pcm-source.ts:323`, which returns `ctx.baseLatency` on the *fallback* path
only). So the README's "input-to-output" is unmeasured by construction.

Observed value: `deckLatency: 0.008` in `SMOKE_RESULT` — 8 ms, which is the
`blockMs: 8` figure, i.e. engine latency, not input-to-output.

**Resolution (H1a/H3):** this row is deliberately deferred by the brief (H1a must
not touch latency claims; H3 owns it). H3 must (a) print `baseLatency` and
`outputLatency` alongside the engine figure, (b) replace `README.md:26` with
three measured numbers and the machine they came from. Do **not** merge them into
one number.

Tier: **INTEGRATION** for the 8 ms engine figure (observed in the smoke run);
**unknown** for input-to-output.

---

## 05 — Loop wrap accuracy

- `README.md:26` — "**`<1 sample` loop wrap** across 10+ minute loops".
- `docs/engine.md:25-26` — "Loops are scheduled through Signalsmith;
  reverse-loop correction in `tick()` is **coarse rather than sample-accurate**".

**What the code contains — three different loop implementations, only one of
which is `<1 sample`:**

1. `src/renderer/engine/pcm-transport.ts` — the deterministic TS transport. Exact
   sample arithmetic. Pinned by `test/pcm-transport.test.ts:38-41`
   ("pcm loop wraps on the exact sample boundary", expected
   `[2,3,4,5,2,3,4,5,2,3]`) and `:43-46` (reverse), `:48` (block-size
   invariance), `:107` (ten minutes). **This module is imported by nothing in
   `src/`** — the only importer is the test file (`grep -rn "pcm-transport"`
   returns `test/pcm-transport.test.ts:3` and nothing else). So the `<1 sample`
   test suite tests a module that is **not on the live path**.
2. `src/renderer/engine/pcm-source.ts:81-110` — the fallback AudioWorklet. Exact
   modulo wrap on integer sample positions (`position % length`). Sample-exact by
   construction, but only reached when `signalsmith-stretch` fails to load
   (`pcm-source.ts:436-438`).
3. `src/renderer/engine/pcm-source.ts:653-661` — **the live reverse-loop path**.
   ```
   if (position <= start + 0.003 && now - this.lastLoopWrapAt > 250) { seek(end) }
   ```
   A 3 ms threshold on a `performance.now()` poll with a 250 ms debounce. At
   44.1 kHz, 3 ms ≈ **132 samples**. This is the "coarse" correction
   `docs/engine.md:26` refers to.
4. Forward loops in the live path are scheduled by
   `pcm-source.ts:628-636` (`applyLoop` → `scheduleStretch({loopStart, loopEnd})`),
   i.e. delegated to the Signalsmith worklet. No test pins that bound.

**Which is true per A1:** `docs/engine.md`. The README's `<1 sample` is true only
for a module that nothing runs and for the unused fallback; it is false for the
live reverse path by roughly two orders of magnitude.

**Resolution:** the brief's H2 owns this. It must measure the actual wrap error
in samples, forward and reverse, across block sizes, and then either fix `tick()`
or correct the doc to the measured bound. **Do not fix the doc before H2
measures** — the number is currently unknown. Two things are already clear and
should be written down regardless: the ten-minute `<1 sample` test does not
exercise the live path, and `README.md:26` overstates.

Tier: **SOURCE** for the code paths; **UNIT** for `pcm-transport.ts` only; the
live bound is **unknown**.

---

## 06 — Stems: offline vs real-time

- `README.md:49` — "**4-Part Offline & Real-Time Stems**".
- `docs/decisions.md:312-314` (D24) — "P5 separates four parts **offline** and
  caches them beside the track … Source separation runs in the Electron main
  process".

**Which is true per A1:** D24. Separation is offline and cached; only *playback*
of the four cached parts is real-time.

Evidence: `src/main/separation.ts` is the main-process worker; `parts.ts:64`
pins the model URL; `deck.ts:138` holds `stemVoices: Partial<Record<PartId,
PcmSource>>` — four `PcmSource` voices over pre-separated buffers. `SMOKE_RESULT`
reports `stemParts: 4`, `stemEngine: "pcm"` — four voices playing, which is
playback, not inference.

**Resolution (H1a, docs only):** reword to "4-part **offline** separation,
real-time playback of the four parts". The word "Real-Time" attached to
"Stems" is the defect.

Tier: **SOURCE**.

---

## 07 — Serato library writes

- `README.md:50` — "Reads and **writes** `_Serato_/database V2`,
  `_Serato_/Subcrates/*.crate` … **and Serato 4.x `master.sqlite`
  (`container_asset_list_columns`)**".
- `docs/decisions.md:95-103` (D8) — "Export the legacy library format, **not**
  Serato's SQLite"; `:105-113` (D9) — the only direct SQLite edit is "a separate
  command, runs only after Serato has imported the crates, and takes a backup …
  **[verify]** against the Serato 4 build under test".

**What the code contains:** `src/main/serato-files.ts:391`
`writeSeratoSqliteColumns(...)` exists and is reachable via
`main.ts:432-433` (`serato:apply-crate-columns`, `serato:sqlite-columns`). So
SQLite *is* written — as an opt-in, backed-up, single-column-list edit.

**Which is true per A1:** the code matches D9, not D8's headline and not the
README. The README's "reads and writes Serato 4.x master.sqlite" reads as full
bidirectional SQLite support; the code writes exactly one table's one column
list. D8's "not Serato's SQLite" is itself now slightly stale, because D9 added
the narrow exception.

**Resolution (H1a, docs only):** state the scope precisely — "reads
`master.sqlite` for the column list; writes `container_asset_list_columns` only,
opt-in, after a backup, behind a separate command". Fix D8's wording to point at
D9 rather than deny the write. D9's own `[verify]` stands.

Tier: **SOURCE**.

---

## 08 — Rust's role

- `README.md:26` — "Decodes tracks into linear PCM (**`PcmSource` /
  `opendeck-audio`**)".
- `docs/decisions.md:268-273` (D22) — "Live deck playback stays on the JS
  `PcmSource`; the optional cpal output is compiled and tested but **no shell
  selects it for deck audio**."

**Which is true per A1:** D22. Pairing `PcmSource` and `opendeck-audio` with a
slash implies they are the same engine or interchangeable; they are not on the
live path.

Evidence: `rust/crates/opendeck-audio/src/` has `cpal_out.rs`, `decode.rs`,
`live.rs`, `render.rs`, `ring.rs`, `transport.rs`. `opendeck-app/Cargo.toml`
enables `features = ["decode"]` only — **not** `native-output`. `tauri.conf.json`
ships `frontendDist: "../../../renderer"`, i.e. the same JS app. The Tauri
command list (`rust/crates/opendeck-app/src/main.rs:821-839`) is
`analyze_file`, `analyze_bytes`, `analyze_bytes_raw`, `media_fetch*`,
`recording_save*`, `streaming_*`, `rtmp_*` — **no playback command at all**.

**Resolution (H1a, docs only):** reword to "TypeScript `PcmSource` owns live
playback; the Rust crate decodes for analysis in the Tauri shell and can render
offline". Do not present them as one engine.

Tier: **SOURCE**.

---

## 09 — Sampler: user samples

- `README.md:43` — "synthesized default kit + **custom sample drop**".
- `docs/decisions.md:308-309` (D23 revisit) — "**Add user samples** and per-slot
  gain/pan **when sampler import lands**".

**Which is true per A1:** D23. There is no user-sample import.

Evidence: `src/renderer/engine/sampler.ts:1-9` — `SamplerKind` is a closed union
of eight synthesized drum voices (`kick`, `snare`, `clap`, `hat`, `openhat`,
`tom`, `rim`, `crash`); `:13-21` `SAMPLER_PADS`; `:28-34` 32 slots = 4 banks × 8;
`:43-49` `makeNoise` is the only sample source. There is no `loadSample`,
`drop`, `File`, or `decodeAudioData` anywhere in the file. Per-slot gain and mute
exist (`README.md:43` is right about those); per-slot *pan* does not.

**Resolution (H1a, docs only):** delete "custom sample drop". Describe the
sampler as "32 synthesized slots across four banks". Keep "per-slot gain & mute",
drop any pan claim.

Tier: **SOURCE**.

---

## 10 — Streaming DRM

- `README.md:55` — "Native `MediaKeySystemAccess` / `MediaKeys` /
  `MediaKeySession` negotiation across **Widevine**, **FairPlay**, **PlayReady**,
  and **ClearKey**".
- `README.md:56` — "**8 Commercial Streaming Services on Decks A–D:** Direct
  catalog search, EME license exchange, and **in-deck playback**".
- A2 (from `docs/decisions.md`): "Stock Electron ships no Widevine CDM.
  FairPlay is Safari/WebKit-only. PlayReady is Edge/Windows."

**What the code contains:**

- `src/renderer/streaming/drm.ts:6-9` maps the four scheme names to the four
  key-system strings. That is a constant table, not a capability.
- `drm.ts:163-201` `probeKeySystems()` calls
  `navigator.requestMediaKeySystemAccess(keySystem, configs)` per scheme inside
  `try/catch` and records which resolve. This is a **capability probe**.
- `drm.ts:234` `DrmSessionManager`, `:310-315` `createMediaKeys()` +
  `element.setMediaKeys()` — this is a real EME attach path.
- `app.ts:347-396` `playStreamOnDeck()`: if the track URL looks like a media file
  (`:359` regex `mp4|m4a|webm|mpd|m3u8|flac|ogg|mp3`) it creates an `<audio>`
  element and calls `drmManager.attachToMediaElement` (`:368`); **otherwise it
  creates an `<iframe>` pointed at the provider's own embed URL** (`:377-384`).
- `app.ts:394` — the UI text: "Enable **Capture output (AUX)** to route encrypted
  player audio through mixer EQ & faders".

**Which is true per A1:** the code. There are two distinct mechanisms and the
README conflates them:

1. **iframe embed** — the provider's own web player renders and plays. OpenDeck
   hosts a rectangle. Audio does not enter the Web Audio graph at all; the app
   itself tells the user to capture it externally. No EQ, no fader, no crossfader,
   no timecode, no stems, no reverse.
2. **`<audio>` + EME attach** — only for direct media URLs, and only if the
   running Chromium exposes that key system.

So "in-deck playback" is true in the narrow sense that a player is drawn inside
the deck panel. It is **not** true that streamed audio is mixed by OpenDeck.

Per-shell reality: stock Electron bundles no Widevine CDM, so
`requestMediaKeySystemAccess("com.widevine.alpha")` will reject unless a CDM is
shipped or a Widevine-enabled build is used; FairPlay is WebKit-only and will
reject in both Chromium shells. What *actually* negotiates on this machine, per
provider, per shell is **`[verify]`** — I did not run the probe against live
services and will not assert its result.

Separately **`[verify]`**: whether any of the eight providers' terms permit DJ
use, time-stretching, or capture. That is a legal question, not a code question,
and I have no evidence either way.

**Resolution (H1a, docs only):** rewrite `README.md:54-56` to describe the
embed/capture model honestly, state that streamed audio bypasses the mixer unless
captured, and add the `[verify]` markers for per-shell negotiation and provider
terms. Do not claim four DRM systems work; claim the probe exists.

Tier: **SOURCE** for mechanism. Capability per provider: **unknown**.

---

## 11 — Which shell is the product

- `README.md:3` — "a TypeScript UI running inside **an Electron shell or a native
  Rust/Tauri shell** (`OpenDeck.exe` / `bin/opendeck-app.exe`)".
- `README.md:72` — "double-click **`OpenDeck.exe`** directly in the repository
  root (or **`bin/opendeck-app.exe`** / `release/OpenDeck-win32-x64/OpenDeck.exe`
  after running `npm run package:win`)".
- `package.json:14` — `"package:win": "node scripts/package-win.mjs"`.

**What the code contains — this row settles itself:**

1. `scripts/package-win.mjs` stages a **standalone Electron** bundle at
   `release/OpenDeck-win32-x64/` by copying `node_modules/electron/dist` and
   renaming `electron.exe` → `OpenDeck.exe`.
2. The **root `OpenDeck.exe` is a rustc-compiled launcher**, not the app. Its
   resolution order, read from the generated source in `package-win.mjs`, is:
   `release/OpenDeck-win32-x64/OpenDeck.exe` → `node_modules/electron/dist/electron.exe`
   → `bin/opendeck-app.exe` (Tauri) — Tauri is **third**.
3. Feature coverage, Electron (`src/main/main.ts` `ipcMain.handle` list,
   lines 147-516) versus Tauri (`rust/crates/opendeck-app/src/main.rs:821-839`):

   | Capability | Electron | Tauri |
   | --- | --- | --- |
   | Stems / separation (`separation:*`) | yes — `main.ts:319-345` | **no** |
   | Video 2nd window (`video:*`) | yes — `main.ts:438-497` | **no** |
   | Serato writes (`serato:*`) | yes — `main.ts:351-436` | **no** |
   | Recording save | yes — `main.ts:231` | yes |
   | RTMP (`rtmp:*`) | yes — `main.ts:248-317` | yes |
   | Streaming (`streaming:*`) | yes — `main.ts:147-209` | yes |
   | Native decode/analysis | no (JS `decodeAudioData`) | **yes** — `analyze_*` |
   | Live audio playback | JS `PcmSource` | JS `PcmSource` (same webview) |

4. Sizes: `OpenDeck.exe` 12,910,080 B (13 MB, the launcher);
   `bin/opendeck-app.exe` 12,910,080 B (same byte count — see note below).

**Which is true per A1:** **Electron is the product.** It is the only shell with
stems, video output and Serato writes, it is what `npm run package:win` packages,
and it is what the root launcher prefers. Tauri is a partial shell whose unique
contribution is native decode for analysis.

Note on the sizes: both `.exe` files report 12,910,080 bytes. Identical size for
a Rust launcher and a Tauri app would be a coincidence. I am flagging it as
**`[verify]`** rather than concluding the files are duplicates — I did not hash
them, and hashing them would not change the answer to this row.

**Resolution (D38, m4):** designate Electron as the product; demote Tauri to
either (a) a dev artifact kept only for the native-decode analysis path, or (b)
the subject of an explicit port. Whichever is chosen, `README.md:3` and `:72`
must stop presenting the two as interchangeable. This also fixes M2's probe
target: **the M2 probe is an N-API addon in the Electron process**, not a Tauri
command.

Tier: **SOURCE** (read the packaging script and both IPC surfaces). Not
COMPILED: I did not run `npm run package:win`.

---

## 12 — Naming: "Serato-style"

- `README.md:18` — "### Vertical Waveforms & **Serato-style** Library Management".
- `docs/decisions.md:139-148` (D12) — "Do not call OpenDeck 'Serato'. Refer to the
  other product as 'Serato DJ Pro' **only when describing compatibility**".

**Which is true per A1:** D12. "Serato-style" is a style claim about OpenDeck
that borrows the mark, which is exactly what D12 forbids; "compatible with Serato
DJ Pro" is the permitted form.

Grep confirms this is the only such heading: `grep -n "Serato-style" README.md`
returns `18:` only.

**Resolution (H1a, docs only):** retitle to something that describes the
behaviour — e.g. "Vertical Waveforms & Crate-Based Library Management" — and keep
the compatibility statement in the Legal section (`README.md:118`), which is
already correctly worded.

Tier: **SOURCE**.

---

## 13 — Docs hygiene in `decisions.md`

- `docs/decisions.md:349` — heading `## Open assumptions`.
- `docs/decisions.md:364` — `## D25: Bidirectional Serato V2 database …`.
- `docs/decisions.md:372` — `## D26`; `:380` `## D27`; `:388` `## D28`;
  `:396` `## D29`; `:404` `## D30`; `:412` `## D31`.
- `docs/decisions.md:420` — `### D32: Phase 7 Video Mixing & Secondary Fullscreen
  Output Window (2026-10-24)`.

Two defects, both confirmed by reading:

1. **Ordering.** D25–D32 (eight decisions) are appended *after* the "Open
   assumptions" list, so the document reads as if the decisions ended at D24 and
   the assumptions are a trailer. They are not; D25–D32 are decisions.
2. **Heading level and format.** D25–D31 use `##`; D32 uses `###`, so it renders
   as a child of D31. D32 also uses a `- **Context:** / - **Decision:**` bullet
   format instead of the D1–D31 `**Decision:** / **Why:** / **Revisit:**` triple,
   and it has **no Why and no Revisit** at all.

**Which is true per A1:** this is a formatting/intent issue, not a factual one.
D15-era format is the `##` + Decision/Why/Revisit triple.

**Resolution (H1a, docs only):** move `## Open assumptions` to the end of the
file, promote D32 to `##`, and give D32 a `**Why:**` and a `**Revisit:**`. The
Why is recoverable from the D32 text itself (negative `playbackRate` is not
supported by `<video>`, so reverse/scratch must step `currentTime`). Do not
invent a Revisit — ask the author or write `[verify]`.

Tier: **SOURCE**.

---

## 14 — Phase naming collision

- `README.md:23` — "## Features (**Phases P0–P7 Complete**)".
- Manifest A4 — "To avoid colliding with the repo's existing P0-P7 feature phases,
  name commits `m<N>: <what>` (m0, m1, …)".

**Which is true per A1:** both are true about different things. P0–P7 are shipped
feature phases; m0–m5 are Run 1 phases. The collision is in the *word* "phase",
and it is a real hazard because `RESUME.md` and `REPORT.md` both talk about
"phases" without a prefix.

**Resolution:** commit messages use `m<N>:` (already mandated). Any new document
must say "m-phase" or "Run 1 phase", never bare "phase". `README.md:23` may keep
"P0–P7" because that is the historical name, but new text must not introduce a
second bare "Phase 8".

Tier: **SPECIFIED**.

---

## 15 — Two status documents

- `REPORT.md:1-3` — "# OpenDeck parity report / Updated after Waves 1–5 (P1–P6 +
  195-device hardware catalogue & verification pass)."
- `docs/serato-parity.md:1-3` — "# Parity plan / This is the **plan of record**
  for reaching feature parity …".

**Which is true per A1:** neither is designated by any other document. `README.md`
links `docs/serato-parity.md` as "Full phase status and feature matrix"
(`README.md:107`) and does not link `REPORT.md` at all. So by *reference*, the
parity matrix is `docs/serato-parity.md`; by *content*, `REPORT.md` is the
narrative status.

Both also drift: `REPORT.md:3` stops at "Waves 1–5 (P1–P6)" but the file contains
a P7 section at `:139`; `docs/serato-parity.md` calls itself a *plan* while
`README.md:107` calls it a *status*.

**Resolution (H1a, docs only):** designate **one** status document. My
recommendation, with reasoning: `docs/serato-parity.md` is the matrix (it is
already linked from the README and its name matches the "parity" framing);
`REPORT.md` becomes a dated narrative changelog and must stop using the word
"status". Whichever way it goes, `README.md:107` must link the designated one and
the other must say, in its first line, that it is not the status document.

Tier: **SOURCE**.

---

## 16 — Zero telemetry

- `README.md:3` — "MIT licensed, with **zero telemetry**".

**Audit.** Grep over `src/**/*.ts` for `fetch(`, `XMLHttpRequest`,
`navigator.sendBeacon`, `gtag(`, `analytics`, `https://`:

- **No analytics, no telemetry SDK, no beacon, no XHR, no error reporting.** The
  claim is **true as stated**.
- Outbound network calls that do exist, all functional:
  - `src/main/separation.ts:14,172` — model download from
    `huggingface.co/StemSplitio/htdemucs-onnx` (on demand, SHA-256 checked).
  - `src/main/main.ts:176,198,214` — provider session fetches, user-initiated.
  - `src/renderer/app.ts:1176-1194` — provider media fetch, user-initiated.
  - `src/renderer/broadcast/whip.ts:91,116` — WHIP broadcast, user-initiated.
  - `src/renderer/streaming/drm.ts:386-498` — embed URLs, rendered only when the
    user plays a stream.
  - `src/renderer/app.ts:1228-1249` `lookupArtwork` → iTunes Search API.

The last one deserves a flag. `app.ts:1248` fires it **automatically** for every
analysed track that has no embedded artwork, sending `artworkQuery(info,
track.name)` — artist and title — to Apple, with no user action and (as far as I
can see) no prompt. That is not telemetry, but "zero telemetry" invites a reader
to conclude "nothing leaves the machine", and something does.

The A3 trap note about Serato's `DJ.gai` Google Analytics hits queue does not
apply: `DJ.gai` is a Serato artefact, and grep finds no reference to it in this
tree.

**Resolution (H1a, docs only):** keep "zero telemetry" but add one sentence:
"OpenDeck contains no analytics or telemetry. It does make three kinds of
outbound request: an on-demand stem-model download, user-initiated provider and
broadcast traffic, and an automatic cover-art lookup against the iTunes Search
API." That is accurate and costs one line.

Tier: **SOURCE**.

---

## 17 — RTMP broadcasting

- Repo GitHub description claims RTMP broadcasting. **Nothing in `README.md`,
  `REPORT.md`, `RESUME.md` or `docs/` mentions RTMP.**
- `src/main/main.ts:248-317` — `rtmp:available`, `rtmp:start`, `rtmp:chunk`,
  `rtmp:stop`.

**What the code contains:** RTMP broadcasting **does exist** in the Electron main
process. `main.ts:248` probes for `ffmpeg` by spawning `ffmpeg -version`;
`:260` validates the endpoint against `^rtmps?://`; `:266-284` spawns ffmpeg with
`-i pipe:0 -vn -c:a aac -b:a 192k -ar 48000 -f flv <url>`; `:300` writes chunks
to stdin. The renderer side is `app.ts:3105-3155`: a `MediaRecorder` over
`mixer.getStream()` producing `audio/webm;codecs=opus`, i.e. the mixed master
output.

So: it exists, it is wired, it requires an **external ffmpeg on `PATH`**, and
`app.ts:3111` disables the button when ffmpeg is missing. There is **no test** —
`grep -rln "rtmp" test/` returns nothing (the only match, `streaming.test.ts`,
matches on unrelated text).

**Which is true per A1:** the code. The GitHub description is backed by an
implementation; the repo documentation is silent about it, which is the actual
defect (an undocumented, untested, external-binary-dependent feature).

**Resolution (H1a, docs only):** document it in `README.md` with its real
constraints (needs ffmpeg, Electron only — the Tauri shell also implements
`rtmp_*`, so say "both shells"), and mark it **untested** — do not list it under
"verified". A test needs a fake ffmpeg on `PATH`; that is an M1 candidate, not
M0.

Tier: **SOURCE**. Never INTEGRATION: nothing was broadcast.

---

## 18 — Hardware catalogue count

- `docs/decisions.md:414` (D31) — "`SUPPORTED_HARDWARE_RAW` (**195** verbatim
  device strings), `HARDWARE_CATALOGUE` (**195** typed entries …)".
- `README.md:60` — "**195 Supported Hardware Devices** … ([`docs/hardware.md`](docs/hardware.md))".
- `docs/hardware.md:88` — "## Supported Hardware Catalogue (195 Devices)".

**Measured:**

- `SUPPORTED_HARDWARE_RAW` — parsed the array literal from
  `src/renderer/midi/profiles.ts`: **195 entries**.
- `docs/hardware.md` — counted data rows in the catalogue section (from line 88):
  **195**, distributed 66 + 45 + 39 + 6 + 23 + 16, matching the six section
  headings at `:92`, `:163`, `:213`, `:257`, `:268`, `:296`.

**Which is true per A1:** all three agree with the code. D31 is backed. This row
is **not** a contradiction; it is a confirmation, and it is recorded so nobody
re-opens it.

The substantive caveat from A2 stands and is not contradicted: these are **name
strings matched by substring** (`profileForDevice`, `profiles.ts`), i.e. a
catalogue, not 195 physically verified profiles. `README.md:60` says "Built-in
plug-and-play device recognition … auto-presets", which overstates what a
substring match delivers. That is a wording issue for H1a, not a count issue.

**Resolution:** keep 195. Reword `README.md:60` to "195 device names recognised
by string match; presets are only defined for the models listed in
`docs/hardware.md`". Physical verification is Run 2 / N7 work.

Tier: **SOURCE** (counted). Not HARDWARE: no device was attached.

---

## 19 — `.gitattributes` and LFS

- `.gitattributes:1-3`, entire file:
  ```
  * text=auto eol=lf
  *.png binary
  *.exe binary
  ```
- Committed binaries: `OpenDeck.exe` 12,910,080 B; `OpenDeck-win64.zip`
  4,236,301 B; `bin/opendeck-app.exe` 12,910,080 B.

**What the file contains:** **no `filter=lfs` line anywhere.** `*.exe binary` is a
diff/merge attribute, not LFS. `git lfs ls-files` returns empty (and LFS may not
be installed here — either way, nothing is tracked through it).

**Which is true per A1:** the repo carries the blobs directly. Total committed
binary weight ≈ **30 MB** (13 MB + 4.1 MB + 13 MB), not 100 MB+.

So the A3 concern ("the repo carries 100 MB+ of blobs") is **half right**: LFS is
genuinely absent, but the total is ~30 MB, and `.gitattributes` is *not*
pretending otherwise — it never mentions LFS. The `*.exe binary` line does what it
says.

**Resolution:** do not add LFS retroactively (that is a history rewrite, forbidden
by A4). The A4 rule already covers the right fix: **stop committing the binaries
and publish them as release assets.** Report the sizes (above) and recommend
that. For M0, record: no LFS, ~30 MB of committed binaries, no rewrite.

Tier: **SOURCE**.

---

## 20 — Tag vs `package.json` version

- `package.json:3` — `"version": "0.1.6"`.
- Tags present: `v0.1.0` … `v0.1.6`, plus `backup-before-performance`.
- `git describe --tags` → `v0.1.6-14-g9035f2c`.

**Which is true per A1:** the *tag* and `package.json` **agree** at `0.1.6`. The
discrepancy is different from the one A3 anticipated: **HEAD is 14 commits past
the `v0.1.6` tag while `package.json` still says `0.1.6`**, so 14 commits of
shipped-looking work carry no version change. `rust/Cargo.toml` workspace
version and `rust/crates/opendeck-app/tauri.conf.json` `"version"` are also both
`0.1.6`, so all three version strings are consistent with each other and all
three are stale relative to `main`.

**Resolution:** M0 does not bump versions (A4 forbids dependency bumps; a version
bump is a release decision). Record it and hand it to M5: either tag the Run 1
work as `v0.1.7`/`v0.2.0` at the end, or state in `REPORT-RUN1.md` that `main` is
ahead of the last tag by N commits. Do not silently leave three files claiming
`0.1.6`.

Tier: **SOURCE**.

---

## 21 — Screenshots referenced by `raw/main` URLs

- A3 claims screenshots are "referenced via raw/main URLs and are the de-facto
  product proof. They break off main."

**What the tree contains:** `README.md:10,13,16,19` use **repo-relative** paths,
e.g. `![…](screenshots/opendeck-p7-performance.png)`. `grep -c
"raw.githubusercontent\|raw/main" README.md` → **0**. `git log
-S"raw.githubusercontent" -- README.md` → **no commits**. All 16 files in
`screenshots/` are tracked (`git ls-files screenshots`).

**Which is true per A1:** the claim is **not reproducible in this tree**. The
screenshots use relative paths and are committed. Relative paths do not break off
`main`; they break if the README is rendered outside the repo (e.g. on a package
registry page).

**Resolution:** no change needed for correctness. Two things are still true and
worth writing down: the screenshots are the only evidence offered for the UI, and
they are **PNG stills, not measurements** — they prove nothing about behaviour.
Treat them as SPECIFIED-tier marketing, never as evidence. If a future README
edit introduces absolute URLs, that is the regression to watch for.

Tier: **SOURCE**.

---

## 22 — "Implemented, wired, and verified"

- `RESUME.md:3` — "All P1–P6 and Wave 1–5 parity items … are implemented, wired,
  and **verified**."
- `docs/decisions.md:349-362` — six open `[verify]` items: Serato 4 legacy-crate
  import; 18-colour cue palette / `Markers2` encoding; `Markers_` vs `Markers2`
  preference; beat-grid lock flag bit; `container_asset_list_columns` usage `1`
  stability; WebView2 SharedArrayBuffer / cross-origin isolation.

**Which is true per A1:** the code and the `[verify]` list. "Verified" is doing
unearned work: six of the behaviours the resume calls verified are explicitly
listed as unverified assumptions in the same repository.

Concretely, the `[verify]` items are not decorative — each one sits under a
shipped feature:

| `[verify]` item | Feature it underwrites | `decisions.md` |
| --- | --- | --- |
| Serato 4 legacy-crate import | whole export path (D8) | `:351-352` |
| cue palette / `Markers2` encoding | every cue write (D7) | `:353-354` |
| `Markers_` vs `Markers2` preference | cue read-back (D7) | `:355-356` |
| beat-grid lock bit | D29 lock enforcement | `:357` |
| `container_asset_list_columns` stability | D9 SQLite column write | `:358-359` |
| WebView2 SAB / COI | the Rust seam (D3/D22) | `:360-362` |

**Resolution (H1a, docs only):** replace "verified" in `RESUME.md:3` with a
graded statement. Suggested: "implemented and wired; unit-tested where
`test/` covers it; **six behaviours remain unverified** (see
`docs/decisions.md` Open assumptions)". Then append the Run 1 section (M5) with
its own tiers. Do not delete the `[verify]` markers to make the sentence true.

Tier: **SOURCE**.

---

## 23 — Two paths for one artefact

- `README.md:72` — root `OpenDeck.exe`, or `bin/opendeck-app.exe`, or
  `release/OpenDeck-win32-x64/OpenDeck.exe` after `npm run package:win`.
- `.gitignore` — contains `release/`.

**Which is true per A1:** there are **three** paths, and they are three different
things:

| Path | What it is | In git? |
| --- | --- | --- |
| `OpenDeck.exe` (root, 12,910,080 B) | rustc launcher; prefers the packaged Electron build, then dev Electron, then Tauri | **yes** (committed) |
| `bin/opendeck-app.exe` (12,910,080 B) | Tauri app | **yes** (committed) |
| `release/OpenDeck-win32-x64/OpenDeck.exe` | packaged Electron app | **no** — `release/` is gitignored, produced by `npm run package:win` |

So the artefact the README tells a user to double-click (root `OpenDeck.exe`) is a
**launcher that may do nothing useful on a clean checkout**, because the packaged
Electron build it prefers does not exist until `npm run package:win` has run, and
its fallback is `node_modules/electron`, which a downloaded zip does not contain.
Whether the shipped `OpenDeck-win64.zip` contains a working app is **`[verify]`**
— I did not extract and run it.

**Resolution (H1a/H1b):** document the three paths and what each requires.
Recommend that `OpenDeck-win64.zip` be a release asset containing the *packaged*
app, and that the root `OpenDeck.exe` stop being committed at all. Do not delete
it in M0 (A4 forbids).

Tier: **SOURCE**. "Does the zip work" is **unknown**.

---

## 24 — "4-part htDemucs" and "real DVS timecode control"

- `README.md:3` — "**real DVS timecode control**, **4-part htDemucs** stem
  separation".
- `README.md:26` — "**true reverse playback**".
- `docs/decisions.md:74-83` (D6) — decoder frozen, byte-identical, five media
  types.
- `docs/decisions.md:268-284` (D22) — Rust plays nothing.

**Which is true per A1:** both headline claims are **substantially** true, with
one qualifier each, and neither is a lie:

- **4-part htDemucs**: real. `src/main/separation.ts`, `parts.ts:64` model URL,
  `SMOKE_RESULT` `stemParts: 4`, `stemRms: 0.0917` (non-zero). Tier **INTEGRATION**
  — four parts were produced and played in the smoke run. The qualifier is
  *offline only* (row 06), not "fake".
- **Real DVS timecode control**: the decoder is real and frozen (D6,
  `src/timecode/`, `src/dvs/`). The qualifier is that DVS *drives* playback
  through `Deck.driveTimecode` → `PcmSource.drive` (D20) and the live transport is
  the JS one; D22 means DVS does not touch Rust. Whether the *closed loop* holds
  under a real turntable is **`[verify]`** — no hardware was attached here, so the
  ceiling is INTEGRATION/UNIT, never HARDWARE.

So this row is a **wording** problem, not a truth problem: the README states the
feature without the qualifier. The one place it goes too far is `README.md:26`
"true reverse playback" combined with "sample-accurate" — reverse is real, but
the reverse *loop* is the coarse path in row 05.

**Resolution (H1a, docs only):** add "offline" to stems and "decoder frozen;
live transport is TypeScript" to DVS. Remove "sample-accurate" from any sentence
that also mentions reverse loops until H2 measures it.

Tier: **INTEGRATION** for stems (observed); **SOURCE** for the decoder;
**unknown** for real-hardware DVS.

---

## 25 — Ableton Link is absent

- `docs/decisions.md` D1–D32 — no Link entry.
- `README.md` — no mention.
- `NOTICE` — no Link entry.
- Manifest A2 — "Ableton Link is ABSENT today."

**Confirmed at the baseline commit.** At `9035f2c`, `grep -ri "ableton\|link"` over
`src/`, `README.md` and `docs/` returns nothing about Ableton Link.

**Caveat that must be recorded, because the tree moved during M0.** While this
baseline ran, another agent added Link wiring to the working tree:
`src/main/link.ts` (untracked), `main.ts:513-516` (`link:status`, `link:enable`,
`link:disable`, `link:set-tempo`), `scripts/smoke-link.mjs`,
`scripts/link-smoke-entry.ts`, `src/renderer/engine/tempo-authority.ts`. **None of
this is in the baseline commit.** Every statement in this document about "Link is
absent" refers to `9035f2c`, and the M3 work is an **addition**, not a
regression — which the brief already requires be stated explicitly so the test
count change is not misread.

**Resolution:** no doc fix. Record as new scope. The relevant consequence is for
row 27.

Tier: **SOURCE**.

---

## 26 — Link licence vs D11

- `docs/decisions.md:128-137` (D11) — "MIT/Apache-2.0 preferred, MPL-2.0 allowed,
  **GPL forbidden for linked code**."
- Manifest A3 row 26 — "The reference C++ implementation is **GPL v2+ with a
  commercial option [verify]**."

**Which is true per A1:** D11 is unambiguous and is the project's own rule. The
licence of Ableton's reference implementation is an **external fact that I cannot
verify from this repository**, and A4 forbids me from asserting it from memory.

**Status: `[verify]` — unresolved by design.** I am not going to state the licence
of `Ableton/link` from recollection. It must be confirmed by reading the
`LICENSE.md` in the upstream repository and recording the commit or release it was
read at.

What *is* settled: **if** the reference implementation is GPL, then D11 as written
forbids linking it, and M3's D34 must either amend D11 in writing (stating that
the distributed combined work becomes GPL while OpenDeck's own source stays MIT)
or choose a non-GPL route. Both are permitted by A4; silence is not.

**Resolution:** D34 owns this. It must contain the verified licence text, the
date/commit it was read at, the chosen route, the rejected routes, and the
`NOTICE` entry. It must not cite this document as evidence of the licence.

Tier: **SPECIFIED** (D11) / **unknown** (upstream licence).

---

## 27 — Tempo authority

- `src/renderer/engine/sync.ts` exists. Manifest A2: "Establish what tempo, beat
  and phase authority it currently implements BEFORE adding Link. Link must not
  become a second tempo authority."

**What `sync.ts` actually is** (read in full, 59 lines): a **pure-function
library**, not a component and not an authority.

| Export | Line | What it does |
| --- | --- | --- |
| `syncRate(masterBpm, targetBpm, maxTempoPercent)` | `:22-27` | `masterBpm / targetBpm`, clamped to `±maxTempoPercent` |
| `syncDeck(input)` | `:29-44` | one-shot: computes `rate`, `phaseError` via `wrapBeatPhase`, and `seekTo = targetPosition - phaseError` |
| `nudgeTowardPhase(...)` | `:46-54` | bounded ±0.03 correction, gain 0.25 |
| `tempoPercentLabel(...)` | `:56-58` | formatting |

`sync.ts` holds **no state**. It has no clock, no session BPM, no peer list, no
timer, and no callback.

**Who owns tempo today, in the live app:** each **deck** owns its own BPM, sourced
from analysis or tags (`deck.info.bpm`), and its own rate
(`deck.setTempoPercent`). There is no session-level tempo object. The "sync"
button is a **one-shot copy** from the other deck:

- `app.ts:1113-1141` `applySync(deckId)` — `otherId = deckId === "A" ? "B" : "A"`,
  so sync is hardcoded to A↔B; C and D cannot be synced at all. It calls
  `syncDeck(...)` once with `master.info.bpm` / `deck.info.bpm`, then
  `applyTempo(deckId, result.tempoPercent)` and `deck.seek(result.seekTo)`.
- `app.ts:1101-1111` `applyTempo` sets `synced[deckId] = false` and clears the
  sync chip — so the "sync" state is a UI flag, not a maintained lock.
- There is **no continuous phase correction**: nothing calls `nudgeTowardPhase`
  (grep: it appears only at its definition, `sync.ts:46`, and nowhere else — it is
  dead code).

**Answer to "who is master":** today, **nobody**. There is no tempo authority to
be master of. Each deck is its own tempo owner and sync is a one-shot copy from
A to B or B to A.

**Which is true per A1:** the code. `docs/engine.md:21-22` ("sync … remain in the
Web Audio graph downstream of the deck source") is misleading — sync is not in the
graph, it is a pure function called from a button handler.

**Resolution:** D35 owns this and must state, as a table, the precedence for
every combination of {Link on/off} × {internal sync on/off} × {manual BPM}. Two
constraints are already forced by the code and should be written into D35 as
given facts: (a) there is no session authority to attach Link to, so D35 must
**create** one rather than integrate with an existing one; (b) `applySync` is
A↔B-only and one-shot, so "internal sync" cannot today be a peer of Link — it is a
button.

Tier: **SOURCE**.

---

## 28 — Link on mobile

- Manifest A3 row 28 / Part C divergences — "iOS requires a local-network
  permission prompt and multicast UDP. A denied prompt is a real state. [verify]".

**Status: `[verify]`.** I have no iOS device, no simulator, and no macOS host in
this environment, so I can neither confirm nor deny any of it. A4 explicitly
forbids asserting Apple API behaviour from memory, and I am not going to.

What I *can* contribute, and what belongs in the record:

- Multicast works on the **desktop** host measured here (BASELINE.md §7). That is
  evidence about Windows 10 + Node, and it **does not transfer** to iOS.
- The shape of the divergence is already correctly described by the brief:
  a denied permission is a **normal state**, not an error, and the smoke test must
  report a **visible skip with a reason**, never a silent pass (Part D, "No silent
  skip in smoke:link").
- The exact `Info.plist` keys, the entitlement name, and whether a multicast
  entitlement is separately required are all `[verify]` for the chosen SDK.

**Resolution:** record as a divergence with `[verify]`, and give it a row in
`docs/mobile/VERIFY-PLAN.md` (A5): cheapest falsification test = build the
N10 target and observe the prompt on a device with the network permission denied
and then granted; owner = human with a phone; what it changes = whether Link is a
shippable mobile feature or a desktop-only one.

Tier: **SPECIFIED** (the requirement) / **unknown** (the platform behaviour).

---

## New items found while checking A3

These are not in A3. They are recorded because they change what later phases can
assume.

### N-1. `pcm-transport.ts` is not on the live path

`src/renderer/engine/pcm-transport.ts` is imported **only** by
`test/pcm-transport.test.ts:3`. Nothing in `src/` imports it. Yet it is the module
that carries the "exact sample boundary", "block-size invariant" and "ten minutes
of looping" tests (`test/pcm-transport.test.ts:38,43,48,57,107`).

Consequence: a green suite proves the *reference implementation* is exact. It
says nothing about the Signalsmith path that actually plays audio. Any claim
resting on those tests (README `<1 sample`, `REPORT.md:100` "Ten-minute offline
loop test is green (sample-exact loop logic)") is resting on the wrong module.

This is the single most consequential finding in M0 and it should be fixed by
labelling, not by deleting the tests — they are good tests of a good module that
happens to be unused. Tier: **SOURCE**.

### N-2. `autopan` and `tapestop` are declared but unreachable

See row 03. `FX_DEFS` (`fx.ts:25-41`) declares both; `buildChain`
(`deck.ts:334-…`) matches neither. Selecting them yields a dry chain. Tier:
**SOURCE**.

### N-3. `nudgeTowardPhase` is dead code

Defined at `sync.ts:46-54`, referenced nowhere. If D35 wants continuous phase
correction, this is a starting point; today it is a claim with no caller. Tier:
**SOURCE**.

### N-4. `applySync` is A↔B only

`app.ts:1113-1114` hardcodes `deckId === "A" ? "B" : "A"`. Decks C and D have no
sync path. Not in A3; matters for D35 and for the 4-deck claim in
`README.md:27`. Tier: **SOURCE**.

### N-5. `deck.load()` treats a plain path string as remote

`deck.ts:556-558`:
```
const local = typeof source !== "string" || /^(blob:|file:)/i.test(source);
```
A `File` object or a `blob:`/`file:` URL takes the PCM path; **any other string**,
including a filesystem path, takes the media-element path. Since the library
supplies `File` objects (`app.ts:2388-2389`), this is correct in practice — but
"local files use PCM" is really "local files *delivered as File/blob:/file:* use
PCM". Worth stating in GROUND_TRUTH so nobody assumes a path-based loader would
get PCM. Tier: **SOURCE**.

### N-6. The smoke harness reports success-shaped output and then hangs

`SMOKE_TIMEOUT` after a complete `SMOKE_RESULT` (BASELINE.md §5.2). Any script
that treats a clean exit as the gate will misread this. Tier: **INTEGRATION**.

### N-7. `.gitignore` carries a UTF-8 BOM

`.gitignore` begins with `\uFEFF` before `node_modules/`. Harmless on most
toolchains, but it means the first pattern is `\uFEFFnode_modules/` for tools
that do not strip the BOM. Not worth a fix; worth knowing if a file ever fails to
be ignored. Tier: **SOURCE**.

---

## Summary table

| # | Topic | Settled by | Verdict |
| --- | --- | --- | --- |
| 01 | Test counts | test run | **190/190**; REPORT and RESUME wrong |
| 02 | Pad modes | `pad-modes.ts:3-14` | D23/REPORT right; README wrong (6/10) |
| 03 | FX | `fx.ts:25-41` + `deck.ts:334-` | all three docs wrong; 12 reachable |
| 04 | Latency | D18 + `pcm-source.ts:419` | README measures a different quantity |
| 05 | Loop wrap | `pcm-source.ts:653-661` | engine.md right; README `<1 sample` false for live path |
| 06 | Stems | D24 | offline only; README says real-time |
| 07 | Serato | `serato-files.ts:391` | narrow opt-in write; README overstates |
| 08 | Rust | D22 + Tauri command list | not on live path; README implies it is |
| 09 | Sampler | `sampler.ts:1-49` | no user samples; README wrong |
| 10 | Streaming | `app.ts:347-396` | iframe + capture; README overstates; `[verify]` |
| 11 | Shell | `package-win.mjs` + IPC lists | **Electron is the product** |
| 12 | Naming | D12 | "Serato-style" heading must go |
| 13 | Docs hygiene | `decisions.md:349,420` | reorder + reformat D32 |
| 14 | Phase naming | manifest A4 | `m<N>:` commits; no bare "phase" |
| 15 | Two status docs | `README.md:107` | designate one; parity matrix is the candidate |
| 16 | Zero telemetry | grep | true; disclose the 3 egress paths |
| 17 | RTMP | `main.ts:248-317` | exists, untested, undocumented |
| 18 | Hardware count | counted | **195 = 195 = 195**; D31 backed |
| 19 | LFS | `.gitattributes` | no LFS; ~30 MB of blobs; no rewrite |
| 20 | Version | `git describe` | tag = package.json, but 14 commits ahead |
| 21 | Screenshots | `README.md:10-19` | relative paths, not raw URLs; not reproducible |
| 22 | "Verified" | `decisions.md:349-362` | 6 open `[verify]` under shipped features |
| 23 | Artefact paths | `.gitignore` + `package-win.mjs` | three paths, three different things |
| 24 | Headline claims | code + D6/D22 | substantially true; qualifiers missing |
| 25 | Link absent | `9035f2c` | confirmed at baseline; added later as new scope |
| 26 | Link licence | — | `[verify]`; D34 must verify, not assert |
| 27 | Tempo authority | `sync.ts` + `app.ts:1113` | **no authority exists**; sync is a one-shot A↔B copy |
| 28 | Link on mobile | — | `[verify]`; divergence, not bug |

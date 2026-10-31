# Checkpoint — Run 1 complete

Written at the end of Run 1, per the ModDeck MANIFEST. Stop conditions did not
fire: the baseline had no failures that blocked M1 (the one pre-existing
`smoke:audio` failure was fixed, not worked around), M2 did not invalidate a D36
option, and D34 concluded that no licence-compatible *Ableton* Link route exists
— but it concluded that as a licence finding with a working in-tree alternative,
not as a dead end, so work continued.

---

## Final gate results

| Gate | Result | Exit |
|---|---|---|
| `npx tsc --noEmit` | clean | 0 |
| `node scripts/build.mjs` | clean | 0 |
| `node --test test/*.test.ts` | 190 pass, 0 fail | 0 |
| `npm run smoke:audio` | `ok:true`, `fxOffGainDb:0`, `bandWorstDb:0`, `startupMs:45` | 0 |
| `npm run smoke:link` | `ok:true`, 8/8 checks pass, convergence 128 BPM | 0 |
| `npm run smoke:ui` | `ok:true`, 0 renderer errors, title "OpenDecks" | 0 |

---

## Top five risks, in order

1. **The shipped artifact and the product disagree.** `OpenDeck.exe` and
   `bin/opendeck-app.exe` are byte-identical Tauri binaries (SHA-1
   `bcea4322…`, 12,910,080 B), and `OpenDeck-win64.zip` contains that same
   binary. The README presents two shells as equals. D38 resolves it — Electron
   is the product, Tauri is a harness — but nothing has shipped on that decision
   yet. Until it ships, the download is the shell with the fewest features.

2. **The audio path was measurably broken and nothing tested it.** Four defects,
   three of them in the fixed part of the graph, survived 190 unit tests because
   the suite tests the transport state machine and never measures a transfer
   function. `smoke:audio` now asserts `fxOffGainDb` and `bandWorstDb`; that gate
   is the only thing standing between this and a silent re-regression.

3. **Link is not Ableton Link.** D34 established that every wire-compatible
   implementation is GPL and that the wire format is published nowhere else, so a
   clean-room compatible build is not derivable from public documentation. What
   ships is `opendeck-link/1`, honest about `abletonCompatible: false`. Anyone
   expecting to sync with a Live set will be disappointed, and the ADR is the
   only place that says so loudly enough.

4. **Nothing hardware-facing was exercised.** DVS, MIDI, audio interfaces and
   Serato writes are all DEVICE-tier claims backed by UNIT tests. Defect 3 lived
   in the DVS drive path and would have presented as a deck going silent
   mid-set — which is exactly the failure mode a unit test cannot catch.

5. **Stems cannot run from a fresh clone.** The 166 MB ONNX model is not in the
   tree and there is no fetch step. The UI offers separation; a new user gets an
   error. This is a packaging gap, not a code gap, and it is the cheapest of the
   five to fix.

## What m0–m3 changed

- **m0.** Baseline captured before any edit: `tsc` clean, 190/190 tests, build
  clean, `smoke:audio` failing. 28 A3 rows adjudicated with file:line citations
  plus seven new findings (`docs/baseline/CONTRADICTIONS.md`). The memory model
  separates exact arithmetic from measured desktop overhead.
- **m1.** Four audio defects found, measured and fixed; `smoke:audio` went from
  `ok:false` to `ok:true` and gained graph-level assertions. README's latency and
  loop-wrap claims replaced with measured values. `smoke:audio`'s own exit code
  was wrong (`ok:true` but exit 1 after a timeout) and is now correct.
- **m2.** `render_offline` characterisation tests added to the Rust crate; `cpal`
  output wired behind a default-off `native-output` feature per D21; D33 written.
  The probe is not the live path.
- **m3.** D34/D35 written before code. `src/main/link.ts` (Electron main,
  `node:dgram`) plus `src/renderer/engine/tempo-authority.ts`; `npm run
  smoke:link` proves two nodes converge on tempo/beat/phase in ~325 ms over
  multicast, that a pushed local tempo is observed by the peer, that disabling
  restores the pre-Link tempo, and that the transport playhead is unchanged.

## Revised order for what comes next

1. Ship the Electron bundle as the release artifact (D38) and stop publishing the
   Tauri binary as the download. Nothing else matters while the artifact and the
   product disagree.
2. A hardware pass on DVS and MIDI. Highest value per unit of risk: the code is
   frozen and only needs to be exercised.
3. Make stems runnable from a clone, or hide the feature.
4. Decide whether Ableton wire compatibility is worth the GPL consequence. That
   is a licensing decision, not an engineering one, and it is the only thing
   left in Link.
5. Mobile, per D36/D37 — and only after (1), because it decides what "the app"
   is.

---

## Files touched / estimated hours

**36 tracked files changed** (+650 insertions, −247 deletions), **17 new
untracked files**, **~8,400 lines of new documentation**.

| Phase | Files | Lines | Est. hours | Owner |
|---|---|---|---|---|
| M0 baseline | `docs/baseline/*.md` (5 files) | ~2,100 | 2.5 | baseline-m0 |
| M1 audio fixes | `deck.ts`, `pcm-source.ts`, `stem-bands.ts`, `fx-shell.ts`, `audio-smoke-entry.ts`, `audio-smoke.mjs` | ~+350 | 4.0 | lead |
| M1 rename | 30 files across `src/`, `renderer/`, `rust/`, `packaging/`, `docs/`, `scripts/`, `test/` | ~+200 | 1.0 | lead |
| M2 Rust probe | `render.rs`, `cpal_out.rs`, `play_probe.rs`, `Cargo.toml` (3 crates), ADR-D33, RUST-PROBE | ~+380 | 3.0 | rust-m2 |
| M3 Link | `link.ts`, `tempo-authority.ts`, `main.ts`, `preload.ts`, `app.ts`, `smoke-link.mjs`, `link-smoke-entry.ts`, ADR-D34/D35, LINK-PROBE | ~+1,100 | 3.5 | link-m3 |
| M4 mobile ADRs | ADR-D36, ADR-D37, ADR-D38, `parity-mobile.md` | ~+950 | 2.5 | adr-m4 |
| M5 integration | `CHECKPOINT.md`, `REPORT-RUN1.md`, `decisions.md` reorganised, `README.md`, `package.json`, `ui-smoke.mjs` | ~+420 | 1.5 | lead |
| **Total** | | | **~18** | |

Two agents (baseline-m0, rust-m2) hit a 429 rate limit at the very end of their
runs and could not send their final summary messages, but their file outputs were
already written to disk and are complete.

---

## Architecture at Run 1

**Playback path (TypeScript, Electron renderer).** `PcmSource` owns an
AudioWorklet (`OpenDecksPcmProcessor`) that drives `signalsmith-stretch` via an
atomic ring buffer. The stretch node is constructed and `prewarm()`ed at deck
construction so first-play latency is ~45 ms, not the ~1.3 s cold-start it was.
A `scheduleStretch()` wrapper sanitises `input: undefined` (which used to write
NaN into the time map) and drops `output` when `rate === 0` (which used to freeze
the worklet). `Deck` wires `PcmSource` → `buildStemBands` (4 transparent bands,
flat to 5e-7 dB) → `createFxShell` (dry+wet starts muted, not at unity) →
`VolumeMeter`/`Limiter`/`Analyser` → `MasterGain`.

**Tempo authority.** `TempoAuthority` in the renderer owns BPM, beat and phase.
`LinkNode` in the Electron main process speaks `opendeck-link/1` over multicast
UDP. Link can push local tempo to the session; disabling restores the pre-Link
local tempo. Link never touches a playhead.

**Rust probe (not the live path).** `opendeck-audio` has `render_offline` tests
(exact frame counts, loop wrap, reverse) and a default-off `cpal_out` behind the
`native-output` feature. It reached DEVICE tier on this machine (opened the
Realtek device at 48 kHz, advanced 95,808 frames in 2.0 s).

**Shell.** Electron is the product. Tauri is a dev/probe harness. The committed
`OpenDeck.exe` in the root zip is a Tauri binary that cannot do stems, Serato
writes or video — D38 documents the contradiction and the resolution.

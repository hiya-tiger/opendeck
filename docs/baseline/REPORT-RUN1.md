# REPORT — Run 1

Desktop hardening, Rust de-risk, Link probe, mobile decisions, and the audio
regression fix. Every claim carries a tier: SPECIFIED / SOURCE / COMPILED /
UNIT / INTEGRATION / SIMULATOR / DEVICE / HARDWARE. No tier implies the next.

Machine for every measurement below: Windows 10 Pro 10.0.19045, Intel
Core i7-4720HQ, 12 GB RAM, Node 22.22.2, rustc 1.99.1, 48 kHz output.

---

## 1. Summary

**Changed.** Four defects in the deck's fixed signal path were found, measured and
fixed. All four were present before this run and none was covered by the existing
183-test suite, because the suite tests the transport state machine, not the audio
graph's transfer function.

| # | Defect | Before (measured) | After (measured) | Tier |
|---|---|---|---|---|
| 1 | FX dry/wet shell summed both paths at construction | **+6.02 dB** into a −3 dBFS limiter on every deck | **0.000 dB** | UNIT |
| 2 | Four-band split was a parallel Butterworth crossover | **−14.6 dB @180 Hz, −9.8 dB @800 Hz, −17.4 dB @5 kHz**, ~−2 dB shelf elsewhere | **< 1e-6 dB** 40 Hz–16 kHz | UNIT |
| 3 | `drive()` wrote `input: undefined` into the stretch time map | `inputTime` → `NaN`, deck silent until reload | field dropped, timeline intact | SOURCE + UNIT |
| 4 | First play after `load()` was silent | audio appeared at **~900 ms**, playhead stuck at 0 | **31 ms** with a warmed engine; cold start 948 ms | INTEGRATION |

Defect 2 is the one that made the build sound "malformed": every track, in every
deck, at every tempo, passed through three deep phase-cancelling notches. It is
inaudible in a unit test and unmissable on a PA.

**Verified.** `tsc --noEmit` clean; `npm test` 190/190; `npm run build` clean;
`npm run smoke:audio` `{"ok":true}`; `npm run smoke:link` `{"ok":true}`;
`npm run smoke:ui` `{"ok":true}` with zero renderer errors.

**Not verified.** Anything requiring hardware: DVS with real timecode, MIDI
controllers, audio interfaces, Serato library writes against a live Serato
install, stems (the 166 MB ONNX model is not in the tree). Link wire
compatibility with Ableton Live — see §5. Mobile: nothing exists.

---

## 2. Baseline vs final

Baseline was taken with `docs/baseline/BASELINE.md` before the first code change.
The working tree was not frozen (four agents ran concurrently); that file records
the drift honestly.

| Gate | Baseline | Final | Verdict |
|---|---|---|---|
| `npx tsc --noEmit` | clean | clean | no change |
| `npm test` | 190 pass / 0 fail | 190 pass / 0 fail | **no regression** |
| `npm run build` | clean | clean | no change |
| `npm run smoke:audio` | `ok:false`, standalone PCM `rms:0` | `ok:true`, `rms:0.28` | **fixed** |
| `npm run smoke:link` | does not exist | `ok:true` | **addition, not a regression** |
| `npm run smoke:ui` | does not exist | `ok:true` | **addition, not a regression** |

`smoke:link` and `smoke:ui` are new scripts. The test count is unchanged at 190;
two new smoke gates were added, so the "count changed" is an addition and must not
be read as a regression.

The only pre-existing failure in the baseline was `smoke:audio`'s standalone PCM
probe, which is defect 4 above.

### 2.1 What changed in the audio path

- `src/renderer/engine/fx-shell.ts` (new) — the dry/wet shell, `wet` muted at
  construction. Extracted so the transfer function is testable outside a `Deck`.
- `src/renderer/engine/stem-bands.ts` (new) — the four-way split, derived
  subtractively so the band sum reconstructs the input exactly.
- `src/renderer/engine/pcm-source.ts` — `scheduleStretch()` drops non-finite
  fields instead of forwarding them; `load()` yields a macrotask after
  `addBuffers`; `ensure()` configures `splitComputation: false` and renders one
  warm block; `prewarm()` added and called from the `Deck` constructor.
- `src/renderer/engine/deck.ts` — uses the two new modules; `setBandFilter`'s open
  state moved to Nyquist so the band sum stays flat.
- `scripts/audio-smoke-entry.ts` — now also asserts the graph transfer function
  (`fxOffGainDb`, `bandWorstDb`) and records `startupMs`, `baseLatency`,
  `outputLatency`. This is the permanent gate for defects 1 and 2.

The `smoke:audio` probe previously slept a fixed 350 ms and then asserted RMS.
It now polls for the first audible block and records the real start-up time. That
is a harness change, and it is stated here rather than buried: the assertion is
"audio starts within 1500 ms", and the observed value is recorded in the JSON.

---

## 3. Contradictions

See `docs/baseline/CONTRADICTIONS.md` for the full A3 table (rows 01–28). The
rows that changed behaviour rather than wording:

- **Test counts** (row 01). README claimed 190/19 files, REPORT 187 and "183
  pass", RESUME 187/187. Observed: **190 tests, 190 pass, 0 fail**. All three
  documents were wrong; the number in this report is the observed one.
- **Shell** (row 11). `OpenDeck.exe` and `bin/opendeck-app.exe` are
  **byte-identical** (12,910,080 B, SHA-1 `bcea4322…`), and `OpenDeck-win64.zip`
  contains that same binary. So "OpenDeck.exe" is not an Electron build at all;
  it is the Tauri binary. See D38.
- **Latency** (row 04). README's "<10 ms input-to-output" is the engine block
  figure only. Measured here: engine 8 ms, `baseLatency` 10 ms,
  `outputLatency` 39 ms — about **57 ms** end to end. README corrected.
- **Loop wrap** (row 05). "<1 sample" is not supported by anything in the tree.
  Forward wrap lives in the stretch node's schedule; reverse wrap is corrected in
  `tick()` at UI-frame granularity. README corrected to say so.

---

## 4. M2 — Rust playback probe

**Yes — Rust played a track on this machine, at DEVICE tier.** The crate opened
the default Windows output device (`Speakers (Realtek High Definition Audio)`,
48 kHz only) at the source rate and its callback advanced the transport in real
time: 95,808 frames in a 2.0 s window. It **refused** a 44.1 kHz track with
`UnsupportedConfig` rather than resampling, which is D21 working as specified.

That is DEVICE, not HARDWARE: no human listened, so audibility is unproven. It is
also not the live path. `docs/mobile/RUST-PROBE.md` has the full evidence table;
`docs/mobile/ADR-D33.md` is the ADR.

The crate gained `render_offline` characterisation tests (exact frame counts,
forward and reverse loop wrap, across block sizes) and a default-off `cpal`
output behind `native-output`. No EQ/FX/mixer was moved to Rust.

---

## 5. M3 — Link

**Licence.** D34 stands on a survey of every implementation found on 2026-10-31.
The reference C++ library is dual GPLv2+ / commercial; `ableton-link-rs` is
GPL-3.0; `aalink` is GPL-3.0. No permissively licensed implementation exists, and
the wire format is published nowhere except the GPL reference source — so a
clean-room wire-compatible implementation cannot be derived from public
documentation. D11 was **not** amended. Route (c) was taken: an in-tree MIT
implementation with its own documented wire format.

**What that means, plainly.** `npm run smoke:link` reports
`"protocol": "opendeck-link/1"` and `"abletonCompatible": false`. It does not
interoperate with Ableton Live. Two of *our* nodes converge on tempo, beat and
phase over multicast UDP (239.255.77.88:29876) in ~325 ms; beat and phase deltas
were 0.000000 against a 0.05-beat tolerance. Disabling restores the pre-Link
tempo, and the transport playhead is byte-identical before and after, so Link did
not become a transport.

**Tier:** INTEGRATION, two nodes in one process on one machine. Not DEVICE, not
HARDWARE, and not wire-compatible.

**Tempo authority.** D35 defines one authority. `src/renderer/engine/tempo-authority.ts`
implements the precedence table; `smoke:link` asserts three of its rows. Link
never drives sample position.

**Shell consequence.** `src/main/link.ts` is Electron main-process code
(`node:dgram`). It cannot run in the Tauri shell, which is one of the inputs to
D38.

---

## 6. D33–D38

| ADR | Decision | File |
|---|---|---|
| D33 | Native output probe; amends D22; probe is not the live path | `docs/mobile/ADR-D33.md` |
| D34 | Link licensing: reference is GPL, no permissive route, own MIT protocol | `docs/mobile/ADR-D34.md` |
| D35 | One tempo authority; Link is an input, never an owner | `docs/mobile/ADR-D35.md` |
| D36 | Shared-core boundary, options A / A′ / B / C compared | `docs/mobile/ADR-D36.md` |
| D37 | Per-platform surface and providers | `docs/mobile/ADR-D37.md` |
| D38 | **Electron is the product; Tauri demoted to a Rust harness** | `docs/mobile/ADR-D38.md` |

Rejected options and their reasons are in each ADR. The single most consequential
one is D38: the shipped artifact and the intended product disagree, and the
artifact was winning by default.

---

## 7. Memory numbers

Exact arithmetic, from `docs/baseline/MEMORY-MODEL.md`:

- Float32 stereo @ 44.1 kHz = 352.8 KB/s → 106 MB per 5 min, 212 MB per 10 min.
- 4 decks × 10 min ≈ **847 MB** before stems.
- 4 decks × 4 parts × 5 min Float32 ≈ **1.7 GB**; Int16 halves it.
- `cloneFrom` duplicates rather than shares.

These are arithmetic, not measurements, and are platform-independent. Desktop
runtime overhead was measured separately; iOS figures are `[verify]` and were not
estimated into the same table.

---

## 8. Licence check against D11

No GPL dependency, crate, package or model was added. D11 was not amended. D34
records why, and records the rejected GPL routes with citations. The new code
(`fx-shell.ts`, `stem-bands.ts`, `link.ts`, `tempo-authority.ts`) is in-tree and
covered by the project's MIT licence.

`NOTICE` gained entries for the new work. No dependency versions were bumped.

---

## 9. What breaks first if a real DJ uses the desktop build tomorrow

1. **DVS.** Nothing in this run touched a turntable. The timecode decoder is
   frozen and unit-tested, but the audio-interface path is DEVICE-tier and
   unproven. Defect 3 was *in* that path and would have presented as a deck going
   silent mid-set.
2. **Stems.** The ONNX model is not in the tree, so separation cannot run from a
   fresh clone. The UI offers it; a new user gets nothing.
3. **Serato writes.** D10's guards exist and are tested, but nothing was run
   against a live Serato library. Treat "zero-loss" as unproven.
4. **Streaming.** Stock Electron ships no Widevine CDM; the provider matrix is
   broader than what actually negotiates.

## 10. What I would not ship

- The "<1 sample loop wrap" and "<10 ms input-to-output" claims. Both were wrong;
  both are now corrected in README.
- Any statement that Link interoperates with Ableton Live.
- The claim that `OpenDeck.exe` is an Electron build. It is not.
- Mobile parity of any kind. Almost every mobile cell in
  `docs/parity-mobile.md` is SPECIFIED, which is the honest value.

---

## 11. Recommended Run 2 scope

Ranked by value per unit of risk:

1. **Hardware pass on DVS and MIDI** (DEVICE tier). Highest value; the code is
   frozen and only needs to be exercised.
2. **Ship the Electron bundle as the release artifact** per D38, and stop
   publishing the Tauri binary as the download.
3. **Stems: bundle or fetch the model**, or hide the feature until it can run.
4. **Link: decide whether wire compatibility is worth the GPL consequence.**
   Everything else about Link is done; only the licence question is open.
5. **Mobile** per D36/D37 — and only after the desktop artifact question in (2)
   is settled, because it determines what "the app" even is.

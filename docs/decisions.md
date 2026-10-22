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

**Decision:** Describe the four bands as filter bands, not stem separation:
"Four-band EQ (low / low-mid / high-mid / high) ... these are filter bands, not
source separation."

**Why:** The current implementation is a filter bank; calling it stem-style
overstates what it does and invites comparison with source-separation products.

**Revisit:** Only if real source separation is implemented.

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

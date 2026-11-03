# Hark decisions

Dated log of decisions Hark makes on the native Linux build (egui + Rust audio engine), branch `feat/linux-egui`.

## 2026-11-03 15:20 EST: scope, layout, where the code comes from

- Branch `feat/linux-egui` from `origin/fix/audio-regression` (c32f721: Nov 1 deck fixes, SLAB driver, Serato keyboard map D45). Own worktree. No other branch is touched; nothing in `src/`, `renderer/` or the Electron packaging changes. Windows and macOS stay on Electron.
- Cargo workspace in `linux/`: `od-core` (analysis, library parsers, beatgrid/sync/FX/mixer/pad maths, keymap, MIDI profiles, SLAB decoder, Link protocol, USB prompt policy, hashing), `od-audio` (engine), `od-stems` (stems), `od-app` (egui), `od-bench` (benchmarks).
- Reused from `experiment/mygo-rust-bench` (our own MIT code): the line-by-line Rust ports of `analyze.ts`/`fft.ts` (bit-identical numerics) and of the Serato / PDB / ANLZ parsers, plus the TS side of that benchmark harness (`bench/ts`, `bench/fixtures/gen.ts`, `bench/equivalence.mjs`). The old Tauri `rust/` crates are not used (their analysis is a different algorithm).
- Tables are not hand-copied: `linux/tools/export-ts.mjs` imports the TS modules (keymap, 194 MIDI device profiles, hardware catalogue) and writes JSON the Rust build embeds, plus test vectors. The Rust tests compare against those vectors: beatgrid, sync, FX maths, crossfader/fader curves, pad modes, every key chord x modifier x repeat x input-focus case, MIDI parse, device-name lookup, and the SLAB decoder over 7 680 messages. All 8 equivalence tests pass.
- JS regexes for device names run on `fancy-regex` (MIT) because some use look-arounds. `Number.toFixed` is ported (half away from zero on the exact binary value), since Rust's formatter rounds half to even and gave "-6.2%" where the app shows "-6.3%".
- Found while porting, not fixed (Electron untouched): `src/main/link.ts` compares a microsecond difference against `PEER_TTL_MS` (2000), so the TS node forgets peers after 2 ms instead of 2 s (peer count flickers to 0 between heartbeats). The Rust node keeps peers for 2 s. Wire format is unchanged.
- Licence rule: permissive only. Not used: symphonia (MPL-2.0), ffmpeg (LGPL/GPL), xwax-derived timecode tables, Ableton SDK, yt-dlp, anything from OpenDecks Unleashed.

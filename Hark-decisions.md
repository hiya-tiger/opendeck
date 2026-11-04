# Hark decisions

Dated log of decisions Hark makes on the Rust-native OpenDecks benchmark, branch
`experiment/rust-native-bench` (from `origin/fix/audio-regression` c32f721). Results and
method: `docs/benchmarks/rust-native.md`.

## 2026-11-04 15:05 EST: scope and starting point

- Donovan cancelled the MyGo + Rust plan the same day. Nothing on `feat/mygo-rust` or
  `experiment/mygo-rust-bench` is continued, and no other branch or checkout is touched.
- New worktree `work/wt-rust-native`, new branch `experiment/rust-native-bench`. All prototype
  code is under `native/`; `src/`, `renderer/` and the Electron packaging are unchanged.
- Goal: benchmark a Rust-native stack that can ship under a custom, closed-source-capable
  licence. Licence rule: every dependency (transitive crates, C/C++ code built into crates,
  fonts, model weights) must be permissive and royalty-free. No GPL/LGPL/AGPL code linked or
  copied. No yt-dlp, xwax tables, Mixxx mapping files or scripts, or OpenDecks Unleashed code.
- Prototype crates were written fresh for this benchmark. None of the earlier `od-*` crates were
  copied, because the components measured here (decode, stretch/jog, DB, render, UI) aren't the
  ones those crates cover. That means the known `od-app` `library.rs:92` compile error
  (`PdbTrack` has no `path` field) is not inherited. It's still recorded in the report.

## 2026-11-04 15:30 EST: licence-driven choices

- **Symphonia is MPL-2.0**, not MIT/Apache. MPL-2.0 is file-level copyleft: a closed-source app
  may link it, but changes to Symphonia's own files must be published. Donovan named Symphonia,
  so I allowed MPL-2.0 for the `symphonia*` crates only, as named `cargo-deny` exceptions. This is
  flagged in the report so he can decide. Unmodified Symphonia carries no publishing duty
  beyond pointing to its source.
- Symphonia has no Opus decoder. Opus goes through libopus (BSD-3-Clause, built from source by
  `opusic-sys`) via `symphonia-adapter-libopus` (MIT/Apache). No ffmpeg anywhere.
- No separate "Signalsmith Scratch" library exists. Signalsmith Audio publishes Stretch, DSP,
  Basics and Linear. I used **Signalsmith Stretch** (MIT) through the `signalsmith-stretch`
  crate 0.1.3 (MIT, vendored C++).
- Stem models: I downloaded only the MIT `htdemucs.onnx` (fp32, sha256 68d0bf16…) and
  `htdemucs_fp16weights.onnx` (the shipping model, sha256 d05c269d…) from
  StemSplitio/htdemucs-onnx. I derived int8 and fp16 myself with ONNX Runtime 1.20.1's
  quantization tools (`native/stems/derive_models.py`). I didn't use HRSadeghi/demucs-onnx
  (its card says CC BY-NC weights). The shipping model is unchanged: report only.
- UI benchmark builds carry **no fonts**. egui's `default_fonts` (Ubuntu Font Licence + OFL)
  is turned off and no text is drawn. A shipping build needs a font picked under the licence rule.
- The UI toolkit comparison has its own Cargo workspace (`native/ui`). That keeps Slint's
  `GPL-3.0-only OR LicenseRef-Slint-*` expression out of the main licence gate.

## 2026-11-04 16:20 EST: findings recorded, not fixed here

- `src/main/link.ts` drops Link peers after 2 ms instead of 2 s: it compares a microsecond
  difference against `PEER_TTL_MS = 2000`. Recorded only.
- The Electron build can't decode AIFF (16/24-bit) or ALAC with `decodeAudioData` (measured on
  Linux), though the library accepts `.aif/.aiff`.
- Jog parity: the Electron build only has on-screen drag-to-scratch on the vinyl (it pauses
  the deck, drives `Platter` physics, seeks). It has no nudge/pitch-bend mode, no touch-top vs
  outer-ring distinction, no vinyl-mode toggle, and none of the 194 generated MIDI profiles binds
  a jog wheel. Those 194 profiles share two generic templates (the same note/CC numbers for every
  controller), so they aren't manufacturer mappings. `docs/hardware.md` says the Numark Party Mix III
  preset "follows the community Mixxx mapping". That contradicts its being clean-room and needs
  re-deriving from a capture.
- Linux audio: ALSA's user-space library (alsa-lib) is LGPL-2.1. CPAL's ALSA backend links it
  dynamically, and the same goes for JACK (libjack, LGPL) and PulseAudio (libpulse, LGPL). Under the
  hard rule ("no LGPL linked"), the Linux path needs PipeWire's native API (libpipewire, MIT)
  or a clean-room ALSA kernel-ioctl backend, unless Donovan allows dynamically linking
  OS-provided LGPL libraries. Tauri on Linux has the same problem (WebKitGTK and GTK are LGPL).

## 2026-11-04 16:30 EST: stop point (run 1)

- Pushed: prototype commit 2c66af8 (native/ workspace, fixtures, Electron baseline, stems derivation,
  UI mocks, deny.toml, CI workflow). CI run 41908439059 was still running at the stop. The licence job passed;
  the UI prototype build step failed on all three platforms, and stems SDR failed on Linux.
- Lost in a sandbox reset before commit, so these must be redone: fp16 derivation via ORT's own converter
  (the onnxconverter-common output doesn't load in ORT), per-variant SDR error handling, Symphonia gapless
  trimming, on-screen jog (screen_jog.rs) and the vinyl-mode check, MIDI unit tests, ui_measure.py watchdogs,
  workflow step timeouts (GNU timeout on macOS), docs/benchmarks/midi-provenance.md, native/tools/summarize_logs.py.
- Local sandbox results (2-core arm64, no audio device or GPU): Symphonia decodes 2-9x faster than Electron
  and handles AIFF and ALAC, which Electron fails on. SQLite: sort and update are far faster, import is about
  2.6x slower. Stretch costs 1-2% CPU per deck. Jog through Stretch is about 48 ms (too slow for scratch);
  the direct read head is 0.25 ms. Recommendation: Stretch for key lock and nudge, direct read head for scratch.
- Next run: redo the lost fixes, push, read both CI runs' logs, write docs/benchmarks/rust-native.md.
  Stems int8/fp16 speed and SDR, vello frame times and audio I/O are still unmeasured. No model switch made.

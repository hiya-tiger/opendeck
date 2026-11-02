# Hark decisions

Dated log of decisions Hark makes on the MyGo + Rust work for OpenDecks.

## 2026-11-02 14:40 EST: MyGo + Rust implementation not started

**Decision:** I didn't start the full MyGo + Rust + ONNX implementation (feat/mygo-rust).

**Why:** The go/no-go gate needs a PASS verdict from the midnight benchmark (Nov 2, 2026 00:00 EST). That verdict doesn't exist:

- `experiment/mygo-rust-bench` was never pushed to origin. When I checked at 14:40 EST, `git fetch` and the GitHub API both found no such branch.
- The local branch of that name has no new commits. It's still at 684f0d7, the tip of fix/audio-regression, and has no `docs/benchmarks/mygo-rust.md`, no `Hark-decisions.md` and no benchmark workflow.
- The scheduled benchmark run finished about 3 minutes after it started and recorded no result. No GitHub Actions runs for Windows, macOS or Flatpak Linux were produced.

So the verdict is missing. The bar is at least a 1.5x geometric-mean speedup on Windows, macOS and Flatpak Linux, no workload slower, stems no slower, no new underruns, and all smokes green. Under the gate rule, a missing verdict means I stop. I didn't change the Electron build.

**Next step:** Run the benchmark again: MyGo shell plus Rust core prototype against the current Electron build, on windows-latest, macos-latest and ubuntu-latest (Flatpak), with the results in `docs/benchmarks/mygo-rust.md`. Start the implementation only if that run records PASS.

## 2026-11-02 14:45 EST: benchmark re-run started

**Decision:** Re-running the MyGo + Rust benchmark on this branch (continuing `experiment/mygo-rust-bench`, based on `fix/audio-regression` 684f0d7). No prior Rust/Go setup existed from the midnight run, so the prototype starts from scratch under `bench/`.

**Verdict rule (fixed before any numbers exist):** PASS only if, on ALL of Windows (windows-latest), macOS (macos-latest, arm64) and Linux (ubuntu-latest, run as a Flatpak):
1. the geometric-mean speedup across analysis, library scan/import, hashing and cold start is at least 1.5x, and no single one of those workloads is slower than today;
2. the best stem path (plain ORT via the `ort` crate, or a tuned/alternative engine) is no more than 5% slower than today's onnxruntime-node path;
3. there are no new audio underruns vs Electron in the 5-minute 4-deck AudioWorklet run;
4. all smoke tests pass.
Any missing measurement counts as not passing. Numbers are reported per workload and never rounded up into a pass.

## 2026-11-02 15:20 EST: prototype built, CI benchmark running

**Decisions:**
- The prototype is benchmark-only and lives under `bench/`; `src/` is untouched. The existing `rust/` Tauri crates were not reused: their analysis is a different algorithm (spectral flux, not a port), so they couldn't give an output-equivalent comparison.
- The Rust analysis port keeps JavaScript's numerics exactly (f64 maths, f32 only where TS stores into a Float32Array, JS `Math.round`). Locally it is bit-identical to the TS on BPM, key, beat phase, confidences, peaks and bands, and the library scan's canonical output hashes match.
- Hashing uses `ring` (MIT/ISC-style licence), not `sha2`: `sha2` was 1.8x *slower* than Node on arm64 because it lacks the ARMv8 SHA path that OpenSSL/BoringSSL have. Comparing against a slow hash would have been unfair to Rust; comparing against a slow Node path would be unfair the other way, so both now use the same assembly.
- Stems in Rust load **the same onnxruntime 1.20.1 library** that onnxruntime-node ships (`ort` rc.9, `load-dynamic`): `ort`'s binary download was unreachable from the sandbox, and using the identical runtime isolates the host-language difference. Local check: chunk output bit-identical to onnxruntime-node (SDR = inf).
- The Rust thread pool is the same size as the app's analysis pool (`defaultPoolSize`), so the speedup is not just "more threads".
- Linux: today's Electron build and the prototype both run inside one Flatpak (GNOME 47 runtime, which carries the WebKitGTK 4.1 MyGo needs). Electron runs with `--no-sandbox` inside Flatpak (no zypak in this test package).
- Underrun metric: the app's own `PcmSource.underruns` plus AudioContext clock stalls, so the comparison uses the app's definition of an xrun.

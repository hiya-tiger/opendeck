# M0 baseline — OpenDecks

Recorded before the first code change of Run 1, per A4 ("Baseline BEFORE the first
code change. Pre-existing failures are never regressions.").

Everything below is pasted from the shell. Where a log is long, the elision is
marked and the elided part is TAP `ok`/`not ok` lines only — no counts are
invented or copied from `README.md`, `REPORT.md` or `RESUME.md`.

## 0. Machine and toolchain

| Item | Value | Command |
| --- | --- | --- |
| OS | Windows 10 Pro 10.0.19045.7807 (x86_64) | `cmd /c ver` |
| Shell kernel | `MINGW64_NT-10.0-19045 Donie 3.6.9-b4195d69.x86_64 2026-06-06 17:49 UTC x86_64 Msys` | `uname -a` |
| node | `v22.22.2` | `node -v` |
| npm | `10.9.7` | `npm -v` |
| cargo | `cargo 1.99.1 (5f94df478 2026-08-27)` | `cargo -V` |
| rustc | `rustc 1.99.1 (58cf8f9c3 2026-10-13)` | `rustc -V` |
| Electron (dev dep) | `44.8.0` | `package.json:17` |

`npm ci` was **not** run: `node_modules` was already installed and the M0 brief
forbids re-installing. This is a documented deviation from the M0 text, not a
skipped verification — every command that depends on `node_modules` was run.

Tier for all of the above: **SOURCE** (observed on this machine).

## 1. Repository state at the start of M0

```
$ git branch --show-current
main

$ git log --oneline | wc -l
40

$ git describe --tags
v0.1.6-14-g9035f2c
```

```
$ git status --porcelain
 M src/renderer/engine/deck.ts
 M src/renderer/engine/pcm-source.ts
?? scripts/audio-characterize-entry.ts
?? scripts/audio-characterize.mjs
?? scripts/audio-diag-entry.ts
?? scripts/audio-diag.mjs
?? scripts/audio-diag2-entry.ts
?? scripts/audio-diag2.mjs
?? scripts/audio-diag3-entry.ts
?? scripts/audio-diag3.mjs
?? src/renderer/engine/fx-shell.ts
?? src/renderer/engine/stem-bands.ts
```

**Important caveat, recorded honestly.** The working tree was not frozen while
this baseline ran: three agents were editing it concurrently. By the time the
last command in this file ran, `git status --porcelain` had grown to:

```
 M rust/crates/opendeck-audio/Cargo.toml
 M rust/crates/opendeck-audio/src/cpal_out.rs
 M rust/crates/opendeck-audio/src/lib.rs
 M rust/crates/opendeck-audio/src/render.rs
 M scripts/audio-smoke-entry.ts
 M src/main/main.ts
 M src/preload/preload.ts
 M src/renderer/engine/deck.ts
 M src/renderer/engine/pcm-source.ts
?? docs/mobile/
?? rust/crates/opendeck-audio/examples/
?? scripts/audio-characterize-entry.ts
?? scripts/audio-characterize.mjs
?? scripts/audio-diag-entry.ts
?? scripts/audio-diag.mjs
?? scripts/audio-diag2-entry.ts
?? scripts/audio-diag2.mjs
?? scripts/audio-diag3-entry.ts
?? scripts/audio-diag3.mjs
?? scripts/audio-diag4-entry.ts
?? scripts/audio-diag4.mjs
?? scripts/audio-diag5-entry.ts
?? scripts/audio-diag5.mjs
?? scripts/link-smoke-entry.ts
?? scripts/smoke-link.mjs
?? src/main/link.ts
?? src/renderer/engine/fx-shell.ts
?? src/renderer/engine/stem-bands.ts
?? src/renderer/engine/tempo-authority.ts
```

Consequence: the TypeScript numbers below (test, tsc, build) are from the tree
as it stood at the start of M0. The Rust numbers are from the tree as it stood
when the Rust build finished, which already included M2 probe edits by another
agent. Both are labelled. Neither is a claim about the final state of Run 1.

## 2. TypeScript typecheck

```
$ npx tsc --noEmit
```

Output: **empty**. Exit code `0`. No errors.

Tier: **COMPILED**.

## 3. Node test suite

```
$ npm test
```

Command line, verbatim from `package.json:13`:

```
node --test test/defs.test.ts test/timecode.test.ts test/dvs.test.ts test/engine.test.ts test/streaming.test.ts test/artwork.test.ts test/midi.test.ts test/formats.test.ts test/pcm-transport.test.ts test/serato.test.ts test/serato-write.test.ts test/serato-extra.test.ts test/cue-store.test.ts test/library-ux.test.ts test/pad-modes.test.ts test/pcm-worklet.test.ts test/platter.test.ts test/parts.test.ts test/video-mixer.test.ts
```

Summary block, verbatim (the ~1,100 preceding lines are TAP `ok N - …` /
`# Subtest:` lines, elided here):

```
1..183
# tests 190
# suites 2
# pass 190
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 7612.9095
```

Observed, not copied:

- **190 tests, 190 pass, 0 fail, 0 skipped, 0 todo.**
- 183 top-level TAP test blocks; the difference is 7 nested `# Subtest:` entries
  counted in `# tests`.
- 19 test files (the 19 paths on the `node --test` line above).
- Elapsed 7.6 s.

Tier: **UNIT** (pure Node, no browser, no audio device).

## 4. Build

```
$ npm run build
> opendeck-desktop@0.1.6 build
> node scripts/build.mjs

built dist/main.cjs, dist/preload.cjs, renderer/app.js, renderer/dvs.js, renderer/analysis-worker.js
```

Exit code `0`.

Tier: **COMPILED**. A successful bundle proves the bundler resolved every
import; it proves nothing about runtime behaviour.

## 5. Headless Electron audio smoke test

```
$ npm run smoke:audio
> opendeck-desktop@0.1.6 smoke:audio
> node scripts/audio-smoke.mjs
```

Renderer output, verbatim:

```
RENDERER warning %cElectron Security Warning (Insecure Content-Security-Policy) font-weight: bold; This renderer process has either no Content Security
  Policy set or a policy with "unsafe-eval" enabled. This exposes users of
  this app to unnecessary security risks.

For more information and help, consult
https://electronjs.org/docs/tutorial/security.
This warning will not show up
once the app is packaged. @2 node:electron/js2c/sandbox_bundle
RENDERER error Uncaught  @69 blob:file:///423975c3-560c-4271-8b97-cb750e98ffbf
RENDERER error Uncaught  @69 blob:file:///0dd0d1d9-af8a-4930-8faf-b962b7703f4f
RENDERER error Uncaught  @69 blob:file:///529ee200-2499-43fc-bbd8-4b11b129067c
RENDERER error Uncaught  @69 blob:file:///89f6c309-e17f-4a5a-9722-ddc02f1e29b8
SMOKE_RESULT {"ok":false,"rms":0,"position":1,"loopPosition":0.7,"looped":true,"deckEngine":"pcm","deckRms":0.21159148385374282,"deckPosition":0.3253333333333333,"deckLoopPosition":0.5,"deckLatency":0.008,"deckPitch":true,"pitchShiftChecked":true,"censorChecked":true,"customFxChecked":true,"reversed":true,"deckPlaying":true,"stemParts":4,"stemRms":0.09166952186530522,"stemPosition":0.304,"stemScratch":true,"stemPlatterScratch":true,"stemPlaying":true,"stemEngine":"pcm","videoSyncChecked":true}
SMOKE_TIMEOUT
```

### 5.1 `SMOKE_RESULT`, field by field

| Field | Value | Reading |
| --- | --- | --- |
| `ok` | `false` | **Pre-existing failure.** Overall gate is red. |
| `rms` | `0` | The standalone `PcmSource` probe produced silence. This is the failure behind `ok:false`. |
| `position` | `1` | Probe transport advanced to 1 s. |
| `loopPosition` / `looped` | `0.7` / `true` | Probe loop wrapped. |
| `deckEngine` | `"pcm"` | Deck took the PCM path. |
| `deckRms` | `0.2116` | **Non-zero** — the full `Deck` path does produce audio. |
| `deckPosition` / `deckLoopPosition` | `0.3253` / `0.5` | Deck transport and loop advanced. |
| `deckLatency` | `0.008` | 8 ms — this is the `blockMs: 8` engine figure from D18, not device latency. |
| `deckPitch`, `pitchShiftChecked`, `censorChecked`, `customFxChecked`, `reversed`, `deckPlaying` | all `true` | Deck-level features reported as exercised. |
| `stemParts` / `stemRms` / `stemPosition` | `4` / `0.0917` / `0.304` | Four stem voices produced audio. |
| `stemScratch`, `stemPlatterScratch`, `stemPlaying`, `stemEngine` | `true`, `true`, `true`, `"pcm"` | Stem voices on the PCM path. |
| `videoSyncChecked` | `true` | Video transport lock exercised. |

Interpretation, stated narrowly: **the standalone `PcmSource` probe is silent
while the `Deck`-level PCM path is audible in the same process.** That is a
contradiction inside one run and is the reason `ok` is `false`. I did not
diagnose it and did not change anything; the M0 brief assigns the fix to
team-lead. Recorded as a pre-existing failure per A4.

### 5.2 `SMOKE_TIMEOUT` — the process does not exit

`SMOKE_TIMEOUT` is printed *after* a valid `SMOKE_RESULT`. The smoke harness
therefore reports its result and then hangs instead of exiting, and the shell
only returns because the harness kills it. Consequences for later phases:

- `npm run smoke:audio` cannot be used as a bare `&&` gate in a CI-style chain
  without an external timeout.
- M3's acceptance criterion "`npm run smoke:audio` output is unchanged from
  baseline" must compare the `SMOKE_RESULT` line, not the exit code or the
  trailing `SMOKE_TIMEOUT`.

The four `RENDERER error Uncaught` lines are separate and are also pre-existing.

Tier: **INTEGRATION** (real Electron, real AudioContext, no audio device
assertion and no human listening). It is not DEVICE tier: nothing was heard.

## 6. Rust workspace

<!--CARGO-->

## 7. UDP multicast availability (gates M3)

The M3 Ableton Link smoke test needs multicast UDP on loopback. Two probes, both
run on this machine with `node` `v22.22.2`, no privileges, inside the sandbox.

Probe A — one receiver joined on `127.0.0.1`, one sender:

```
MCAST_RESULT {"sent":1,"received":1,"ok":true,"error":null,"payload":"opendeck-m0-mcast-probe"}
```

Group `239.255.76.67`, port `41234`, `addMembership(GROUP, "127.0.0.1")`,
`setMulticastLoopback(true)`, `setMulticastTTL(1)`.

Probe B — **two** receivers on the same host and port, sender on the default
interface. This is the shape the two-Link-node smoke test needs:

```
MCAST2_RESULT {"interfaces":["vEthernet (Default Switch)=172.18.48.1","Wi-Fi=192.168.2.236","Loopback Pseudo-Interface 1=127.0.0.1","vEthernet (Wi-Fi)=172.26.128.1"],"perReceiver":[1,1],"ok":true,"error":null}
```

Group `239.255.76.68`, port `41235`, `reuseAddr: true`, `addMembership(GROUP)`
with no explicit interface (default route via `Wi-Fi=192.168.2.236`).

**Result: multicast UDP works in this sandbox.** Both of two co-located
receivers received the datagram. M3's two-node convergence test is therefore
runnable here and does **not** need to be skipped for network reasons.

Caveats, so this is not over-read:

- Two sockets in **one process** on **one host** is not two peers on a network.
  It proves the OS and sandbox permit the mechanism, not that Link's own socket
  configuration will bind.
- The probe does not test cross-host delivery, IGMP snooping on a managed switch,
  or Wi-Fi multicast reliability. Those stay `[verify]` for a two-machine test.
- iOS local-network permission (`NSLocalNetworkUsageDescription`, denial as a
  normal state) is a different question entirely and remains `[verify]`; see
  A3 row 28.

Tier: **INTEGRATION** for "this Windows 10 host, one process, loopback and Wi-Fi
interface". Nothing above that tier is claimed.

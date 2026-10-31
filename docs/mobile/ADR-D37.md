# D37: Per-platform surface and providers

**Status:** decision, Run 1 (m4). No mobile code exists. This record fixes *what
each device gets* and *which external services are refused*, so that Run 2's N1
skeleton is built once rather than renegotiated per phase.

**Evidence snapshot:** working tree at HEAD `9035f2c` plus uncommitted m1–m3 work,
read on 2026-10-30.

Depends on: D36 (boundary — this ADR assumes option C), D10 (write safety),
D11 (licence policy), D17 (streaming limitation), D24 (stems), D34/D35 (Link).

---

## Decision

1. **One universal binary, one Xcode target.** iPhone and iPad are size classes
   and idiom checks, not separate apps.
2. **The per-device feature set is the PLATFORM MATRIX, with three refusals
   added on top of it**: no in-deck streaming on mobile in v1 (§3); no in-place
   Serato writes from mobile in v1 (§4); and no DVS on iPadOS in v1, which is
   stricter than the matrix's "harder" because the frozen TypeScript decoder sits
   on the wrong side of the boundary (D36 §4). The matrix's own "no DVS on
   iPhone" stands unchanged.
3. **Stems are onnxruntime with the existing MIT ONNX weights**, not a Core ML
   conversion, on iPadOS only, offline only, opt-in, and Int16 on disk exactly as
   D24 writes them.
4. **Everything deferred stays deferred**: video, recording, broadcast, CloudKit,
   practice coach, watchOS.

---

## 1. Feature list per device

Source: the brief's PLATFORM MATRIX (Part C), plus the tier each row can reach at
the end of Run 1 — which is `SPECIFIED` for every mobile row, because no mobile
code exists.

| Capability | Desktop (today) | iPadOS | iPhone | Run 1 tier (mobile) |
|---|---|---|---|---|
| Decks | 4 (`DeckId` A–D, `mixer.ts`) | 4 | 2, 4 in landscape optional | SPECIFIED |
| Library | pane | pane + decks + mixer at regular width | full-screen push | SPECIFIED |
| Stems | yes, offline, Electron main (D24) | yes, offline, opt-in | off by default | SPECIFIED |
| DVS | yes (`src/dvs/transport.ts`, `src/timecode/decoder.ts`) | USB-C class-compliant input is possible, but harder: no HAL gain, no aggregate devices, limited rate control | no | **no (v1)** — refused; blocked by hardware *and* by D36 §4 (frozen TS decoder) |
| External video | 2nd window (`src/main/main.ts` `video:*`, `video-mixer.ts`) | extended display via `UIScene` | AirPlay mirror only | SPECIFIED — but video on mobile is **deferred entirely**, so this row is capability-only in Run 1 |
| MIDI | yes (`midi/midi.ts`, 195-entry catalogue) | BT + USB | BT | SPECIFIED |
| Link | yes, m3 (`src/main/link.ts`, D34/D35) | yes, N10 | yes, N10 | SPECIFIED; needs the Rust port from D36 §7 |
| Streaming | EME in a provider window (8 providers) | refused in v1 (§3) | refused in v1 (§3) | **DECIDED: not shipped** |
| Live Activity / Dynamic Island | n/a | `[verify]` ActivityKit availability on iPadOS | yes; Dynamic Island hardware varies | SPECIFIED |
| CoreHaptics | n/a | `[verify]` — most iPads have no haptic engine | yes | SPECIFIED |
| Recording | yes (`recording:save`) | deferred | deferred | deferred |
| Broadcast (RTMP/WHIP) | yes (`rtmp:*`, `broadcast/whip.ts`) | deferred | deferred | deferred |

Two things in that table are deliberate refusals rather than gaps, and both are
recorded as divergences rather than as unfinished work:

- **Bluetooth A2DP latency (~100–200 ms per the brief) is not beatmatchable.**
  This is a UI statement, not a code one: on iPhone, when the active route is
  Bluetooth, the app says so instead of pretending sync is usable.
- **44 pt touch targets vs 24 px desktop controls.** The desktop CSS
  (`renderer/styles.css`) is written for pointer density; the mobile surface does
  not inherit it.

## 2. One universal binary, not two targets

**Decision: one target, universal, `TARGETED_DEVICE_FAMILY = 1,2`.**

Why:

1. **The differences are layout, not code paths.** The matrix's iPad/iPhone
   deltas are deck count, pane arrangement and push-vs-pane navigation. Deck
   count is already data — `DeckId` widens to `"A" | "B" | "C" | "D"` (D30) and
   the mixer is a record keyed by it — so "2 decks" is a flag, not a build.
2. **iPad multitasking removes the reason for a phone-only build.** Under Stage
   Manager an iPad app runs at iPhone widths; if the layout cannot survive that,
   a separate iPhone target does not fix it, it hides it.
3. **Two targets double the review surface.** Two bundle ids, two provisioning
   profiles, two sets of entitlements, two privacy manifests, two TestFlight
   trains, and N12 has to state BUILD-READY / DISTRIBUTE-READY twice.
4. **Run 2's N1 already says "one target"**, and D15-style phase discipline says
   the skeleton is built once.

The honest cost of one target: **binary size**. A universal binary ships
iPad-only resources to phones. The mitigation is N12's on-demand resource tags,
not a second target — and the stem model (166 MB, D24) must never be bundled at
all; it stays a download with a SHA-256 check, exactly as on desktop.

## 3. Streaming: no in-deck streaming on mobile in v1

The desktop path is a provider window with EME (`src/renderer/streaming/drm.ts`,
`providers.ts`, and the `streaming:*` IPC in `src/main/main.ts`). The repo lists
eight providers:

`youtube-music`, `spotify`, `soundcloud`, `tidal`, `deezer`, `apple-music`,
`beatport`, `beatsource`.

For each, two questions decide whether it can be a *deck source* on mobile:

- **(a) does the SDK expose PCM** (or a decoded, unencrypted audio stream) that we
  may feed into the transport?
- **(b) do the provider's terms permit time-stretch, EQ, mixing and DJ use at
  all** — let alone on a phone?

Neither question can be answered from this repo, and neither may be assumed.

| Provider | EME schemes declared in `providers.ts` | Exposes PCM? | DJ use permitted? | Verdict |
|---|---|---|---|---|
| YouTube Music | widevine, clearkey | **unknown — `[verify]`**; the repo path is a media element in a provider window, not a sample feed | **unknown — `[verify]`** | refused in v1 |
| Spotify | widevine, playready, clearkey | **unknown — `[verify]`**; `providers.ts` itself describes the path as "Spotify Web Playback SDK (Widevine EME)", i.e. EME, not PCM | **unknown — `[verify]`** | refused in v1 |
| SoundCloud | widevine, clearkey | **unknown — `[verify]`** | **unknown — `[verify]`** | refused in v1 |
| TIDAL | widevine, fairplay, clearkey | **unknown — `[verify]`** | **unknown — `[verify]`** | refused in v1 |
| Deezer | widevine, clearkey | **unknown — `[verify]`** | **unknown — `[verify]`** | refused in v1 |
| Apple Music | fairplay, widevine, clearkey | **unknown — `[verify]`** | **unknown — `[verify]`** | refused in v1 |
| Beatport | widevine, clearkey | **unknown — `[verify]`** | **unknown — `[verify]`** (Beatport's own streaming product is a separate commercial thing; not assumed) | refused in v1 |
| Beatsource | widevine, clearkey | **unknown — `[verify]`** | **unknown — `[verify]`** | refused in v1 |

**Zero of eight pass, and zero of eight are known to fail.** That is the honest
state: not "no provider supports it", but "we have not verified one, and shipping
an unverified provider into a deck is how a DJ app gets a takedown".

Two further reasons the answer is the same even if a provider passes (a):

- **D17's limitation travels.** A media element cannot be reversed, stem-
  separated or scratched. A streamed deck on a phone would be a deck that cannot
  do three of the four things the app is for.
- **The DRM capability is a shell property, not ours.** Stock Electron ships no
  Widevine CDM, FairPlay is WebKit-only, PlayReady is Edge/Windows (A2). On iOS
  the only EME in a WKWebView is whatever Apple exposes `[verify]`. So "streaming
  works on mobile" would be a claim about Apple's CDM, not about OpenDecks.

**Decision: no in-deck streaming on mobile in v1.** Run 2's N11 ("one provider via
its SDK, labelled a degraded surface") is therefore **out of scope for v1** and
becomes a Run 3 candidate conditional on a written provider answer to (a) and (b).
This is a refusal, not a gap, and the parity scoreboard says so per provider.

## 4. Mobile writes to Serato: no, and the route explains why

**Decision: no in-place Serato writes from mobile in v1.** Mobile may read a
library and may write an *export bundle* to a user-chosen folder; the desktop
performs the write.

The reasoning is D10, not caution:

- D10 rule 1 is **"refuse to write while Serato is running"**. The check is
  `isSeratoRunning()` in `src/main/serato-files.ts:85`, which runs `tasklist` on
  Windows and `pgrep -fil "Serato DJ"` elsewhere. Both inspect **the local
  machine's process table**. From a phone there is no such check: the phone
  cannot see the laptop that owns the library. A phone write is therefore a write
  with D10's first rule unenforced.
- The physical argument — "the drive is unplugged from the laptop, so Serato
  cannot be writing to it" — is plausible and unverified. Serato may hold the
  volume open, may be mid-export, or may be running from a cached library. It is
  not a check, so it does not satisfy D10.

**What mobile can do, and the filesystem route:**

- **Read.** `UIDocumentPickerViewController` (or the Files provider) grants a
  security-scoped bookmark to a user-chosen folder. Reading `.crate`,
  `database V2`, `Serato Markers_`/`Markers2`/`BeatGrid` is a read of files the
  user pointed at — no D10 exposure.
- **Write an export bundle.** The same bookmark, write mode, to a folder the user
  picks (`OpenDecks Export/`), containing `Subcrates/*.crate`, `database V2` and
  `neworder.pref` (D8). No file inside `_Serato_/` is touched. The desktop's
  existing import path consumes it.
- **`[verify]` the route itself:** whether iOS/iPadOS can mount an external
  volume that carries `_Serato_` and whether a security-scoped bookmark can reach
  a dot-directory inside it (the Files UI does not normally show `.Serato_`), and
  which filesystems such a volume may use. Until that is verified, even the read
  path is `[verify]`, and the export bundle is the only guaranteed route because
  it targets a normal, user-visible folder.

Consequence for the scoreboard: "Serato library import" is a mobile row with a
real tier only after Run 2's N4 (security-scoped bookmarks surviving cold launch).
"Serato library write" is `not doing this` on mobile.

## 5. Stems on device: onnxruntime, not Core ML

**Decision: onnxruntime with the same MIT `htdemucs_fp16weights.onnx` weights
(`src/main/separation.ts` `MODEL`, 165,612,636 B, SHA-256 pinned), offline only,
iPadOS only, opt-in, Int16 on disk per D24.**

Why not just "the desktop path, smaller":

- **`onnxruntime-node` does not run on iOS.** It is a Node native addon
  (`import * as ort from "onnxruntime-node"` at `src/main/separation.ts:7`).
  There is no Node runtime inside an App Store app, and no `node:` modules in the
  mobile boundary D36 chose. **"Proven on desktop" does not transfer**: the
  desktop measurement (~8 s inference per 7.8 s chunk, D24) is a desktop CPU
  number and is **not** an iOS number. It must not appear in an iOS budget.
- **The iOS-capable package is a different artefact.** onnxruntime ships
  iOS/macOS builds under the same project; the packages this ADR believes exist
  are an Objective-C wrapper and a C/C++ static library, distributed for
  CocoaPods/SPM — **`[verify]` the exact package name, the licence file it
  carries, whether it ships an XCFramework, and whether it accepts the fp16 ONNX
  graph as-is.** The desktop dependency's MIT licence (`NOTICE`) does not by
  itself establish the iOS package's licence; that must be read, not assumed
  (D11).
- **Core ML is a conversion, not a dependency swap.** Converting ONNX →
  Core ML needs `coremltools` (**`[verify]` its licence and version**) and the
  htdemucs graph must convert with acceptable numerics. Risks: unsupported ops
  (`[verify]`), fp16 accuracy drift (`[verify]`), and a **different cache key** —
  D24 keys the stem cache on `SHA-256(source bytes) + model version`, so a
  converted model is a new version and every previously separated track
  re-separates. Core ML may be faster on the Neural Engine, but that is a
  performance claim with no measurement behind it here.

Cost of the chosen route, stated as arithmetic rather than as a promise:

- **Weights:** 165,612,636 B = 157.9 MiB on disk, downloaded on demand, never
  bundled. Resident cost once loaded is **unknown — `[verify]`**; measure it.
- **Stem cache per deck, Int16, 5 minutes:** `44,100 × 2 ch × 2 B = 176,400 B/s`,
  `× 300 s = 52,920,000 B` per part, `× 4 parts = 211,680,000 B = 201.9 MiB`.
  Ten minutes doubles that to **423,360,000 B = 403.7 MiB** per deck.
- **That cache is on disk**, memory-mapped per D24's format; the resident portion
  is what the deck is playing, not the whole file — `[verify]` on device with
  `phys_footprint`.

**Why iPadOS only, opt-in, off by default on iPhone:** the matrix says so, and the
arithmetic supports it — one 5-minute stem set is 201.9 MiB of cache plus a
157.9 MiB model plus decoded audio, before any UI. On a phone that is the whole
budget for one track.

## Rejected options

- **Two targets (iPhone + iPad).** Rejected: §2. The deltas are layout and a deck
  count that is already a runtime value.
- **Shipping one streaming provider in v1 to have "a" streaming story.** Rejected:
  no provider has a verified PCM path or a verified DJ-use permission, and a
  media-element deck cannot be reversed, stem-separated or scratched (D17). A
  provider that only plays forward is not a deck.
- **Writing Serato files from mobile "because the drive is detached".** Rejected:
  D10 rule 1 becomes unenforceable, and the check that exists
  (`serato-files.ts:85`) is machine-local by construction.
- **Core ML as the primary stems runtime.** Rejected as primary because it is a
  model conversion with unverified op coverage and a cache-key change; retained
  as a measured optimisation after N8.
- **Bundling the stem model in the app.** Rejected: 157.9 MiB against App Store
  size limits and against D24's download-with-digest design.
- **A separate "mobile-lite" feature set that quietly drops the mixer.** Rejected:
  the matrix is the feature set; divergences are listed, not improvised.

## Revisit

- **If any provider gives a written answer that it exposes PCM and permits DJ
  use**, N11 comes back into scope for that provider alone, and the parity
  scoreboard gets one non-`SPECIFIED` mobile cell.
- **If the `[verify]` Serato volume/bookmark route passes**, mobile read of a
  Serato library becomes a real row. Writes still need a D10 answer that does not
  depend on the phone seeing the laptop's process table.
- **If onnxruntime's iOS package turns out to be GPL or unavailable**, stems on
  device moves to Core ML or is dropped; D11 is not negotiable for linked code.
- **If Run 2's N8 measures stem separation on device at more than a few minutes
  per track**, the honest response is a progress-aware queue and an explicit
  "this will take a while" UI, or dropping on-device stems — not a smaller model
  with unmeasured quality.

## `[verify]` register raised by this ADR

1. PCM exposure and DJ-use permission, per provider (8 rows, §3).
2. Whether a WKWebView on iOS has any usable EME at all.
3. Whether iOS/iPadOS can mount an external volume carrying `_Serato_` and grant
   a security-scoped bookmark into a dot-directory.
4. onnxruntime's iOS package: exact name, licence, XCFramework, fp16 ONNX support.
5. `coremltools` licence/version and whether htdemucs converts with acceptable
   numerics.
6. Resident memory of the stem model and the memory-mapped Int16 cache on device.
7. `ActivityKit` availability on iPadOS.
8. Whether most iPads have a haptic engine (CoreHaptics row).

# D38: Shell — Electron is the product, Tauri is demoted to a Rust harness

**Status:** decision, Run 1 (m4). This gates M2's probe target, D36 option A′, and
the README's dual-shell claim.

**Evidence snapshot:** working tree at HEAD `9035f2c` plus uncommitted m1–m3 work,
read on 2026-10-30.

---

## Decision

**Electron is the product shell. Tauri is demoted to a development and
verification artifact: the host for the Rust analysis path and for Rust probes,
not a shipping target.**

Concretely:

1. `npm run package:win` and the release artifact are Electron. The committed
   `OpenDeck.exe` / `bin/opendeck-app.exe` are the **Tauri** binary and must be
   re-labelled or dropped from release assets (not deleted from the tree — A4);
   they must not be the download.
2. **The Rust crates stay.** `opendeck-audio`, `opendeck-core` and the Tauri
   command surface remain in-tree as the portable core and as the probe host. The
   crates are not demoted; the *shell* is.
3. **M2's probe target is therefore the N-API addon loaded in the Electron
   process**, per M2's own conditional, with Electron's COOP/COEP requirement
   recorded as the delta against the Tauri route.
4. **The m3 Link implementation survives unchanged** (`src/main/link.ts`,
   `node:dgram`, Electron main). This is the single strongest argument for the
   decision: under a Tauri product, 408 lines of tested Link code would have to
   be ported to Rust before it could run at all.

---

## 1. What each shell can actually do

The claim "Electron is feature-complete and Tauri is partial" is true, and the
repo says so in three places that agree with each other.

### Features that exist only in Electron

| Feature | Evidence | Consequence if Tauri ships |
|---|---|---|
| Stems / source separation | `src/main/separation.ts` (352 lines, `onnxruntime-node`); IPC `separation:status`, `install`, `cache`, `run`, `read` at `src/main/main.ts:319-348`; preload namespace `separation` at `src/preload/preload.ts:36-43` | `desktop?.separation` is `undefined` in Tauri (`renderer/tauri-bridge.js` defines no such namespace), so the whole Parts bar is dead. |
| Serato writes | `src/main/serato-files.ts`; IPC `serato:running`, `write-tags`, `export-library`, `apply-crate-columns`, `undo` at `src/main/main.ts:351-435`; preload namespace at `src/preload/preload.ts:44-55` | `desktop?.serato` is undefined; export and tag writes silently unavailable. |
| Video output window | IPC `video:open-output`, `close-output`, `fullscreen-output`, `status-output`, `sync-output` at `src/main/main.ts:438-512`; `src/renderer/engine/video-mixer.ts` (440 lines); `renderer/video-output.html` | `desktop?.video` is undefined; the second-window feature (D32) does not exist. |
| EME licence proxy | `streaming:license` at `src/main/main.ts:181-207`, fetching a licence URL through the provider's `persist:provider-*` session | Tauri's bridge exposes `streaming.login`, `open`, `status`, `logout` and `search` but **no licence call**, so a DRM playback path has no licence step. |
| Per-provider sessions | `session.fromPartition("persist:provider-…")` at `src/main/main.ts:82-83`, permission handlers at `:528-530` | Tauri uses one webview cookie jar per window (`window.cookies()` in `rust/crates/opendeck-app/src/main.rs`), no partition isolation. |
| Native path for a dropped file | `webUtils.getPathForFile` at `src/preload/preload.ts:34` | Not exposed; Tauri has no equivalent in the bridge. |

### Features that exist only in Tauri

| Feature | Evidence | Note |
|---|---|---|
| Rust decode for analysis (D22) | `analyze_file` / `analyze_bytes` / `analyze_bytes_raw` in `rust/crates/opendeck-app/src/main.rs`, calling `opendeck_audio::decode_file` | **This is Rust decode's only shipping consumer.** Electron analyses with TypeScript (`src/renderer/engine/analyze.ts`, 397 lines + `analysis-worker.ts`). |
| A Rust command host | `tauri::generate_handler![…]`, 17 commands | The only place where Rust is reachable from the UI today. |

### Duplicated in both

`rtmp_*` (`src/main/main.ts:248-316` vs `main.rs` `rtmp_available/start/chunk/stop`),
`streaming_search` (`main.ts:165-179` vs `main.rs` `streaming_search`),
`recording_save` (`main.ts:231-245` vs `main.rs` `recording_save`), and
`media_fetch` (`main.ts:209-229` vs `main.rs` `media_fetch`). Four feature
families implemented twice, in two languages, with no shared test.

**That is the maintenance cost, measured in code rather than asserted:** four
duplicated families, six Electron-only families, one Tauri-only family, and a
61-line bridge that must track a 79-line preload by hand.

## 2. The artifacts say Tauri; the feature set says Electron

This is the part that decides the question, and it is not what the README says.

```
$ sha1sum OpenDeck.exe bin/opendeck-app.exe
bcea432289c6dc9f947caac59aa7665065fe3dce *OpenDeck.exe
bcea432289c6dc9f947caac59aa7665065fe3dce *bin/opendeck-app.exe
```

- The two committed executables are **byte-identical** (12,910,080 B each).
- `OpenDeck-win64.zip` (4,236,301 B) contains that same 12,910,080 B `OpenDeck.exe`.
- So **the only executable the repo ships is the Tauri build**, and it is the one
  that cannot do stems, Serato writes, video output or EME licensing.

Meanwhile `scripts/package-win.mjs` builds the Electron bundle into
`release/OpenDecks-win32-x64/OpenDecks.exe`, then compiles a small `rustc` launcher
whose fallback order is: packaged Electron → `node_modules` Electron → **Tauri
`bin/opendeck-app.exe` last**. The launcher's own preference is Electron; the
committed binary is not the launcher (it is 12.9 MB, not a stripped stub), which
means `package:win` either has not been run since the launcher was added or its
`rustc` step failed and left the previous file in place — the script warns and
continues on failure (`package-win.mjs`, `catch` around the `rustc` call).

**Resolution:** the feature set decides which shell is the product (A1: source
tree + tests > README), and priority 1 of the brief is "desktop: harden, do not
regress". Shipping the Tauri binary as "OpenDecks" is a regression against D24 and
D32 by omission. Therefore Electron is the product and the committed binary is a
misleading artifact, to be replaced by a release asset built by `package:win`.

## 3. Why not the other direction

**Why not "Tauri is the product, Electron is the legacy dev shell".** It is
tempting: Tauri is 12.9 MB against an Electron bundle that stages a whole Chromium
runtime; it has a Rust host, which is where the mobile core is going (D36). But it
would require, in this order:

1. porting stems to Rust or an iOS-style ONNX runtime in the Tauri host,
2. porting `serato-files.ts` to Rust (the encoder is TypeScript, 2,534 lines of
   `serato*.ts`, and D7/D8/D9/D25 decisions live in it),
3. re-implementing the video output window,
4. porting the EME licence proxy,
5. **porting `src/main/link.ts` (408 lines) to Rust**, because there is no Node
   in a Tauri host,
6. accepting that the desktop app is now a different code path from the one every
   existing test and smoke run exercises.

That is a rewrite of the five feature families that took the longest to get
right, in exchange for binary size. It also contradicts the brief's own
instruction not to regress the desktop.

**Why not keep both as equals.** Because they are not equal, and the duplication
is already visible (§1). Two shells with four duplicated families and six
one-sided families is how a feature silently exists on one platform and not the
other — which is precisely the failure this whole Run is meant to prevent. One
shell, one set of guarantees.

## 4. DRM

DRM capability is a property of the shell and the platform, not of OpenDecks:

- **Stock Electron ships no Widevine CDM** (A2). The provider windows
  (`src/main/main.ts:107-145`) can navigate to a provider and the renderer can
  call `requestMediaKeySystemAccess` (`src/renderer/streaming/drm.ts:168`), but
  whether any key system is actually usable in a stock Electron build is
  **`[verify]`, per provider, per shell** — and it is already A3 row 10.
- **WebView2 has its own CDM story** and it is different from Electron's.
  `[verify]` — but note this no longer gates the decision, because streaming is
  refused on mobile in v1 (D37 §3) and the desktop streaming claim is already
  marked unverified.
- **FairPlay is WebKit-only.** On iOS that is the only DRM that could exist; on
  desktop it is irrelevant.

So the shell decision does **not** hinge on DRM. It hinges on the six
Electron-only feature families, and DRM is a separate open question that the
decision leaves exactly as unresolved as it found it — which is honest, and is
why the README's EME claim is a separate A3 row.

## 5. Entitlements, packaging, maintenance

- **Packaging.** Electron: `scripts/package-win.mjs` stages
  `node_modules/electron/dist` → `release/OpenDecks-win32-x64/`, renames
  `electron.exe` → `OpenDecks.exe`, and copies `package.json`, `dist`, `renderer`,
  `LICENSE`, `NOTICE`, `README.md` into `resources/app`. Tauri:
  `rust/crates/opendeck-app/tauri.conf.json` has `bundle.active: true`,
  `targets: "all"`, `frontendDist: "../../../renderer"`. Both work; only one is
  exercised by a script in the repo, and only one is committed.
- **Entitlements.** For macOS distribution, an Electron app needs a hardened
  runtime, an entitlements plist and notarisation, including entitlements for the
  Chromium helper processes; a Tauri app needs a plist for one native host.
  Neither is configured in this repo today (`[verify]` what each requires;
  nothing here has been signed). **For iOS, neither applies**: Electron has no
  iOS target, and a Tauri iOS app would be a third thing again. The mobile
  decision (D36) is therefore independent of this one.
- **Maintenance.** §1: four duplicated families, six one-sided, one bridge kept
  in sync by hand. Demoting Tauri removes the obligation to keep the bridge at
  parity, and converts "Tauri is missing features" from a bug into a documented
  scope.

## 6. What survives the decision

| Thing | Survives? | How |
|---|---|---|
| M2 probe target | **Yes, changes form.** | Electron is the product ⇒ the probe is an N-API addon in the Electron process (M2's stated conditional). Delta to record: Electron needs COOP/COEP for the SharedArrayBuffer seam; Tauri would not have needed it on Windows. |
| Rust decode's only shipping consumer | **No.** | `analyze_file` reaches users only through the Tauri build. After demotion, Rust decode is exercised by `cargo test` and by the M2 probe, not by the shipped app, until the N-API addon lands. This is a real loss and must be said in REPORT-RUN1. |
| M3 Link route | **Yes, unchanged.** | `src/main/link.ts` is Electron main + `node:dgram`. Under a Tauri product it would need a Rust port before it could run. |
| Rust crates as the mobile core | **Yes.** | D36 option C consumes `opendeck-audio` from the iOS host; the crates are unaffected by which desktop shell ships. |
| D36 option A′ (Tauri iOS) | **Weakened, not removed.** | A′ would be a second shell on a platform the desktop never runs. It stays second-ranked, which is what D36 already says. |
| README's dual-shell claim | **Must change.** | `README.md:3` presents "an Electron shell or a native Rust/Tauri shell (`OpenDeck.exe` / `bin/opendeck-app.exe`)" as equals. It is one product and one harness. |

## Rejected options

- **Tauri as the product.** Rejected: §3 — it costs a Rust port of stems, Serato,
  video, EME licensing and Link, and it regresses the desktop, which priority 1
  forbids.
- **Both shells maintained as equals.** Rejected: §1 — the duplication is already
  four families wide and the bridge is already behind the preload.
- **Deleting the Tauri crate.** Rejected: it is the only Rust↔UI seam that
  exists, it is the harness the M2 probe can fall back to, and the brief forbids
  deleting committed artifacts.
- **Deleting the committed `.exe`/`.zip`.** Rejected: A4 says report their size
  and recommend release assets instead. Recommendation: `OpenDeck.exe`
  (12,910,080 B) and `OpenDeck-win64.zip` (4,236,301 B) move to release assets and
  out of the tree; until then they must be labelled as the Tauri harness build,
  not as the product.
- **Deciding the shell from the README.** Rejected: the README is the lowest
  precedence source (A1) and it is the only source that claims parity.

## Revisit

- **If the N-API probe (M2/D33) fails to load in Electron** — build flags, ABI,
  COOP/COEP — the probe falls back to a Tauri command and the shell question is
  reopened, because then Tauri is the only shell that can host Rust at all.
- **If the Electron bundle size becomes a distribution problem** (a DJ downloading
  a Chromium runtime to play four tracks), the answer is a measured comparison of
  the two bundles, not a re-litigation of the feature set.
- **If macOS distribution (Run 2's N1.1) makes Electron signing materially harder
  than a native host**, that is a new input and this decision is re-scored with
  the signing result in hand.
- **If the Tauri bridge ever reaches parity** — stems, Serato, video, EME licence
  — the demotion is worth revisiting, because at that point it is a real choice
  rather than a regression.

## `[verify]` register raised by this ADR

1. Whether stock Electron 44.8.0 negotiates any EME key system, per provider
   (already A3 row 10; unchanged by this decision).
2. What macOS hardened-runtime entitlements each shell needs for notarisation.
3. Whether the `rustc` launcher step in `scripts/package-win.mjs` currently
   succeeds on the build machine (the committed `OpenDeck.exe` is not its output).
4. Whether the committed `OpenDeck.exe` was built from the current
   `tauri.conf.json` (`version: "0.1.6"`) or an earlier tree — its timestamp is
   older than the launcher script.

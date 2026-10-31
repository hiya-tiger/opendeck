# Memory model

Two halves that must not be mixed.

- **Part A — decoded audio bytes.** Pure arithmetic. Exact, platform
  independent, reproducible with a calculator. This is the half that decides
  whether a WebView core can ever fit a phone.
- **Part B — runtime overhead.** Measured on this Windows desktop only. Every
  number is tagged with how it was obtained. iOS is `[verify]` and is **not**
  estimated from Part B.

Part A is not evidence about Part B, and Part B is not evidence about a phone.
Tiers: SPECIFIED / SOURCE / COMPILED / UNIT / INTEGRATION / SIMULATOR / DEVICE /
HARDWARE.

---

# Part A — decoded audio bytes (exact)

## A.0 The one constant

Float32 stereo at 44.1 kHz, one second:

```
44,100 frames/s × 2 channels × 4 bytes = 352,800 bytes/s
                                      = 352.8 kB/s   (decimal, 10³)
                                      = 336.3 KiB/s  (binary, 2¹⁰)
```

That is the "352.8 KB/s" figure in the brief, confirmed by multiplication.

`AudioBuffer` for a local file holds exactly this: two `Float32Array`s of
`frames` length, nothing else. `deck.ts:564` `ctx.decodeAudioData(data)` produces
it; `deck.ts:565` stores it in `this.pcmBuffer`. There is no compression, no
resampling at load (the decoded rate is the file's rate), and no chunking.
Tier: SOURCE.

All figures below assume 44.1 kHz stereo Float32 unless stated.

## A.1 Per-track cost

| Duration | Frames | Bytes | Decimal | Binary (MiB) |
| --- | --- | --- | --- | --- |
| 1 min | 2,646,000 | 10,584,000 | **10.58 MB** | 10.09 MiB |
| 3 min | 7,938,000 | 31,752,000 | **31.75 MB** | 30.28 MiB |
| 5 min | 13,230,000 | 105,840,000 | **105.84 MB** | 100.94 MiB |
| 7.8 min (the D24 chunk) | 20,638,800 | 165,110,400 | **165.11 MB** | 157.46 MiB |
| 10 min | 26,460,000 | 211,680,000 | **211.68 MB** | 201.87 MiB |

Arithmetic for the 5-minute case, written out once:

```
13,230,000 frames × 2 ch × 4 B = 105,840,000 B
105,840,000 / 1,000,000        = 105.84 MB
105,840,000 / 1,048,576        = 100.94 MiB
```

The brief's "~106 MB per 5 min, ~212 MB per 10 min" is **correct in decimal MB**.
In MiB it is 100.9 and 201.9. Use one unit consistently or the 5% difference will
be mistaken for a measurement error later.

## A.2 Four decks, one part each

| Duration per deck | 4 decks | Decimal | Binary (MiB) |
| --- | --- | --- | --- |
| 5 min | 4 × 105,840,000 | **423.36 MB** | 403.75 MiB |
| 10 min | 4 × 211,680,000 | **846.72 MB** | 807.50 MiB |

The brief's "4 decks × 10 min ≈ 847 MB" is correct (846.72 MB).

## A.3 Four decks, four stem parts each

Stems are four separate decoded buffers per track. D24 stores the *cache* as
interleaved Int16, but the deck **decodes them back to Float32 `AudioBuffer`s**
before playback — `deck.ts:139` `stemBuffers: Partial<Record<PartId, AudioBuffer>>`,
and each part gets its own `PcmSource` (`deck.ts:138`). So the in-RAM cost is
Float32, not Int16.

| Configuration | Arithmetic | Decimal | Binary (MiB) |
| --- | --- | --- | --- |
| 4 decks × 4 parts × 5 min | 16 × 105,840,000 | **1,693.44 MB ≈ 1.69 GB** | 1,615.0 MiB |
| 4 decks × 4 parts × 10 min | 16 × 211,680,000 | **3,386.88 MB ≈ 3.39 GB** | 3,230.0 MiB |

The brief's "4 decks × 4 parts × 5 min Float32 ≈ 1.7 GB" is correct (1.69 GB).

## A.4 Int16 halves it

```
Int16 stereo 44.1 kHz = 44,100 × 2 × 2 = 176,400 B/s = 176.4 kB/s
```

| Configuration | Float32 | Int16 | Saving |
| --- | --- | --- | --- |
| 1 track, 5 min | 105.84 MB | **52.92 MB** | 52.92 MB |
| 1 track, 10 min | 211.68 MB | **105.84 MB** | 105.84 MB |
| 4 decks, 10 min | 846.72 MB | **423.36 MB** | 423.36 MB |
| 4 decks × 4 parts, 5 min | 1,693.44 MB | **846.72 MB** | 846.72 MB |
| 4 decks × 4 parts, 10 min | 3,386.88 MB | **1,693.44 MB** | 1,693.44 MB |

Exactly 2×, because Int16 is 2 bytes against Float32's 4. That is the whole
argument for D24's Int16 cache — but note it applies to the **cache on disk**, not
to the decoded buffers in RAM, unless the playback path is changed to read
Int16 and convert per block. Today it does not. Tier: SOURCE.

## A.5 48 kHz, for comparison

| Configuration | Arithmetic | Decimal |
| --- | --- | --- |
| 1 track, 5 min | 48,000 × 2 × 4 × 300 | **115.20 MB** |
| 1 track, 10 min | 48,000 × 2 × 4 × 600 | **230.40 MB** |
| 4 decks, 10 min | 4 × 230,400,000 | **921.60 MB** |
| 4 decks × 4 parts, 5 min | 16 × 115,200,000 | **1,843.20 MB** |

44.1 kHz is the worst case per minute only if the file is 44.1 kHz; a 48 kHz
library costs 8.16% more. Both are common in practice.

## A.6 What actually multiplies the number

Four multipliers, each confirmed in code. These are the ones that make the
arithmetic above a floor rather than a total.

**(1) `cloneFrom` does NOT duplicate.** The brief's note "cloneFrom duplicates"
is **wrong for the current code**. `deck.ts:642`:

```
this.pcmBuffer = other.pcmBuffer;
```

That is a reference assignment to the same `AudioBuffer` object, and
`deck.ts:661-664` then hands that same object to `this.pcm.load(...)`. Instant
Doubles therefore costs **0 extra decoded bytes** on the JS side. D28's wording
("copies the decoded `AudioBuffer`") is a description of the *effect* (a second
deck plays the same audio without re-decoding), not of an allocation.
Tier: SOURCE.

**(2) Every loaded deck ALSO copies its channels into the AudioWorklet.**
`pcm-source.ts:466-472`:

```
const left  = buffer.getChannelData(0);
const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
await this.stretch.dropBuffers();
await this.stretch.addBuffers([left, right]);
```

`addBuffers` crosses into the worklet, so the worklet holds its own copy. Live
steady state for one 10-minute track is therefore **2 × 211.68 MB = 423.36 MB**,
not 211.68 MB.

Caveat, and it is a real one: I measured the *cost of a duplicate pair* (Part B,
+202.0 MB) but I did **not** measure what signalsmith-stretch retains internally.
It may resample, segment, or window its input, in which case the worklet-side
figure is smaller or larger than 2×. The 2× is **`[verify]`** — the mechanism is
SOURCE, the magnitude is not measured.

**(3) Stems multiply by four, and each part is also copied into a worklet.**
`deck.ts:138` creates one `PcmSource` per part; each calls `load()` →
`addBuffers`. So the stem figure in A.3 doubles again under the same `[verify]`
caveat.

**(4) `decodeAudioData` holds the compressed bytes transiently.** `deck.ts:562`
`const data = await response.arrayBuffer()` holds the whole file, and `:564`
decodes it while `data` is still live. Peak during load ≈ decoded + compressed.
A 10-minute 320 kbps MP3 is 24 MB, so the transient is small relative to the
decoded buffer — but it is not zero, and for a 10-minute lossless file it is
~100 MB. Tier: SOURCE.

## A.7 The number that decides the mobile question

For a phone core, the honest statement is:

- **One 5-minute stereo track, Float32, in RAM: 105.84 MB (exact).**
- **Four decks, 10 minutes each: 846.72 MB (exact), before any worklet copy.**
- **Four decks × four parts × 5 minutes: 1.69 GB (exact), before any worklet
  copy.**
- Every one of those is **before** the per-deck worklet copy in A.6(2), whose
  magnitude is `[verify]`.

Whether that fits a given device is a comparison against a **ceiling that is not
published** (Part C: "Jetsam ceilings are not published numbers. Treat any table
as estimates"). So this half of the document gives an exact numerator and no
denominator. Any claim of the form "option A fits / does not fit" is arithmetic
against an estimate and must be labelled as such.

---

# Part B — runtime overhead (measured on desktop)

All of this is **this machine, this Electron, this run**. None of it is an iOS
footprint and none of it may be quoted as one.

## B.1 Method

A throwaway Electron app in `/tmp/memprobe` (not in the repo), run against the
repo's own Electron binary so the version matches:

```
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe /tmp/memprobe
```

`ELECTRON_RUN_AS_NODE` must be unset or Electron starts as plain Node — the same
workaround `scripts/audio-smoke.mjs:53-55` uses.

The page:

1. takes a baseline snapshot of the renderer,
2. allocates `new OfflineAudioContext(2, 44100 × 300, 44100).createBuffer(...)`
   and fills both channels with deterministic noise (a real `AudioBuffer`, the
   same object type `decodeAudioData` returns),
3. takes a snapshot,
4. repeats for 600 s,
5. duplicates both channels of the 600 s buffer into two `Float32Array`s — which
   is the JS-side shape of what `addBuffers` sends — and takes a snapshot.

Snapshots read `app.getAppMetrics()` (per-process working set), plus
`process.memoryUsage()` in main and `performance.memory.usedJSHeapSize` in the
renderer. Window is offscreen and hidden. `app.disableHardwareAcceleration()`.

Environment: Electron `44.8.0`, Chrome `152.0.7977.167`, Node `24.22.0`,
Windows 10.0.19045.

## B.2 Raw output

```
{"electron":"44.8.0","chrome":"152.0.7977.167","steps":[
 {"label":"baseline","mainRssMB":95.3,"rendererWorkingSetMB":67,"rendererPeakWorkingSetMB":67},
 {"label":"after-5min-1deck","mainRssMB":99.2,"rendererWorkingSetMB":176.4,"rendererPeakWorkingSetMB":176.4},
 {"label":"after-10min-2decks","mainRssMB":99.2,"rendererWorkingSetMB":378.5,"rendererPeakWorkingSetMB":378.5},
 {"label":"after-worklet-copy-of-10min","mainRssMB":99.2,"rendererWorkingSetMB":580.5,"rendererPeakWorkingSetMB":580.5}],
 "rendererReport":{"samples":[
  {"label":"after-5min-1deck","frames":13230000,"arithmeticMB":100.9,"jsHeapBeforeMB":9.5,"jsHeapAfterMB":9.5,"allocMs":390.9},
  {"label":"after-10min-2decks","frames":26460000,"arithmeticMB":201.9,"jsHeapBeforeMB":9.5,"jsHeapAfterMB":9.5,"allocMs":666.4},
  {"label":"worklet-copy-10min","arithmeticMB":201.9,"jsHeapAfterMB":9.5}],
  "started":true,"done":true},
 "bootMs":2838}
```

## B.3 What it means

| Step | Renderer working set | Δ vs previous | Arithmetic for that step | Δ − arithmetic |
| --- | --- | --- | --- | --- |
| baseline (blank page, no audio) | 67.0 MB | — | — | — |
| + one 5-min stereo Float32 buffer | 176.4 MB | **+109.4 MB** | 100.94 MiB (105.84 MB) | +3.6 MiB (+8.5 MB) |
| + one 10-min stereo Float32 buffer | 378.5 MB | **+202.1 MB** | 201.87 MiB (211.68 MB) | +0.2 MiB (+0.4 MB) |
| + a duplicate pair of the 10-min channels | 580.5 MB | **+202.0 MB** | 201.87 MiB (211.68 MB) | +0.1 MiB |

Three conclusions, each earned:

1. **The backing store scales linearly with the arithmetic, and lands within
   ~0.1% of it** once the allocator is warm. The 5-minute step is 8.5 MB over
   arithmetic; the 10-minute step is 0.4 MB over. That is allocator slack and
   page rounding, not a hidden multiplier. Part A is therefore a good predictor
   of renderer working set **for decoded audio alone**.
2. **`performance.memory.usedJSHeapSize` is the wrong instrument and would have
   produced a fabricated answer.** It stayed flat at **9.5 MB** across all three
   steps while working set grew by 513 MB. `AudioBuffer` channel data lives
   outside the V8 JS heap. Anyone measuring this with `usedJSHeapSize` will
   conclude "audio is free", which is exactly wrong. This is why the method is
   documented rather than just the result.
3. **The baseline renderer is not free either: 67.0 MB idle.** An empty offscreen
   Electron renderer already costs 67 MB before a single sample is decoded. The
   main process adds 95.3 MB RSS, growing to 99.2 MB. So a minimal 4-deck,
   4×10-minute session is roughly `67 + 95 + 4 × 211.68` ≈ **1.01 GB of process
   memory** on this desktop, of which 847 MB is decoded audio.

## B.4 Allocation cost, not just size

| Step | Wall time |
| --- | --- |
| 13,230,000 frames × 2 ch, fill with noise | **390.9 ms** |
| 26,460,000 frames × 2 ch, fill with noise | **666.4 ms** |

This is a *synthetic fill*, not a decode, so it is a **lower bound** on the
observable stall of loading a 10-minute track into an `AudioBuffer`: allocating
and touching 212 MB takes ~0.67 s here. `decodeAudioData` on top of that is
unmeasured in this probe. Tier: INTEGRATION (real Electron, synthetic data).

## B.5 What Part B does not tell you

Stated plainly, because this is the failure mode the brief warns about:

- **Nothing about iOS.** A desktop Electron renderer's working set is not a
  `phys_footprint`, and Jetsam is not Windows' working-set accounting. Do not
  convert.
- **Nothing about the AudioWorklet's real cost.** The probe duplicates the
  channels in the renderer's JS context. That is the same *shape* as
  `addBuffers`, not the same *place*: the worklet is a separate realm with its
  own allocator, and signalsmith-stretch may transform what it stores. `[verify]`.
- **Nothing about stems.** No separation, no four-voice session, no Int16 cache
  read-back was measured.
- **Nothing about a long session.** These are single-shot allocations in a fresh
  process, with no fragmentation, no repeated load/eject, and no GC pressure from
  the app's own UI. Real DJ sessions load and eject for hours.

## B.6 iOS

**`[verify]` — unknown.** No iOS device, simulator or macOS host was available in
this environment, so there is no iOS number in this document and none is inferred.

Run 2 must measure, per device tier, with `phys_footprint` and
`os_proc_available_memory()` — **not RSS** (Part C: "measure with
`os_proc_available_memory()` and `phys_footprint`, NOT RSS"), reporting peak
footprint, decoded-audio bytes per deck, and Int16 memory-mapped stem-cache
bytes separately. The decoded-audio figure for that comparison comes from
**Part A**, which is exact and needs no re-measurement. Only the *ceiling* and
the *overhead* need measuring.

---

## Summary — exact vs measured

| Claim | Value | Status |
| --- | --- | --- |
| Float32 stereo 44.1 kHz rate | 352.8 kB/s | **exact arithmetic** |
| 1 track, 5 min | 105.84 MB / 100.94 MiB | **exact arithmetic** |
| 1 track, 10 min | 211.68 MB / 201.87 MiB | **exact arithmetic** |
| 4 decks, 10 min | 846.72 MB / 807.50 MiB | **exact arithmetic** |
| 4 decks × 4 parts, 5 min | 1.69 GB / 1,615.0 MiB | **exact arithmetic** |
| Int16 halves all of the above | × 0.5 exactly | **exact arithmetic** |
| `cloneFrom` duplicates the buffer | **false** — reference copy, `deck.ts:642` | **SOURCE** |
| Worklet holds a second copy | mechanism yes, magnitude `[verify]` | SOURCE / unknown |
| Renderer + one 5-min buffer | 67.0 → 176.4 MB working set | **INTEGRATION, measured** |
| Renderer + one 10-min buffer | 176.4 → 378.5 MB | **INTEGRATION, measured** |
| Renderer + duplicate 10-min pair | 378.5 → 580.5 MB | **INTEGRATION, measured** |
| JS heap reflects audio cost | **no** — flat at 9.5 MB | **INTEGRATION, measured** |
| Idle renderer + main process | 67.0 MB + 95.3 MB | **INTEGRATION, measured** |
| Allocate 212 MB (synthetic fill) | 666 ms | **INTEGRATION, measured** |
| Anything about iOS | — | **`[verify]`** |

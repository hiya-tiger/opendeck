# LINK-PROBE — opendeck-link/1

**What this is:** a session tempo/beat/phase transport for OpenDecks, implemented
in the Electron main process (`src/main/link.ts`) over multicast UDP, with a
Link-shaped API, behind a default-off switch.

**What this is not:** Ableton Link. It does not speak Ableton's wire protocol, it
does not use Ableton's multicast group, and it will not appear in, or see, a Link
session in Ableton Live, LinkHut, Traktor, or any iOS Link app. See
`docs/mobile/ADR-D34.md` for why.

**Protocol id:** `opendeck-link/1` · **Group:** `239.255.77.88:29876` · **TTL 1**

---

## 1. The one-line result on this machine

```
SMOKE_RESULT {"ok":true,"skipped":false,"skipCode":0,"reason":null,"protocol":"opendeck-link/1",
"abletonCompatible":false,"tier":"INTEGRATION","multicast":{"group":"239.255.77.88","port":29876},
"checks":[
 {"name":"enable-reports-enabled","ok":true,"detail":"A.enabled=true B.enabled=true"},
 {"name":"peers-discovered","ok":true,"detail":"A.peers=1 B.peers=1 observerDatagrams=4"},
 {"name":"tempo-converges","ok":true,"detail":"A=128 B=128 within 5000 ms"},
 {"name":"beat-phase-agree","ok":true,"detail":"beatDelta=0.000000 phaseDelta=0.000000 tolerance=0.05 beats at one shared instant (independent status() reads differ by 0.000053 beats, which is read skew, not timeline disagreement)"},
 {"name":"local-tempo-pushed-and-observed","ok":true,"detail":"A pushed 124; B.sessionTempo=124"},
 {"name":"disable-restores-pre-link-tempo","ok":true,"detail":"pre-Link 120, was 124, restored 120, enabled=false"},
 {"name":"transport-playhead-unchanged","ok":true,"detail":"before={\"position\":12.345678,\"playing\":true,\"rate\":1} after={\"position\":12.345678,\"playing\":true,\"rate\":1}"},
 {"name":"tempo-authority-precedence","ok":true,"detail":"row2=true row5=true row6=true restore=true pushes=126,130"}],
"convergence":{"tempo":128,"beatDelta":0,"phaseDelta":0,"beatTolerance":0.05,"timeoutMs":5000},
"platform":"win32","node":"v22.22.2","durationMs":414}
```

Machine: Windows 10 Pro, Node v22.22.2, one process, loopback multicast.
Run on 2026-10-31. Reproduced four times with the same `ok:true`.

`beatDelta=0` is not a tautology: both nodes compute beat from an anchor that is
only shared over the wire, and the negative control below (nodes that cannot hear
each other) shows no convergence at all. The parenthesised figure is the delta
between two *independent* `status()` calls a few ms apart, i.e. read skew.

**Negative control (run, then removed):** two nodes on *different* ports —
`{"aPeers":0,"bPeers":0,"aTempo":120,"bTempo":140}`. No discovery, no
convergence. So the passing result is network-mediated, not a shared variable.

## 2. How to run it

```bash
node scripts/smoke-link.mjs        # or: npm run smoke:link, once the script is registered
```

Exit codes: `0` pass · `1` fail · `2` skipped (multicast unavailable).

> **`package.json` note.** `package.json` is owned by another agent in this run,
> so `"smoke:link"` was **not** added to it. The script is complete and runnable
> directly. The one line needed is:
> `"smoke:link": "node scripts/smoke-link.mjs"`.
> Until it is added, `npm run smoke:link` does not exist — that is an addition,
> not a regression, and it must not be counted as a test-count change.

A skip is never a pass. The script prints `SMOKE_SKIPPED <reason>` and exits `2`
when the host cannot multicast. It distinguishes two cases:

- an independent listener socket on the same group received **nothing** →
  multicast is blocked here → **skip**, reason stated;
- the listener received datagrams but the two nodes did not see each other →
  **fail**, because that is a bug in this code, not a property of the host.

## 3. How a human verifies it by hand (two OpenDecks instances)

Not yet a UI feature — there is a status chip only. To drive it by hand you need
the app's main process; the shortest path is a Node REPL against the built module,
which is what the smoke test does. For a human-visible check:

1. `npm run build` (so `dist/main.cjs` includes the link handlers).
2. Start two copies of the app. On Windows the second copy needs a separate
   user-data dir to avoid the single-instance lock:
   `set ELECTRON_USER_DATA=<tmp> && npx electron .`
3. In each renderer devtools console:
   `await opendeckDesktop.link.enable()` → expect `enabled:true`.
4. In the first: `await opendeckDesktop.link.setLocalTempo(128)`.
5. In the second: `await opendeckDesktop.link.status()` → expect `sessionBpm:128`,
   `peerCount:1`. The header chip shows `link on · 1 peer · 128.0 BPM`.
6. `await opendeckDesktop.link.disable()` in the first → it returns to the tempo
   it had before `enable()`.

What this proves: two OpenDecks processes on one LAN agree on tempo, beat and
phase. What it does **not** prove: anything about Ableton Live.

### Against Ableton Live — not possible with this build

There is no procedure that makes this build interoperate with Live, because the
wire format is not implemented. A human cannot "verify" it; there is nothing on
the wire to verify. The honest statement is: **`[verify]`, unverified, not
attempted.**

If interoperability is ever required, the route is ADR-D34 option (a): link the
reference C++ implementation (or buy Ableton's commercial licence) and replace the
transport behind the `LinkNode` interface. The `TempoAuthority` in D35 does not
change if that happens — that is why the seam is there.

## 4. What is not implemented

| Missing | Consequence |
|---|---|
| Ableton wire protocol | No interop with Live, LinkHut, Traktor, iOS Link apps |
| Ableton's group/port | Deliberately different, so a real Link session on the same LAN is never joined or polluted |
| Clock offset estimation between machines | Beat/phase agreement is only proven **within one process**. Across two machines, `Date.now()` skew (ms-scale) shifts phase by `skew × bpm / 60`. `[verify]` on real hardware |
| Start/stop (`isPlaying`) sync | Link shares tempo, not transport state. Play/stop is local, always |
| Quantum negotiation | Quantum is fixed at 4 beats; no bar-phase alignment |
| Latency compensation / host-time filter | Not present. Not needed while phase is display-only |
| Beat-synced FX following session phase | Not wired. Phase is advisory (D35 rule 6) |
| Link Audio | Not present in any form |
| iOS/iPadOS local-network permission handling | SPECIFIED only. `NSLocalNetworkUsageDescription` + a user-visible prompt are required on iOS; a denial is a normal state. `[verify]` — N10 |
| Any UI beyond the status chip | Enable/disable exist as API only |

Also not implemented, by design: **Link never moves a playhead.** `src/main/link.ts`
imports nothing from the renderer and holds no transport reference;
`TempoAuthority` has no `Deck` handle. The smoke test asserts a transport object is
byte-identical across a full session, which is the strongest available check that
this stayed true.

## 5. The licence consequence, in one paragraph

Ableton's reference implementation is dual-licensed **GPLv2+ or proprietary**
(confirmed at github.com/ableton/link, 2026-10-31), and the Rust and Python
implementations found are GPL-3.0 derivatives of it; the wire format exists only
inside that GPL source, so a clean-room wire-compatible implementation cannot be
derived from public documentation. D11 forbids GPL for linked code, therefore this
feature is an independent MIT implementation of a *different* protocol with a
Link-shaped API, and **it does not interoperate with Ableton Live**. The price is
paid in function, not in licence: OpenDecks stays MIT and ships no GPL code, and the
"works with Ableton Link" feature is not delivered. If that feature is ever
required, the choice in D34 must be revisited in writing — either the commercial
licence, or a D11 amendment stating that the distributed binary becomes GPLv2+
while OpenDecks's own source stays MIT.

## 6. Evidence tier

| Claim | Tier |
|---|---|
| Code exists, builds, passes `tsc --noEmit` | COMPILED |
| Two nodes converge in one process, on this machine | INTEGRATION |
| Transport untouched | INTEGRATION (by construction + assertion) |
| Across two physical machines | **not tested**, `[verify]` |
| Against Ableton Live | **not implemented**, `[verify]` |
| iOS / iPadOS | SPECIFIED only |
| Real DJ hardware / a real Link session | HARDWARE — not attempted |

Tiers used verbatim: SPECIFIED / SOURCE / COMPILED / UNIT / INTEGRATION /
SIMULATOR / DEVICE / HARDWARE. No tier implies the next.

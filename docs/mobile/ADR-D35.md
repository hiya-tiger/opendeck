# D35: Tempo authority

**Status:** Accepted for Run 1 (m3).
**Date:** 2026-10-31.
**Depends on:** D34 (Link route = MIT, own protocol).
**Evidence tier:** SOURCE for "what exists today" (code read, line references below);
SPECIFIED for the authority defined here; UNIT + INTEGRATION for the implementation.

---

## 1. What owns BPM, beat and phase today (source read)

There is **no session tempo object** in the current tree. Grepping the renderer for a
global BPM/tempo owner finds only per-deck state and a stateless maths module.

| Quantity | Current owner | Where | Notes |
|---|---|---|---|
| Track BPM (reference grid) | each `Deck` | `deck.ts:119` `info.bpm`, set by `setBpm()` at `deck.ts:1487` | Comes from analysis (`analyze.ts`) or Serato beatgrid tags (`app.ts:1688-1691`). Never modified by the pitch fader. |
| Pitch / tempo % | each `Deck` | `deck.ts:1221` `setTempoPercent()`, clamped by `pitchRangePercent` in `app.ts:1075` `applyTempo()` | UI-driven (`app.ts:874` pitch input, `app.ts:1087` `applySync`). |
| Playback rate | each `Deck` | `deck.ts:1212` `setRate()`; `setTempoPercent` calls `setRate(1 + p/100)` at `deck.ts:1223` | Drives `PcmSource.setRate`, `el.playbackRate`, stem voices. This is the *only* thing that changes how fast audio is consumed. |
| Effective BPM of a deck | derived, not stored | `info.bpm × (1 + tempoPercent/100)` | No code names it; `sync.ts:22` `syncRate()` computes the same ratio. |
| Beat / phase | each `Deck` beatgrid | `beatgrid.ts` `EditableBeatGrid.firstBeatSeconds`; `deck.ts:1487` `info.beatPhase` | Per-track grid, editable, lockable (D29). Phase 0 is the track's first downbeat, not a session phase. |
| Sync between two decks | `sync.ts` | `sync.ts:29` `syncDeck()` | **Stateless.** Returns `{rate, tempoPercent, phaseErrorSeconds, seekTo}`. `app.ts:1095` consumes it once and calls `applyTempo()` + `deck.seek()`. It is a one-shot command, not a running owner. |

**Conclusion.** Today the tempo authority is the *deck transport itself*: a deck's
rate is a pure function of its own pitch fader, and the reference BPM is a property
of the loaded track. There is no session-wide BPM, so adding Link cannot "become a
second authority" unless we first create a session object — which is what this ADR
does, deliberately, with Link as an input to it.

## 2. Decision

**Exactly one component owns session BPM, beat and phase:
`TempoAuthority` in `src/renderer/engine/tempo-authority.ts`.**
Everything else — manual BPM, the pitch fader, `sync.ts`, and the Link node — is an
*input* to it or a *consumer* of it.

Rules, in full:

1. `TempoAuthority` holds `{ bpm, beat, phase, quantum, source }`. It is the only
   object that may answer "what is the session tempo right now".
2. **`sync.ts` stays a calculator, not an owner.** `syncDeck()` keeps returning a
   rate and a seek offset; the authority does not call it and it does not call the
   authority. Making sync a *running* follower loop is out of scope for m3.
3. **Link can be master of session BPM, and only of that.** When Link is enabled the
   authority adopts the Link session tempo whenever it changes. When Link is
   disabled the authority never reads it.
4. **Local tempo can be pushed to the session.** Setting BPM while Link is enabled
   calls `link.setLocalTempo(bpm)`, which publishes a new timeline; the authority
   then adopts it back from the session, so the displayed value and the network value
   are the same number by construction, not by coincidence.
5. **Link never drives sample position.** `TempoAuthority` has no reference to a
   `Deck`, a `PcmSource`, a media element or a transport clock, and `src/main/link.ts`
   imports nothing from the renderer. Link writes BPM, beat and phase; the transport
   owns position. This is enforced by the smoke test, which asserts the transport
   playhead is byte-identical before and after a Link session.
6. **Beat/phase from Link are advisory for display and for future beat-synced FX.**
   They do not seek, nudge or re-align any deck in m3. Aligning a deck to a session
   phase is a transport action and would need its own decision.

## 3. Precedence

`{Link}` × `{internal sync}` × `{manual BPM}`. "Manual BPM set" means the user has
moved the tempo control or explicitly entered a session BPM since the last track
load; "unset" means the authority is falling back to track data.

| # | Link | Internal sync (deck SYNC) | Manual BPM | Session BPM source | Manual BPM effect | Deck rate / position |
|---|---|---|---|---|---|---|
| 1 | off | off | unset | master deck effective BPM, else 120 (`source: "deck"` / `"default"`) | — | unchanged |
| 2 | off | off | set | manual value (`source: "manual"`) | sets session BPM directly | unchanged |
| 3 | off | on | unset | master deck effective BPM (`source: "deck"`) | — | `syncDeck()` sets follower rate + seek, as today |
| 4 | off | on | set | manual value wins over the deck (`source: "manual"`) | sets session BPM; a deck/master mismatch is *displayed*, not silently resolved | follower rate + seek from `syncDeck()`, as today |
| 5 | on | off | unset | **Link session tempo** (`source: "link"`) | — | unchanged; Link never seeks |
| 6 | on | off | set | **Link session tempo**; the manual value was pushed into it (`source: "link"`) | publishes a new timeline via `link.setLocalTempo()` | unchanged |
| 7 | on | on | unset | **Link session tempo** (`source: "link"`) | — | `syncDeck()` may still set follower rate/seek; it does not write session BPM |
| 8 | on | on | set | **Link session tempo**, updated by the push (`source: "link"`) | publishes a new timeline | as row 7 |

Read the table as three precedence layers, highest first:

1. **Link enabled ⇒ Link session tempo owns session BPM.** Manual BPM is demoted to a
   *contribution* that is pushed into the session (rows 6, 8). A remote peer changing
   tempo afterwards overrides the local push — last writer wins, by design.
2. **Link disabled, manual BPM set ⇒ manual owns session BPM** (rows 2, 4).
3. **Otherwise ⇒ the master deck's effective BPM** (rows 1, 3), with 120 as the
   default when no track is analysed.

**Internal sync is orthogonal in every row.** It changes a deck's rate and position;
it never writes session BPM, and it is not consulted by the authority. That is
deliberate: making sync and Link both drive one number is how you get two owners.

### What happens on enable / disable

- **Enable:** the authority snapshots the current session BPM as `preLinkBpm`, then
  publishes it to the session as the initial local contribution. Link is not
  allowed to change the local BPM until it has heard from a peer.
- **Disable:** the authority restores `preLinkBpm` — not the last value a peer
  pushed. Transport position, rate and play state are untouched by both
  transitions.

## 4. Rejected options

| Option | Why rejected |
|---|---|
| Let Link write `Deck.setTempoPercent()` directly | That is a second tempo authority and it couples a network input to the transport. It would also make the pitch fader fight the network. |
| Let Link seek decks to a session phase | Link must not drive sample position (brief, Part D). Phase alignment is a transport action. |
| Make `sync.ts` a running follower of the session tempo | It is stateless by design and D20-style one-shot sync is the current product behaviour. Converting it would be a transport change, not a Link change. |
| A second global BPM variable next to the deck's `info.bpm` | Two sources of "the tempo" is the exact failure this ADR exists to prevent. `info.bpm` stays "this track's grid BPM"; session BPM lives only in `TempoAuthority`. |
| Put the authority in the Electron main process | It would make every tempo read an IPC round trip, and it would put session state in a process that has no transport. The authority is renderer-side; only the *network* state lives in main. |

## 5. Where the split runs

```
  UI (pitch / BPM entry) ──┐
                           ▼
                    TempoAuthority  (renderer, single owner)
                       │        ▲
        setLocalTempo  │        │  sessionTempo read (polled)
                       ▼        │
                 preload IPC  (link:*)
                       │        ▲
                       ▼        │
                    LinkNode  (Electron main, node:dgram)
                       │
                 multicast 239.255.77.88:29876
```

`LinkNode` owns the *network-visible* tempo. `TempoAuthority` owns the *application*
tempo. They are not two authorities over the same quantity: the node's value is the
session's, the authority's value is what the app does with it, and rule 4 keeps them
equal whenever a local push happens.

## 6. What m3 actually wires, and what it does not

| Piece | State in m3 |
|---|---|
| `TempoAuthority` (owner of session BPM/beat/phase) | Implemented, instantiated once in `app.ts`, fed by the Link status poll |
| Manual BPM → Link push (rule 4) | Implemented (`onPushLink` → `link:set-tempo`); **no UI control calls `setManualBpm` yet** |
| Link → session BPM adoption (rule 3) | Wired: the 1 s status poll calls `onLinkStatus` |
| Deck-BPM fallback (rows 1, 3) | Implemented and unit-asserted in the smoke, but **not fed from a deck in m3** — the app has no single "master deck" object to read from, and inventing one would change `applySync` |
| Status readout | One header chip (`#linkStatus`), hidden while Link is off |
| Anything that moves a deck | **Nothing.** No deck, transport or seek call is added |

The gap that matters: until a manual-BPM control is wired, the only way to change
the session tempo is `opendeckDesktop.link.setLocalTempo()` from devtools or a
second peer. That is a UI gap, not an authority gap — there is still exactly one
owner.

## 7. Revisit if

- Beat-synced FX should follow Link phase. That needs a decision on whether phase is
  allowed to re-anchor running decks.
- `sync.ts` becomes a continuous follower. Then it must consume `TempoAuthority`
  rather than compute its own ratio, or rule 2 breaks.
- A second network tempo source appears (MIDI clock, Pro DJ Link). Same pattern
  applies: it is an input to `TempoAuthority`, never an owner.

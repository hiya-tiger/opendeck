# D34: Ableton Link licensing

**Status:** Accepted for Run 1 (m3).
**Date:** 2026-10-31.
**Supersedes:** nothing. **Amends:** nothing. D11 stands unmodified.
**Evidence tier for the decision:** SOURCE (licence texts and package metadata read
directly; see citations). **Evidence tier for the implementation that follows:**
UNIT + INTEGRATION on one machine, no DEVICE, no HARDWARE, and **not** wire
compatible with Ableton Live — see §6.

---

## 1. The question

D11 (docs/decisions.md:128) says: *"MIT/Apache-2.0 preferred, MPL-2.0 allowed, GPL
forbidden for linked code."* Link is the one feature in Run 1 whose obvious
implementation is GPL. So the licence question is decided **before** any code, and
the answer determines what can be built at all.

Three routes were on the table:

- **(a)** Link the reference C++ implementation and amend D11 in writing.
- **(b)** Adopt a permissive reimplementation, if a complete one exists.
- **(c)** Write a minimal implementation of the subset needed, in-tree, under MIT.

## 2. Candidate survey (checked 2026-10-31)

| # | Candidate | Language | Licence | Protocol coverage | Maintenance | Last release | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | [`ableton/link`](https://github.com/ableton/link) — reference implementation | C++17, header-only | **Dual: GPLv2+ or proprietary commercial.** Quoted: *"Ableton Link is dual licensed under GPLv2+ and a proprietary license. If you would like to incorporate Link into a proprietary software application, please contact link-devs@ableton.com."* ([repo](https://github.com/ableton/link), [ableton.github.io](http://ableton.github.io/)) | Complete; the wire format is defined here and nowhere else. `LinkAudio.hpp` (Link Audio) was added by 2026. | Active — commits dated 2026-10-15. | No tagged release visible on the repo landing page; `[verify]` the exact tag/date before vendoring. | **Rejected.** GPLv2+ is incompatible with D11 as written. The proprietary option is a paid commercial licence, i.e. a business decision outside this brief's authority. |
| 2 | [`ableton-link-rs`](https://lib.rs/crates/ableton-link-rs) | Rust | **GPL-3.0** — README: *"licensed under the GNU General Public License v3.0, consistent with the original Ableton Link project."* | Claims *"Full Link Protocol Support"* and *"aims for full compatibility"*, but its own README lists *"Serialization: Uses bincode instead of custom serialization"* and says the audio-thread session-state methods *"are placeholders"*. | Early stage by its own admission (*"This is an early-stage implementation"*). 3 releases, all Aug 2025. | 0.1.2, 2025-08-19. | **Rejected on licence alone** (GPL-3.0), before the wire-compatibility doubt matters. Also unusable here: it is async/Tokio and would add ~15 crates to a repo that must not gain dependencies. |
| 3 | [`artfwo/aalink`](https://github.com/artfwo/aalink) | Python (pybind11 bindings over the C++ lib) | **GPL-3.0** — *"aalink includes code from pybind11 and Ableton Link."* | Whatever the C++ lib does, via bindings. | Active-ish (page dated 2026-03-10). | `[verify]`. | **Rejected.** GPL-3.0, and it is a Python binding — not reachable from an Electron main process. |
| 4 | A permissive (MIT/Apache-2.0) JS/TS or Rust implementation | — | — | — | — | — | **Not found.** Searches on 2026-10-31 for a permissively licensed Ableton Link implementation in JS/TS, Rust, Go and Python returned only items 1–3. Absence of evidence is recorded as absence, not as proof that none exists: this is an `[verify]` gap, not a settled negative. |

### What the survey establishes

1. Every implementation that actually speaks the Ableton Link wire protocol is
   **GPL** (the reference is the only definition of the wire format; the Rust and
   Python projects are GPL derivatives of it).
2. **The wire format is not published.** The reference repo's README documents the
   *concept* (discovery, session, tempo/beat/phase, clock, latency compensation) and
   the *API* (`Link.hpp`), but contains no protocol specification. A clean-room
   reimplementation of the wire format therefore cannot be derived from public
   documentation — it can only be derived by reading GPL source, which is not
   clean-room.
3. Consequently route (b) does not exist today.

## 3. Decision

**Route (c): a minimal, in-tree, MIT implementation of a session-tempo protocol
with a Link-shaped API. It is not Ableton Link and does not claim to be.**

What is implemented (see `src/main/link.ts`):

- peer discovery on a private multicast group with a documented, versioned JSON
  message format (own design, §5);
- session tempo with last-writer-wins resolution keyed on `(timestamp, origin)`;
- beat and phase derived from a shared `(anchorTime, anchorBeat, bpm)` timeline;
- peer count, enable/disable, local-tempo contribution, status string;
- restore-pre-Link-tempo on disable.

What is **not** implemented, and must not be described as working:

- wire compatibility with Ableton Live, LinkHut, or any Link app — **unverified and
  not attempted**;
- Ableton's actual multicast group/port. This implementation deliberately uses a
  different group (`239.255.77.88:29876`) so that it *cannot* accidentally join,
  pollute or be mistaken for a real Link session on the same LAN;
- clock synchronisation across machines beyond `Date.now()` resolution (no NTP-style
  offset estimation, no host-time filter, no latency compensation);
- start/stop transport sync (`isPlaying`), quantum negotiation, Link Audio;
- sample-accurate phase locking.

## 4. Why (c) and not (a)

(a) is the only route that produces a genuinely Link-compatible product, and it is
a legitimate choice. It is rejected here for three reasons, in order of weight:

1. **It changes the licence of every distributed binary.** Linking the reference
   implementation makes the combined work a GPL work. OpenDecks's own source could
   stay MIT, but a distributed OpenDecks build would have to be conveyed under
   GPLv2+ terms, with source availability obligations for the whole binary. That is
   a product-identity change, not a dependency addition, and it contradicts the
   brief's premise (*"this is necessary to maintain MIT License"*).
2. **The commercial option is a contract, not a code change.** It cannot be adopted
   by an agent, and its terms (per-seat, per-product, redistribution) are unknown
   here. `[verify]` with Ableton before it is ever treated as an option.
3. **Run 1 needs the *decision*, not the feature.** The brief asks for a licence
   decision, a probe and a headless smoke test. Route (c) delivers all three at MIT,
   and leaves the door open: if Run 2 decides Link interoperability is a product
   requirement, the honest move is then to buy the commercial licence, and the
   `LinkNode` interface in `src/main/link.ts` is the seam to swap behind.

The cost of (c), stated plainly: **users cannot jam with Ableton Live.** The feature
as shipped in Run 1 is "two or more OpenDecks instances share tempo, beat and phase".
That is a much smaller feature than "Ableton Link", and the UI/status string says
`opendeck-link/1` rather than "Link" for exactly that reason.

## 5. The protocol we did define (so the claim is checkable)

Deliberately small. One UDP datagram = one JSON object, UTF-8, ≤ 512 bytes.

```
{
  "p":  "opendeck-link",   // protocol tag; rejects anything else
  "v":  1,                 // version
  "peer": "<uuid>",        // sender
  "origin": "<uuid>",      // author of the current timeline
  "ts": 1750000000000000,  // microseconds; monotonic key of the last tempo change
  "bpm": 124.0,
  "anchor": 1750000000000000, // microseconds; beat 0 of the current timeline
  "anchorBeat": 0,
  "quantum": 4
}
```

- **Multicast:** `239.255.77.88:29876`, TTL 1, loopback enabled, `SO_REUSEADDR`.
- **Cadence:** one datagram on every state change, plus a 200 ms heartbeat.
- **Peer expiry:** 2 s without a datagram.
- **Resolution:** a receiver adopts a timeline iff `(ts, origin)` is strictly greater
  than its own. Adopting never re-stamps `ts`, so two nodes cannot ping-pong.
- **Beat:** `beat = anchorBeat + (now − anchor) / 1e6 × bpm / 60`; `phase = beat mod quantum`.
- **Re-anchor:** a tempo change sets `anchor = now`, `anchorBeat = 0`. Phase is
  therefore continuous and identical on every node from that instant.

This is our format. It is documented here so that "two of our nodes converge" is a
falsifiable claim rather than a vibe.

## 6. Evidence tier and what is *not* claimed

| Claim | Tier |
|---|---|
| Licence facts in §2 | SOURCE (URLs quoted above, read 2026-10-31) |
| No permissive Link implementation found | SOURCE for the searches performed; **absence of evidence**, `[verify]` |
| `src/main/link.ts` compiles and its unit/integration behaviour passes | UNIT / INTEGRATION on Windows 10, one machine, one process |
| Two OpenDecks nodes converge on tempo/beat/phase | INTEGRATION (see `npm run smoke:link` output recorded in LINK-PROBE.md) |
| Interoperates with Ableton Live | **Not claimed. `[verify]`. Not attempted.** |
| Works across two physical machines | **Not claimed.** Multicast loopback within one process is what was tested. `[verify]` |
| Works on iOS/iPadOS (local-network permission) | **Not claimed.** SPECIFIED only; see `VERIFY-PLAN` row |

## 7. NOTICE entries

Added to `NOTICE` under a new "Ableton Link" heading (this ADR is the reason the
entry exists, and the entry states the negative):

- **No Ableton Link code is included.** No GPL component, crate, package or model is
  linked, vendored or downloaded. The `opendeck-link/1` protocol in
  `src/main/link.ts` is original MIT code written for this repository.
- **Ableton and Link are trademarks of Ableton AG.** They are used here only to
  describe what this feature is *not* compatible with, which is nominative use.
  OpenDecks ships no Ableton code, assets or documentation text.
- **If a future run adopts route (a)**, the NOTICE entry must then read: *"Includes
  Ableton Link, Copyright (c) Ableton AG, licensed under GPLv2+ (or a commercial
  licence). The distributed binary is therefore conveyed under GPLv2+; the source of
  that binary must be made available on request."* D11 must be amended in the same
  commit, with that consequence written out. This ADR does **not** make that
  amendment.

## 8. Revisit if

- A permissively licensed, wire-compatible implementation appears (re-run the §2
  survey; it is cheap).
- A commercial Link licence is obtained — then swap the transport behind the
  `LinkNode` interface and keep D35 unchanged.
- Run 2's N10 concludes that interop with Live is required on mobile. That would
  force (a) or the commercial licence, and it would force a D11 amendment before
  any of it is written.

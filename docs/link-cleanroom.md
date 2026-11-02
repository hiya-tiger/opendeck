# Ableton Link, clean-room provenance log (D44)

This file records every source used to write `src/main/ableton-link/`
(`wire.ts`, `node.ts`), its licence, and what was taken from it. It is the
Link counterpart of the Pro DJ Link source list in D39. Date of the work:
2026-11-02.

## Rules followed

1. **No GPL code.** The reference library `github.com/Ableton/link`
   (GPLv2+ or proprietary) was cloned and built in an isolated directory
   outside this repository (`isolated-gpl-linkref/`, with a DO-NOT-READ note).
   No file of it was opened, read, searched or copied. The only interactions
   were `git clone --recursive`, `cmake`, `cmake --build --target LinkHutSilent`
   (build logs were redirected to a file and checked only for exit status and
   the name of a missing header), and running the resulting binary.
2. **Black-box observation only.** The binary was run under a pseudo-terminal,
   its own on-screen help was read, keys were pressed, and its UDP traffic was
   captured with `tcpdump` on `lo`/`any`. Every byte layout and constant in
   `wire.ts` comes from those captures (summarised below).
3. **No third-party implementation's code.** Permissive repos were evaluated
   from their licence files, READMEs and package metadata (see "Existing
   attempts"); none of their source code was used.
4. **Honest caveat about the author.** The implementation was written in this
   run by an AI agent. That agent did not read the GPL source during the work,
   but like any language model it was trained on large amounts of public text
   and code, which may include material about Link. To keep the result
   grounded, every constant and layout was taken from the captures below and
   checked against a running reference peer, not from recall. Where behaviour
   was not observable, the rule is our own design and is marked [design] in
   `node.ts`.

## Sources used

| # | Source | Licence | Used for |
|---|---|---|---|
| 1 | Ableton Link README, `github.com/Ableton/link` (README.md, LICENSE.md only) | GPLv2+ / proprietary (text read for licensing facts only) | Licence terms; build instructions for the examples; "LinkHut" example name; concept of host time and latency compensation. No code. |
| 2 | `ableton.github.io/link` concepts page | Ableton documentation (public web page) | Tempo / beat / phase / quantum semantics, start/stop semantics, capture/commit model. |
| 3 | F. Goltz, "Ableton Link – A technology to synchronize music software", Linux Audio Conference 2018 proceedings, pp. 39–42, DOI 10.14279/depositonce-7046 | CC BY-SA 4.0 | Architecture: multicast discovery with peer id and timeline snapshot; timeline = (host time, beat, tempo); "global host time" measured by ping-pong bursts; founder's clock as reference; any member can serve measurements. |
| 4 | `Compellerai/link-bpm` README | MIT OR Apache-2.0 | Corroborated the multicast group/port `224.76.78.75:20808` and that the tempo sits in the timeline payload. Source code not read or used. |
| 5 | `ablink` 0.1.0 crate metadata and module doc comment (crates.io) | Declared MIT, no licence text shipped | Evaluated and **rejected** (see below). Only `Cargo.toml`, `.cargo_vcs_info.json`, the `//!` doc header of `lib.rs` and a keyword search for provenance terms were looked at; no implementation code was read or used. |
| 6 | Black-box captures of LinkHutSilent built from `Ableton/link` @ `5ba907ae027a8c2ec8824463e37296dcefc5e9be` | Observation of a program's network behaviour (facts, not code) | All wire layouts and the behavioural rules marked [observed]. |

Sources deliberately **not** used (licence): `2bbb/node-abletonlink` and
`ktamas77/ableton-link` (bundle the GPL SDK), `anweiss/ableton-link-rs`
(GPL-3.0), `rusty_link` (GPL-2.0), `aalink` / `aalink-js` (GPL). None was
opened.

## Existing attempts evaluated (step 2)

**`akx/ablink`** ("Unofficial pure-Rust implementation of the Ableton Link
protocol", crate `ablink` 0.1.0, published 2026-08-13 by Aarni Koskela, 215
downloads, no dependents).
- Licence: `license = "MIT"` in Cargo.toml only. The crate ships **no LICENSE
  file and no copyright line**, so there is no notice we could carry into
  `NOTICE` as MIT requires.
- Provenance: the doc header calls it "an unofficial, independent, pure-Rust
  implementation". There is **no clean-room statement**, no description of how
  the wire format was learned, and no README in the crate. The repository
  `github.com/akx/ablink` now returns **404** (deleted or private), so its
  history and any provenance notes cannot be checked. The source path in the
  crate (`crates/ablink` in a workspace) suggests a larger repo we can't see.
- Completeness (from its doc header): discovery, clock-offset measurement,
  tempo/beat timeline and start/stop over IPv4; no IPv6, no Link Audio. Its one
  integration test runs two `ablink` instances against each other, not against
  a real Link peer.
- Maintenance: a single release, repo gone.
- **Verdict: not used.** Nothing shows it was derived from the GPL code, but
  nothing shows it wasn't, and with the repo gone and no licence text it can't
  be attributed properly. Porting it would import a provenance risk this
  project exists to avoid. Revisit if the author restores the repo with a
  LICENSE and a provenance statement.

**`Compellerai/link-bpm`** (MIT OR Apache-2.0, 3 commits, 2 stars).
- Provenance: an explicit clean-room note: "built from observed network
  traffic … contains no Ableton source code … The packet tests ship synthetic
  packets, not captured Ableton data."
- Completeness: passive tempo listener only. No peer presence, no
  measurement/ghost time, no beat/phase, no start/stop, never announces.
- **Verdict: credible but far too small** to give interoperability. Used only
  as corroboration of the multicast address (source 4).

Conclusion: no existing permissive implementation was both complete and of
verifiable provenance, so step 3 (clean room) was taken.

## What the captures showed

All integers big-endian; times in microseconds; beats in micro-beats.

**Discovery** — UDP multicast to `224.76.78.75:20808` from a per-interface
socket (seen on `lo` 127.0.0.1 and on the LAN interface; also IPv6 to
`ff12::8080`), every **250 ms** while enabled; nothing is sent while disabled.

```
5f 61 73 64 70 5f 76 01   "_asdp_v" + version 1
01                        message type: 1 alive, 2 response, 3 bye-bye
05                        ttl (5); 0 on bye-bye
00 00                     group (always 0)
58 77 4a 49 5e 64 75 6c   peer id, 8 printable ASCII bytes
74 6d 6c 6e 00000018      "tmln", 24 bytes:
   0007a120                 µs per beat = 500000 → 120 BPM (121 BPM → 495868)
   000f13fe                 beat origin in µbeats (0.988158)
   0000000000000000         time origin in ghost µs
73 65 73 73 00000008      "sess", 8 bytes: session id (= founding peer's id)
73 74 73 74 00000011      "stst", 17 bytes: playing u8, beats i64, timestamp i64
6d 65 70 34 00000006      "mep4", 6 bytes: IPv4 + port of the measurement socket
(IPv6 copies carry "mep6", 18 bytes, instead)
```

- Bye-bye is the 20-byte header alone with type 3, ttl 0, sent on disable.
- Each alive was answered with a **type-2 response, unicast** to the alive's
  source address and port, carrying the responder's full state.
- A fresh peer founds its own session (sess = its peer id) and its ghost time
  starts at ~0 when Link is enabled (time origin 0 with the beat it had then).
- A tempo change publishes a new timeline whose beat at the change instant is
  continuous: `(495868, 5989558, 2500700)` after `(500000, 988158, 0)`.
- With start/stop sync off, `stst` is all zeros. Starting transport with sync
  on published `stst = (1, beats, ghost timestamp)` and a re-anchored copy of
  the same timeline line.

**Measurement** — UDP unicast between peers' `mep4` sockets, in bursts of
about 50 exchanges right after two peers of different sessions meet (both
sides measure each other):

```
5f 6c 69 6e 6b 5f 76 01   "_link_v" + version 1
01                        1 ping, 2 pong
ping: "__ht" (8) sender host time; from the 2nd ping on also "_pgt" (8) = the
      ghost time from the previous pong
pong: "sess" (8) responder's session id, "__gt" (8) responder's ghost time,
      "__ht" (8) echoed, "_pgt" (8) echoed when present
```

**Session merging** — in six trials with random peer ids, the peer that
enabled second always switched its `sess` to the first peer's id within
~50 ms of the measurement burst and adopted that peer's timeline verbatim
(already expressed in the shared ghost time). So the older session (later
ghost clock) wins, independent of id order. Afterwards, when either peer
changed tempo, the other adopted the new timeline within one message.

## Rules that are our own design [design]

- Offset estimate: median of `ghost − (hostSent + hostReceived) / 2` over up
  to 40 ping/pong rounds (the reference's internal maths is unknown).
- Ties: if two sessions' ghost clocks are within 1 ms, the lower session id
  wins (never observed; random ids make it practically irrelevant).
- Adoption inside a session: adopt a peer's timeline when that peer's
  advertised timeline changes on the same channel (alive vs. response), so a
  stale echo can't revert a newer local change. Found necessary in testing:
  without the per-channel rule, two OpenDecks nodes could ping-pong.
- Start/stop: with sync on, adopt a peer's `stst` whose timestamp is newer.
- Peers expire after their advertised ttl (5 s) without a message.
- Not implemented: IPv6 discovery, Link Audio, periodic re-measurement (the
  reference was not seen re-measuring within 11 s; long sessions on machines
  with drifting clocks may need it), audio-thread capture/commit.

## Verification against a real peer (step 4)

`npm run smoke:link` with `LINKHUT_BIN` pointing at the LinkHutSilent built
above runs `scripts/link-ableton-smoke-entry.ts`. The peer is driven through
`scripts/link-peer-pty.py`; each status row it draws is timestamped on
`CLOCK_MONOTONIC` (the clock `process.hrtime` uses on Linux) so OpenDecks'
beat is evaluated at the same instant. A raw socket decodes both peers'
alive packets to confirm one session id and one timeline line.

Result on 2026-11-02 (Linux, loopback, Node 22, one machine): see the
"Verification" section of D44 in `docs/decisions.md` for the numbers.
Without `LINKHUT_BIN` the interop part reports `NOT_RUN` and is never
counted as verified.

Not verified: Ableton Live itself, other Link apps, two physical machines on
Wi-Fi, Windows and macOS networking (the code is portable Node `dgram`, but
only Linux ran it).

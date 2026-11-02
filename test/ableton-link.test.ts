// D43: clean-room Ableton Link codec, session rules and backend switching.
// Fixtures are synthetic (built by hand from the documented layout in
// src/main/ableton-link/wire.ts), not captured packets.
import test from "node:test";
import assert from "node:assert/strict";
import {
  LINK_MULTICAST_GROUP,
  LINK_MULTICAST_PORT,
  MSG_ALIVE,
  MSG_BYEBYE,
  MSG_PING,
  MSG_PONG,
  MSG_RESPONSE,
  beatAtGhost,
  bpmToMicrosPerBeat,
  decodeDiscovery,
  decodeMeasurement,
  encodeDiscovery,
  encodeMeasurement,
  ghostAtBeat,
  microsPerBeatToBpm,
  phaseOf,
  randomPeerId,
  retempo,
  sameTimeline,
} from "../src/main/ableton-link/wire.ts";
import { AbletonLinkNode, offsetSample, shouldJoinSession } from "../src/main/ableton-link/node.ts";
import { LinkManager, normalizeLinkSettings } from "../src/main/link-manager.ts";
import type { LinkBackend, LinkProtocolChoice, LinkStatus } from "../src/main/link-backend.ts";
import { LinkNode } from "../src/main/link.ts";

const PEER = "4142434445464748"; // "ABCDEFGH"
const OTHER = "3132333435363738"; // "12345678"

test("multicast group and port are the observed ones", () => {
  assert.equal(LINK_MULTICAST_GROUP, "224.76.78.75");
  assert.equal(LINK_MULTICAST_PORT, 20808);
});

test("alive message: byte layout of header and entries", () => {
  const buf = encodeDiscovery({
    type: MSG_ALIVE,
    ttl: 5,
    group: 0,
    peerId: PEER,
    timeline: { microsPerBeat: 500000n, beatOrigin: 1_000_000n, timeOrigin: 2_000_000n },
    sessionId: PEER,
    startStop: { playing: false, beats: 0n, timestamp: 0n },
    endpoint: { address: "127.0.0.1", port: 53391 },
  });
  assert.equal(buf.toString("latin1", 0, 7), "_asdp_v");
  assert.deepEqual([...buf.subarray(7, 12)], [1, MSG_ALIVE, 5, 0, 0]);
  assert.equal(buf.toString("hex", 12, 20), PEER);
  assert.equal(buf.toString("latin1", 20, 24), "tmln");
  assert.equal(buf.readUInt32BE(24), 24);
  assert.equal(buf.readBigInt64BE(28), 500000n);
  // tmln 32 + sess 16 + stst 25 + mep4 14 after the 20-byte header = 107, the observed size.
  assert.equal(buf.length, 107);
  const tail = buf.subarray(buf.length - 6);
  assert.deepEqual([...tail.subarray(0, 4)], [127, 0, 0, 1]);
  assert.equal(tail.readUInt16BE(4), 53391);
});

test("discovery round trip and bye-bye", () => {
  const msg = {
    type: MSG_RESPONSE,
    ttl: 5,
    group: 0,
    peerId: PEER,
    timeline: { microsPerBeat: 495868n, beatOrigin: 5989558n, timeOrigin: 2500700n },
    sessionId: OTHER,
    startStop: { playing: true, beats: 12047288n, timestamp: 5893421n },
    endpoint: { address: "192.168.1.20", port: 40000 },
  };
  assert.deepEqual(decodeDiscovery(encodeDiscovery(msg)), msg);
  const bye = encodeDiscovery({ type: MSG_BYEBYE, ttl: 0, group: 0, peerId: PEER });
  assert.equal(bye.length, 20);
  assert.deepEqual(decodeDiscovery(bye), { type: MSG_BYEBYE, ttl: 0, group: 0, peerId: PEER });
});

test("decoder rejects foreign, truncated and malformed datagrams", () => {
  assert.equal(decodeDiscovery(Buffer.from('{"p":"opendeck-link"}')), null);
  const good = encodeDiscovery({ type: MSG_ALIVE, ttl: 5, group: 0, peerId: PEER, sessionId: PEER, timeline: { microsPerBeat: 500000n, beatOrigin: 0n, timeOrigin: 0n } });
  assert.equal(decodeDiscovery(good.subarray(0, good.length - 3)), null);
  const badType = Buffer.from(good);
  badType[8] = 9;
  assert.equal(decodeDiscovery(badType), null);
  const zeroTempo = encodeDiscovery({ type: MSG_ALIVE, ttl: 5, group: 0, peerId: PEER, timeline: { microsPerBeat: 0n, beatOrigin: 0n, timeOrigin: 0n } });
  assert.equal(decodeDiscovery(zeroTempo), null);
  assert.equal(decodeDiscovery(Buffer.alloc(600)), null);
});

test("unknown entries are skipped", () => {
  const base = encodeDiscovery({ type: MSG_ALIVE, ttl: 5, group: 0, peerId: PEER, sessionId: PEER, timeline: { microsPerBeat: 500000n, beatOrigin: 0n, timeOrigin: 0n } });
  const extra = Buffer.alloc(8 + 18);
  extra.write("mep6", 0, "latin1");
  extra.writeUInt32BE(18, 4);
  const d = decodeDiscovery(Buffer.concat([base, extra]));
  assert.ok(d);
  assert.equal(d.sessionId, PEER);
});

test("ping/pong layout and round trip", () => {
  const ping = encodeMeasurement({ type: MSG_PING, hostTime: 501192260n });
  assert.equal(ping.toString("latin1", 0, 7), "_link_v");
  assert.deepEqual([...ping.subarray(7, 9)], [1, MSG_PING]);
  assert.equal(ping.toString("latin1", 9, 13), "__ht");
  assert.equal(ping.length, 25);
  assert.deepEqual(decodeMeasurement(ping), { type: MSG_PING, hostTime: 501192260n, ghostTime: undefined, prevGhostTime: undefined });
  const pong = encodeMeasurement({ type: MSG_PONG, sessionId: PEER, ghostTime: 3000220n, hostTime: 501192260n, prevGhostTime: 544n });
  assert.equal(pong.toString("latin1", 9, 13), "sess");
  const d = decodeMeasurement(pong);
  assert.deepEqual(d, { type: MSG_PONG, hostTime: 501192260n, ghostTime: 3000220n, prevGhostTime: 544n, sessionId: PEER });
  assert.equal(decodeMeasurement(encodeMeasurement({ type: MSG_PING })), null, "ping without host time");
});

test("tempo encoding: µs per beat", () => {
  assert.equal(bpmToMicrosPerBeat(120), 500000n);
  assert.equal(bpmToMicrosPerBeat(121), 495868n);
  assert.ok(Math.abs(microsPerBeatToBpm(495868n) - 121) < 1e-3);
});

test("timeline maths: beat at ghost, inverse, retempo keeps beat continuous", () => {
  const tl = { microsPerBeat: 500000n, beatOrigin: 988158n, timeOrigin: 0n };
  assert.ok(Math.abs(beatAtGhost(tl, 2_500_700) - 5.989558) < 1e-6);
  assert.ok(Math.abs(ghostAtBeat(tl, beatAtGhost(tl, 1_234_567)) - 1_234_567) < 1e-3);
  const next = retempo(tl, 121, 2_500_700);
  assert.equal(next.microsPerBeat, 495868n);
  assert.ok(Math.abs(beatAtGhost(next, 2_500_700) - beatAtGhost(tl, 2_500_700)) < 1e-6);
  assert.ok(sameTimeline(tl, { ...tl }));
  assert.ok(!sameTimeline(tl, next));
  assert.equal(phaseOf(-0.5, 4), 3.5);
  assert.equal(phaseOf(9, 4), 1);
});

test("peer ids are 8 printable bytes", () => {
  const id = randomPeerId();
  assert.match(id, /^[0-9a-f]{16}$/);
  for (const byte of Buffer.from(id, "hex")) assert.ok(byte >= 0x21 && byte <= 0x7e);
});

test("session precedence: older ghost clock wins; near-ties by id", () => {
  assert.equal(shouldJoinSession(1_000, 3_000_000, PEER, OTHER), true);
  assert.equal(shouldJoinSession(3_000_000, 1_000, PEER, OTHER), false);
  assert.equal(shouldJoinSession(5_000, 5_400, PEER, OTHER), OTHER < PEER);
  assert.equal(shouldJoinSession(5_000, 5_400, OTHER, PEER), PEER < OTHER);
});

test("offset sample uses the round-trip midpoint", () => {
  assert.equal(offsetSample(1_000, 1_200, 50_100), 49_000);
});

test("node adopts a session peer's change but not a stale echo", () => {
  let now = 10_000_000;
  const node = new AbletonLinkNode({ peerId: PEER, nowMicros: () => now });
  const own = node.wireTimeline;
  const alive = (tl: typeof own, type = MSG_ALIVE) => ({ type, ttl: 5, group: 0, peerId: OTHER, sessionId: PEER, timeline: tl });
  node.handleDiscovery(alive(own));
  assert.equal(node.peerCount, 1);
  // The peer changes tempo: adopted.
  now += 1_000_000;
  const faster = retempo(own, 128, now - 10_000_000);
  node.handleDiscovery(alive(faster));
  assert.ok(Math.abs(node.sessionTempo - 128) < 1e-3);
  // We change tempo locally; the peer still advertises its unchanged 128 timeline: not a change, no revert.
  node.setLocalTempo(140);
  node.handleDiscovery(alive(faster));
  assert.ok(Math.abs(node.sessionTempo - 140) < 1e-3);
  // A response carrying an older value on the other channel is not a change on that channel either.
  node.handleDiscovery(alive(faster, MSG_RESPONSE));
  assert.ok(Math.abs(node.sessionTempo - 140) < 1e-3);
  // Bye-bye removes the peer.
  node.handleDiscovery({ type: MSG_BYEBYE, ttl: 0, group: 0, peerId: OTHER });
  assert.equal(node.peerCount, 0);
});

test("node ignores its own packets and peers of other sessions don't count", () => {
  const node = new AbletonLinkNode({ peerId: PEER });
  node.handleDiscovery({ type: MSG_ALIVE, ttl: 5, group: 0, peerId: PEER, sessionId: PEER, timeline: node.wireTimeline });
  node.handleDiscovery({ type: MSG_ALIVE, ttl: 5, group: 0, peerId: OTHER, sessionId: OTHER, timeline: node.wireTimeline });
  assert.equal(node.peerCount, 0);
  assert.equal(node.status().protocol, "ableton-link");
  assert.equal(node.status().backend, "ableton");
});

test("start/stop: adopt newer intent only with sync on", () => {
  const node = new AbletonLinkNode({ peerId: PEER });
  const tl = node.wireTimeline;
  const msg = { type: MSG_ALIVE, ttl: 5, group: 0, peerId: OTHER, sessionId: PEER, timeline: tl, startStop: { playing: true, beats: 0n, timestamp: 99n } };
  node.handleDiscovery(msg);
  assert.equal(node.status().playing, false);
  node.setStartStopSync(true);
  node.handleDiscovery(msg);
  assert.equal(node.status().playing, true);
});

class FakeBackend implements LinkBackend {
  readonly peerId: string;
  readonly protocolId: string;
  readonly backend: LinkProtocolChoice;
  enabled = false;
  bpm = 120;
  sync = false;
  constructor(kind: LinkProtocolChoice) {
    this.backend = kind;
    this.peerId = kind;
    this.protocolId = kind;
  }
  async enable(): Promise<LinkStatus> {
    this.enabled = true;
    return this.status();
  }
  async disable(): Promise<LinkStatus> {
    this.enabled = false;
    return this.status();
  }
  setLocalTempo(bpm: number): LinkStatus {
    this.bpm = bpm;
    return this.status();
  }
  setStartStopSync(on: boolean): LinkStatus {
    this.sync = on;
    return this.status();
  }
  status(): LinkStatus {
    return { enabled: this.enabled, peerCount: 0, sessionBpm: this.bpm, localBpm: this.bpm, beat: 0, phase: 0, quantum: 4, status: "", protocol: this.protocolId, backend: this.backend, error: null, counters: { sent: 0, received: 0, adopted: 0, rejected: 0 } };
  }
  get sessionTempo(): number {
    return this.bpm;
  }
  get peerCount(): number {
    return 0;
  }
  now(): number {
    return 0;
  }
  beatAt(): number {
    return 0;
  }
  phaseAt(): number {
    return 0;
  }
}

test("link settings default to Ableton with opendeck-link/1 as the fallback", () => {
  assert.deepEqual(normalizeLinkSettings(null), { protocol: "ableton", startStopSync: false });
  assert.deepEqual(normalizeLinkSettings({ protocol: "opendeck", startStopSync: true }), { protocol: "opendeck", startStopSync: true });
  assert.deepEqual(normalizeLinkSettings({ protocol: "gpl", startStopSync: "yes" }), { protocol: "ableton", startStopSync: false });
});

test("switching protocol while enabled moves tempo and enabled state to the new backend", async () => {
  const made: FakeBackend[] = [];
  const saved: unknown[] = [];
  const mgr = new LinkManager({
    create: (p) => {
      const b = new FakeBackend(p);
      made.push(b);
      return b;
    },
    save: (s) => void saved.push(s),
  });
  await mgr.enable();
  mgr.setLocalTempo(127);
  const st = await mgr.updateSettings({ protocol: "opendeck" });
  assert.equal(made.length, 2);
  assert.equal(made[0].enabled, false);
  assert.equal(made[1].enabled, true);
  assert.equal(made[1].bpm, 127);
  assert.equal(st.backend, "opendeck");
  assert.deepEqual(saved.at(-1), { protocol: "opendeck", startStopSync: false });
  await mgr.updateSettings({ startStopSync: true });
  assert.equal(made.length, 2);
});

test("opendeck-link/1 fallback still implements the backend seam", () => {
  const node: LinkBackend = new LinkNode({ peerId: "x" });
  assert.equal(node.protocolId, "opendeck-link/1");
  assert.equal(node.backend, "opendeck");
  assert.equal(typeof node.now(), "number");
});

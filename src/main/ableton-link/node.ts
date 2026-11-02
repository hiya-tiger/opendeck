/**
 * AbletonLinkNode — a clean-room, MIT implementation of the Ableton Link wire
 * protocol (tempo, beat, phase, start/stop) for the Electron main process.
 *
 * Provenance: built only from black-box observation of the reference
 * LinkHutSilent example and public non-GPL descriptions; see
 * docs/link-cleanroom.md and the header of ./wire.ts. Behavioural rules below
 * marked [observed] were seen on the wire; rules marked [design] are our own
 * choices where observation did not pin the behaviour down.
 *
 * Model (LAC 2018 paper, §4–6):
 *  - each session has a "ghost" (global) clock; a peer maps its host clock to
 *    it with an offset measured by ping/pong against a session member;
 *  - the session timeline is (tempo, beat origin, ghost time origin);
 *  - a newcomer whose session is younger joins the older one [observed: in six
 *    trials the second LinkHut always joined the first, whatever the ids].
 *
 * Like opendeck-link/1 it owns tempo/beat/phase/start-stop intent only and has
 * no handle on any deck or sample position (D35).
 */

import dgram from "node:dgram";
import os from "node:os";
import type { LinkBackend, LinkStatus } from "../link-backend.ts";
import {
  DEFAULT_TTL_SECONDS,
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
  microsPerBeatToBpm,
  phaseOf,
  randomPeerId,
  retempo,
  sameTimeline,
  type DiscoveryMessage,
  type WireEndpoint,
  type WireStartStop,
  type WireTimeline,
} from "./wire.ts";

export const ABLETON_LINK_PROTOCOL_ID = "ableton-link";

/** [observed] the reference peer sends an alive every 250 ms. */
const ALIVE_INTERVAL_MS = 250;
/** [design] samples per measurement burst; the reference peer did ~50. */
const MEASURE_SAMPLES = 40;
const MEASURE_TIMEOUT_MS = 1_500;
const MEASURE_RETRY_MS = 3_000;
/** [design] ghost-time ties closer than this are broken by session id. */
const SESSION_TIE_MICROS = 1_000;
const MIN_BPM = 20;
const MAX_BPM = 999;

export interface AbletonLinkOptions {
  peerId?: string;
  group?: string;
  port?: number;
  /** IPv4 interface addresses to use. Default: every IPv4 interface, loopback included. */
  interfaces?: string[];
  /** Host clock in µs. Default: monotonic process.hrtime. */
  nowMicros?: () => number;
  aliveIntervalMs?: number;
  quantum?: number;
  initialBpm?: number;
}

interface PeerState {
  sessionId: string;
  timeline?: WireTimeline;
  /** Last timeline seen per channel (alive = multicast, response = unicast). */
  lastByChannel: Map<number, WireTimeline>;
  startStop?: WireStartStop;
  endpoint?: WireEndpoint;
  lastSeen: number;
  ttlMs: number;
}

interface Iface {
  address: string;
  netmask: string;
  send: dgram.Socket;
  measure: dgram.Socket;
  measurePort: number;
}

interface Measurement {
  sessionId: string;
  endpoint: WireEndpoint;
  via: Iface;
  samples: number[];
  pendingHost: bigint | null;
  lastGhost: bigint | null;
  timer: ReturnType<typeof setTimeout>;
  timeline?: WireTimeline;
}

const defaultClock = (): number => Number(process.hrtime.bigint() / 1000n);

const ipToInt = (ip: string): number => ip.split(".").reduce((acc, n) => (acc << 8) + Number(n), 0) >>> 0;
const sameSubnet = (a: string, b: string, mask: string): boolean => ((ipToInt(a) ^ ipToInt(b)) & ipToInt(mask)) === 0;

const clampBpm = (bpm: number): number => (Number.isFinite(bpm) ? Math.max(MIN_BPM, Math.min(MAX_BPM, bpm)) : 120);

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function listIPv4Interfaces(): { address: string; netmask: string }[] {
  const out: { address: string; netmask: string }[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === "IPv4") out.push({ address: info.address, netmask: info.netmask });
    }
  }
  return out;
}

/**
 * [design] Session precedence: the session whose ghost clock reads later (it
 * was founded earlier) wins; near-ties go to the lower session id.
 */
export function shouldJoinSession(ourGhostNow: number, theirGhostNow: number, ourSession: string, theirSession: string): boolean {
  if (theirGhostNow > ourGhostNow + SESSION_TIE_MICROS) return true;
  if (theirGhostNow < ourGhostNow - SESSION_TIE_MICROS) return false;
  return theirSession < ourSession;
}

/** Offset (ghost − host) from one ping/pong: ghost sampled at the midpoint of the round trip. */
export const offsetSample = (hostSent: number, hostReceived: number, ghost: number): number => ghost - (hostSent + hostReceived) / 2;

export class AbletonLinkNode implements LinkBackend {
  readonly peerId: string;
  readonly protocolId = ABLETON_LINK_PROTOCOL_ID;
  readonly backend = "ableton" as const;

  private readonly group: string;
  private readonly port: number;
  private readonly wantedInterfaces: string[] | undefined;
  private readonly clock: () => number;
  private readonly aliveIntervalMs: number;

  private recv: dgram.Socket | null = null;
  private ifaces: Iface[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private enabled = false;
  private lastError: string | null = null;
  private counters = { sent: 0, received: 0, adopted: 0, rejected: 0 };

  private sessionId: string;
  /** ghost = host + ghostOffset (µs). */
  private ghostOffset = 0;
  private timeline: WireTimeline;
  private startStop: WireStartStop = { playing: false, beats: 0n, timestamp: 0n };
  private startStopSync = false;
  private quantum: number;
  private localBpm: number;
  private preLinkBpm: number | null = null;

  private peers = new Map<string, PeerState>();
  private measurements = new Map<string, Measurement>();
  private lastMeasured = new Map<string, number>();

  constructor(options: AbletonLinkOptions = {}) {
    this.peerId = options.peerId ?? randomPeerId();
    this.group = options.group ?? LINK_MULTICAST_GROUP;
    this.port = options.port ?? LINK_MULTICAST_PORT;
    this.wantedInterfaces = options.interfaces;
    this.clock = options.nowMicros ?? defaultClock;
    this.aliveIntervalMs = options.aliveIntervalMs ?? ALIVE_INTERVAL_MS;
    this.quantum = options.quantum && options.quantum > 0 ? options.quantum : 4;
    this.localBpm = clampBpm(options.initialBpm ?? 120);
    this.sessionId = this.peerId;
    this.ghostOffset = -this.clock();
    this.timeline = { microsPerBeat: bpmToMicrosPerBeat(this.localBpm), beatOrigin: 0n, timeOrigin: 0n };
  }

  // ------------------------------------------------------------ clocks

  now(): number {
    return this.clock();
  }

  ghostNow(): number {
    return this.clock() + this.ghostOffset;
  }

  get sessionTempo(): number {
    return microsPerBeatToBpm(this.timeline.microsPerBeat);
  }

  get session(): string {
    return this.sessionId;
  }

  get peerCount(): number {
    this.sweep();
    let n = 0;
    for (const p of this.peers.values()) if (p.sessionId === this.sessionId) n += 1;
    return n;
  }

  /** Current wire timeline (for tests and the smoke). */
  get wireTimeline(): WireTimeline {
    return { ...this.timeline };
  }

  beatAt(nowMicros = this.clock()): number {
    return beatAtGhost(this.timeline, nowMicros + this.ghostOffset);
  }

  phaseAt(nowMicros = this.clock()): number {
    return phaseOf(this.beatAt(nowMicros), this.quantum);
  }

  // --------------------------------------------------------- lifecycle

  async enable(): Promise<LinkStatus> {
    if (this.enabled) return this.status();
    this.lastError = null;
    this.preLinkBpm = this.sessionTempo;
    // [observed] a fresh peer founds its own session with ghost time ~0 at enable.
    const host = this.clock();
    const beatNow = this.beatAt(host);
    this.sessionId = this.peerId;
    this.ghostOffset = -host;
    this.timeline = { microsPerBeat: bpmToMicrosPerBeat(this.localBpm), beatOrigin: BigInt(Math.round(beatNow * 1e6)), timeOrigin: 0n };
    this.peers.clear();

    try {
      await this.openSockets();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.closeSockets();
      return this.status();
    }
    this.enabled = true;
    this.broadcast(MSG_ALIVE);
    this.heartbeat = setInterval(() => {
      this.sweep();
      this.broadcast(MSG_ALIVE);
    }, this.aliveIntervalMs);
    this.heartbeat.unref?.();
    return this.status();
  }

  async disable(): Promise<LinkStatus> {
    if (this.enabled) this.broadcast(MSG_BYEBYE);
    this.enabled = false;
    this.closeSockets();
    this.peers.clear();
    const restored = this.preLinkBpm ?? this.sessionTempo;
    this.preLinkBpm = null;
    this.localBpm = clampBpm(restored);
    const host = this.clock();
    this.timeline = retempo(this.timeline, this.localBpm, host + this.ghostOffset);
    this.sessionId = this.peerId;
    return this.status();
  }

  private async openSockets(): Promise<void> {
    const all = listIPv4Interfaces();
    const chosen = this.wantedInterfaces
      ? this.wantedInterfaces.map((address) => all.find((i) => i.address === address) ?? { address, netmask: "255.255.255.255" })
      : all;
    if (chosen.length === 0) throw new Error("no IPv4 network interface");

    const recv = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.recv = recv;
    recv.on("message", (msg, rinfo) => this.onDiscovery(msg, rinfo, true));
    recv.on("error", (error) => (this.lastError = error.message));
    await new Promise<void>((resolve, reject) => {
      recv.once("error", reject);
      recv.bind(this.port, () => {
        recv.removeListener("error", reject);
        resolve();
      });
    });

    const errors: string[] = [];
    for (const info of chosen) {
      try {
        recv.addMembership(this.group, info.address);
        const send = await this.bindSocket(info.address);
        send.setMulticastInterface(info.address);
        send.setMulticastTTL(1);
        send.setMulticastLoopback(true);
        send.on("message", (msg, rinfo) => this.onDiscovery(msg, rinfo, false));
        const measure = await this.bindSocket(info.address);
        const iface: Iface = { address: info.address, netmask: info.netmask, send, measure, measurePort: measure.address().port };
        measure.on("message", (msg, rinfo) => this.onMeasurement(iface, msg, rinfo));
        this.ifaces.push(iface);
      } catch (error) {
        errors.push(`${info.address}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (this.ifaces.length === 0) throw new Error(`could not join ${this.group} on any interface (${errors.join("; ")})`);
  }

  private bindSocket(address: string): Promise<dgram.Socket> {
    const socket = dgram.createSocket({ type: "udp4" });
    socket.on("error", (error) => (this.lastError = error.message));
    return new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, address, () => {
        socket.removeListener("error", reject);
        resolve(socket);
      });
    });
  }

  private closeSockets(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const m of this.measurements.values()) clearTimeout(m.timer);
    this.measurements.clear();
    this.lastMeasured.clear();
    const close = (s: dgram.Socket | null): void => {
      try {
        s?.close();
      } catch {
        /* already closed */
      }
    };
    close(this.recv);
    this.recv = null;
    for (const i of this.ifaces) {
      close(i.send);
      close(i.measure);
    }
    this.ifaces = [];
  }

  // ------------------------------------------------------------- tempo

  setLocalTempo(bpm: number): LinkStatus {
    this.localBpm = clampBpm(bpm);
    this.timeline = retempo(this.timeline, this.localBpm, this.ghostNow());
    if (this.enabled) this.broadcast(MSG_ALIVE);
    return this.status();
  }

  setQuantum(quantum: number): LinkStatus {
    if (Number.isFinite(quantum) && quantum > 0) this.quantum = quantum;
    return this.status();
  }

  setStartStopSync(on: boolean): LinkStatus {
    this.startStopSync = on;
    if (this.enabled) this.broadcast(MSG_ALIVE);
    return this.status();
  }

  setPlaying(playing: boolean): LinkStatus {
    const ghost = this.ghostNow();
    this.startStop = {
      playing,
      beats: BigInt(Math.round(beatAtGhost(this.timeline, ghost) * 1e6)),
      timestamp: BigInt(Math.round(ghost)),
    };
    if (this.enabled) this.broadcast(MSG_ALIVE);
    return this.status();
  }

  status(): LinkStatus {
    const sessionBpm = this.sessionTempo;
    const peerCount = this.peerCount;
    let status: string;
    if (this.lastError && !this.enabled) status = `Ableton Link unavailable · ${this.lastError}`;
    else if (!this.enabled) status = `Ableton Link off · ${sessionBpm.toFixed(1)} BPM`;
    else status = `Ableton Link · ${peerCount === 1 ? "1 peer" : `${peerCount} peers`} · ${sessionBpm.toFixed(1)} BPM`;
    return {
      enabled: this.enabled,
      peerCount,
      sessionBpm,
      localBpm: this.localBpm,
      beat: this.beatAt(),
      phase: this.phaseAt(),
      quantum: this.quantum,
      status,
      protocol: ABLETON_LINK_PROTOCOL_ID,
      backend: "ableton",
      startStopSync: this.startStopSync,
      playing: this.startStop.playing,
      error: this.lastError,
      counters: { ...this.counters },
    };
  }

  // ------------------------------------------------------- discovery

  private discoveryMessage(type: number, iface: Iface): Buffer {
    if (type === MSG_BYEBYE) return encodeDiscovery({ type, ttl: 0, group: 0, peerId: this.peerId });
    // [observed] with start/stop sync off the reference peer advertises an all-zero stst.
    const startStop = this.startStopSync ? this.startStop : { playing: false, beats: 0n, timestamp: 0n };
    return encodeDiscovery({
      type,
      ttl: DEFAULT_TTL_SECONDS,
      group: 0,
      peerId: this.peerId,
      timeline: this.timeline,
      sessionId: this.sessionId,
      startStop,
      endpoint: { address: iface.address, port: iface.measurePort },
    });
  }

  private broadcast(type: number): void {
    for (const iface of this.ifaces) {
      const buf = this.discoveryMessage(type, iface);
      iface.send.send(buf, this.port, this.group, (error) => {
        if (error) this.lastError = error.message;
        else this.counters.sent += 1;
      });
    }
  }

  private ifaceFor(address: string): Iface | undefined {
    return this.ifaces.find((i) => sameSubnet(i.address, address, i.netmask)) ?? this.ifaces.find((i) => i.address === address) ?? this.ifaces[0];
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, peer] of this.peers) if (now - peer.lastSeen > peer.ttlMs) this.peers.delete(id);
  }

  /** Exposed for unit tests: feed one decoded discovery message. */
  handleDiscovery(msg: DiscoveryMessage, from?: { address: string; port: number }, viaMulticast = true): void {
    if (msg.peerId === this.peerId) return;
    if (msg.type === MSG_BYEBYE) {
      this.peers.delete(msg.peerId);
      return;
    }
    if (!msg.sessionId || !msg.timeline) {
      this.counters.rejected += 1;
      return;
    }
    const timeline = msg.timeline;
    this.counters.received += 1;
    const prev = this.peers.get(msg.peerId);
    const channelPrev = prev && prev.sessionId === msg.sessionId ? prev.lastByChannel.get(msg.type) : undefined;
    const lastByChannel = prev && prev.sessionId === msg.sessionId ? prev.lastByChannel : new Map<number, WireTimeline>();
    lastByChannel.set(msg.type, msg.timeline);
    const peer: PeerState = {
      sessionId: msg.sessionId,
      timeline: msg.timeline,
      lastByChannel,
      startStop: msg.startStop,
      endpoint: msg.endpoint,
      lastSeen: Date.now(),
      ttlMs: Math.max(1, msg.ttl) * 1000,
    };
    this.peers.set(msg.peerId, peer);

    this.applyPeer({ ...msg, timeline }, peer, channelPrev);

    // [observed] an alive is answered by a unicast response to its source port.
    // Sent after applying the message so it carries our updated state.
    if (this.enabled && viaMulticast && msg.type === MSG_ALIVE && from) {
      const iface = this.ifaceFor(from.address);
      if (iface) iface.send.send(this.discoveryMessage(MSG_RESPONSE, iface), from.port, from.address);
    }
  }

  private applyPeer(msg: DiscoveryMessage & { timeline: WireTimeline }, peer: PeerState, channelPrev: WireTimeline | undefined): void {
    if (peer.sessionId === this.sessionId) {
      // [design] adopt a session peer's timeline when *that peer* changed it, as
      // seen on one channel (alive and response travel on different sockets and
      // can interleave), so a stale echo never reverts a newer change.
      const changed = channelPrev !== undefined && !sameTimeline(channelPrev, peer.timeline);
      if (changed && !sameTimeline(peer.timeline, this.timeline)) {
        this.timeline = { ...msg.timeline };
        this.counters.adopted += 1;
        if (this.enabled) this.broadcast(MSG_ALIVE);
      }
      if (this.startStopSync && msg.startStop && msg.startStop.timestamp > this.startStop.timestamp) {
        this.startStop = { ...msg.startStop };
      }
      return;
    }

    // A peer of a different session: measure it, then decide who joins whom.
    if (this.enabled && msg.endpoint) this.startMeasurement(peer.sessionId, msg.endpoint, msg.timeline);
  }

  private onDiscovery(buf: Buffer, rinfo: dgram.RemoteInfo, viaMulticast: boolean): void {
    const msg = decodeDiscovery(buf);
    if (!msg) {
      this.counters.rejected += 1;
      return;
    }
    this.handleDiscovery(msg, { address: rinfo.address, port: rinfo.port }, viaMulticast);
  }

  // ----------------------------------------------------- measurement

  private startMeasurement(sessionId: string, endpoint: WireEndpoint, timeline: WireTimeline): void {
    const existing = this.measurements.get(sessionId);
    if (existing) {
      existing.timeline = timeline;
      return;
    }
    const last = this.lastMeasured.get(sessionId);
    if (last !== undefined && Date.now() - last < MEASURE_RETRY_MS) return;
    const via = this.ifaceFor(endpoint.address);
    if (!via) return;
    const m: Measurement = {
      sessionId,
      endpoint,
      via,
      samples: [],
      pendingHost: null,
      lastGhost: null,
      timeline,
      timer: setTimeout(() => this.finishMeasurement(sessionId), MEASURE_TIMEOUT_MS),
    };
    m.timer.unref?.();
    this.measurements.set(sessionId, m);
    this.sendPing(m);
  }

  private sendPing(m: Measurement): void {
    const host = BigInt(Math.round(this.clock()));
    m.pendingHost = host;
    const buf = encodeMeasurement({ type: MSG_PING, hostTime: host, prevGhostTime: m.lastGhost ?? undefined });
    m.via.measure.send(buf, m.endpoint.port, m.endpoint.address);
  }

  private onMeasurement(iface: Iface, buf: Buffer, rinfo: dgram.RemoteInfo): void {
    const msg = decodeMeasurement(buf);
    if (!msg) {
      this.counters.rejected += 1;
      return;
    }
    if (msg.type === MSG_PING) {
      // Answer with our session id and ghost time; echo the host time and _pgt.
      const pong = encodeMeasurement({
        type: MSG_PONG,
        sessionId: this.sessionId,
        ghostTime: BigInt(Math.round(this.ghostNow())),
        hostTime: msg.hostTime,
        prevGhostTime: msg.prevGhostTime,
      });
      iface.measure.send(pong, rinfo.port, rinfo.address);
      return;
    }
    const received = this.clock();
    const m = msg.sessionId ? this.measurements.get(msg.sessionId) : undefined;
    if (!m || msg.hostTime === undefined || msg.ghostTime === undefined) return;
    if (m.pendingHost === null || msg.hostTime !== m.pendingHost) return; // late or duplicate pong
    m.samples.push(offsetSample(Number(msg.hostTime), received, Number(msg.ghostTime)));
    m.lastGhost = msg.ghostTime;
    m.pendingHost = null;
    if (m.samples.length >= MEASURE_SAMPLES) this.finishMeasurement(m.sessionId);
    else this.sendPing(m);
  }

  private finishMeasurement(sessionId: string): void {
    const m = this.measurements.get(sessionId);
    if (!m) return;
    clearTimeout(m.timer);
    this.measurements.delete(sessionId);
    this.lastMeasured.set(sessionId, Date.now());
    if (m.samples.length < 3 || !this.enabled || sessionId === this.sessionId) return;
    const theirOffset = median(m.samples);
    const host = this.clock();
    if (!shouldJoinSession(host + this.ghostOffset, host + theirOffset, this.sessionId, sessionId)) return;
    // Join: adopt their ghost clock, session id and the freshest timeline any of
    // their members advertised.
    let timeline = m.timeline;
    for (const p of this.peers.values()) if (p.sessionId === sessionId && p.timeline) timeline = p.timeline;
    this.ghostOffset = theirOffset;
    this.sessionId = sessionId;
    if (timeline) this.timeline = { ...timeline };
    this.counters.adopted += 1;
    this.broadcast(MSG_ALIVE);
  }
}

export const createAbletonLinkNode = (options: AbletonLinkOptions = {}): AbletonLinkNode => new AbletonLinkNode(options);

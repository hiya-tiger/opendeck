/**
 * opendeck-link/1 — a session tempo/beat/phase transport for OpenDecks.
 *
 * This is NOT Ableton Link and makes no claim to be. It is a small,
 * independently designed multicast protocol with a Link-shaped API. See
 * docs/mobile/ADR-D34.md for why (licence) and docs/mobile/LINK-PROBE.md for
 * what a human can and cannot verify.
 *
 * Design constraints honoured here:
 *  - runs in the Electron main process only; the renderer cannot open sockets;
 *  - owns session tempo, beat and phase, and nothing else. It has no reference
 *    to a transport, a deck, or a sample position, so it cannot drive one;
 *  - default-off; enabling is explicit.
 *
 * Wire format (one UDP datagram = one UTF-8 JSON object, <= 512 bytes):
 *   { p:"opendeck-link", v:1, peer, origin, ts, bpm, anchor, anchorBeat, quantum }
 *   ts      microseconds, monotonic key of the last tempo change (last-writer-wins)
 *   origin  peer id of the author of that change (tie-break when ts collides)
 *   anchor  microseconds; anchorBeat is the beat at that instant
 *   beat    = anchorBeat + (now - anchor) / 1e6 * bpm / 60
 *   phase   = beat mod quantum
 */

import dgram from "node:dgram";
import { randomUUID } from "node:crypto";

export const LINK_PROTOCOL = "opendeck-link";
export const LINK_PROTOCOL_VERSION = 1;
export const LINK_PROTOCOL_ID = `${LINK_PROTOCOL}/${LINK_PROTOCOL_VERSION}`;

/**
 * Deliberately NOT Ableton Link's group/port (239.255.77.77:20808). Using a
 * distinct group means this implementation cannot join, pollute or be mistaken
 * for a real Link session on the same LAN.
 */
export const LINK_GROUP = "239.255.77.88";
export const LINK_PORT = 29876;

const HEARTBEAT_MS = 200;
const PEER_TTL_MS = 2_000;
const MAX_PACKET_BYTES = 512;
const MIN_BPM = 20;
const MAX_BPM = 300;

export interface LinkStatus {
  /** True only while the socket is bound, joined and the heartbeat is running. */
  enabled: boolean;
  /** Live peers (a peer is live if heard from within PEER_TTL_MS). */
  peerCount: number;
  /** The session tempo the network currently agrees on. */
  sessionBpm: number;
  /** The tempo this node contributes / would contribute to the session. */
  localBpm: number;
  /** Session beat at the instant of the read. */
  beat: number;
  /** Session phase (beat mod quantum) at the instant of the read. */
  phase: number;
  quantum: number;
  /** Single-line string for the UI. Never claims Ableton compatibility. */
  status: string;
  protocol: string;
  /** Last socket error, or null. */
  error: string | null;
  counters: { sent: number; received: number; adopted: number; rejected: number };
}

export interface LinkNodeOptions {
  group?: string;
  port?: number;
  peerId?: string;
  /** Injectable clock in microseconds. Defaults to Date.now() * 1000. */
  nowMicros?: () => number;
  heartbeatMs?: number;
  /** Test hook: lets the smoke test shorten peer expiry. */
  peerTtlMs?: number;
}

interface Timeline {
  bpm: number;
  anchorMicros: number;
  anchorBeat: number;
  quantum: number;
  ts: number;
  origin: string;
}

interface PeerRecord {
  lastSeen: number;
  bpm: number;
}

const clampBpm = (bpm: number): number => {
  if (!Number.isFinite(bpm)) return 120;
  return Math.max(MIN_BPM, Math.min(MAX_BPM, bpm));
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export class LinkNode {
  readonly peerId: string;
  private readonly group: string;
  private readonly port: number;
  private readonly clock: () => number;
  private readonly heartbeatMs: number;
  private readonly peerTtlMs: number;

  private socket: dgram.Socket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private enabled = false;
  private lastError: string | null = null;
  private peers = new Map<string, PeerRecord>();
  private counters = { sent: 0, received: 0, adopted: 0, rejected: 0 };

  private timeline: Timeline;
  /** Tempo before enable(), restored by disable(). */
  private preLinkBpm: number | null = null;
  /** Last tempo this node asked the session to adopt. */
  private localBpm: number;

  constructor(options: LinkNodeOptions = {}) {
    this.peerId = options.peerId ?? randomUUID();
    this.group = options.group ?? LINK_GROUP;
    this.port = options.port ?? LINK_PORT;
    this.clock = options.nowMicros ?? (() => Math.round(performance.timeOrigin * 1000 + performance.now() * 1000));
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.peerTtlMs = options.peerTtlMs ?? PEER_TTL_MS;
    const now = this.clock();
    this.localBpm = 120;
    this.timeline = {
      bpm: 120,
      anchorMicros: now,
      anchorBeat: 0,
      quantum: 4,
      ts: now,
      origin: this.peerId,
    };
  }

  // ---------------------------------------------------------------- lifecycle

  async enable(): Promise<LinkStatus> {
    if (this.enabled) return this.status();
    if (this.socket) this.closeSocket();

    this.preLinkBpm = this.timeline.bpm;
    this.lastError = null;
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;
    socket.on("message", (message) => this.onMessage(message));

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          socket.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          socket.removeListener("error", onError);
          try {
            socket.addMembership(this.group);
            socket.setMulticastTTL(1);
            socket.setMulticastLoopback(true);
            resolve();
          } catch (error) {
            reject(error as Error);
          }
        };
        socket.once("error", onError);
        socket.once("listening", onListening);
        socket.bind(this.port);
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.closeSocket();
      this.enabled = false;
      return this.status();
    }

    socket.on("error", (error: Error) => {
      this.lastError = error.message;
    });

    this.enabled = true;
    this.broadcast();
    this.heartbeat = setInterval(() => this.onHeartbeat(), this.heartbeatMs);
    if (typeof this.heartbeat.unref === "function") this.heartbeat.unref();
    return this.status();
  }

  async disable(): Promise<LinkStatus> {
    this.closeSocket();
    this.enabled = false;
    this.peers.clear();
    const now = this.clock();
    // Restore the tempo the app had before Link was enabled. Transport state is
    // not represented in this object at all, so it cannot be touched.
    const restored = this.preLinkBpm ?? this.timeline.bpm;
    this.timeline = {
      bpm: restored,
      anchorMicros: now,
      anchorBeat: 0,
      quantum: this.timeline.quantum,
      ts: now,
      origin: this.peerId,
    };
    this.localBpm = restored;
    this.preLinkBpm = null;
    return this.status();
  }

  private closeSocket(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.dropMembership(this.group);
    } catch {
      /* socket may never have joined */
    }
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }

  // ------------------------------------------------------------------- tempo

  /** Read the tempo the session currently agrees on. */
  get sessionTempo(): number {
    return this.timeline.bpm;
  }

  get peerCount(): number {
    return this.peers.size;
  }

  /**
   * Contribute a tempo to the session. While enabled this becomes the session
   * tempo immediately and is published; while disabled it only sets the local
   * value (and therefore the value enable() will publish).
   */
  setLocalTempo(bpm: number): LinkStatus {
    const value = clampBpm(bpm);
    const now = this.clock();
    this.localBpm = value;
    this.timeline = {
      bpm: value,
      anchorMicros: now,
      anchorBeat: 0,
      quantum: this.timeline.quantum,
      ts: now,
      origin: this.peerId,
    };
    if (this.enabled) this.broadcast();
    return this.status();
  }

  beatAt(nowMicros = this.clock()): number {
    const elapsedSeconds = (nowMicros - this.timeline.anchorMicros) / 1e6;
    return this.timeline.anchorBeat + (elapsedSeconds * this.timeline.bpm) / 60;
  }

  phaseAt(nowMicros = this.clock()): number {
    const quantum = this.timeline.quantum > 0 ? this.timeline.quantum : 4;
    const beat = this.beatAt(nowMicros);
    const wrapped = beat % quantum;
    return wrapped < 0 ? wrapped + quantum : wrapped;
  }

  status(): LinkStatus {
    const sessionBpm = this.timeline.bpm;
    const peerCount = this.peers.size;
    let status: string;
    if (this.lastError && !this.enabled) {
      status = `link unavailable · ${this.lastError}`;
    } else if (!this.enabled) {
      status = `link off · ${sessionBpm.toFixed(1)} BPM`;
    } else {
      const peers = peerCount === 1 ? "1 peer" : `${peerCount} peers`;
      status = `link on · ${peers} · ${sessionBpm.toFixed(1)} BPM`;
    }
    return {
      enabled: this.enabled,
      peerCount,
      sessionBpm,
      localBpm: this.localBpm,
      beat: this.beatAt(),
      phase: this.phaseAt(),
      quantum: this.timeline.quantum,
      status,
      protocol: LINK_PROTOCOL_ID,
      error: this.lastError,
      counters: { ...this.counters },
    };
  }

  // ----------------------------------------------------------------- network

  private onHeartbeat(): void {
    this.sweepPeers();
    this.broadcast();
  }

  private sweepPeers(): void {
    const now = this.clock();
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > this.peerTtlMs) this.peers.delete(id);
    }
  }

  private broadcast(): void {
    const socket = this.socket;
    if (!socket || !this.enabled) return;
    const payload = Buffer.from(
      JSON.stringify({
        p: LINK_PROTOCOL,
        v: LINK_PROTOCOL_VERSION,
        peer: this.peerId,
        origin: this.timeline.origin,
        ts: this.timeline.ts,
        bpm: this.timeline.bpm,
        anchor: this.timeline.anchorMicros,
        anchorBeat: this.timeline.anchorBeat,
        quantum: this.timeline.quantum,
      }),
    );
    if (payload.length > MAX_PACKET_BYTES) return;
    socket.send(payload, 0, payload.length, this.port, this.group, (error) => {
      if (error) {
        this.lastError = error.message;
        return;
      }
      this.counters.sent += 1;
    });
  }

  private onMessage(message: Buffer): void {
    if (message.length > MAX_PACKET_BYTES) {
      this.counters.rejected += 1;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.toString("utf8"));
    } catch {
      this.counters.rejected += 1;
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      this.counters.rejected += 1;
      return;
    }
    const msg = parsed as Record<string, unknown>;
    if (msg.p !== LINK_PROTOCOL || msg.v !== LINK_PROTOCOL_VERSION) {
      this.counters.rejected += 1;
      return;
    }
    const peer = msg.peer;
    if (typeof peer !== "string" || peer === this.peerId) return;
    if (
      !isFiniteNumber(msg.ts) ||
      !isFiniteNumber(msg.bpm) ||
      !isFiniteNumber(msg.anchor) ||
      !isFiniteNumber(msg.anchorBeat)
    ) {
      this.counters.rejected += 1;
      return;
    }
    if (msg.bpm < MIN_BPM || msg.bpm > MAX_BPM) {
      this.counters.rejected += 1;
      return;
    }

    this.counters.received += 1;
    this.peers.set(peer, { lastSeen: this.clock(), bpm: msg.bpm });

    const origin = typeof msg.origin === "string" ? msg.origin : peer;
    if (!this.isNewer(msg.ts, origin)) return;

    const quantum = isFiniteNumber(msg.quantum) && msg.quantum > 0 ? msg.quantum : this.timeline.quantum;
    this.timeline = {
      bpm: msg.bpm,
      anchorMicros: msg.anchor,
      anchorBeat: msg.anchorBeat,
      quantum,
      ts: msg.ts,
      origin,
    };
    // Adopting never re-stamps ts and never rebroadcasts immediately: the next
    // heartbeat carries the adopted timeline verbatim, so two nodes cannot
    // ping-pong the tempo between them.
    this.counters.adopted += 1;
  }

  private isNewer(ts: number, origin: string): boolean {
    if (ts > this.timeline.ts) return true;
    if (ts < this.timeline.ts) return false;
    return origin > this.timeline.origin;
  }
}

export const createLinkNode = (options: LinkNodeOptions = {}): LinkNode => new LinkNode(options);

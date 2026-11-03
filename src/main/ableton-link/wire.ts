/**
 * Ableton Link wire codec, clean-room.
 *
 * Every constant and layout in this file was derived from black-box packet
 * captures of the reference LinkHutSilent example (built and run as an opaque
 * binary in an isolated directory) plus public, non-GPL descriptions of the
 * protocol (the LAC 2018 paper, CC BY-SA 4.0; ableton.github.io/link; the
 * Compellerai/link-bpm README, MIT/Apache-2.0). No Ableton source code was
 * read. The capture log and source list are in docs/link-cleanroom.md.
 *
 * All integers are big-endian. Times are microseconds, beats are micro-beats.
 *
 * Discovery datagram (UDP multicast 224.76.78.75:20808, plus unicast replies):
 *   "_asdp_v" 0x01 | type u8 | ttl u8 | group u16 | peerId 8 bytes | entries...
 *   type 1 = alive (multicast), 2 = response (unicast to the alive's source),
 *   3 = bye-bye (ttl 0, no entries).
 *   entry = key 4 ASCII bytes | length u32 | value
 *     "tmln" (24) tempo as µs-per-beat i64, beat origin µbeats i64, time origin µs i64
 *     "sess" (8)  session id (the founding peer's id)
 *     "stst" (17) playing u8, beats µbeats i64, timestamp µs i64
 *     "mep4" (6)  IPv4 address + u16 port of the peer's measurement endpoint
 *     "mep6" (18) IPv6 address + u16 port (ignored here)
 *
 * Measurement datagram (UDP unicast to a peer's mep4 endpoint):
 *   "_link_v" 0x01 | type u8 | entries...   type 1 = ping, 2 = pong
 *   ping entries: "__ht" host time i64, optional "_pgt" previous ghost time i64
 *   pong entries: "sess" 8 bytes, "__gt" responder ghost time i64,
 *                 "__ht" echoed, optional "_pgt" echoed
 */

export const LINK_MULTICAST_GROUP = "224.76.78.75";
export const LINK_MULTICAST_PORT = 20808;
export const DISCOVERY_MAGIC = Buffer.from("_asdp_v\u0001", "latin1");
export const MEASUREMENT_MAGIC = Buffer.from("_link_v\u0001", "latin1");

export const MSG_ALIVE = 1;
export const MSG_RESPONSE = 2;
export const MSG_BYEBYE = 3;
export const MSG_PING = 1;
export const MSG_PONG = 2;

/** Observed TTL (seconds) on every alive/response from the reference peer. */
export const DEFAULT_TTL_SECONDS = 5;
export const MAX_DATAGRAM = 512;

export interface WireTimeline {
  /** Microseconds per beat (60e6 / bpm, rounded). */
  microsPerBeat: bigint;
  /** Beat (in micro-beats) at timeOrigin. */
  beatOrigin: bigint;
  /** Ghost (session) time in microseconds. */
  timeOrigin: bigint;
}

export interface WireStartStop {
  playing: boolean;
  beats: bigint;
  timestamp: bigint;
}

export interface WireEndpoint {
  address: string;
  port: number;
}

export interface DiscoveryMessage {
  type: number;
  ttl: number;
  group: number;
  /** 8-byte peer id as 16 hex chars. */
  peerId: string;
  timeline?: WireTimeline;
  sessionId?: string;
  startStop?: WireStartStop;
  endpoint?: WireEndpoint;
}

export interface MeasurementMessage {
  type: number;
  hostTime?: bigint;
  ghostTime?: bigint;
  prevGhostTime?: bigint;
  sessionId?: string;
}

// ---------------------------------------------------------------- helpers

const isHexId = (id: string): boolean => /^[0-9a-f]{16}$/.test(id);

const i64 = (value: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(value);
  return b;
};

const entry = (key: string, value: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.write(key, 0, 4, "latin1");
  head.writeUInt32BE(value.length, 4);
  return Buffer.concat([head, value]);
};

const readEntries = (buf: Buffer, offset: number): Map<string, Buffer> | null => {
  const out = new Map<string, Buffer>();
  let off = offset;
  while (off < buf.length) {
    if (off + 8 > buf.length) return null;
    const key = buf.toString("latin1", off, off + 4);
    const len = buf.readUInt32BE(off + 4);
    if (off + 8 + len > buf.length) return null;
    out.set(key, buf.subarray(off + 8, off + 8 + len));
    off += 8 + len;
  }
  return out;
};

export const bpmToMicrosPerBeat = (bpm: number): bigint => BigInt(Math.round(60e6 / bpm));
export const microsPerBeatToBpm = (micros: bigint): number => 60e6 / Number(micros);

/** Random 8-byte peer id. The reference peer uses printable ASCII bytes; we do the same. */
export const randomPeerId = (rand: () => number = Math.random): string => {
  const bytes = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) bytes[i] = 0x21 + Math.floor(rand() * 94);
  return bytes.toString("hex");
};

// --------------------------------------------------------------- discovery

export function encodeDiscovery(msg: DiscoveryMessage): Buffer {
  if (!isHexId(msg.peerId)) throw new Error("peerId must be 16 hex chars");
  const head = Buffer.alloc(12);
  DISCOVERY_MAGIC.copy(head, 0);
  head[8] = msg.type;
  head[9] = msg.ttl;
  head.writeUInt16BE(msg.group, 10);
  const parts: Buffer[] = [head, Buffer.from(msg.peerId, "hex")];
  if (msg.type !== MSG_BYEBYE) {
    if (msg.timeline) {
      parts.push(entry("tmln", Buffer.concat([i64(msg.timeline.microsPerBeat), i64(msg.timeline.beatOrigin), i64(msg.timeline.timeOrigin)])));
    }
    if (msg.sessionId) parts.push(entry("sess", Buffer.from(msg.sessionId, "hex")));
    if (msg.startStop) {
      parts.push(
        entry("stst", Buffer.concat([Buffer.from([msg.startStop.playing ? 1 : 0]), i64(msg.startStop.beats), i64(msg.startStop.timestamp)])),
      );
    }
    if (msg.endpoint) {
      const v = Buffer.alloc(6);
      const octets = msg.endpoint.address.split(".").map((n) => Number(n));
      if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error("bad IPv4 endpoint");
      octets.forEach((n, i) => (v[i] = n));
      v.writeUInt16BE(msg.endpoint.port, 4);
      parts.push(entry("mep4", v));
    }
  }
  return Buffer.concat(parts);
}

export function decodeDiscovery(buf: Buffer): DiscoveryMessage | null {
  if (buf.length < 20 || buf.length > MAX_DATAGRAM) return null;
  if (!buf.subarray(0, 8).equals(DISCOVERY_MAGIC)) return null;
  const type = buf[8];
  if (type !== MSG_ALIVE && type !== MSG_RESPONSE && type !== MSG_BYEBYE) return null;
  const msg: DiscoveryMessage = {
    type,
    ttl: buf[9],
    group: buf.readUInt16BE(10),
    peerId: buf.toString("hex", 12, 20),
  };
  const entries = readEntries(buf, 20);
  if (!entries) return null;
  const tl = entries.get("tmln");
  if (tl && tl.length === 24) {
    msg.timeline = { microsPerBeat: tl.readBigInt64BE(0), beatOrigin: tl.readBigInt64BE(8), timeOrigin: tl.readBigInt64BE(16) };
    if (msg.timeline.microsPerBeat <= 0n) return null;
  }
  const sess = entries.get("sess");
  if (sess && sess.length === 8) msg.sessionId = sess.toString("hex");
  const st = entries.get("stst");
  if (st && st.length === 17) msg.startStop = { playing: st[0] !== 0, beats: st.readBigInt64BE(1), timestamp: st.readBigInt64BE(9) };
  const ep = entries.get("mep4");
  if (ep && ep.length === 6) msg.endpoint = { address: `${ep[0]}.${ep[1]}.${ep[2]}.${ep[3]}`, port: ep.readUInt16BE(4) };
  return msg;
}

// ------------------------------------------------------------- measurement

export function encodeMeasurement(msg: MeasurementMessage): Buffer {
  const parts: Buffer[] = [MEASUREMENT_MAGIC, Buffer.from([msg.type])];
  if (msg.type === MSG_PONG) {
    if (!msg.sessionId || !isHexId(msg.sessionId)) throw new Error("pong needs a session id");
    parts.push(entry("sess", Buffer.from(msg.sessionId, "hex")));
    parts.push(entry("__gt", i64(msg.ghostTime ?? 0n)));
  }
  if (msg.hostTime !== undefined) parts.push(entry("__ht", i64(msg.hostTime)));
  if (msg.prevGhostTime !== undefined) parts.push(entry("_pgt", i64(msg.prevGhostTime)));
  return Buffer.concat(parts);
}

export function decodeMeasurement(buf: Buffer): MeasurementMessage | null {
  if (buf.length < 9 || buf.length > MAX_DATAGRAM) return null;
  if (!buf.subarray(0, 8).equals(MEASUREMENT_MAGIC)) return null;
  const type = buf[8];
  if (type !== MSG_PING && type !== MSG_PONG) return null;
  const entries = readEntries(buf, 9);
  if (!entries) return null;
  const msg: MeasurementMessage = { type };
  const read = (key: string): bigint | undefined => {
    const v = entries.get(key);
    return v && v.length === 8 ? v.readBigInt64BE(0) : undefined;
  };
  msg.hostTime = read("__ht");
  msg.ghostTime = read("__gt");
  msg.prevGhostTime = read("_pgt");
  const sess = entries.get("sess");
  if (sess && sess.length === 8) msg.sessionId = sess.toString("hex");
  if (type === MSG_PONG && (msg.ghostTime === undefined || msg.hostTime === undefined || !msg.sessionId)) return null;
  if (type === MSG_PING && msg.hostTime === undefined) return null;
  return msg;
}

// ---------------------------------------------------------- timeline maths

/** Beat (as a float) on a wire timeline at a ghost time (µs). */
export function beatAtGhost(tl: WireTimeline, ghostMicros: number): number {
  const mpb = Number(tl.microsPerBeat);
  return Number(tl.beatOrigin) / 1e6 + (ghostMicros - Number(tl.timeOrigin)) / mpb;
}

/** Ghost time (µs) at which the timeline reaches a beat. */
export function ghostAtBeat(tl: WireTimeline, beat: number): number {
  return Number(tl.timeOrigin) + (beat - Number(tl.beatOrigin) / 1e6) * Number(tl.microsPerBeat);
}

/** A new timeline at `bpm` that passes through the old one's beat at `ghostMicros` (tempo change keeps beat continuous). */
export function retempo(tl: WireTimeline, bpm: number, ghostMicros: number): WireTimeline {
  const beat = beatAtGhost(tl, ghostMicros);
  return { microsPerBeat: bpmToMicrosPerBeat(bpm), beatOrigin: BigInt(Math.round(beat * 1e6)), timeOrigin: BigInt(Math.round(ghostMicros)) };
}

export const sameTimeline = (a: WireTimeline | undefined, b: WireTimeline | undefined): boolean =>
  !!a && !!b && a.microsPerBeat === b.microsPerBeat && a.beatOrigin === b.beatOrigin && a.timeOrigin === b.timeOrigin;

/** Phase in [0, quantum). */
export const phaseOf = (beat: number, quantum: number): number => {
  const q = quantum > 0 ? quantum : 4;
  const r = beat % q;
  return r < 0 ? r + q : r;
};

/**
 * LinkBackend — the seam behind TempoAuthority (docs/mobile/ADR-D35.md) for
 * session tempo transports. Two implementations ship:
 *
 *  - "ableton":  AbletonLinkNode (src/main/ableton-link/node.ts), a clean-room
 *                implementation of the Ableton Link wire protocol (D43,
 *                docs/link-cleanroom.md). Interoperates with Link peers.
 *  - "opendeck": LinkNode (src/main/link.ts), the original opendeck-link/1
 *                protocol (D34). OpenDecks-to-OpenDecks only. Kept as the
 *                fallback.
 *
 * A backend owns session tempo, beat, phase and (optionally) start/stop
 * intent, and nothing else: it never touches a deck or a sample position.
 */

export type LinkProtocolChoice = "ableton" | "opendeck";

export const LINK_PROTOCOL_CHOICES: readonly LinkProtocolChoice[] = ["ableton", "opendeck"];

export const isLinkProtocolChoice = (value: unknown): value is LinkProtocolChoice =>
  value === "ableton" || value === "opendeck";

export interface LinkStatus {
  /** True only while the sockets are bound, joined and the heartbeat is running. */
  enabled: boolean;
  /** Live peers in this node's session. */
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
  /** Single-line string for the UI. */
  status: string;
  /** Wire protocol identifier, e.g. "opendeck-link/1" or "ableton-link". */
  protocol: string;
  /** Which backend produced this status. */
  backend?: LinkProtocolChoice;
  /** Start/stop sync (Ableton backend only). */
  startStopSync?: boolean;
  playing?: boolean;
  /** Last socket error, or null. */
  error: string | null;
  counters: { sent: number; received: number; adopted: number; rejected: number };
}

export interface LinkBackend {
  readonly peerId: string;
  readonly protocolId: string;
  readonly backend: LinkProtocolChoice;
  enable(): Promise<LinkStatus>;
  disable(): Promise<LinkStatus>;
  setLocalTempo(bpm: number): LinkStatus;
  status(): LinkStatus;
  readonly sessionTempo: number;
  readonly peerCount: number;
  /** Host clock in microseconds, the clock beatAt/phaseAt take. */
  now(): number;
  beatAt(nowMicros?: number): number;
  phaseAt(nowMicros?: number): number;
  setQuantum?(quantum: number): LinkStatus;
  setStartStopSync?(on: boolean): LinkStatus;
  setPlaying?(playing: boolean): LinkStatus;
}

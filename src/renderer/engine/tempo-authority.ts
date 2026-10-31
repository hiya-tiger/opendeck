/**
 * TempoAuthority — the single owner of session BPM, beat and phase.
 * See docs/mobile/ADR-D35.md.
 *
 * Inputs: manual BPM, the master deck's reference BPM, and the Link node's
 * session tempo. None of them owns the value; this object does.
 *
 * It has no reference to a Deck, a PcmSource, a media element or a transport
 * clock, and it exposes no method that could move playback. Link therefore
 * cannot drive sample position through it.
 */

export type TempoSource = "link" | "manual" | "deck" | "default";

export interface LinkTempoStatus {
  enabled: boolean;
  sessionBpm: number;
  beat: number;
  phase: number;
  quantum: number;
}

export interface TempoSnapshot {
  bpm: number;
  beat: number;
  phase: number;
  quantum: number;
  source: TempoSource;
  linkEnabled: boolean;
}

export interface TempoAuthorityOptions {
  /** Milliseconds. Injectable so tests do not depend on wall time. */
  now?: () => number;
  quantum?: number;
  defaultBpm?: number;
  /**
   * Called when a manual BPM change must be contributed to the Link session.
   * Wired by the shell to `opendeckDesktop.link.setLocalTempo`. Kept as a
   * callback so this module stays free of IPC and of the network.
   */
  onPushLink?: (bpm: number) => void;
}

const MIN_BPM = 20;
const MAX_BPM = 300;
const EPSILON = 1e-6;

const clampBpm = (bpm: number): number => {
  if (!Number.isFinite(bpm)) return 120;
  return Math.max(MIN_BPM, Math.min(MAX_BPM, bpm));
};

export class TempoAuthority {
  private readonly clock: () => number;
  private readonly onPushLink: ((bpm: number) => void) | undefined;
  private readonly defaultBpm: number;

  private quantum: number;
  private bpmValue: number;
  private anchorMs: number;
  private anchorBeat = 0;

  private manual: number | null = null;
  private deckBpm: number | null = null;
  private link: LinkTempoStatus | null = null;
  /** Session tempo at the instant Link was enabled; restored on disable. */
  private preLinkBpm: number | null = null;

  constructor(options: TempoAuthorityOptions = {}) {
    this.clock = options.now ?? (() => Date.now());
    this.onPushLink = options.onPushLink;
    this.defaultBpm = clampBpm(options.defaultBpm ?? 120);
    this.quantum = options.quantum && options.quantum > 0 ? options.quantum : 4;
    this.bpmValue = this.defaultBpm;
    this.anchorMs = this.clock();
  }

  get bpm(): number {
    return this.bpmValue;
  }

  get source(): TempoSource {
    if (this.link?.enabled) return "link";
    if (this.manual !== null) return "manual";
    if (this.deckBpm !== null) return "deck";
    return "default";
  }

  get linkEnabled(): boolean {
    return Boolean(this.link?.enabled);
  }

  beatAt(nowMs = this.clock()): number {
    return this.anchorBeat + ((nowMs - this.anchorMs) / 1000) * (this.bpmValue / 60);
  }

  phaseAt(nowMs = this.clock()): number {
    const wrapped = this.beatAt(nowMs) % this.quantum;
    return wrapped < 0 ? wrapped + this.quantum : wrapped;
  }

  snapshot(nowMs = this.clock()): TempoSnapshot {
    return {
      bpm: this.bpmValue,
      beat: this.beatAt(nowMs),
      phase: this.phaseAt(nowMs),
      quantum: this.quantum,
      source: this.source,
      linkEnabled: this.linkEnabled,
    };
  }

  /**
   * The master deck's reference BPM. Used only when Link is off and no manual
   * BPM has been set. Passing null clears it.
   */
  setDeckBpm(bpm: number | null): void {
    this.deckBpm = bpm !== null && Number.isFinite(bpm) && bpm > 0 ? clampBpm(bpm) : null;
    if (this.link?.enabled) return;
    if (this.manual !== null) return;
    this.reanchor(this.deckBpm ?? this.defaultBpm);
  }

  /**
   * A user-entered or fader-driven session BPM. While Link is enabled this is a
   * *contribution*: it is pushed to the session and then read back, so the
   * displayed value and the network value are the same number by construction.
   */
  setManualBpm(bpm: number): TempoSnapshot {
    const value = clampBpm(bpm);
    this.manual = value;
    if (this.link?.enabled) {
      this.onPushLink?.(value);
      this.link = { ...this.link, sessionBpm: value };
      this.reanchor(value);
      return this.snapshot();
    }
    this.reanchor(value);
    return this.snapshot();
  }

  /** Clear the manual override and fall back to the deck / default layer. */
  clearManualBpm(): TempoSnapshot {
    this.manual = null;
    if (this.link?.enabled) return this.snapshot();
    this.reanchor(this.deckBpm ?? this.defaultBpm);
    return this.snapshot();
  }

  /**
   * Feed a Link status read. Called on every poll while Link is on, and once
   * more with `enabled: false` after disabling.
   */
  onLinkStatus(status: LinkTempoStatus): TempoSnapshot {
    const wasEnabled = Boolean(this.link?.enabled);
    if (!status.enabled) {
      if (!wasEnabled) return this.snapshot();
      const restored = this.preLinkBpm ?? this.bpmValue;
      this.link = null;
      this.preLinkBpm = null;
      this.reanchor(restored);
      return this.snapshot();
    }
    if (!wasEnabled) {
      // Enabling Link never changes the local tempo; it publishes what we have.
      this.preLinkBpm = this.bpmValue;
      this.onPushLink?.(this.bpmValue);
    }
    this.link = {
      enabled: true,
      sessionBpm: clampBpm(status.sessionBpm),
      beat: Number.isFinite(status.beat) ? status.beat : 0,
      phase: Number.isFinite(status.phase) ? status.phase : 0,
      quantum: status.quantum > 0 ? status.quantum : this.quantum,
    };
    this.quantum = this.link.quantum;
    if (Math.abs(this.link.sessionBpm - this.bpmValue) > EPSILON) {
      this.bpmValue = this.link.sessionBpm;
    }
    // Track the session timeline rather than a locally free-running one, so the
    // displayed beat/phase is the session's.
    this.anchorMs = this.clock();
    this.anchorBeat = this.link.beat;
    return this.snapshot();
  }

  private reanchor(bpm: number): void {
    const now = this.clock();
    this.anchorBeat = this.beatAt(now);
    this.anchorMs = now;
    this.bpmValue = clampBpm(bpm);
  }
}

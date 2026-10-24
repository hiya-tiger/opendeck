import type { TimecodeDef } from "../timecode/defs.ts";
import { TimecodeDecoder, type TimecodeState } from "../timecode/decoder.ts";

export type DvsStatus = "idle" | "searching" | "locked" | "stalled" | "no-signal";
export type DvsMode = "internal" | "relative" | "absolute";

export interface DvsReading {
  status: DvsStatus;
  rate: number;
  positionSeconds: number;
  speedPercent: number;
  confidence: number;
  jump: number | null;
  carrierHz: number;
  mode: DvsMode;
  driftSeconds: number;
  driftOffsetSeconds: number;
  effectiveRate: number;
  effectivePositionSeconds: number;
  calibratedGain: number;
  gainScale: number;
  phaseBalance: number;
}

export interface DvsOptions {
  jumpSeconds?: number;
  rateSmoothing?: number;
  stallMs?: number;
  offsetSeconds?: number;
  reverse?: boolean;
  mode?: DvsMode;
  driftCorrection?: number;
}

export interface DvsCalibrationResult {
  calibratedGain: number;
  phaseBalance: number;
  rms: number;
}

export class DvsTransport {
  readonly def: TimecodeDef;
  readonly sampleRate: number;
  readonly decoder: TimecodeDecoder;
  private options: Required<DvsOptions>;
  private smoothRate = 0;
  private lastLockedAt = 0;
  private clock = 0;
  private lastPosition = -1;
  private pendingJump: number | null = null;
  private sawSignal = false;
  private lastBitCount = 0;
  private lastBitClock = 0;
  private relativeAnchor = 0;
  private calibratedGain = 1;
  private phaseBalance = 1;
  private lastDriftSeconds = 0;

  constructor(def: TimecodeDef, sampleRate: number, options: DvsOptions = {}, table?: Int32Array) {
    this.def = def;
    this.sampleRate = sampleRate;
    this.decoder = new TimecodeDecoder(def, sampleRate, table);
    this.options = {
      jumpSeconds: options.jumpSeconds ?? 0.4,
      rateSmoothing: options.rateSmoothing ?? 0.25,
      stallMs: options.stallMs ?? 250,
      offsetSeconds: options.offsetSeconds ?? 0,
      reverse: options.reverse ?? false,
      mode: options.mode ?? "absolute",
      driftCorrection: options.driftCorrection ?? 0.12,
    };
  }

  get mode(): DvsMode {
    return this.options.mode;
  }

  getMode(): DvsMode {
    return this.options.mode;
  }

  setRelativeOffset(offsetSeconds: number): void {
    this.setOffsetSeconds(offsetSeconds);
  }

  resetRelativeOffset(deckPositionSeconds = 0): void {
    this.relativeAnchor = this.decoder.state.positionSeconds - deckPositionSeconds;
  }

  setMode(mode: DvsMode): void {
    this.options.mode = mode;
    if (mode === "relative") {
      this.pendingJump = null;
    }
  }

  setOffsetSeconds(offsetSeconds: number): void {
    if (Number.isFinite(offsetSeconds)) {
      this.options.offsetSeconds = offsetSeconds;
    }
  }

  get offsetSeconds(): number {
    return this.options.offsetSeconds;
  }

  calibrate(left: Float32Array, right: Float32Array): DvsCalibrationResult {
    const n = Math.min(left.length, right.length);
    if (n === 0) {
      return { calibratedGain: this.calibratedGain, phaseBalance: this.phaseBalance, rms: 0 };
    }
    let sumL = 0;
    let sumR = 0;
    for (let i = 0; i < n; i += 1) {
      sumL += left[i] * left[i];
      sumR += right[i] * right[i];
    }
    const rmsL = Math.sqrt(sumL / n);
    const rmsR = Math.sqrt(sumR / n);
    const rms = Math.sqrt((sumL + sumR) / (2 * n));
    if (rms > 1e-4) {
      this.calibratedGain = Math.max(0.25, Math.min(8, 0.35 / rms));
    }
    if (rmsL > 1e-4 && rmsR > 1e-4) {
      this.phaseBalance = Math.max(0.5, Math.min(2, rmsL / rmsR));
    }
    return {
      calibratedGain: this.calibratedGain,
      phaseBalance: this.phaseBalance,
      rms,
    };
  }

  computeDriftCorrection(deckPositionSeconds: number): number {
    if (this.options.mode === "internal" || !this.decoder.state.locked) {
      this.lastDriftSeconds = 0;
      return 0;
    }
    const targetPosition =
      this.options.mode === "relative"
        ? this.decoder.state.positionSeconds - this.relativeAnchor + this.options.offsetSeconds
        : this.decoder.state.positionSeconds + this.options.offsetSeconds;
    const error = targetPosition - deckPositionSeconds;
    this.lastDriftSeconds = error;
    if (Math.abs(error) < 0.002) return 0;
    if (Math.abs(error) > this.options.jumpSeconds && this.options.mode === "absolute") {
      return 0;
    }
    return Math.max(-0.08, Math.min(0.08, error * this.options.driftCorrection));
  }

  push(left: Float32Array, right: Float32Array): DvsReading {
    this.clock += (left.length / this.sampleRate) * 1000;
    let energy = 0;
    for (let i = 0; i < left.length; i += 1) energy += left[i] * left[i] + right[i] * right[i];
    if (energy / (left.length * 2) > 1e-6) this.sawSignal = true;
    const previousBits = this.decoder.bitCount;
    this.decoder.push(left, right);
    if (this.decoder.bitCount !== previousBits) {
      this.lastBitCount = this.decoder.bitCount;
      this.lastBitClock = this.clock;
    }
    return this.read();
  }

  private read(): DvsReading {
    const state: TimecodeState = this.decoder.state;
    const sign = this.options.reverse ? -1 : 1;
    if (state.locked) {
      this.lastLockedAt = this.clock;
      const incoming = state.speed * sign;
      this.smoothRate += (incoming - this.smoothRate) * this.options.rateSmoothing;
      if (this.lastPosition >= 0) {
        const delta = state.positionSeconds - this.lastPosition;
        const jump = Math.abs(delta);
        if (jump > this.options.jumpSeconds) {
          if (this.options.mode === "relative") {
            this.relativeAnchor += delta;
          } else if (this.options.mode === "absolute") {
            this.pendingJump = state.positionSeconds;
          }
        }
      }
      this.lastPosition = state.positionSeconds;
    } else {
      this.smoothRate *= 0.8;
    }

    const stale = this.clock - this.lastLockedAt > this.options.stallMs;
    const silent = this.clock - this.lastBitClock > this.options.stallMs;
    let status: DvsStatus = "searching";
    if (this.options.mode === "internal") status = "idle";
    else if (!this.sawSignal) status = "no-signal";
    else if (state.locked && !silent) status = "locked";
    else if (stale || silent) status = "stalled";

    const jump = this.options.mode === "absolute" ? this.pendingJump : null;
    this.pendingJump = null;
    const rate = status === "locked" ? this.smoothRate : 0;
    const positionSeconds = state.locked
      ? this.options.mode === "relative"
        ? Math.max(0, state.positionSeconds - this.relativeAnchor + this.options.offsetSeconds)
        : state.positionSeconds + this.options.offsetSeconds
      : 0;
    return {
      status,
      rate,
      positionSeconds,
      speedPercent: rate * 100,
      confidence: state.confidence,
      jump,
      carrierHz: state.carrierHz,
      mode: this.options.mode,
      driftSeconds: this.lastDriftSeconds,
      driftOffsetSeconds: this.lastDriftSeconds,
      effectiveRate: rate,
      effectivePositionSeconds: positionSeconds,
      calibratedGain: this.calibratedGain,
      gainScale: this.calibratedGain,
      phaseBalance: this.phaseBalance,
    };
  }
}

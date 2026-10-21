import type { TimecodeDef } from "../timecode/defs.ts";
import { TimecodeDecoder, type TimecodeState } from "../timecode/decoder.ts";

export type DvsStatus = "idle" | "searching" | "locked" | "stalled" | "no-signal";

export interface DvsReading {
  status: DvsStatus;
  rate: number;
  positionSeconds: number;
  speedPercent: number;
  confidence: number;
  jump: number | null;
  carrierHz: number;
}

export interface DvsOptions {
  jumpSeconds?: number;
  rateSmoothing?: number;
  stallMs?: number;
  offsetSeconds?: number;
  reverse?: boolean;
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
    };
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
        const jump = Math.abs(state.positionSeconds - this.lastPosition);
        if (jump > this.options.jumpSeconds) this.pendingJump = state.positionSeconds;
      }
      this.lastPosition = state.positionSeconds;
    } else {
      this.smoothRate *= 0.8;
    }

    const stale = this.clock - this.lastLockedAt > this.options.stallMs;
    const silent = this.clock - this.lastBitClock > this.options.stallMs;
    let status: DvsStatus = "searching";
    if (!this.sawSignal) status = "no-signal";
    else if (state.locked && !silent) status = "locked";
    else if (stale || silent) status = "stalled";

    const jump = this.pendingJump;
    this.pendingJump = null;
    const rate = status === "locked" ? this.smoothRate : 0;
    return {
      status,
      rate,
      positionSeconds: state.locked
        ? state.positionSeconds + this.options.offsetSeconds
        : 0,
      speedPercent: rate * 100,
      confidence: state.confidence,
      jump,
      carrierHz: state.carrierHz,
    };
  }
}

import type { TimecodeDef } from "./defs.ts";
import { buildPositionTable, forward, maskOf, reverse, stateAt } from "./lfsr.ts";

export interface TimecodeState {
  locked: boolean;
  speed: number;
  position: number;
  positionSeconds: number;
  confidence: number;
  bitRate: number;
  direction: 1 | -1;
  carrierHz: number;
}

interface Hypothesis {
  dir: 1 | -1;
  register: number;
  expected: number;
  streak: number;
  hits: number;
}

const LOCK_BITS = 40;
const MAX_SPEED = 1.8;
const HIGH_LEVEL = 0.775;

export class TimecodeDecoder {
  readonly def: TimecodeDef;
  readonly sampleRate: number;
  readonly table: Int32Array;

  private hypotheses: Hypothesis[];
  private active = 0;
  private prevPrimary = 0;
  private prevSecondary = 0;
  private started = false;
  private sampleIndex = 0;
  private cyclePeak = 0;
  private cycles = 0;
  private peakMax = 0; private reference = 0;
  private lastBitSample = 0;
  private haveBitTime = false;
  private rate = 0;
  private position = -1;
  private positionSeconds = 0;
  private carrierRate = 0;
  private lowPrimary = 0;
  private lowSecondary = 0;
  private lowGain = 0;
  private bp: number[][] = [[0,0,0,0],[0,0,0,0]];
  private bq = { b0: 1, b2: 0, a1: 0, a2: 0 };
  private lastCrossing = 0;
  private acceptedBits = 0;

  constructor(def: TimecodeDef, sampleRate: number, table?: Int32Array) {
    this.def = def;
    this.sampleRate = sampleRate;
    this.table = table ?? buildPositionTable(def);
    this.hypotheses = this.seedHypotheses();
  }

  private seedHypotheses(): Hypothesis[] {
    const initial: Hypothesis[] = [];
    for (const dir of [1, -1] as const) {
      initial.push({ dir, register: 0, expected: 0, streak: 0, hits: 0 });
    }
    return initial;
  }

  reset(): void {
    this.hypotheses = this.seedHypotheses();
    this.active = 0;
    this.prevPrimary = 0;
    this.started = false;
    this.sampleIndex = 0;
    this.cyclePeak = 0;
    this.cycles = 0;
    this.peakMax = 0;
    this.reference = 0;
    this.lastBitSample = 0;
    this.haveBitTime = false;
    this.rate = 0;
    this.position = -1;
    this.positionSeconds = 0;
    this.carrierRate = 0;
    this.lowPrimary = 0;
    this.lowSecondary = 0;
    this.lastCrossing = -1000;
    this.acceptedBits = 0;
  }

  get lastBitSeconds(): number {
    return this.lastBitSample / this.sampleRate;
  }

  get bitCount(): number {
    return this.acceptedBits;
  }

  get state(): TimecodeState {
    const hypothesis = this.hypotheses[this.active];
    const locked = hypothesis.streak >= LOCK_BITS;
    const speed = locked ? this.rate * hypothesis.dir : 0;
    return {
      locked,
      speed: Math.abs(speed) > MAX_SPEED ? 0 : speed,
      position: this.position,
      positionSeconds: this.positionSeconds,
      confidence: Math.min(1, hypothesis.streak / (LOCK_BITS * 2)),
      bitRate: this.carrierRate,
      direction: hypothesis.dir,
      carrierHz: this.def.carrierHz,
    };
  }

  push(left: Float32Array, right: Float32Array): void {
    const primaryLeft = this.def.primary === "left";
    const count = Math.min(left.length, right.length);
    if (this.lowGain === 0) {
      const w0 = (2 * Math.PI * this.def.carrierHz) / this.sampleRate;
      const alpha = Math.sin(w0) / 2;
      const a0 = 1 + alpha;
      this.bq = {
        b0: alpha / a0,
        b2: -alpha / a0,
        a1: (-2 * Math.cos(w0)) / a0,
        a2: (1 - alpha) / a0,
      };
      this.lowGain = 1;
    }
    const minGap = Math.max(2, Math.floor(this.sampleRate / (this.def.carrierHz * 3.2)));
    for (let i = 0; i < count; i += 1) {
      const rawPrimary = primaryLeft ? left[i] : right[i];
      const rawSecondary = primaryLeft ? right[i] : left[i];
      const pState = this.bp[0];
      const sState = this.bp[1];
      this.lowPrimary =
        this.bq.b0 * rawPrimary + this.bq.b2 * pState[1] - this.bq.a1 * pState[2] - this.bq.a2 * pState[3];
      this.lowSecondary =
        this.bq.b0 * rawSecondary + this.bq.b2 * sState[1] - this.bq.a1 * sState[2] - this.bq.a2 * sState[3];
      pState[1] = pState[0];
      pState[0] = rawPrimary;
      pState[3] = pState[2];
      pState[2] = this.lowPrimary;
      sState[1] = sState[0];
      sState[0] = rawSecondary;
      sState[3] = sState[2];
      sState[2] = this.lowSecondary;
      const primary = this.lowPrimary;
      const secondary = this.lowSecondary;
      if (
        this.started &&
        this.prevPrimary < 0 &&
        primary >= 0 &&
        primary !== this.prevPrimary &&
        this.sampleIndex - this.lastCrossing >= minGap
      ) {
        const fraction = -this.prevPrimary / (primary - this.prevPrimary);
        const peak = Math.max(Math.abs(this.prevSecondary), Math.abs(secondary));
        this.lastCrossing = this.sampleIndex;
        this.closeCycle(peak, this.sampleIndex - 1 + fraction);
      }
      this.prevPrimary = primary;
      this.prevSecondary = secondary;
      this.sampleIndex += 1;
      this.started = true;
    }
  }

  private closeCycle(peak: number, at: number): void {
    this.cycles += 1;
    if (peak < 1e-4) return;
    if (peak > this.peakMax) this.peakMax = peak;
    else this.peakMax *= 0.9995;
    const bit = peak > this.peakMax * HIGH_LEVEL ? 1 : 0;
    this.acceptBit(bit, at);
  }

  private acceptBit(bit: number, at: number): void {
    const dt = at - this.lastBitSample;
    const validTiming = this.haveBitTime && dt > 0;
    if (validTiming) {
      const instant = this.sampleRate / dt / this.def.carrierHz;
      if (instant > 0.1 && instant < MAX_SPEED) {
        this.carrierRate =
          this.carrierRate === 0 ? instant : this.carrierRate * 0.85 + instant * 0.15;
      }
    }

    for (const hypothesis of this.hypotheses) {
      hypothesis.register =
        hypothesis.dir === 1
          ? ((hypothesis.register >>> 1) | (bit << (this.def.bits - 1))) & maskOf(this.def)
          : (((hypothesis.register << 1) & maskOf(this.def)) | bit) >>> 0;
      if (hypothesis.expected === 0) {
        hypothesis.expected = hypothesis.register;
        hypothesis.streak = 1;
      } else if (hypothesis.register === hypothesis.expected) {
        hypothesis.streak += 1;
        hypothesis.hits += 1;
      } else {
        hypothesis.expected = hypothesis.register;
        hypothesis.streak = 1;
      }
      hypothesis.expected =
        hypothesis.dir === 1
          ? forward(hypothesis.expected, this.def)
          : reverse(hypothesis.expected, this.def);
    }

    let best = 0;
    for (let i = 1; i < this.hypotheses.length; i += 1) {
      if (this.hypotheses[i].streak > this.hypotheses[best].streak) best = i;
    }
    if (best !== this.active) {
      this.active = best;
      this.rate = 0;
    }

    const chosen = this.hypotheses[this.active];
    if (chosen.streak >= LOCK_BITS) {
      const index = this.table[chosen.register];
      this.position = index;
      this.positionSeconds = index / this.def.carrierHz;
      if (validTiming && this.carrierRate > 0) this.rate = this.carrierRate;
    }

    this.lastBitSample = at;
    this.acceptedBits += 1;
    this.haveBitTime = true;
  }
}

export const decoderFor = (def: TimecodeDef, sampleRate: number): TimecodeDecoder =>
  new TimecodeDecoder(def, sampleRate);

export const positionAtBit = (def: TimecodeDef, bit: number): number =>
  stateAt(def, Math.max(0, Math.min(def.length - 1, bit)));

export { forward };

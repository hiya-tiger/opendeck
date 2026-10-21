import type { TimecodeDef } from "./defs.ts";
import { forward, stateAt } from "./lfsr.ts";

export interface EncodeOptions {
  sampleRate?: number;
  seconds: number;
  startBit?: number;
  speed?: number;
  amplitude?: number;
}

export interface EncodedSignal {
  left: Float32Array;
  right: Float32Array;
  durationSeconds: number;
  carrierHz: number;
}

export const encodeTimecode = (def: TimecodeDef, options: EncodeOptions): EncodedSignal => {
  const sampleRate = options.sampleRate ?? 48000;
  const speed = Math.abs(options.speed ?? 1);
  const amplitude = options.amplitude ?? 0.6;
  const startBit = Math.max(0, Math.floor(options.startBit ?? 0));
  const total = Math.round(sampleRate * options.seconds);
  const left = new Float32Array(total);
  const right = new Float32Array(total);

  let state = stateAt(def, startBit);
  let bit = (state >>> (def.bits - 1)) & 1;
  const carrier = def.carrierHz * speed;
  const step = (2 * Math.PI * carrier) / sampleRate;
  const primaryLeft = def.primary === "left";
  let phase = 0;

  for (let i = 0; i < total; i += 1) {
    const primary = Math.sin(phase) * amplitude;
    const secondary = Math.cos(phase) * (bit === 1 ? amplitude : amplitude * 0.5);
    if (primaryLeft) {
      left[i] = primary;
      right[i] = secondary;
    } else {
      left[i] = secondary;
      right[i] = primary;
    }
    const previous = phase;
    phase += step;
    if (phase >= 2 * Math.PI) phase -= 2 * Math.PI;
    if (previous < Math.PI / 2 && phase >= Math.PI / 2) {
      state = forward(state, def);
      bit = (state >>> (def.bits - 1)) & 1;
    }
  }

  return { left, right, durationSeconds: total / sampleRate, carrierHz: carrier };
};

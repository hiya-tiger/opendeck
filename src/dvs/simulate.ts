import type { TimecodeDef } from "../timecode/defs.ts";
import { encodeTimecode, type EncodeOptions } from "../timecode/encoder.ts";
import { DvsTransport } from "../dvs/transport.ts";

export interface SignalSpec extends EncodeOptions {
  noise?: number;
  gain?: number;
}

export const renderSignal = (def: TimecodeDef, spec: SignalSpec, sampleRate: number) => {
  const signal = encodeTimecode(def, { sampleRate, ...spec });
  const noise = spec.noise ?? 0;
  const gain = spec.gain ?? 1;
  for (let i = 0; i < signal.left.length; i += 1) {
    signal.left[i] = signal.left[i] * gain + (Math.random() * 2 - 1) * noise;
    signal.right[i] = signal.right[i] * gain + (Math.random() * 2 - 1) * noise;
  }
  return signal;
};

export const drive = (
  def: TimecodeDef,
  signal: { left: Float32Array; right: Float32Array },
  sampleRate: number,
  options: { block?: number; onBlock?: (reading: ReturnType<DvsTransport["push"]>, index: number) => void } = {},
) => {
  const block = options.block ?? 480;
  const transport = new DvsTransport(def, sampleRate);
  const readings = [];
  for (let offset = 0; offset < signal.left.length; offset += block) {
    const end = Math.min(offset + block, signal.left.length);
    const reading = transport.push(signal.left.subarray(offset, end), signal.right.subarray(offset, end));
    readings.push(reading);
    options.onBlock?.(reading, readings.length - 1);
  }
  return readings;
};

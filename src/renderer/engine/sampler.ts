export type SamplerKind =
  | "kick"
  | "snare"
  | "clap"
  | "hat"
  | "openhat"
  | "tom"
  | "rim"
  | "crash";

export interface SamplerPad {
  label: string;
  kind: SamplerKind;
}

export const SAMPLER_PADS: SamplerPad[] = [
  { label: "Kick", kind: "kick" },
  { label: "Snare", kind: "snare" },
  { label: "Clap", kind: "clap" },
  { label: "Hat", kind: "hat" },
  { label: "Open", kind: "openhat" },
  { label: "Tom", kind: "tom" },
  { label: "Rim", kind: "rim" },
  { label: "Crash", kind: "crash" },
];

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const makeNoise = (length: number): Float32Array => {
  const data = new Float32Array(length);
  let seed = 0x2f6e2b1;
  for (let i = 0; i < length; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data[i] = (seed / 0xffffffff) * 2 - 1;
  }
  return data;
};

export class Sampler {
  readonly gain: GainNode;
  private readonly ctx: AudioContext;
  private readonly buffers = new Map<number, AudioBuffer>();

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0.85;
    this.gain.connect(destination);
    SAMPLER_PADS.forEach((pad, index) => {
      this.buffers.set(index, this.render(pad.kind));
    });
  }

  setVolume(value: number): void {
    this.gain.gain.setTargetAtTime(clamp01(value), this.ctx.currentTime, 0.01);
  }

  trigger(index: number, velocity = 1): void {
    const buffer = this.buffers.get(index);
    if (!buffer) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const envelope = this.ctx.createGain();
    envelope.gain.value = clamp01(velocity) * 0.9;
    source.connect(envelope).connect(this.gain);
    source.start();
    source.onended = () => {
      source.disconnect();
      envelope.disconnect();
    };
  }

  private render(kind: SamplerKind): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const duration =
      kind === "crash" ? 1.6 : kind === "openhat" ? 0.5 : kind === "kick" ? 0.5 : 0.32;
    const length = Math.max(1, Math.floor(rate * duration));
    const buffer = this.ctx.createBuffer(1, length, rate);
    const out = buffer.getChannelData(0);
    const noise = makeNoise(length);
    const tau = 1 / rate;
    let phase = 0;

    for (let i = 0; i < length; i += 1) {
      const t = i * tau;
      switch (kind) {
        case "kick": {
          const hz = 48 + 132 * Math.exp(-t * 32);
          phase += (2 * Math.PI * hz) / rate;
          const body = Math.sin(phase) * Math.exp(-t * 7.5);
          const click = t < 0.004 ? noise[i] * 0.35 * (1 - t / 0.004) : 0;
          out[i] = body + click;
          break;
        }
        case "snare": {
          phase += (2 * Math.PI * 186) / rate;
          out[i] =
            noise[i] * Math.exp(-t * 17) * 0.7 +
            Math.sin(phase) * Math.exp(-t * 26) * 0.35;
          break;
        }
        case "clap": {
          const bursts = [0, 0.012, 0.024, 0.038];
          let gate = 0;
          for (const start of bursts) {
            if (t >= start && t < start + 0.012) {
              gate = Math.max(gate, 1 - (t - start) / 0.012);
            }
          }
          out[i] = noise[i] * (gate * 0.55 + Math.exp(-t * 18) * 0.45);
          break;
        }
        case "hat": {
          const high = noise[i] - (i > 0 ? noise[i - 1] : 0);
          out[i] = high * Math.exp(-t * 70) * 0.6;
          break;
        }
        case "openhat": {
          const high = noise[i] - (i > 0 ? noise[i - 1] : 0);
          out[i] = high * Math.exp(-t * 9) * 0.5;
          break;
        }
        case "tom": {
          const hz = 105 + 95 * Math.exp(-t * 24);
          phase += (2 * Math.PI * hz) / rate;
          out[i] = Math.sin(phase) * Math.exp(-t * 9) * 0.8;
          break;
        }
        case "rim": {
          phase += (2 * Math.PI * 1650) / rate;
          const square = Math.sin(phase) >= 0 ? 1 : -1;
          out[i] = square * Math.exp(-t * 80) * 0.4;
          break;
        }
        case "crash": {
          const high = noise[i] - (i > 0 ? noise[i - 1] : 0);
          const shimmer = Math.sin(2 * Math.PI * 5200 * t) * 0.12;
          out[i] = (high * 0.7 + shimmer * Math.exp(-t * 1.4)) * Math.exp(-t * 2.6);
          break;
        }
        default:
          break;
      }
    }

    let peak = 0;
    for (let i = 0; i < length; i += 1) peak = Math.max(peak, Math.abs(out[i]));
    if (peak > 0) {
      const scale = 0.82 / peak;
      for (let i = 0; i < length; i += 1) out[i] *= scale;
    }
    return buffer;
  }
}

export type FxType = "off" | "echo" | "delay" | "reverb" | "filter" | "flanger" | "phaser" | "crush";

export interface FxDef {
  id: FxType;
  label: string;
  beatSynced: boolean;
  hint: string;
}

export const FX_DEFS: FxDef[] = [
  { id: "off", label: "Off", beatSynced: false, hint: "dry signal" },
  { id: "echo", label: "Echo", beatSynced: true, hint: "beat-synced feedback delay" },
  { id: "delay", label: "Delay", beatSynced: true, hint: "ping-pong delay" },
  { id: "reverb", label: "Reverb", beatSynced: false, hint: "generated room impulse" },
  { id: "filter", label: "Filter", beatSynced: false, hint: "bipolar sweep, LP to HP" },
  { id: "flanger", label: "Flanger", beatSynced: true, hint: "modulated comb" },
  { id: "phaser", label: "Phaser", beatSynced: false, hint: "all-pass sweep" },
  { id: "crush", label: "Crush", beatSynced: false, hint: "bit and rate reduction" },
];

export const DIVISIONS = ["1/16", "1/8", "1/4", "3/8", "1/2", "1", "2", "4"] as const;
export type Division = (typeof DIVISIONS)[number];

const DIVISION_BEATS: Record<Division, number> = {
  "1/16": 0.25,
  "1/8": 0.5,
  "1/4": 1,
  "3/8": 1.5,
  "1/2": 2,
  "1": 4,
  "2": 8,
  "4": 16,
};

export const divisionBeats = (division: Division): number => DIVISION_BEATS[division];

export function delaySeconds(division: Division, bpm: number): number {
  const beats = divisionBeats(division);
  return (60 / Math.max(1, bpm)) * beats;
}

export function filterFrequency(amount: number): number {
  const clamped = Math.max(-1, Math.min(1, amount));
  const hz = 180 * Math.pow(20000 / 180, (clamped + 1) / 2);
  return Math.max(60, Math.min(19000, hz));
}

export function filterType(amount: number): BiquadFilterType {
  return amount >= 0 ? "lowpass" : "highpass";
}

export function crushCurve(amount: number): Float32Array<ArrayBuffer> {
  const steps = Math.max(2, Math.round(256 - amount * 248));
  const curve = new Float32Array(new ArrayBuffer(1024 * 4));
  for (let i = 0; i < curve.length; i += 1) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

export function wetGain(amount: number): number {
  return Math.max(0, Math.min(1, amount));
}

export function fxDefault(type: FxType): { division: Division; amount: number; wet: number } {
  switch (type) {
    case "echo":
      return { division: "1/4", amount: 0.4, wet: 0.55 };
    case "delay":
      return { division: "1/8", amount: 0.35, wet: 0.5 };
    case "reverb":
      return { division: "1/4", amount: 0.5, wet: 0.4 };
    case "filter":
      return { division: "1/4", amount: 0.6, wet: 1 };
    case "flanger":
      return { division: "1/8", amount: 0.4, wet: 0.6 };
    case "phaser":
      return { division: "1/4", amount: 0.5, wet: 0.6 };
    case "crush":
      return { division: "1/16", amount: 0.35, wet: 0.7 };
    default:
      return { division: "1/4", amount: 0, wet: 0 };
  }
}

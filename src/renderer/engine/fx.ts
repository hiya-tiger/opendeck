export type FxType =
  | "off"
  | "echo"
  | "delay"
  | "reverb"
  | "filter"
  | "flanger"
  | "phaser"
  | "crush"
  | "autopan"
  | "tremolo"
  | "gate"
  | "tape-stop"
  | "tapestop"
  | "brake"
  | "combo-filter-echo";

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
  { id: "autopan", label: "Auto Pan", beatSynced: true, hint: "beat-synced stereo panner" },
  { id: "tremolo", label: "Tremolo", beatSynced: true, hint: "beat-synced amplitude LFO" },
  { id: "gate", label: "Trance Gate", beatSynced: true, hint: "rhythmic chopper gate" },
  { id: "tape-stop", label: "Tape Stop", beatSynced: false, hint: "turntable power-down sweep" },
  { id: "tapestop", label: "Tape Stop (Quick)", beatSynced: false, hint: "turntable power-down sweep" },
  { id: "brake", label: "Vinyl Brake", beatSynced: true, hint: "timed platter brake" },
  { id: "combo-filter-echo", label: "Filter Echo", beatSynced: true, hint: "resonant filter into dub echo" },
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

export function tremoloRateHz(division: Division, bpm: number): number {
  const sec = delaySeconds(division, bpm);
  return sec > 0 ? Math.max(0.25, Math.min(32, 1 / sec)) : 4;
}

export function tapeStopRate(amount: number): number {
  const clamped = Math.max(0, Math.min(1, amount));
  return Math.max(0.05, 1 - Math.pow(clamped, 1.5) * 0.95);
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
    case "tremolo":
      return { division: "1/8", amount: 0.65, wet: 0.8 };
    case "gate":
      return { division: "1/16", amount: 0.75, wet: 0.9 };
    case "autopan":
      return { division: "1/4", amount: 0.6, wet: 0.8 };
    case "tape-stop":
    case "tapestop":
      return { division: "1/2", amount: 0.5, wet: 1 };
    case "brake":
      return { division: "1", amount: 0.6, wet: 1 };
    case "combo-filter-echo":
      return { division: "1/4", amount: 0.55, wet: 0.75 };
    default:
      return { division: "1/4", amount: 0, wet: 0 };
  }
}

export interface CustomFxSlot {
  type: FxType;
  division: Division;
  amount: number;
  wet: number;
  enabled: boolean;
}

export interface CustomFxPreset {
  id: string;
  name: string;
  slots: CustomFxSlot[];
}

export const DEFAULT_CUSTOM_FX_PRESETS: CustomFxPreset[] = [
  {
    id: "dub-riser",
    name: "Dub Filter Echo",
    slots: [
      { type: "filter", division: "1/4", amount: 0.65, wet: 0.85, enabled: true },
      { type: "echo", division: "3/8", amount: 0.5, wet: 0.6, enabled: true },
      { type: "reverb", division: "1/2", amount: 0.35, wet: 0.3, enabled: true },
    ],
  },
  {
    id: "cyber-chop",
    name: "Cyber Gate Crush",
    slots: [
      { type: "crush", division: "1/16", amount: 0.45, wet: 0.65, enabled: true },
      { type: "gate", division: "1/16", amount: 0.8, wet: 0.85, enabled: true },
      { type: "flanger", division: "1/8", amount: 0.4, wet: 0.5, enabled: true },
    ],
  },
  {
    id: "space-wash",
    name: "Space Wash Out",
    slots: [
      { type: "phaser", division: "1/2", amount: 0.55, wet: 0.6, enabled: true },
      { type: "delay", division: "1/8", amount: 0.45, wet: 0.55, enabled: true },
      { type: "reverb", division: "1", amount: 0.7, wet: 0.65, enabled: true },
    ],
  },
];

export class CustomFxStore {
  private presets: CustomFxPreset[];

  constructor(initial: CustomFxPreset[] = DEFAULT_CUSTOM_FX_PRESETS) {
    this.presets = initial.map((p) => ({
      id: p.id,
      name: p.name,
      slots: p.slots.slice(0, 3).map((s) => ({ ...s })),
    }));
  }

  list(): CustomFxPreset[] {
    return this.presets.map((p) => ({
      ...p,
      slots: p.slots.map((s) => ({ ...s })),
    }));
  }

  get(id: string): CustomFxPreset | undefined {
    const found = this.presets.find((p) => p.id === id);
    return found ? { ...found, slots: found.slots.map((s) => ({ ...s })) } : undefined;
  }

  save(name: string, slots: CustomFxSlot[], id?: string): CustomFxPreset {
    const cleanName = name.trim() || "Custom FX";
    const cleanId = id ?? cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const preset: CustomFxPreset = {
      id: cleanId,
      name: cleanName,
      slots: slots.slice(0, 3).map((s) => ({
        type: s.type,
        division: s.division,
        amount: Math.max(0, Math.min(1, s.amount)),
        wet: wetGain(s.wet),
        enabled: Boolean(s.enabled),
      })),
    };
    const existingIdx = this.presets.findIndex((p) => p.id === cleanId);
    if (existingIdx >= 0) this.presets[existingIdx] = preset;
    else this.presets.push(preset);
    return { ...preset, slots: preset.slots.map((s) => ({ ...s })) };
  }

  create(name: string, slots: CustomFxSlot[]): CustomFxPreset {
    return this.save(name, slots);
  }

  update(id: string, slots: CustomFxSlot[], name?: string): CustomFxPreset | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    return this.save(name ?? existing.name, slots, id);
  }

  toJSON(): CustomFxPreset[] {
    return this.list();
  }

  static fromJSON(raw: unknown): CustomFxStore {
    if (!Array.isArray(raw)) return new CustomFxStore();
    return new CustomFxStore(raw as CustomFxPreset[]);
  }

  remove(id: string): boolean {
    const idx = this.presets.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    this.presets.splice(idx, 1);
    return true;
  }
}

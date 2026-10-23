export type PartId = "drums" | "bass" | "other" | "vocals";

export interface PartDef {
  id: PartId;
  label: string;
  short: string;
  color: string;
}

export const PARTS: PartDef[] = [
  { id: "drums", label: "Drums", short: "D", color: "#CC4444" },
  { id: "bass", label: "Bass", short: "B", color: "#4477CC" },
  { id: "other", label: "Other", short: "O", color: "#44AA44" },
  { id: "vocals", label: "Vocals", short: "V", color: "#CCAA44" },
];

export function partLabel(id: PartId): string {
  const part = PARTS.find((entry) => entry.id === id);
  if (!part) throw new Error(`Unknown part: ${id as string}`);
  return part.label;
}

export interface PartMix {
  gain: Record<PartId, number>;
  muted: Record<PartId, boolean>;
  solo: PartId | null;
}

export function defaultPartMix(): PartMix {
  return {
    gain: { drums: 1, bass: 1, other: 1, vocals: 1 },
    muted: { drums: false, bass: false, other: false, vocals: false },
    solo: null,
  };
}

export function partGains(mix: PartMix): Record<PartId, number> {
  const out: Record<PartId, number> = { drums: 0, bass: 0, other: 0, vocals: 0 };
  for (const part of PARTS) {
    const id = part.id;
    if (mix.solo !== null) {
      out[id] = mix.solo === id && !mix.muted[id] ? mix.gain[id] : 0;
    } else if (mix.muted[id]) {
      out[id] = 0;
    } else {
      out[id] = mix.gain[id];
    }
  }
  return out;
}

export function vocalsOnly(on: boolean): PartMix {
  const mix = defaultPartMix();
  if (!on) return mix;
  mix.gain = { drums: 0, bass: 0, other: 0, vocals: 1 };
  mix.muted = { drums: true, bass: true, other: true, vocals: false };
  return mix;
}

export const STEM_MODEL = {
  id: "htdemucs-fp16weights",
  version: "1",
  filename: "htdemucs_fp16weights.onnx",
  url: "https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx",
  sha256: "d05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a",
  bytes: 165612636,
} as const;

export const MODEL_SAMPLE_RATE = 44100;
export const MODEL_FRAME_COUNT = 343980;
export const MODEL_OVERLAP = Math.floor(MODEL_FRAME_COUNT / 4);
export const MODEL_STRIDE = MODEL_FRAME_COUNT - MODEL_OVERLAP;

export interface ChunkPlan {
  index: number;
  start: number;
  length: number;
}

export function planChunks(totalFrames: number): ChunkPlan[] {
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) return [];
  const frames = Math.floor(totalFrames);
  const chunks: ChunkPlan[] = [];
  for (let start = 0; start < frames; start += MODEL_STRIDE) {
    const length = Math.min(MODEL_FRAME_COUNT, frames - start);
    chunks.push({ index: chunks.length, start, length });
  }
  return chunks;
}

export function transitionWindow(length: number, overlap: number): Float32Array {
  if (!Number.isInteger(length) || !Number.isInteger(overlap) || length < overlap * 2 || length < 1 || overlap < 0) {
    throw new Error("transitionWindow requires length >= overlap*2 >= 1");
  }
  const window = new Float32Array(length);
  if (overlap === 0) {
    window.fill(1);
    return window;
  }
  for (let i = 0; i < overlap; i += 1) window[i] = i / overlap;
  const tailStart = length - overlap;
  for (let i = 0; i < overlap; i += 1) window[tailStart + i] = (overlap - 1 - i) / overlap;
  for (let i = overlap; i < tailStart; i += 1) window[i] = 1;
  return window;
}

export function toInt16(data: Float32Array): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    const value = data[i];
    const clamped = value < -1 ? -1 : value > 1 ? 1 : value;
    out[i] = Math.round(clamped * 32767);
  }
  return out;
}

export function fromInt16(data: Int16Array): Float32Array {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = data[i] / 32768;
  return out;
}

const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;

export function cacheDirName(hash: string, modelVersion: string): string {
  const safeHash = sanitizeName(hash);
  const safeVersion = sanitizeName(modelVersion);
  if (!safeHash) throw new Error(`cacheDirName: hash "${hash}" has no safe characters`);
  if (!safeVersion) throw new Error(`cacheDirName: modelVersion "${modelVersion}" has no safe characters`);
  return `${safeHash}-${safeVersion}`;
}

function sanitizeName(value: string): string {
  const replaced = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+/, "").replace(/[-.]+$/, "");
  return replaced.slice(0, 128);
}

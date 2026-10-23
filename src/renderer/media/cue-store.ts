import { CUE_PALETTE, LOOP_COLOR } from "./serato-tags.ts";

export interface CueRecord {
  time: number;
  color: string;
  name: string;
}

export interface SavedLoop {
  id: string;
  start: number;
  end: number;
  name: string;
  color: string;
  locked: boolean;
}

export const MAX_SAVED_LOOPS = 8;
const MAX_CUE_NAME = 32;
const MAX_LOOP_NAME = 32;
const cueSet = new Set(CUE_PALETTE);

function cleanName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_CUE_NAME) : "";
}

function cleanColor(value: unknown, fallback: string): string {
  return typeof value === "string" && cueSet.has(value.toUpperCase()) ? value.toUpperCase() : fallback;
}

export function normaliseCues(raw: unknown, defaults: readonly string[]): (CueRecord | null)[] {
  const result: (CueRecord | null)[] = new Array(8).fill(null);
  if (!Array.isArray(raw)) return result;
  for (let index = 0; index < Math.min(raw.length, 8); index += 1) {
    const item = raw[index];
    const fallback = defaults[index] ?? CUE_PALETTE[0];
    if (typeof item === "number") {
      if (!Number.isFinite(item)) continue;
      result[index] = { time: Math.max(0, item), color: fallback, name: "" };
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Partial<CueRecord>;
    if (typeof record.time !== "number" || !Number.isFinite(record.time)) continue;
    result[index] = {
      time: Math.max(0, record.time),
      color: cleanColor(record.color, fallback),
      name: cleanName(record.name),
    };
  }
  return result;
}

export function cycleCueColor(color: string): string {
  const current = CUE_PALETTE.indexOf(color.toUpperCase());
  return CUE_PALETTE[(current + 1) % CUE_PALETTE.length];
}

export function normaliseLoops(raw: unknown): SavedLoop[] {
  if (!Array.isArray(raw)) return [];
  const loops: SavedLoop[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Partial<SavedLoop>;
    if (
      typeof record.start !== "number" ||
      typeof record.end !== "number" ||
      !Number.isFinite(record.start) ||
      !Number.isFinite(record.end) ||
      record.end <= record.start
    ) {
      continue;
    }
    loops.push({
      id: typeof record.id === "string" && record.id ? record.id : `loop-${record.start}-${record.end}`,
      start: Math.max(0, record.start),
      end: record.end,
      name: cleanName(record.name).slice(0, MAX_LOOP_NAME),
      color: cleanColor(record.color, LOOP_COLOR),
      locked: record.locked === true,
    });
    if (loops.length === MAX_SAVED_LOOPS) break;
  }
  return loops;
}

export function addSavedLoop(loops: readonly SavedLoop[], loop: SavedLoop): SavedLoop[] {
  const duplicate = loops.find(
    (item) => Math.abs(item.start - loop.start) < 1e-6 && Math.abs(item.end - loop.end) < 1e-6,
  );
  if (duplicate) return [...loops];
  return [...loops, loop].slice(-MAX_SAVED_LOOPS);
}

export function removeSavedLoop(loops: readonly SavedLoop[], id: string): SavedLoop[] {
  return loops.filter((loop) => loop.id !== id);
}

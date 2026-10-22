import type { BeatGridMarker, SeratoLoop } from "./serato-tags.ts";

export interface SeratoTempo {
  bpm: number;
  phase: number;
}

export function beatgridTempo(grid: BeatGridMarker[] | null | undefined): SeratoTempo | null {
  if (!grid || grid.length === 0) return null;
  const last = grid[grid.length - 1];
  const bpm = last.bpm ?? 0;
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  const first = grid[0].position;
  if (!Number.isFinite(first) || first < 0) return null;
  return { bpm, phase: first };
}

export function firstSavedLoop(
  loops: SeratoLoop[] | null | undefined,
): { start: number; end: number } | null {
  const loop = loops?.[0];
  if (!loop) return null;
  const start = loop.startMs / 1000;
  const end = loop.endMs / 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

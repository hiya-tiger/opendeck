import type { BeatGridMarker } from "../media/serato-tags.ts";

export const BEATS_PER_BAR = 4;

export const LOOP_BEATS = [1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32] as const;

export const beatSeconds = (bpm: number): number => (bpm > 0 ? 60 / bpm : 0.5);

export const barSeconds = (bpm: number): number => beatSeconds(bpm) * BEATS_PER_BAR;

export const loopSeconds = (bpm: number, beats: number): number =>
  bpm > 0 ? beatSeconds(bpm) * beats : 0.5 * beats;

export function beatIndexAt(time: number, bpm: number): number {
  if (bpm <= 0) return time / 0.5;
  return time / beatSeconds(bpm);
}

export function snapToBeat(time: number, bpm: number): number {
  if (bpm <= 0) return time;
  const beat = beatSeconds(bpm);
  return Math.round(time / beat) * beat;
}

export function beatJumpTarget(
  time: number,
  bpm: number,
  beats: number,
  duration: number,
): number {
  const next = time + beatSeconds(bpm) * beats;
  return Math.max(0, Math.min(duration > 0 ? duration - 0.01 : 0, next));
}

export function wrapBeatPhase(deltaSeconds: number, bpm: number): number {
  const beat = beatSeconds(bpm);
  if (beat <= 0) return deltaSeconds;
  let delta = deltaSeconds % beat;
  if (delta > beat / 2) delta -= beat;
  if (delta < -beat / 2) delta += beat;
  return delta;
}

export function nearestBeat(time: number, bpm: number, phase = 0): number {
  const beat = beatSeconds(bpm);
  if (beat <= 0) return time;
  return Math.round((time - phase) / beat) * beat + phase;
}

export function formatBeatPosition(time: number, bpm: number, phase = 0): string {
  if (bpm <= 0) return "--";
  const beat = beatSeconds(bpm);
  const index = Math.max(0, (time - phase) / beat);
  const bar = Math.floor(index / BEATS_PER_BAR) + 1;
  const inBar = Math.floor(index % BEATS_PER_BAR) + 1;
  const fraction = Math.floor((index % 1) * 4) + 1;
  return `${bar}.${inBar}.${fraction}`;
}

export interface EditableBeatGrid {
  bpm: number;
  firstBeatSeconds: number;
  locked: boolean;
  markers: BeatGridMarker[];
}

function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 120;
  return Math.max(20, Math.min(300, Math.round(bpm * 100) / 100));
}

export function createBeatGrid(
  bpm: number,
  firstBeatSeconds = 0,
  locked = false,
  markers?: BeatGridMarker[],
): EditableBeatGrid {
  const cleanBpm = clampBpm(bpm);
  const cleanPhase = Math.max(0, Number.isFinite(firstBeatSeconds) ? firstBeatSeconds : 0);
  const normalizedMarkers: BeatGridMarker[] =
    markers && markers.length > 0
      ? markers.map((m, idx) =>
          idx === markers.length - 1
            ? { position: Math.max(0, m.position), bpm: clampBpm(m.bpm ?? cleanBpm) }
            : { position: Math.max(0, m.position), beatsTillNext: Math.max(1, Math.round(m.beatsTillNext ?? 4)) },
        )
      : [{ position: cleanPhase, bpm: cleanBpm }];
  return {
    bpm: normalizedMarkers[normalizedMarkers.length - 1].bpm ?? cleanBpm,
    firstBeatSeconds: normalizedMarkers[0].position,
    locked: Boolean(locked),
    markers: normalizedMarkers,
  };
}

export function setBeatGridLock(grid: EditableBeatGrid, locked: boolean): EditableBeatGrid {
  return { ...grid, locked: Boolean(locked), markers: grid.markers.map((m) => ({ ...m })) };
}

export function toggleBeatGridLock(grid: EditableBeatGrid): EditableBeatGrid {
  return setBeatGridLock(grid, !grid.locked);
}

export function setGridDownbeat(grid: EditableBeatGrid, downbeatSeconds: number): EditableBeatGrid {
  if (grid.locked) return grid;
  const clamped = Math.max(0, Number.isFinite(downbeatSeconds) ? downbeatSeconds : 0);
  const delta = clamped - grid.firstBeatSeconds;
  const markers = grid.markers.map((m, idx) => ({
    ...m,
    position: idx === 0 ? clamped : Math.max(0, m.position + delta),
  }));
  return { ...grid, firstBeatSeconds: clamped, markers };
}

export function shiftBeatGrid(grid: EditableBeatGrid, deltaSeconds: number): EditableBeatGrid {
  if (grid.locked || !Number.isFinite(deltaSeconds)) return grid;
  const nextFirst = Math.max(0, grid.firstBeatSeconds + deltaSeconds);
  return setGridDownbeat(grid, nextFirst);
}

export function setBeatGridBpm(grid: EditableBeatGrid, bpm: number): EditableBeatGrid {
  if (grid.locked) return grid;
  const nextBpm = clampBpm(bpm);
  const markers = grid.markers.map((m, idx) =>
    idx === grid.markers.length - 1 ? { ...m, bpm: nextBpm } : { ...m },
  );
  return { ...grid, bpm: nextBpm, markers };
}

export function adjustBeatGridBpm(grid: EditableBeatGrid, deltaBpm: number): EditableBeatGrid {
  if (grid.locked || !Number.isFinite(deltaBpm)) return grid;
  return setBeatGridBpm(grid, grid.bpm + deltaBpm);
}

export function scaleBeatGridBpm(grid: EditableBeatGrid, factor: number): EditableBeatGrid {
  if (grid.locked || !Number.isFinite(factor) || factor <= 0) return grid;
  return setBeatGridBpm(grid, grid.bpm * factor);
}

export function addWarpMarker(
  grid: EditableBeatGrid,
  positionSeconds: number,
  beatsTillNext = 4,
): EditableBeatGrid {
  if (grid.locked || !Number.isFinite(positionSeconds) || positionSeconds < 0) return grid;
  const nonTerminal = grid.markers
    .slice(0, -1)
    .map((m) => ({ position: m.position, beatsTillNext: Math.max(1, m.beatsTillNext ?? 4) }));
  const terminal = grid.markers[grid.markers.length - 1] ?? { position: grid.firstBeatSeconds, bpm: grid.bpm };
  const all = [
    ...nonTerminal,
    { position: Math.max(0, positionSeconds), beatsTillNext: Math.max(1, Math.round(beatsTillNext)) },
  ].sort((a, b) => a.position - b.position);
  const terminalPos = Math.max(terminal.position, all[all.length - 1].position + beatSeconds(grid.bpm) * 4);
  const markers: BeatGridMarker[] = [...all, { position: terminalPos, bpm: grid.bpm }];
  return {
    ...grid,
    firstBeatSeconds: markers[0].position,
    markers,
  };
}

export function clearWarpMarkers(grid: EditableBeatGrid): EditableBeatGrid {
  if (grid.locked) return grid;
  return createBeatGrid(grid.bpm, grid.firstBeatSeconds, grid.locked);
}

export function tapBeatGridBpm(tapTimesMs: readonly number[]): number | null {
  if (tapTimesMs.length < 2) return null;
  const recent = tapTimesMs.slice(-8);
  const intervals: number[] = [];
  for (let i = 1; i < recent.length; i += 1) {
    const dt = recent[i] - recent[i - 1];
    if (dt >= 200 && dt <= 2500) intervals.push(dt);
  }
  if (intervals.length === 0) return null;
  const avgMs = intervals.reduce((sum, v) => sum + v, 0) / intervals.length;
  return clampBpm(60000 / avgMs);
}

export function beatGridToMarkers(grid: EditableBeatGrid): BeatGridMarker[] {
  if (grid.markers.length > 0) {
    return grid.markers.map((m, idx) =>
      idx === grid.markers.length - 1
        ? { position: m.position, bpm: grid.bpm }
        : { position: m.position, beatsTillNext: Math.max(1, m.beatsTillNext ?? 4) },
    );
  }
  return [{ position: grid.firstBeatSeconds, bpm: grid.bpm }];
}

export function markersToBeatGrid(
  markers: BeatGridMarker[] | null | undefined,
  fallbackBpm = 120,
  fallbackPhase = 0,
  locked = false,
): EditableBeatGrid {
  if (!markers || markers.length === 0) {
    return createBeatGrid(fallbackBpm, fallbackPhase, locked);
  }
  const last = markers[markers.length - 1];
  const bpm = clampBpm(last.bpm ?? fallbackBpm);
  const firstBeat = Math.max(0, markers[0].position ?? fallbackPhase);
  return createBeatGrid(bpm, firstBeat, locked, markers);
}

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

export const SECONDS_PER_TURN = 1.8;

export function normaliseDegrees(delta: number): number {
  return (((delta + 180) % 360) + 360) % 360 - 180;
}

export function pointerAngle(x: number, y: number, centerX: number, centerY: number): number {
  return (Math.atan2(y - centerY, x - centerX) * 180) / Math.PI;
}

export function scratchRate(
  deltaDegrees: number,
  dtSeconds: number,
  secondsPerTurn = SECONDS_PER_TURN,
): number {
  if (!Number.isFinite(deltaDegrees) || !Number.isFinite(dtSeconds) || dtSeconds <= 0) return 0;
  const step = (deltaDegrees / 360) * secondsPerTurn;
  return step / Math.max(dtSeconds, 1 / 500);
}

export function scratchPosition(
  current: number,
  deltaDegrees: number,
  duration: number,
  secondsPerTurn = SECONDS_PER_TURN,
): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const next = current + (deltaDegrees / 360) * secondsPerTurn;
  return Math.min(Math.max(next, 0), Math.max(0, duration - 0.05));
}

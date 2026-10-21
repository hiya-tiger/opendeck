import { beatSeconds, wrapBeatPhase } from "./beatgrid.ts";

export interface SyncInput {
  masterBpm: number;
  targetBpm: number;
  masterPosition: number;
  targetPosition: number;
  targetPhase?: number;
  masterPhase?: number;
  targetPlaying?: boolean;
  maxTempoPercent?: number;
}

export interface SyncResult {
  rate: number;
  tempoPercent: number;
  phaseErrorSeconds: number;
  seekTo: number;
  clamped: boolean;
}

export function syncRate(masterBpm: number, targetBpm: number, maxTempoPercent = 50): number {
  if (masterBpm <= 0 || targetBpm <= 0) return 1;
  const rate = masterBpm / targetBpm;
  const limit = 1 + maxTempoPercent / 100;
  return Math.max(1 / limit, Math.min(limit, rate));
}

export function syncDeck(input: SyncInput): SyncResult {
  const rate = syncRate(input.masterBpm, input.targetBpm, input.maxTempoPercent ?? 50);
  const beats = beatSeconds(input.masterBpm);
  const phaseError = wrapBeatPhase(
    input.targetPosition - input.masterPosition + (input.targetPhase ?? 0) - (input.masterPhase ?? 0),
    input.masterBpm,
  );
  const seekTo = input.targetPosition - phaseError;
  return {
    rate,
    tempoPercent: (rate - 1) * 100,
    phaseErrorSeconds: phaseError,
    seekTo,
    clamped: Math.abs(rate - input.masterBpm / Math.max(input.targetBpm, 1e-6)) > 1e-6,
  };
}

export function nudgeTowardPhase(
  masterBpm: number,
  masterPosition: number,
  targetPosition: number,
  maxNudge = 0.03,
): number {
  const error = wrapBeatPhase(targetPosition - masterPosition, masterBpm);
  return Math.max(-maxNudge, Math.min(maxNudge, -error * 0.25));
}

export function tempoPercentLabel(percent: number, digits = 1): string {
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(digits)}%`;
}

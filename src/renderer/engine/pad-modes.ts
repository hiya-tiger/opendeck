import { beatSeconds } from "./beatgrid.ts";

export const PAD_MODE_DEFS = [
  { id: "hot-cue", label: "Hot Cue", hint: "Jump or set eight cues." },
  { id: "cue-loop", label: "Cue Loop", hint: "Cue plus a four-beat loop." },
  { id: "loop-roll", label: "Loop Roll", hint: "Hold a pad for a rolling loop." },
  { id: "slicer", label: "Slicer", hint: "Hold to loop one slice of the track." },
  { id: "beat-jump", label: "Beat Jump", hint: "Jump by musical lengths." },
  { id: "transport", label: "Transport", hint: "Play, cue, sync, loop and reverse." },
  { id: "pitch-play", label: "Pitch Play", hint: "Hold a cue at a new pitch." },
  { id: "scratch", label: "Scratch", hint: "Load a track into a pad and scratch it." },
  { id: "sequence", label: "Sequence", hint: "Record and loop pad actions." },
  { id: "part-fx", label: "Part FX", hint: "Filter or mute drums, bass, other or vocals." },
] as const;

export type PadMode = (typeof PAD_MODE_DEFS)[number]["id"];

export const PAD_MODE_IDS: PadMode[] = PAD_MODE_DEFS.map((mode) => mode.id);

export function isPadMode(value: string): value is PadMode {
  return PAD_MODE_IDS.includes(value as PadMode);
}

export const LOOP_ROLL_BEATS = [1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16] as const;

export const BEAT_JUMP_STEPS = [-16, -8, -4, -1, 1, 4, 8, 16] as const;

export const PITCH_PLAY_SEMITONES = [-7, -5, -3, -2, 2, 3, 5, 7] as const;

export type PartFxAction = "filter-drums" | "filter-bass" | "filter-other" | "filter-vocals" | "mute-drums" | "mute-bass" | "mute-other" | "mute-vocals";

export const PART_FX_PADS: PartFxAction[] = [
  "filter-drums",
  "filter-bass",
  "filter-other",
  "filter-vocals",
  "mute-drums",
  "mute-bass",
  "mute-other",
  "mute-vocals",
];

export function loopRollBeats(index: number): number {
  return LOOP_ROLL_BEATS[Math.max(0, Math.min(7, Math.floor(index)))]!;
}

export function beatJumpStep(index: number): number {
  return BEAT_JUMP_STEPS[Math.max(0, Math.min(7, Math.floor(index)))]!;
}

export function pitchPlaySemitones(index: number): number {
  return PITCH_PLAY_SEMITONES[Math.max(0, Math.min(7, Math.floor(index)))]!;
}

export function pitchPlayRate(index: number): number {
  return 2 ** (pitchPlaySemitones(index) / 12);
}

export function sliceRange(index: number, duration: number): { start: number; end: number } {
  const safeDuration = Math.max(0, Number.isFinite(duration) ? duration : 0);
  const slot = Math.floor(index);
  const start = safeDuration * (Math.max(0, Math.min(7, slot)) / 8);
  return { start, end: safeDuration * ((Math.max(0, Math.min(7, slot)) + 1) / 8) };
}

export function rollingReleasePosition(
  startPosition: number,
  startedAtMs: number,
  releasedAtMs: number,
  rate: number,
  duration: number,
): number {
  const elapsed = Math.max(0, releasedAtMs - startedAtMs) / 1000;
  const target = startPosition + elapsed * rate;
  const limit = duration > 0 ? duration - 0.02 : 0;
  return Math.max(0, Math.min(limit, target));
}

export function cueLoopRange(cueTime: number, bpm: number, beats = 4): { start: number; end: number } {
  const start = Math.max(0, cueTime);
  return { start, end: start + beatSeconds(bpm) * beats };
}

export type SequencePhase = "tap" | "press" | "release";

export interface SequenceEvent {
  atMs: number;
  cue?: number;
  mode?: PadMode;
  index?: number;
  phase?: SequencePhase;
}

export const MAX_SEQUENCE_EVENTS = 128;

export class SequenceRecorder {
  private events: SequenceEvent[] = [];
  private startedAt: number | null = null;
  private eventLimit = MAX_SEQUENCE_EVENTS;

  constructor(limit = MAX_SEQUENCE_EVENTS) {
    this.eventLimit = Math.max(1, Math.floor(limit));
  }

  get recording(): boolean {
    return this.startedAt !== null;
  }

  get length(): number {
    return this.events.length;
  }

  start(nowMs: number): void {
    this.events = [];
    this.startedAt = nowMs;
  }

  stop(): SequenceEvent[] {
    this.startedAt = null;
    return this.events.map((event) => ({ ...event }));
  }

  record(cue: number, nowMs: number): boolean {
    if (this.startedAt === null || !Number.isInteger(cue) || cue < 0) return false;
    if (this.events.length >= this.eventLimit) return false;
    this.events.push({ atMs: Math.max(0, nowMs - this.startedAt), cue });
    return true;
  }

  recordAction(
    mode: PadMode,
    index: number,
    nowMs: number,
    phase: SequencePhase = "tap",
    cue?: number,
  ): boolean {
    if (this.startedAt === null) return false;
    if (!Number.isInteger(index) || index < 0 || index > 7) return false;
    if (this.events.length >= this.eventLimit) return false;
    const event: SequenceEvent = {
      atMs: Math.max(0, nowMs - this.startedAt),
      mode,
      index,
      phase,
    };
    if (cue !== undefined && Number.isInteger(cue) && cue >= 0) event.cue = cue;
    this.events.push(event);
    return true;
  }

  durationMs(): number {
    return this.events.reduce((max, event) => Math.max(max, event.atMs), 0);
  }

  clear(): void {
    this.events = [];
    this.startedAt = null;
  }

  list(): SequenceEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
}

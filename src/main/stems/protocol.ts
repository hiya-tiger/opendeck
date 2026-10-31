import type { StemPart } from "./core.ts";

/** Main process -> separation worker. */
export type HostMessage =
  | { type: "init"; modelPath: string; statePath: string; force?: string | null; overlap?: number }
  | { type: "prewarm" }
  | {
      type: "job";
      id: string;
      hash: string;
      sampleRate: number;
      left: Float32Array;
      right: Float32Array;
      focusFrame: number;
      cacheDir: string;
    }
  | { type: "cancel"; id: string }
  | { type: "focus"; id: string; frame: number };

export interface WorkerRegion {
  type: "region";
  id: string;
  /** First frame at the job's sample rate (the deck's buffer rate). */
  start: number;
  sampleRate: number;
  totalFrames: number;
  chunksDone: number;
  chunksTotal: number;
  parts: Record<StemPart, [Float32Array, Float32Array]>;
}

/** Separation worker -> main process. */
export type WorkerMessage =
  | { type: "ready"; provider: string; createMs: number; fallbackReason?: string }
  | { type: "provider"; provider: string; reason: string }
  | WorkerRegion
  | { type: "progress"; id: string; stage: string; percent: number; detail: string }
  | { type: "done"; id: string; manifest: Record<string, unknown>; ms: number; provider: string; firstRegionMs: number }
  | { type: "cancelled"; id: string }
  | { type: "error"; id: string | null; message: string };

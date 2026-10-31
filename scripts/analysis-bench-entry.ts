// Renderer side of scripts/bench-analysis.mjs: analyses the same tracks the
// old way (one at a time: read, decode, one worker, 30 ms gap) and through
// the new AnalysisScheduler, and checks both give identical results.
import { AnalysisScheduler, WorkerPool, defaultPoolSize } from "../src/renderer/engine/analysis-pool.ts";
import type { AnalysisResult } from "../src/renderer/engine/analyze.ts";

interface BenchTrack {
  id: string;
  file: File;
}

declare global {
  interface Window {
    __benchFiles?: Array<{ name: string; bytes: Uint8Array }>;
    __startBench?: () => Promise<unknown>;
  }
}

const ctx = new AudioContext();

const channelsOf = (buffer: AudioBuffer) => {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
  return {
    payload: { sampleRate: buffer.sampleRate, length: buffer.length, duration: buffer.duration, channels },
    transfer: channels.map((c) => c.buffer),
  };
};

async function oldWay(tracks: BenchTrack[]): Promise<{ ms: number; results: Map<string, AnalysisResult> }> {
  const worker = new Worker("analysis-worker.js");
  let id = 0;
  const pending = new Map<number, (r: AnalysisResult) => void>();
  worker.addEventListener("message", (event: MessageEvent<{ id: number; result: AnalysisResult }>) => {
    pending.get(event.data.id)?.(event.data.result);
    pending.delete(event.data.id);
  });
  const results = new Map<string, AnalysisResult>();
  const t0 = performance.now();
  for (const track of tracks) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const data = await track.file.arrayBuffer();
    const buffer = await ctx.decodeAudioData(data);
    const { payload, transfer } = channelsOf(buffer);
    const requestId = (id += 1);
    const result = await new Promise<AnalysisResult>((resolve) => {
      pending.set(requestId, resolve);
      worker.postMessage({ id: requestId, ...payload }, transfer);
    });
    results.set(track.id, result);
  }
  const ms = performance.now() - t0;
  worker.terminate();
  return { ms, results };
}

async function newWay(tracks: BenchTrack[], size: number): Promise<{ ms: number; results: Map<string, AnalysisResult>; size: number }> {
  const pool = new WorkerPool<AnalysisResult>({ size, create: () => new Worker("analysis-worker.js") });
  const scheduler = new AnalysisScheduler<BenchTrack, AudioBuffer, AnalysisResult>(pool, {
    key: (track) => track.id,
    decode: async (track) => ctx.decodeAudioData(await track.file.arrayBuffer()),
    toMessage: channelsOf,
  });
  const results = new Map<string, AnalysisResult>();
  const t0 = performance.now();
  await Promise.all(
    tracks.map(async (track) => {
      const result = await scheduler.analyse(track, "background");
      if (result) results.set(track.id, result);
    }),
  );
  const ms = performance.now() - t0;
  pool.terminate();
  return { ms, results, size };
}

const same = (a: AnalysisResult, b: AnalysisResult): boolean =>
  a.bpm === b.bpm &&
  a.beatPhase === b.beatPhase &&
  a.key.key === b.key.key &&
  a.duration === b.duration &&
  a.peaks.length === b.peaks.length &&
  a.peaks.every((v, i) => v === b.peaks[i]);

async function run(): Promise<unknown> {
  const files = window.__benchFiles ?? [];
  const tracks = files.map((f, i) => ({ id: `t${i}`, file: new File([f.bytes as BlobPart], f.name, { type: "audio/mpeg" }) }));
  const cores = navigator.hardwareConcurrency;
  const before = await oldWay(tracks);
  const runs: Array<{ size: number; ms: number; identical: boolean }> = [];
  const sizes = Array.from(new Set([defaultPoolSize(cores), 2, 4]));
  for (const size of sizes) {
    const after = await newWay(tracks, size);
    const identical = tracks.every((t) => {
      const a = before.results.get(t.id);
      const b = after.results.get(t.id);
      return Boolean(a && b && same(a, b));
    });
    runs.push({ size, ms: Math.round(after.ms), identical });
  }
  const sample = before.results.get("t0");
  return {
    tracks: tracks.length,
    hardwareConcurrency: cores,
    defaultPoolSize: defaultPoolSize(cores),
    beforeMs: Math.round(before.ms),
    after: runs,
    sampleBpm: sample?.bpm,
    sampleKey: sample?.key.key,
  };
}

window.__startBench = () => run().catch((error) => ({ error: String(error) }));

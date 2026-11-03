/**
 * One separation job, from the deck's PCM to the finished cache, independent
 * of how the model runs and how messages travel (so it is testable with a fake
 * model). Moved out of worker.ts for D45, which added resumable partial work:
 * chunks already finished by an earlier, interrupted run are loaded from
 * `<cacheDir>/partial/` and posted as regions first, and only the missing
 * chunks go through the model.
 */
import {
  DEFAULT_OVERLAP,
  MODEL_FRAME_COUNT,
  MODEL_SAMPLE_RATE,
  PART_ORDER,
  StemAccumulator,
  orderChunksFromFocus,
  planChunksWith,
  reorderRemaining,
  resampleLinear,
  type StemPart,
} from "./core.ts";
import { PartialStore } from "./partial.ts";
import type { HostMessage, WorkerMessage } from "./protocol.ts";

export type StemJob = Extract<HostMessage, { type: "job" }>;

export interface JobRunnerDeps {
  runChunk: (input: Float32Array) => Promise<Float32Array>;
  send: (message: WorkerMessage, transfer?: ArrayBuffer[]) => void;
  isCancelled: () => boolean;
  /** A newer playhead for this job, if the deck moved (frames at the job's rate). */
  takeFocus?: () => number | undefined;
  /** Resolves when the user has not paused separation (tray "Pause"). */
  waitWhilePaused?: () => Promise<void>;
  /** Called before the first model chunk (session warm-up). */
  prepare?: () => Promise<void>;
  writeCache: (dir: string, hash: string, frames: number, parts: Record<StemPart, Int16Array>) => Promise<Record<string, unknown>>;
  provider?: () => Promise<string> | string;
  model: { id: string; version: string };
  overlap?: number;
  frameCount?: number;
  modelRate?: number;
  /** Keep finished chunks on disk so an interrupted job resumes (default true). */
  persistPartial?: boolean;
}

export interface JobOutcome {
  status: "done" | "cancelled" | "error";
  /** Chunks taken from an earlier run's partial work. */
  resumed: number;
  /** Chunks the model ran in this run. */
  computed: number;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const runStemJob = async (job: StemJob, deps: JobRunnerDeps): Promise<JobOutcome> => {
  const t0 = performance.now();
  const frameCount = deps.frameCount ?? MODEL_FRAME_COUNT;
  const modelRate = deps.modelRate ?? MODEL_SAMPLE_RATE;
  const overlap = deps.overlap ?? DEFAULT_OVERLAP;
  const outcome: JobOutcome = { status: "error", resumed: 0, computed: 0 };
  const { send } = deps;
  const postRegion = (acc: StemAccumulator, region: ReturnType<StemAccumulator["add"]>, done: number, total: number): void => {
    const transfer: ArrayBuffer[] = [];
    for (const id of PART_ORDER) for (const channel of region.parts[id]) transfer.push(channel.buffer as ArrayBuffer);
    send(
      { type: "region", id: job.id, start: region.start, sampleRate: job.sampleRate, totalFrames: acc.outFrames, chunksDone: done, chunksTotal: total, parts: region.parts },
      transfer,
    );
  };
  try {
    const left = resampleLinear(job.left, job.sampleRate, modelRate);
    const right = resampleLinear(job.right, job.sampleRate, modelRate);
    const frames = Math.min(left.length, right.length);
    const chunks = planChunksWith(frames, frameCount, overlap);
    if (!chunks.length) throw new Error("No audio to separate");
    const toModel = modelRate / job.sampleRate;
    const acc = new StemAccumulator(frames, { left: job.left, right: job.right, sampleRate: job.sampleRate }, frameCount, overlap, modelRate);
    const done = new Set<number>();
    const persist = deps.persistPartial !== false && Boolean(job.cacheDir);
    const partial = persist
      ? await PartialStore.open(job.cacheDir, {
          model: deps.model.id,
          modelVersion: deps.model.version,
          hash: job.hash,
          frames,
          frameCount,
          overlap,
          chunks: chunks.length,
        }).catch((error) => {
          if (process.env.OPENDECK_STEM_DEBUG) process.stderr.write(`[stems] partial store unavailable: ${(error as Error)?.message}\n`);
          return null;
        })
      : null;

    send({ type: "progress", id: job.id, stage: "prepare", percent: 0, detail: `Preparing ${chunks.length} chunks` });

    // Chunks an earlier run already finished: no model time, posted at once.
    if (partial) {
      for (const index of partial.doneIndices.sort((a, b) => a - b)) {
        if (deps.isCancelled()) break;
        const data = await partial.load(index);
        const plan = chunks[index];
        if (!data || !plan || data.length !== PART_ORDER.length * 2 * frameCount) continue;
        const region = acc.add(plan, data);
        done.add(index);
        outcome.resumed += 1;
        postRegion(acc, region, done.size, chunks.length);
      }
      if (outcome.resumed) {
        send({
          type: "progress",
          id: job.id,
          stage: "separate",
          percent: Math.round((done.size / chunks.length) * 100),
          detail: `Resumed ${done.size} of ${chunks.length} chunks from the cache`,
        });
      }
    }

    let order = orderChunksFromFocus(chunks, job.focusFrame * toModel).filter((plan) => !done.has(plan.index));
    if (order.length) await deps.prepare?.();
    const input = new Float32Array(2 * frameCount);
    let firstRegionMs = outcome.resumed ? performance.now() - t0 : 0;
    while (order.length) {
      if (deps.waitWhilePaused) await deps.waitWhilePaused();
      if (deps.isCancelled()) {
        await partial?.flush();
        send({ type: "cancelled", id: job.id });
        outcome.status = "cancelled";
        return outcome;
      }
      const focus = deps.takeFocus?.();
      if (focus !== undefined) order = reorderRemaining(chunks, done, focus * toModel);
      const plan = order.shift()!;
      input.fill(0);
      input.set(left.subarray(plan.start, plan.start + plan.length), 0);
      input.set(right.subarray(plan.start, plan.start + plan.length), frameCount);
      const data = await deps.runChunk(input);
      // Saved before the accumulator sees it (its buffers are not touched by add()).
      void partial?.save(plan.index, data);
      const region = acc.add(plan, data);
      done.add(plan.index);
      outcome.computed += 1;
      if (!firstRegionMs) firstRegionMs = performance.now() - t0;
      postRegion(acc, region, done.size, chunks.length);
      send({
        type: "progress",
        id: job.id,
        stage: "separate",
        percent: Math.round((done.size / chunks.length) * 100),
        detail: `Chunk ${done.size} of ${chunks.length}`,
      });
      await tick();
    }
    if (deps.isCancelled()) {
      await partial?.flush();
      send({ type: "cancelled", id: job.id });
      outcome.status = "cancelled";
      return outcome;
    }
    await partial?.flush();
    send({ type: "progress", id: job.id, stage: "write", percent: 100, detail: "Writing stem cache" });
    // writeCache replaces the whole entry directory, partial/ included.
    const manifest = await deps.writeCache(job.cacheDir, job.hash, frames, acc.toInt16());
    send({
      type: "done",
      id: job.id,
      manifest,
      ms: Math.round(performance.now() - t0),
      provider: deps.provider ? await deps.provider() : "cpu",
      firstRegionMs: Math.round(firstRegionMs),
    });
    outcome.status = "done";
    return outcome;
  } catch (error) {
    send({ type: "error", id: job.id, message: (error as Error)?.message ?? String(error) });
    outcome.status = "error";
    return outcome;
  }
};

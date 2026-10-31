/**
 * Stem separation worker. Runs in an Electron utilityProcess (its own OS
 * process, so a GPU driver crash or a 5 s synchronous `session.run` never
 * touches the main process) or, outside Electron, in a worker_thread.
 *
 * One onnxruntime session is shared by every job; jobs run one at a time from
 * a FIFO. Chunks run from the deck's playhead outward and every finished
 * chunk is posted at once as a playable region.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  DEFAULT_OVERLAP,
  JobQueue,
  MODEL_FRAME_COUNT,
  MODEL_SAMPLE_RATE,
  PART_ORDER,
  StemAccumulator,
  openSession,
  orderChunksFromFocus,
  outputLooksBroken,
  planChunksWith,
  providerPlans,
  reorderRemaining,
  resampleLinear,
  type OpenedSession,
  type OrtLike,
  type ProviderState,
} from "./core.ts";
import { physicalCores } from "./cores.ts";
import type { HostMessage, WorkerMessage } from "./protocol.ts";
import { writeCache } from "../separation.ts";

const req = createRequire(typeof __filename === "string" ? __filename : import.meta.url);

/* ------------------------------------------------------------ transport */

interface ElectronParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const electronPort = (process as unknown as { parentPort?: ElectronParentPort }).parentPort;
const threadPort = electronPort ? null : (req("node:worker_threads") as typeof import("node:worker_threads")).parentPort;

const send = (message: WorkerMessage, transfer: ArrayBuffer[] = []): void => {
  if (electronPort) electronPort.postMessage(message);
  else threadPort?.postMessage(message, transfer);
};

const onMessage = (handler: (message: HostMessage) => void): void => {
  if (electronPort) electronPort.on("message", (event) => handler(event.data as HostMessage));
  else threadPort?.on("message", (message) => handler(message as HostMessage));
};

if (electronPort) {
  // Its own process: let the audio thread and UI win every contention.
  // Threads onnxruntime creates later inherit this.
  try {
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // not permitted; run at normal priority
  }
}

/* -------------------------------------------------------------- session */

let ort: (OrtLike & { Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown; listSupportedBackends?: () => Array<{ name: string }> }) | null = null;
let modelPath = "";
let statePath = "";
let force: string | null = null;
let overlap = DEFAULT_OVERLAP;
let state: ProviderState = { disabled: {} };
let opening: Promise<OpenedSession> | null = null;
let validated = false;

const ortVersion = (): string => {
  try {
    return (req("onnxruntime-node/package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
};

const loadState = (): void => {
  try {
    const data = JSON.parse(readFileSync(statePath, "utf8")) as ProviderState;
    state = { disabled: data?.disabled ?? {} };
    // A newer onnxruntime gets a fresh chance at the GPU.
    const version = ortVersion();
    for (const [name, entry] of Object.entries(state.disabled)) if (entry.ort !== version) delete state.disabled[name];
  } catch {
    state = { disabled: {} };
  }
};

const disable = (provider: string, reason: string): void => {
  state.disabled[provider] = { reason: reason.slice(0, 400), at: new Date().toISOString(), ort: ortVersion() };
  try {
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {
    // remembered for this run only
  }
  send({ type: "provider", provider: "cpu", reason: `${provider} disabled: ${reason}` });
};

const cudaInstalled = (): boolean => {
  try {
    const dir = path.dirname(req.resolve("onnxruntime-node/package.json"));
    return existsSync(path.join(dir, "bin", "napi-v3", "linux", "x64", "libonnxruntime_providers_cuda.so"));
  } catch {
    return false;
  }
};

const getSession = (): Promise<OpenedSession> => {
  if (opening) return opening;
  if (!ort) ort = req("onnxruntime-node");
  const supported = (ort!.listSupportedBackends?.() ?? [{ name: "cpu" }]).map((b) => b.name);
  const plans = providerPlans({
    platform: process.platform,
    arch: process.arch,
    supported,
    state,
    threads: physicalCores(),
    force,
    optimization: process.env.OPENDECK_STEM_OPT || null,
    cudaInstalled: process.platform === "linux" && process.arch === "x64" && cudaInstalled(),
  });
  validated = false;
  opening = openSession(ort!, modelPath, plans, disable).then((opened) => {
    send({ type: "ready", provider: opened.provider, createMs: opened.createMs });
    return opened;
  });
  opening.catch(() => {
    opening = null;
  });
  return opening;
};

const runChunk = async (input: Float32Array): Promise<Float32Array> => {
  const opened = await getSession();
  const { session } = opened;
  const inputName = session.inputNames.includes("mix") ? "mix" : session.inputNames[0];
  const outputName = session.outputNames.includes("stems") ? "stems" : session.outputNames[0];
  try {
    const result = await session.run({ [inputName]: new ort!.Tensor("float32", input, [1, 2, MODEL_FRAME_COUNT]) });
    const data = result[outputName].data as Float32Array;
    if (opened.provider !== "cpu" && !validated) {
      if (outputLooksBroken(data, input)) throw new Error("output was NaN/Inf or silent");
      validated = true;
    }
    return data;
  } catch (error) {
    if (opened.provider === "cpu" || !opened.fallbacks.length) throw error;
    // First-run (or any) GPU failure: remember it and finish on the CPU.
    disable(opened.provider, `run: ${(error as Error)?.message ?? String(error)}`);
    try {
      await session.release?.();
    } catch {
      // ignore
    }
    validated = false;
    opening = openSession(ort!, modelPath, opened.fallbacks, disable).then((next) => {
      send({ type: "ready", provider: next.provider, createMs: next.createMs });
      return next;
    });
    return runChunk(input);
  }
};

/* ----------------------------------------------------------------- jobs */

type Job = Extract<HostMessage, { type: "job" }>;
const focusUpdates = new Map<string, number>();
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const runJob = async (job: Job, isCancelled: () => boolean): Promise<void> => {
  const t0 = performance.now();
  try {
    const left = resampleLinear(job.left, job.sampleRate, MODEL_SAMPLE_RATE);
    const right = resampleLinear(job.right, job.sampleRate, MODEL_SAMPLE_RATE);
    const frames = Math.min(left.length, right.length);
    const chunks = planChunksWith(frames, MODEL_FRAME_COUNT, overlap);
    if (!chunks.length) throw new Error("No audio to separate");
    const toModel = MODEL_SAMPLE_RATE / job.sampleRate;
    const acc = new StemAccumulator(frames, { left: job.left, right: job.right, sampleRate: job.sampleRate }, MODEL_FRAME_COUNT, overlap);
    const done = new Set<number>();
    let order = orderChunksFromFocus(chunks, job.focusFrame * toModel);
    send({ type: "progress", id: job.id, stage: "prepare", percent: 0, detail: `Preparing ${chunks.length} chunks` });
    await getSession();
    const input = new Float32Array(2 * MODEL_FRAME_COUNT);
    let firstRegionMs = 0;
    while (order.length) {
      if (isCancelled()) {
        send({ type: "cancelled", id: job.id });
        return;
      }
      const focus = focusUpdates.get(job.id);
      if (focus !== undefined) {
        focusUpdates.delete(job.id);
        order = reorderRemaining(chunks, done, focus * toModel);
      }
      const plan = order.shift()!;
      input.fill(0);
      input.set(left.subarray(plan.start, plan.start + plan.length), 0);
      input.set(right.subarray(plan.start, plan.start + plan.length), MODEL_FRAME_COUNT);
      if (process.env.OPENDECK_STEM_DEBUG) process.stderr.write(`[stems] chunk ${plan.index} start\n`);
      const data = await runChunk(input);
      if (process.env.OPENDECK_STEM_DEBUG) process.stderr.write(`[stems] chunk ${plan.index} ran\n`);
      const region = acc.add(plan, data);
      done.add(plan.index);
      if (!firstRegionMs) firstRegionMs = performance.now() - t0;
      const transfer: ArrayBuffer[] = [];
      for (const id of PART_ORDER) for (const channel of region.parts[id]) transfer.push(channel.buffer as ArrayBuffer);
      send(
        {
          type: "region",
          id: job.id,
          start: region.start,
          sampleRate: job.sampleRate,
          totalFrames: acc.outFrames,
          chunksDone: done.size,
          chunksTotal: chunks.length,
          parts: region.parts,
        },
        transfer,
      );
      send({
        type: "progress",
        id: job.id,
        stage: "separate",
        percent: Math.round((done.size / chunks.length) * 100),
        detail: `Chunk ${done.size} of ${chunks.length}`,
      });
      await tick();
    }
    if (isCancelled()) {
      send({ type: "cancelled", id: job.id });
      return;
    }
    send({ type: "progress", id: job.id, stage: "write", percent: 100, detail: "Writing stem cache" });
    const manifest = await writeCache(job.cacheDir, job.hash, frames, acc.toInt16());
    const opened = await getSession();
    send({
      type: "done",
      id: job.id,
      manifest: manifest as unknown as Record<string, unknown>,
      ms: Math.round(performance.now() - t0),
      provider: opened.provider,
      firstRegionMs: Math.round(firstRegionMs),
    });
  } catch (error) {
    send({ type: "error", id: job.id, message: (error as Error)?.message ?? String(error) });
  } finally {
    focusUpdates.delete(job.id);
  }
};

const queue = new JobQueue<Job>(runJob);

onMessage((message) => {
  switch (message.type) {
    case "init":
      modelPath = message.modelPath;
      statePath = message.statePath;
      force = message.force ?? null;
      if (message.overlap && message.overlap > 0) overlap = message.overlap;
      loadState();
      break;
    case "prewarm":
      getSession().catch((error) => send({ type: "error", id: null, message: `prewarm: ${(error as Error).message}` }));
      break;
    case "job":
      queue.push(message);
      break;
    case "cancel":
      if (!queue.cancel(message.id)) send({ type: "cancelled", id: message.id });
      else if (queue.active?.id !== message.id) send({ type: "cancelled", id: message.id });
      break;
    case "focus":
      focusUpdates.set(message.id, message.frame);
      break;
  }
});

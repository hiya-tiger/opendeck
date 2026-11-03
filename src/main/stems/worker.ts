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
  openSession,
  outputLooksBroken,
  providerPlans,
  type OpenedSession,
  type OrtLike,
  type ProviderState,
} from "./core.ts";
import { physicalCores } from "./cores.ts";
import type { HostMessage, WorkerMessage } from "./protocol.ts";
import { MODEL, writeCache } from "../separation.ts";
import { runStemJob } from "./job-runner.ts";

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
    threads: threadTarget || physicalCores(),
    force,
    optimization: process.env.OPENDECK_STEM_OPT || null,
    cudaInstalled: process.platform === "linux" && process.arch === "x64" && cudaInstalled(),
  });
  validated = false;
  sessionThreads = threadTarget || physicalCores();
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

// Tray controls (D45). Pause holds the running job at its next chunk boundary.
let paused = false;
let resumeWaiters: Array<() => void> = [];
const waitWhilePaused = (): Promise<void> =>
  paused ? new Promise<void>((resolve) => resumeWaiters.push(resolve)) : Promise.resolve();
const setPaused = (next: boolean): void => {
  paused = next;
  if (!paused) {
    const waiters = resumeWaiters;
    resumeWaiters = [];
    for (const resolve of waiters) resolve();
  }
};

// Background mode: fewer CPU threads. onnxruntime fixes the pool size when the
// session is created, so a CPU session is rebuilt at the next chunk boundary;
// threads it creates then also inherit the lowered priority (Linux nice is per thread).
let threadTarget = 0; // 0 = physical cores (foreground default)
let sessionThreads = -1;
const applyThreadTarget = async (): Promise<void> => {
  if (!opening) return;
  let opened: OpenedSession;
  try {
    opened = await opening;
  } catch {
    return;
  }
  const want = threadTarget || physicalCores();
  if (opened.provider !== "cpu" || sessionThreads === want) return;
  try {
    await opened.session.release?.();
  } catch {
    // ignore
  }
  opening = null;
};

const runJob = async (job: Job, isCancelled: () => boolean): Promise<void> => {
  try {
    await runStemJob(job, {
      runChunk: async (input) => {
        await applyThreadTarget();
        if (process.env.OPENDECK_STEM_DEBUG) process.stderr.write(`[stems] chunk start (${threadTarget || "default"} threads)\n`);
        return runChunk(input);
      },
      send,
      isCancelled,
      takeFocus: () => {
        const frame = focusUpdates.get(job.id);
        focusUpdates.delete(job.id);
        return frame;
      },
      waitWhilePaused,
      prepare: async () => {
        await getSession();
      },
      writeCache: async (dir, hash, frames, parts) => (await writeCache(dir, hash, frames, parts)) as unknown as Record<string, unknown>,
      provider: async () => (await getSession()).provider,
      model: { id: MODEL.id, version: MODEL.version },
      overlap,
    });
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
    case "pause":
      setPaused(Boolean(message.paused));
      break;
    case "background":
      threadTarget = message.on ? Math.max(1, Math.floor(message.threads) || 1) : 0;
      try {
        os.setPriority(message.on ? os.constants.priority.PRIORITY_LOW : os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // not permitted (raising back from LOW needs privileges on Linux/macOS)
      }
      break;
  }
});

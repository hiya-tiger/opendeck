/**
 * Pure stem-separation logic shared by the inference worker, the main-process
 * host, the benchmark and the tests. Nothing here imports onnxruntime or
 * Electron: the ort module is passed in, so the fallback logic can be tested
 * with a mock.
 */

export const MODEL_SAMPLE_RATE = 44100;
export const MODEL_FRAME_COUNT = 343980;
/** Demucs' own default (overlap 0.25). See D40 for why it was not reduced. */
export const DEFAULT_OVERLAP = Math.floor(MODEL_FRAME_COUNT / 4);
/** Crossfade between finished stems and the full-mix placeholder (~93 ms at 44.1 kHz). */
export const BOUNDARY_FADE = 4096;
export const PART_ORDER = ["drums", "bass", "other", "vocals"] as const;
export type StemPart = (typeof PART_ORDER)[number];

export interface ChunkPlan {
  index: number;
  start: number;
  length: number;
}

export const planChunksWith = (totalFrames: number, frameCount = MODEL_FRAME_COUNT, overlap = DEFAULT_OVERLAP): ChunkPlan[] => {
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) return [];
  const stride = frameCount - overlap;
  if (stride <= 0) throw new Error("overlap must be smaller than the chunk");
  const chunks: ChunkPlan[] = [];
  for (let start = 0, index = 0; start < totalFrames; start += stride, index += 1) {
    chunks.push({ index, start, length: Math.min(frameCount, totalFrames - start) });
  }
  return chunks;
};

/**
 * Processing order for a track: the chunk under `focusFrame` first, then
 * outward, two chunks ahead for every one behind (playback runs forward, so the
 * music about to play matters more than what was just played).
 */
export const orderChunksFromFocus = (chunks: ChunkPlan[], focusFrame: number): ChunkPlan[] => {
  if (!chunks.length) return [];
  const focus = Math.max(0, Number.isFinite(focusFrame) ? focusFrame : 0);
  // The chunk whose body (furthest from either fade) covers the focus.
  let first = chunks.length - 1;
  let best = -Infinity;
  for (let i = 0; i < chunks.length; i += 1) {
    const { start, length } = chunks[i];
    if (focus < start || focus >= start + length) continue;
    const margin = Math.min(focus - start, start + length - focus);
    if (margin > best) {
      best = margin;
      first = i;
    }
  }
  const out: ChunkPlan[] = [chunks[first]];
  let ahead = first + 1;
  let behind = first - 1;
  while (ahead < chunks.length || behind >= 0) {
    for (let k = 0; k < 2 && ahead < chunks.length; k += 1) out.push(chunks[ahead++]);
    if (behind >= 0) out.push(chunks[behind--]);
  }
  return out;
};

export const transitionWindowFor = (length: number, overlap: number): Float32Array => {
  const window = new Float32Array(length);
  const ramp = Math.max(1, Math.floor(overlap));
  for (let i = 0; i < length; i += 1) {
    if (i < ramp) window[i] = i / ramp;
    else if (i >= length - ramp) window[i] = Math.max(0, (length - i) / ramp);
    else window[i] = 1;
  }
  return window;
};

/** Sorted, merged [start, end) intervals. */
export class IntervalSet {
  private items: Array<[number, number]> = [];

  add(start: number, end: number): void {
    if (end <= start) return;
    const next: Array<[number, number]> = [];
    let s = start;
    let e = end;
    let placed = false;
    for (const [a, b] of this.items) {
      if (b < s) next.push([a, b]);
      else if (a > e) {
        if (!placed) {
          next.push([s, e]);
          placed = true;
        }
        next.push([a, b]);
      } else {
        s = Math.min(s, a);
        e = Math.max(e, b);
      }
    }
    if (!placed) next.push([s, e]);
    this.items = next;
  }

  /** The interval containing `frame`, or null. */
  find(frame: number): [number, number] | null {
    for (const item of this.items) {
      if (frame >= item[0] && frame < item[1]) return item;
      if (item[0] > frame) break;
    }
    return null;
  }

  get list(): ReadonlyArray<readonly [number, number]> {
    return this.items;
  }

  covers(start: number, end: number): boolean {
    const item = this.find(start);
    return Boolean(item && item[1] >= end);
  }
}

/**
 * Weight of the separated stems against the placeholder at `frame`: 1 inside
 * finished audio, ramping to 0 over `fade` frames toward any edge that borders
 * unfinished audio. Track edges are not boundaries.
 */
export const coverageAt = (covered: IntervalSet, frame: number, totalFrames: number, fade = BOUNDARY_FADE): number => {
  const item = covered.find(frame);
  if (!item) return 0;
  const [lo, hi] = item;
  let d = Infinity;
  if (lo > 0) d = Math.min(d, frame - lo);
  if (hi < totalFrames) d = Math.min(d, hi - 1 - frame);
  if (d === Infinity) return 1;
  return Math.max(0, Math.min(1, d / fade));
};

export interface Region {
  /** First frame, at the output sample rate. */
  start: number;
  /** parts[p] = [left, right], each its own ArrayBuffer (transferable). */
  parts: Record<StemPart, [Float32Array, Float32Array]>;
}

/**
 * Overlap-add accumulator. Chunks may arrive in any order; after each one the
 * caller gets the region it touched, already normalised, resampled to the
 * output rate and blended with the full-mix placeholder (mix / 4 per part) at
 * every edge that still borders unfinished audio. Writing regions in arrival
 * order into a buffer pre-filled with that placeholder always yields audio
 * that sums back to the mix: no gaps, no clicks.
 */
export class StemAccumulator {
  readonly frames: number;
  readonly outFrames: number;
  private readonly acc: Float32Array[];
  private readonly weight: Float32Array;
  private readonly covered = new IntervalSet();
  private readonly window: Float32Array;
  private readonly ratio: number;
  private readonly mix: { left: Float32Array; right: Float32Array; sampleRate: number };
  readonly frameCount: number;
  readonly overlap: number;
  readonly fade: number;

  constructor(
    frames: number,
    mix: { left: Float32Array; right: Float32Array; sampleRate: number },
    frameCount = MODEL_FRAME_COUNT,
    overlap = DEFAULT_OVERLAP,
    modelRate = MODEL_SAMPLE_RATE,
    fade = BOUNDARY_FADE,
  ) {
    this.frames = frames;
    this.mix = mix;
    this.frameCount = frameCount;
    this.overlap = overlap;
    this.fade = fade;
    this.acc = Array.from({ length: PART_ORDER.length * 2 }, () => new Float32Array(frames));
    this.weight = new Float32Array(frames);
    this.window = transitionWindowFor(frameCount, overlap);
    this.ratio = modelRate / mix.sampleRate;
    this.outFrames = Math.min(mix.left.length, mix.right.length);
  }

  get coverage(): IntervalSet {
    return this.covered;
  }

  get complete(): boolean {
    return this.covered.covers(0, this.frames);
  }

  /** `data` is the model output: [part][channel][frameCount] flattened. */
  add(plan: ChunkPlan, data: Float32Array): Region {
    const { frameCount, window } = this;
    const stride = 2 * frameCount;
    for (let part = 0; part < PART_ORDER.length; part += 1) {
      const l = this.acc[part * 2];
      const r = this.acc[part * 2 + 1];
      const base = part * stride;
      for (let i = 0; i < plan.length; i += 1) {
        const gain = window[i];
        l[plan.start + i] += data[base + i] * gain;
        r[plan.start + i] += data[base + frameCount + i] * gain;
      }
    }
    for (let i = 0; i < plan.length; i += 1) this.weight[plan.start + i] += window[i];
    this.covered.add(plan.start, plan.start + plan.length);
    return this.region(plan.start, plan.start + plan.length);
  }

  /** Normalised model-rate value of one accumulator lane. */
  private value(lane: number, frame: number): number {
    const w = this.weight[frame];
    return w > 1e-6 ? this.acc[lane][frame] / w : 0;
  }

  /** Output-rate region for model frames [a, b). */
  region(a: number, b: number): Region {
    const ratio = this.ratio;
    const t0 = Math.max(0, Math.ceil(a / ratio - 1e-9));
    const t1 = Math.min(this.outFrames, Math.floor((b - 1) / ratio) + 1);
    const n = Math.max(0, t1 - t0);
    const parts = {} as Record<StemPart, [Float32Array, Float32Array]>;
    const lanes: Float32Array[] = [];
    for (const id of PART_ORDER) {
      const pair: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
      parts[id] = pair;
      lanes.push(pair[0], pair[1]);
    }
    const { left, right } = this.mix;
    const last = b - 1;
    for (let j = 0; j < n; j += 1) {
      const t = t0 + j;
      const pos = t * ratio;
      const i0 = Math.min(last, Math.floor(pos));
      const i1 = Math.min(last, i0 + 1);
      const frac = pos - i0;
      const c = coverageAt(this.covered, Math.min(last, Math.round(pos)), this.frames, this.fade);
      const ml = left[t] * 0.25 * (1 - c);
      const mr = right[t] * 0.25 * (1 - c);
      for (let lane = 0; lane < lanes.length; lane += 1) {
        const v0 = this.value(lane, i0);
        const v = i1 === i0 ? v0 : v0 + (this.value(lane, i1) - v0) * frac;
        lanes[lane][j] = c * v + ((lane & 1) === 0 ? ml : mr);
      }
    }
    return { start: t0, parts };
  }

  /** Final model-rate stems, interleaved int16, one buffer per part (the cache format). */
  toInt16(): Record<StemPart, Int16Array> {
    const out = {} as Record<StemPart, Int16Array>;
    for (let part = 0; part < PART_ORDER.length; part += 1) {
      const l = this.acc[part * 2];
      const r = this.acc[part * 2 + 1];
      const data = new Int16Array(this.frames * 2);
      for (let i = 0; i < this.frames; i += 1) {
        const w = this.weight[i];
        const normal = w > 0 ? 1 / w : 0;
        data[i * 2] = quantize(l[i] * normal);
        data[i * 2 + 1] = quantize(r[i] * normal);
      }
      out[PART_ORDER[part]] = data;
    }
    return out;
  }
}

const quantize = (value: number): number => Math.round((value < -1 ? -1 : value > 1 ? 1 : value) * 32767);

/** Linear resample of a whole channel (same maths the app always used). */
export const resampleLinear = (data: Float32Array, from: number, to: number): Float32Array => {
  if (!data.length) return new Float32Array(0);
  if (from === to) return data;
  const length = Math.max(1, Math.round((data.length * to) / from));
  const out = new Float32Array(length);
  const ratio = from / to;
  const last = data.length - 1;
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const next = index < last ? index + 1 : last;
    const t = position - index;
    out[i] = data[index] * (1 - t) + data[next] * t;
  }
  return out;
};

/**
 * Cache (interleaved int16 at `from` Hz) -> planar float at `to` Hz, in one
 * pass with no intermediate float copy.
 */
export const decodeCachePart = (data: Int16Array, frames: number, from: number, to: number): [Float32Array, Float32Array] => {
  const scale = 1 / 32768;
  if (from === to) {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      left[i] = data[i * 2] * scale;
      right[i] = data[i * 2 + 1] * scale;
    }
    return [left, right];
  }
  const length = Math.max(1, Math.round((frames * to) / from));
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const ratio = from / to;
  const last = frames - 1;
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.min(last, Math.floor(position));
    const next = index < last ? index + 1 : last;
    const t = position - index;
    left[i] = (data[index * 2] * (1 - t) + data[next * 2] * t) * scale;
    right[i] = (data[index * 2 + 1] * (1 - t) + data[next * 2 + 1] * t) * scale;
  }
  return [left, right];
};

/* ------------------------------------------------------------ providers */

export interface ProviderState {
  /** Execution providers that failed here, with why. Survives restarts. */
  disabled: Record<string, { reason: string; at: string; ort: string }>;
}

export interface ProviderPlan {
  name: string;
  options: Record<string, unknown>;
}

/** GPU execution provider onnxruntime-node 1.20.1 ships for this platform, if any. */
export const gpuProviderFor = (platform: string, arch: string, supported: string[], cudaInstalled = false): string | null => {
  if (platform === "win32" && (arch === "x64" || arch === "arm64") && supported.includes("dml")) return "dml";
  if (platform === "darwin" && supported.includes("coreml")) return "coreml";
  // CUDA is compiled into the linux-x64 binding but its provider library and
  // the CUDA runtime are separate installs; only try it when they are there.
  if (platform === "linux" && arch === "x64" && cudaInstalled && supported.includes("cuda")) return "cuda";
  return null;
};

/**
 * Graph optimisation for the CPU session. "disabled" on purpose (D40): with
 * any other level onnxruntime-node 1.20.1 aborts the process (SIGTRAP) on the
 * second htdemucs run inside Electron 44 (main or utility process; plain Node
 * is fine), and it also peaks at ~4.5 GB resident against ~1.1 GB, for
 * ~5-10% faster chunks.
 */
export const CPU_GRAPH_OPTIMIZATION = "disabled";

export const cpuSessionOptions = (threads: number, optimization: string = CPU_GRAPH_OPTIMIZATION): Record<string, unknown> => {
  const options: Record<string, unknown> = {
    executionProviders: ["cpu"],
    graphOptimizationLevel: optimization,
    executionMode: "sequential",
    // The arena kept ~1.2-1.7 GB more resident at peak for no measurable speed
    // gain on htdemucs (D40 bench).
    enableCpuMemArena: false,
    enableMemPattern: true,
  };
  // 0 lets onnxruntime size its pool to the physical cores itself.
  if (threads > 0) options.intraOpNumThreads = threads;
  return options;
};

export const providerPlans = (input: {
  platform: string;
  arch: string;
  supported: string[];
  state: ProviderState;
  threads: number;
  force?: string | null;
  cudaInstalled?: boolean;
  /** Override the CPU graph optimisation level (bench / diagnostics). */
  optimization?: string | null;
}): ProviderPlan[] => {
  const cpu: ProviderPlan = { name: "cpu", options: cpuSessionOptions(input.threads, input.optimization || CPU_GRAPH_OPTIMIZATION) };
  if (input.force === "cpu") return [cpu];
  const gpu = gpuProviderFor(input.platform, input.arch, input.supported, input.cudaInstalled);
  if (!gpu) return [cpu];
  if (input.state.disabled[gpu] && input.force !== gpu) return [cpu];
  // GPU providers keep full optimisation (fusions are where they win); if that
  // crashes the worker, the host restarts it on the CPU plan above.
  const base = cpuSessionOptions(input.threads, input.optimization || "all");
  let provider: unknown = gpu;
  if (gpu === "dml") {
    provider = { name: "dml", deviceId: 0 };
    // DirectML requires both of these (onnxruntime DML EP docs).
    base.enableMemPattern = false;
    base.executionMode = "sequential";
  } else if (gpu === "coreml") {
    provider = { name: "coreml", coreMlFlags: 0 };
  } else if (gpu === "cuda") {
    provider = { name: "cuda", deviceId: 0 };
  }
  // CPU stays in the list so nodes the GPU EP cannot take still run.
  base.executionProviders = [provider, "cpu"];
  return [{ name: gpu, options: base }, cpu];
};

export interface OrtLike {
  InferenceSession: { create(path: string, options?: Record<string, unknown>): Promise<SessionLike> };
}

export interface SessionLike {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>>;
  release?(): Promise<void>;
}

export interface OpenedSession {
  session: SessionLike;
  provider: string;
  createMs: number;
  /** Plans still available if this one fails at run time. */
  fallbacks: ProviderPlan[];
}

/**
 * Creates a session with the first plan that works. Every failure is
 * recorded through `onDisable` so the next start goes straight to the plan
 * that works. CPU is never disabled.
 */
export const openSession = async (
  ort: OrtLike,
  modelPath: string,
  plans: ProviderPlan[],
  onDisable: (provider: string, reason: string) => void,
  now: () => number = () => Date.now(),
): Promise<OpenedSession> => {
  let lastError: unknown = null;
  for (let i = 0; i < plans.length; i += 1) {
    const plan = plans[i];
    const t0 = now();
    try {
      const session = await ort.InferenceSession.create(modelPath, plan.options);
      return { session, provider: plan.name, createMs: now() - t0, fallbacks: plans.slice(i + 1) };
    } catch (error) {
      lastError = error;
      if (plan.name !== "cpu") onDisable(plan.name, `session: ${(error as Error)?.message ?? String(error)}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not create a stem separation session");
};

/** A GPU result we refuse to trust: NaN/Inf, or silence for a non-silent input. */
export const outputLooksBroken = (output: Float32Array, input: Float32Array): boolean => {
  let inputEnergy = 0;
  for (let i = 0; i < input.length; i += 97) inputEnergy += input[i] * input[i];
  let energy = 0;
  for (let i = 0; i < output.length; i += 97) {
    const v = output[i];
    if (!Number.isFinite(v)) return true;
    energy += v * v;
  }
  return inputEnergy > 1e-6 && energy < inputEnergy * 1e-6;
};

/* ---------------------------------------------------------------- queue */

export interface QueuedJob {
  id: string;
}

/**
 * FIFO of separation jobs sharing one session. `cancel` drops a waiting job,
 * or flags the running one so the runner stops at the next chunk boundary.
 */
export class JobQueue<T extends QueuedJob> {
  private waiting: T[] = [];
  private running: T | null = null;
  private cancelled = new Set<string>();
  private readonly runner: (job: T, isCancelled: () => boolean) => Promise<void>;

  constructor(runner: (job: T, isCancelled: () => boolean) => Promise<void>) {
    this.runner = runner;
  }

  get active(): T | null {
    return this.running;
  }

  get pending(): readonly T[] {
    return this.waiting;
  }

  has(id: string): boolean {
    return this.running?.id === id || this.waiting.some((job) => job.id === id);
  }

  push(job: T): void {
    this.cancelled.delete(job.id);
    this.waiting.push(job);
    void this.pump();
  }

  cancel(id: string): boolean {
    const before = this.waiting.length;
    this.waiting = this.waiting.filter((job) => job.id !== id);
    if (this.running?.id === id) {
      this.cancelled.add(id);
      return true;
    }
    return this.waiting.length !== before;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const job = this.waiting.shift();
    if (!job) return;
    this.running = job;
    try {
      await this.runner(job, () => this.cancelled.has(job.id));
    } catch {
      // the runner reports its own errors
    } finally {
      this.cancelled.delete(job.id);
      this.running = null;
    }
    await this.pump();
  }
}

/**
 * Remaining chunks re-ordered for a new focus (the user seeked), keeping the
 * ones already done out.
 */
export const reorderRemaining = (all: ChunkPlan[], done: Set<number>, focusFrame: number): ChunkPlan[] =>
  orderChunksFromFocus(all, focusFrame).filter((plan) => !done.has(plan.index));

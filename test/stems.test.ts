import assert from "node:assert/strict";
import test from "node:test";
import {
  IntervalSet,
  JobQueue,
  PART_ORDER,
  StemAccumulator,
  coverageAt,
  decodeCachePart,
  gpuProviderFor,
  openSession,
  orderChunksFromFocus,
  outputLooksBroken,
  planChunksWith,
  providerPlans,
  reorderRemaining,
  resampleLinear,
  type OrtLike,
  type SessionLike,
} from "../src/main/stems/core.ts";
import { StemHost, type WorkerHandle } from "../src/main/stems/host.ts";
import type { HostMessage, WorkerMessage } from "../src/main/stems/protocol.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/* ---------------------------------------------------------------- queue */

test("job queue runs jobs one at a time in FIFO order", async () => {
  const log: string[] = [];
  const queue = new JobQueue<{ id: string }>(async (job) => {
    log.push(`start ${job.id}`);
    await tick();
    log.push(`end ${job.id}`);
  });
  queue.push({ id: "a" });
  queue.push({ id: "b" });
  queue.push({ id: "c" });
  assert.equal(queue.active?.id, "a");
  assert.deepEqual(queue.pending.map((j) => j.id), ["b", "c"]);
  for (let i = 0; i < 10; i += 1) await tick();
  assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  assert.equal(queue.active, null);
});

test("job queue cancel drops a waiting job and stops the running one at a chunk boundary", async () => {
  const chunks: string[] = [];
  const queue = new JobQueue<{ id: string }>(async (job, cancelled) => {
    for (let i = 0; i < 5; i += 1) {
      if (cancelled()) return;
      chunks.push(`${job.id}${i}`);
      await tick();
    }
  });
  queue.push({ id: "a" });
  queue.push({ id: "b" });
  queue.push({ id: "c" });
  assert.equal(queue.cancel("b"), true);
  await tick();
  await tick();
  assert.equal(queue.cancel("a"), true);
  for (let i = 0; i < 20; i += 1) await tick();
  assert.ok(chunks.filter((c) => c.startsWith("a")).length < 5, "a stopped early");
  assert.equal(chunks.some((c) => c.startsWith("b")), false, "b never ran");
  assert.equal(chunks.filter((c) => c.startsWith("c")).length, 5, "c ran in full");
  assert.equal(queue.cancel("zzz"), false);
});

test("job queue survives a job that throws", async () => {
  const ran: string[] = [];
  const queue = new JobQueue<{ id: string }>(async (job) => {
    ran.push(job.id);
    if (job.id === "bad") throw new Error("boom");
  });
  queue.push({ id: "bad" });
  queue.push({ id: "good" });
  for (let i = 0; i < 6; i += 1) await tick();
  assert.deepEqual(ran, ["bad", "good"]);
});

/* ------------------------------------------------------------ providers */

test("gpu provider per platform matches what onnxruntime-node 1.20.1 ships", () => {
  assert.equal(gpuProviderFor("win32", "x64", ["cpu", "dml"]), "dml");
  assert.equal(gpuProviderFor("win32", "arm64", ["cpu", "dml"]), "dml");
  assert.equal(gpuProviderFor("darwin", "arm64", ["cpu", "coreml"]), "coreml");
  assert.equal(gpuProviderFor("darwin", "x64", ["cpu", "coreml"]), "coreml");
  assert.equal(gpuProviderFor("linux", "x64", ["cpu", "cuda", "tensorrt"]), null, "no CUDA libraries installed");
  assert.equal(gpuProviderFor("linux", "x64", ["cpu", "cuda", "tensorrt"], true), "cuda");
  assert.equal(gpuProviderFor("linux", "arm64", ["cpu"], true), null);
  assert.equal(gpuProviderFor("win32", "x64", ["cpu"]), null, "binding without dml");
});

test("provider plans put the GPU first with CPU behind it, and honour disable / force", () => {
  const base = { platform: "win32", arch: "x64", supported: ["cpu", "dml"], threads: 6 };
  const plans = providerPlans({ ...base, state: { disabled: {} } });
  assert.deepEqual(plans.map((p) => p.name), ["dml", "cpu"]);
  const dml = plans[0].options;
  assert.deepEqual(dml.executionProviders, [{ name: "dml", deviceId: 0 }, "cpu"]);
  assert.equal(dml.enableMemPattern, false, "DirectML requires mem pattern off");
  assert.equal(dml.executionMode, "sequential");
  const cpu = plans[1].options;
  assert.deepEqual(cpu.executionProviders, ["cpu"]);
  assert.equal(cpu.intraOpNumThreads, 6, "physical cores, not capped");
  assert.equal(cpu.graphOptimizationLevel, "disabled", "see D40: other levels abort under Electron");
  assert.equal(dml.graphOptimizationLevel, "all");
  assert.equal(cpu.executionMode, "sequential");

  const disabled = providerPlans({ ...base, state: { disabled: { dml: { reason: "x", at: "", ort: "1.20.1" } } } });
  assert.deepEqual(disabled.map((p) => p.name), ["cpu"]);
  assert.deepEqual(providerPlans({ ...base, state: { disabled: {} }, force: "cpu" }).map((p) => p.name), ["cpu"]);
  assert.equal(providerPlans({ ...base, threads: 0, state: { disabled: {} } })[1].options.intraOpNumThreads, undefined);
  const mac = providerPlans({ platform: "darwin", arch: "arm64", supported: ["cpu", "coreml"], threads: 8, state: { disabled: {} } });
  assert.deepEqual(mac[0].options.executionProviders, [{ name: "coreml", coreMlFlags: 0 }, "cpu"]);
});

const mockOrt = (fail: Set<string>, calls: string[]): OrtLike => ({
  InferenceSession: {
    async create(_path: string, options?: Record<string, unknown>): Promise<SessionLike> {
      const eps = (options?.executionProviders as unknown[]) ?? [];
      const first = eps[0];
      const name = typeof first === "string" ? first : (first as { name: string }).name;
      calls.push(name);
      if (fail.has(name)) throw new Error(`${name} unavailable`);
      return { inputNames: ["mix"], outputNames: ["stems"], run: async () => ({ stems: { data: new Float32Array(4) } }) };
    },
  },
});

test("openSession falls back to CPU and remembers the failed GPU provider", async () => {
  const calls: string[] = [];
  const disabled: string[] = [];
  const plans = providerPlans({ platform: "win32", arch: "x64", supported: ["cpu", "dml"], threads: 4, state: { disabled: {} } });
  const opened = await openSession(mockOrt(new Set(["dml"]), calls), "/m.onnx", plans, (name, reason) => disabled.push(`${name}:${reason}`));
  assert.equal(opened.provider, "cpu");
  assert.deepEqual(calls, ["dml", "cpu"]);
  assert.equal(disabled.length, 1);
  assert.match(disabled[0], /^dml:session: dml unavailable/);
  assert.deepEqual(opened.fallbacks, []);
});

test("openSession keeps the GPU when it works, with CPU left as the run-time fallback", async () => {
  const calls: string[] = [];
  const plans = providerPlans({ platform: "darwin", arch: "arm64", supported: ["cpu", "coreml"], threads: 4, state: { disabled: {} } });
  const opened = await openSession(mockOrt(new Set(), calls), "/m.onnx", plans, () => assert.fail("nothing disabled"));
  assert.equal(opened.provider, "coreml");
  assert.deepEqual(opened.fallbacks.map((p) => p.name), ["cpu"]);
});

test("openSession rejects when even CPU fails, without disabling CPU", async () => {
  const disabled: string[] = [];
  await assert.rejects(
    openSession(mockOrt(new Set(["cpu"]), []), "/m.onnx", [{ name: "cpu", options: { executionProviders: ["cpu"] } }], (n) => disabled.push(n)),
    /cpu unavailable/,
  );
  assert.deepEqual(disabled, []);
});

test("broken GPU output is detected (NaN, silence on a loud input)", () => {
  const input = new Float32Array(2000).fill(0.5);
  assert.equal(outputLooksBroken(new Float32Array(8000).fill(0.1), input), false);
  const nan = new Float32Array(8000).fill(0.1);
  nan[97 * 3] = Number.NaN;
  assert.equal(outputLooksBroken(nan, input), true);
  assert.equal(outputLooksBroken(new Float32Array(8000), input), true);
  assert.equal(outputLooksBroken(new Float32Array(8000), new Float32Array(2000)), false, "silent in, silent out is fine");
});

/* -------------------------------------------------------------- ordering */

test("chunks are ordered from the playhead outward, two ahead for one behind", () => {
  const chunks = planChunksWith(10_000, 1000, 250); // stride 750 -> 14 chunks
  assert.equal(chunks.length, 14);
  const fromStart = orderChunksFromFocus(chunks, 0).map((c) => c.index);
  assert.deepEqual(fromStart, [...Array(14).keys()], "stopped at the top: plain order");
  const mid = orderChunksFromFocus(chunks, 5200).map((c) => c.index);
  assert.equal(mid[0], 6, "the chunk whose body holds frame 5200 (starts 4500)");
  assert.deepEqual(mid.slice(0, 7), [6, 7, 8, 5, 9, 10, 4]);
  assert.deepEqual([...mid].sort((a, b) => a - b), [...Array(14).keys()], "every chunk exactly once");
  const end = orderChunksFromFocus(chunks, 9_999).map((c) => c.index);
  assert.ok(end[0] === 12 || end[0] === 13);
  assert.deepEqual([...end].sort((a, b) => a - b), [...Array(14).keys()]);
  const done = new Set([6, 7, 8]);
  const re = reorderRemaining(chunks, done, 0).map((c) => c.index);
  assert.deepEqual(re, [0, 1, 2, 3, 4, 5, 9, 10, 11, 12, 13], "seek back to the top skips finished chunks");
});

test("interval set merges and coverage ramps only at edges that border unfinished audio", () => {
  const set = new IntervalSet();
  set.add(100, 200);
  set.add(300, 400);
  set.add(190, 310);
  assert.deepEqual(set.list, [[100, 400]]);
  set.add(0, 50);
  assert.deepEqual(set.list, [[0, 50], [100, 400]]);
  assert.equal(coverageAt(set, 0, 1000, 10), 1, "track start is not a boundary");
  assert.equal(coverageAt(set, 49, 1000, 10), 0, "last frame before a gap");
  assert.equal(coverageAt(set, 45, 1000, 10), 0.4);
  assert.equal(coverageAt(set, 75, 1000, 10), 0, "not covered");
  assert.equal(coverageAt(set, 250, 1000, 10), 1);
  const whole = new IntervalSet();
  whole.add(0, 1000);
  assert.equal(coverageAt(whole, 999, 1000, 10), 1, "track end is not a boundary");
});

/* ----------------------------------------------------- progressive merge */

const FRAME = 1000;
const OVERLAP = 250;
const FADE = 64;

/** Fake htdemucs: part p gets `split[p]` of the mix, plus a per-chunk wobble so overlaps matter. */
const fakeModel = (left: Float32Array, right: Float32Array, start: number, length: number, split: number[], wobble: number): Float32Array => {
  const out = new Float32Array(PART_ORDER.length * 2 * FRAME);
  for (let p = 0; p < PART_ORDER.length; p += 1) {
    for (let i = 0; i < length; i += 1) {
      out[p * 2 * FRAME + i] = left[start + i] * split[p] * (1 + wobble);
      out[p * 2 * FRAME + FRAME + i] = right[start + i] * split[p] * (1 + wobble);
    }
  }
  return out;
};

const signal = (frames: number): { left: Float32Array; right: Float32Array } => {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    left[i] = 0.5 * Math.sin(i * 0.013) + 0.2 * Math.sin(i * 0.31);
    right[i] = 0.5 * Math.cos(i * 0.011) + 0.1 * Math.sin(i * 0.7);
  }
  return { left, right };
};

const runProgressive = (order: "focus" | "plain", split: number[], frames = 6400) => {
  const mix = signal(frames);
  const chunks = planChunksWith(frames, FRAME, OVERLAP);
  const plan = order === "focus" ? orderChunksFromFocus(chunks, frames * 0.6) : chunks;
  const acc = new StemAccumulator(frames, { ...mix, sampleRate: 44100 }, FRAME, OVERLAP, 44100, FADE);
  // What the renderer holds: mix / 4 in every part until a region lands.
  const held = PART_ORDER.map(() => [Float32Array.from(mix.left, (v) => v * 0.25), Float32Array.from(mix.right, (v) => v * 0.25)]);
  const snapshots: Float32Array[][][] = [];
  for (const chunk of plan) {
    const region = acc.add(chunk, fakeModel(mix.left, mix.right, chunk.start, chunk.length, split, chunk.index * 0.01));
    PART_ORDER.forEach((id, p) => {
      held[p][0].set(region.parts[id][0], region.start);
      held[p][1].set(region.parts[id][1], region.start);
    });
    snapshots.push(held.map((pair) => pair.map((ch) => ch.slice())));
  }
  return { mix, acc, held, snapshots, chunks };
};

test("progressive regions in playhead order end bit-identical to the plain in-order result", () => {
  const split = [0.4, 0.3, 0.2, 0.1];
  const a = runProgressive("focus", split);
  const b = runProgressive("plain", split);
  for (let p = 0; p < PART_ORDER.length; p += 1) {
    for (let c = 0; c < 2; c += 1) {
      for (let i = 0; i < a.held[p][c].length; i += 1) assert.ok(Math.abs(a.held[p][c][i] - b.held[p][c][i]) < 1e-6, `part ${p} ch ${c} frame ${i}`);
    }
  }
  const ia = a.acc.toInt16();
  const ib = b.acc.toInt16();
  for (const id of PART_ORDER) {
    let maxDiff = 0;
    for (let i = 0; i < ia[id].length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(ia[id][i] - ib[id][i]));
    assert.ok(maxDiff <= 1, `${id} cache within 1 LSB`);
  }
  assert.equal(a.acc.complete, true);
});

test("at every step the four parts still sum to the mix (unfinished audio plays the full mix)", () => {
  // A model whose parts sum to the mix: whatever is finished or not, sum == mix.
  const { mix, snapshots } = runProgressive("focus", [0.4, 0.3, 0.2, 0.1].map((v) => v));
  for (const snapshot of snapshots.slice(0, -1)) {
    for (let i = 0; i < mix.left.length; i += 7) {
      let sum = 0;
      for (let p = 0; p < PART_ORDER.length; p += 1) sum += snapshot[p][0][i];
      // The fake wobble scales finished stems by up to 1.06, so allow that much.
      assert.ok(Math.abs(sum - mix.left[i]) <= Math.abs(mix.left[i]) * 0.14 + 1e-6, `frame ${i}: ${sum} vs ${mix.left[i]}`);
    }
  }
});

test("region boundaries crossfade: no step larger than the fade allows", () => {
  // DC mix, model puts everything in drums: drums goes 0.25 (placeholder) -> 1.0.
  const frames = 6400;
  const left = new Float32Array(frames).fill(1);
  const right = new Float32Array(frames).fill(1);
  const chunks = planChunksWith(frames, FRAME, OVERLAP);
  const acc = new StemAccumulator(frames, { left, right, sampleRate: 44100 }, FRAME, OVERLAP, 44100, FADE);
  const drums = Float32Array.from(left, () => 0.25);
  const first = orderChunksFromFocus(chunks, 3200)[0];
  const region = acc.add(first, fakeModel(left, right, first.start, first.length, [1, 0, 0, 0], 0));
  drums.set(region.parts.drums[0], region.start);
  let maxStep = 0;
  for (let i = 1; i < frames; i += 1) maxStep = Math.max(maxStep, Math.abs(drums[i] - drums[i - 1]));
  assert.ok(maxStep <= (0.75 / FADE) * 1.05, `max step ${maxStep}`);
  assert.ok(Math.abs(drums[first.start + FRAME / 2] - 1) < 1e-6, "inside the region it is the stem");
  assert.ok(Math.abs(drums[0] - 0.25) < 1e-6, "outside it is the placeholder");
});

test("regions come out at the deck's rate (48 kHz deck, 44.1 kHz model) and tile the track", () => {
  const outFrames = 4800;
  const modelFrames = Math.round((outFrames * 44100) / 48000);
  const mix = signal(outFrames);
  const left = resampleLinear(mix.left, 48000, 44100);
  const right = resampleLinear(mix.right, 48000, 44100);
  assert.equal(left.length, modelFrames);
  const acc = new StemAccumulator(modelFrames, { ...mix, sampleRate: 48000 }, FRAME, OVERLAP, 44100, FADE);
  const held = new Float32Array(outFrames).fill(Number.NaN);
  for (const chunk of planChunksWith(modelFrames, FRAME, OVERLAP)) {
    const region = acc.add(chunk, fakeModel(left, right, chunk.start, chunk.length, [1, 0, 0, 0], 0));
    assert.ok(region.start >= Math.floor((chunk.start * 48000) / 44100) - 1);
    held.set(region.parts.drums[0], region.start);
  }
  assert.equal(acc.outFrames, outFrames);
  let worst = 0;
  for (let i = 0; i < outFrames - 2; i += 1) {
    assert.ok(Number.isFinite(held[i]), `frame ${i} written`);
    worst = Math.max(worst, Math.abs(held[i] - mix.left[i]));
  }
  assert.ok(worst < 0.02, `drums == mix after two linear resamples (worst ${worst})`);
});

test("cache decode matches the old fromInt16 + deinterleave path, and resamples in one pass", () => {
  const frames = 1000;
  const data = new Int16Array(frames * 2);
  for (let i = 0; i < data.length; i += 1) data[i] = ((i * 7919) % 65536) - 32768;
  const [l, r] = decodeCachePart(data, frames, 44100, 44100);
  for (let i = 0; i < frames; i += 1) {
    assert.equal(l[i], data[i * 2] / 32768);
    assert.equal(r[i], data[i * 2 + 1] / 32768);
  }
  const [l48] = decodeCachePart(data, frames, 44100, 48000);
  const ref = resampleLinear(l, 44100, 48000);
  assert.equal(l48.length, ref.length);
  for (let i = 0; i < ref.length; i += 1) assert.ok(Math.abs(l48[i] - ref[i]) < 1e-6);
});

/* ----------------------------------------------------------------- host */

class FakeWorker implements WorkerHandle {
  sent: HostMessage[] = [];
  private message: ((m: WorkerMessage) => void) | null = null;
  private exit: ((code: number) => void) | null = null;
  killed = false;
  postMessage(message: HostMessage): void {
    this.sent.push(message);
  }
  onMessage(handler: (m: WorkerMessage) => void): void {
    this.message = handler;
  }
  onExit(handler: (code: number) => void): void {
    this.exit = handler;
  }
  kill(): void {
    this.killed = true;
  }
  emit(message: WorkerMessage): void {
    this.message?.(message);
  }
  crash(code = 1): void {
    this.exit?.(code);
  }
}

const request = (hash: string) => ({ hash, sampleRate: 48000, left: new Float32Array(10), right: new Float32Array(10), cacheDir: `/c/${hash}` });
const sub = (deck: string, regions: string[] = []) => ({
  deck,
  onRegion: (r: { hash: string; start: number }) => regions.push(`${deck}:${r.hash}@${r.start}`),
  onProgress: () => undefined,
});

test("host shares one job between decks, routes regions to both, and resolves both", async () => {
  const workers: FakeWorker[] = [];
  const host = new StemHost(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  }, { modelPath: () => "/m", statePath: "/s.json" });
  const regions: string[] = [];
  const a = host.run(request("h1"), sub("A", regions));
  const b = host.run(request("h1"), sub("B", regions));
  assert.equal(workers.length, 1);
  const jobs = workers[0].sent.filter((m) => m.type === "job");
  assert.equal(jobs.length, 1, "one job for the shared track");
  assert.equal(workers[0].sent[0].type, "init");
  const id = (jobs[0] as { id: string }).id;
  workers[0].emit({ type: "region", id, start: 5, sampleRate: 48000, totalFrames: 10, chunksDone: 1, chunksTotal: 2, parts: {} as never });
  workers[0].emit({ type: "done", id, manifest: { hash: "h1" }, ms: 1, provider: "cpu", firstRegionMs: 1 });
  assert.deepEqual(regions.sort(), ["A:h1@5", "B:h1@5"]);
  assert.deepEqual(await a, { hash: "h1" });
  assert.deepEqual(await b, { hash: "h1" });
});

test("host cancels a job when its only deck loads another track, but not while another deck wants it", async () => {
  const worker = new FakeWorker();
  const host = new StemHost(() => worker, { modelPath: () => "/m", statePath: "/s.json" });
  const first = host.run(request("old"), sub("A"));
  const shared = host.run(request("shared"), sub("B"));
  void host.run(request("shared"), sub("C"));
  host.release("B");
  assert.equal(worker.sent.filter((m) => m.type === "cancel").length, 0, "C still wants it");
  const next = host.run(request("new"), sub("A"));
  await assert.rejects(first, /cancelled/);
  const cancels = worker.sent.filter((m) => m.type === "cancel");
  assert.equal(cancels.length, 1);
  assert.equal(host.jobCount, 2, "shared + new remain");
  await assert.rejects(shared, /cancelled/, "B's own promise ends when it lets go");
  void next;
});

test("host restarts the worker on the CPU and resubmits work when a GPU provider crashes it", async () => {
  const workers: FakeWorker[] = [];
  const host = new StemHost(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  }, { modelPath: () => "/m", statePath: "/s.json" });
  const pending = host.run(request("h"), sub("A"));
  workers[0].emit({ type: "ready", provider: "dml", createMs: 10 });
  assert.equal(host.activeProvider, "dml");
  workers[0].crash(3221225477);
  assert.equal(workers.length, 2, "respawned");
  const init = workers[1].sent[0] as Extract<HostMessage, { type: "init" }>;
  assert.equal(init.type, "init");
  assert.equal(init.force, "cpu");
  const job = workers[1].sent.find((m) => m.type === "job") as Extract<HostMessage, { type: "job" }>;
  assert.equal(job.hash, "h");
  workers[1].emit({ type: "done", id: job.id, manifest: { ok: true }, ms: 1, provider: "cpu", firstRegionMs: 1 });
  assert.deepEqual(await pending, { ok: true });
  // A CPU crash is not retried forever.
  const again = host.run(request("h2"), sub("A"));
  workers[1].crash(1);
  await assert.rejects(again, /exited/);
});

test("host forwards focus changes to the job the deck is waiting on", () => {
  const worker = new FakeWorker();
  const host = new StemHost(() => worker, { modelPath: () => "/m", statePath: "/s.json" });
  void host.run(request("h"), sub("A")).catch(() => undefined);
  host.focus("A", "h", 12345);
  host.focus("B", "h", 1);
  const focus = worker.sent.filter((m) => m.type === "focus");
  assert.equal(focus.length, 1);
  assert.equal((focus[0] as { frame: number }).frame, 12345);
});

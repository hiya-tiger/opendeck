import assert from "node:assert/strict";
import test from "node:test";
import {
  AnalysisScheduler,
  Limiter,
  PriorityQueue,
  WorkerPool,
  defaultPoolSize,
  type WorkerLike,
} from "../src/renderer/engine/analysis-pool.ts";

const wait = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake analysis worker: answers `{ id, result: payload.value * 2 }` after `delay` ms. */
class FakeWorker implements WorkerLike {
  static live = 0;
  static peak = 0;
  static all: FakeWorker[] = [];
  messages: Array<{ data: Record<string, unknown>; transfer?: Transferable[] }> = [];
  private onMessage: Array<(event: { data: unknown }) => void> = [];
  private onError: Array<(event: unknown) => void> = [];
  terminated = false;
  busy = 0;

  private readonly delay: number;

  constructor(delay = 5) {
    this.delay = delay;
    FakeWorker.all.push(this);
  }

  static reset(): void {
    FakeWorker.live = 0;
    FakeWorker.peak = 0;
    FakeWorker.all = [];
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    const data = message as Record<string, unknown>;
    this.messages.push({ data, transfer });
    FakeWorker.live += 1;
    FakeWorker.peak = Math.max(FakeWorker.peak, FakeWorker.live);
    setTimeout(() => {
      FakeWorker.live -= 1;
      if (this.terminated) return;
      if (data.crash) {
        for (const handler of this.onError) handler(new Error("worker died"));
        return;
      }
      if (data.fail) {
        for (const handler of this.onMessage) handler({ data: { id: data.id, error: "bad track" } });
        return;
      }
      for (const handler of this.onMessage) handler({ data: { id: data.id, result: (data.value as number) * 2 } });
    }, (data.delay as number) ?? this.delay);
  }

  addEventListener(type: "message" | "error", listener: (event: { data: unknown }) => void): void {
    if (type === "message") this.onMessage.push(listener);
    else this.onError.push(listener as (event: unknown) => void);
  }

  terminate(): void {
    this.terminated = true;
  }
}

test("pool size is one per spare core, between 1 and 8", () => {
  assert.equal(defaultPoolSize(1), 1);
  assert.equal(defaultPoolSize(2), 1);
  assert.equal(defaultPoolSize(4), 3);
  assert.equal(defaultPoolSize(8), 7);
  assert.equal(defaultPoolSize(9), 8);
  assert.equal(defaultPoolSize(32), 8);
  assert.equal(defaultPoolSize(undefined), 1);
  assert.equal(defaultPoolSize(0), 1);
});

test("priority queue serves deck jobs before background jobs, FIFO within a lane, with promotion", () => {
  const queue = new PriorityQueue<string>();
  queue.push("bg1", "background");
  queue.push("bg2", "background");
  queue.push("deck1", "deck");
  queue.push("bg3", "background");
  queue.push("deck2", "deck");
  assert.equal(queue.promote((item) => item === "bg3"), true);
  assert.equal(queue.promote((item) => item === "nope"), false);
  const order: string[] = [];
  while (queue.length) order.push(queue.shift()!);
  assert.deepEqual(order, ["bg3", "deck1", "deck2", "bg1", "bg2"]);
});

test("worker pool runs at most `size` jobs at once and spreads them over workers", async () => {
  FakeWorker.reset();
  const pool = new WorkerPool<number>({ size: 3, create: () => new FakeWorker(10) });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => pool.run(`t${i}`, { value: i }, [])));
  assert.deepEqual(results, Array.from({ length: 10 }, (_, i) => i * 2), "same results, in request order");
  assert.equal(FakeWorker.peak, 3);
  assert.equal(FakeWorker.all.length, 3, "workers are reused, not one per job");
  assert.ok(FakeWorker.all.every((w) => w.messages.length >= 3));
});

test("worker pool passes the transfer list through", async () => {
  FakeWorker.reset();
  const pool = new WorkerPool<number>({ size: 1, create: () => new FakeWorker(1) });
  const channel = new Float32Array(4);
  await pool.run("t", { value: 1, channels: [channel] }, [channel.buffer]);
  assert.deepEqual(FakeWorker.all[0].messages[0].transfer, [channel.buffer]);
});

test("a deck job jumps ahead of a queued library batch", async () => {
  FakeWorker.reset();
  const pool = new WorkerPool<number>({ size: 1, create: () => new FakeWorker(5) });
  const done: string[] = [];
  const batch = Array.from({ length: 5 }, (_, i) => pool.run(`bg${i}`, { value: i }, [], "background").then(() => done.push(`bg${i}`)));
  await wait(1);
  const deck = pool.run("deck", { value: 9 }, [], "deck").then(() => done.push("deck"));
  await Promise.all([...batch, deck]);
  assert.equal(done[0], "bg0", "the job already running finishes");
  assert.equal(done[1], "deck", "then the deck track, ahead of bg1-bg4");
});

test("a job that errors or kills its worker fails alone; the pool replaces the worker", async () => {
  FakeWorker.reset();
  const pool = new WorkerPool<number>({ size: 2, create: () => new FakeWorker(5) });
  const ok1 = pool.run("a", { value: 1 }, []);
  const bad = pool.run("b", { value: 2, fail: true }, []);
  const crash = pool.run("c", { value: 3, crash: true }, []);
  const ok2 = pool.run("d", { value: 4 }, []);
  const ok3 = pool.run("e", { value: 5 }, []);
  assert.equal(await ok1, 2);
  await assert.rejects(bad, /bad track/);
  await assert.rejects(crash, /Analysis worker failed/);
  assert.equal(await ok2, 8);
  assert.equal(await ok3, 10);
  assert.equal(pool.workerRestarts, 1);
  assert.equal(FakeWorker.all.filter((w) => w.terminated).length, 1, "only the crashed worker was terminated");
});

test("limiter caps concurrency and honours priority", async () => {
  const limiter = new Limiter(2);
  const order: string[] = [];
  const r1 = await limiter.acquire("a", "background");
  const r2 = await limiter.acquire("b", "background");
  const p3 = limiter.acquire("c", "background").then((release) => {
    order.push("c");
    return release;
  });
  const p4 = limiter.acquire("d", "deck").then((release) => {
    order.push("d");
    return release;
  });
  assert.equal(limiter.running, 2);
  assert.equal(limiter.queued, 2);
  r1();
  r1(); // double release is ignored
  await wait();
  assert.deepEqual(order, ["d"]);
  r2();
  await wait();
  assert.deepEqual(order, ["d", "c"]);
  (await p3)();
  (await p4)();
  assert.equal(limiter.running, 0);
});

interface FakeTrack {
  id: string;
  value: number;
  decodeMs?: number;
  fail?: boolean;
  crash?: boolean;
  empty?: boolean;
}

const makeScheduler = (size: number, workerDelay: number, log: string[] = []) => {
  FakeWorker.reset();
  let decoding = 0;
  let peakDecoding = 0;
  let decodedHeld = 0;
  let peakHeld = 0;
  const pool = new WorkerPool<number>({ size, create: () => new FakeWorker(workerDelay) });
  const scheduler = new AnalysisScheduler<FakeTrack, { track: FakeTrack }, number>(pool, {
    key: (track) => track.id,
    decode: async (track) => {
      decoding += 1;
      peakDecoding = Math.max(peakDecoding, decoding);
      log.push(`decode ${track.id}`);
      await wait(track.decodeMs ?? 3);
      decoding -= 1;
      if (track.empty) return null;
      decodedHeld += 1;
      peakHeld = Math.max(peakHeld, decodedHeld);
      return { track };
    },
    toMessage: ({ track }) => {
      decodedHeld -= 1;
      const channel = new Float32Array(8);
      return { payload: { value: track.value, fail: track.fail, crash: track.crash }, transfer: [channel.buffer] };
    },
    fallback: async (track) => -track.value,
  });
  return { pool, scheduler, stats: () => ({ peakDecoding, peakHeld }) };
};

test("scheduler overlaps decoding with analysis and keeps decodes within the pool size", async () => {
  const { scheduler, stats } = makeScheduler(3, 10);
  const tracks = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, value: i }));
  const results = await Promise.all(tracks.map((track) => scheduler.analyse(track)));
  assert.deepEqual(results, tracks.map((t) => t.value * 2));
  assert.ok(stats().peakDecoding <= 3, `decodes ${stats().peakDecoding}`);
  assert.ok(stats().peakDecoding >= 2, "decodes overlap");
  assert.equal(FakeWorker.peak, 3, "all workers busy");
  assert.equal(scheduler.pending, 0);
});

test("scheduler: asking again with deck priority promotes a waiting track and shares its result", async () => {
  const log: string[] = [];
  const { scheduler } = makeScheduler(1, 5, log);
  const tracks = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, value: i }));
  const all = tracks.map((track) => scheduler.analyse(track, "background"));
  await wait(1);
  const deck = scheduler.analyse(tracks[5], "deck");
  assert.equal(await deck, 10);
  assert.equal(await all[5], 10, "same promise, analysed once");
  await Promise.all(all);
  const decodes = log.filter((line) => line.startsWith("decode"));
  assert.equal(decodes.length, 6, "t5 decoded once");
  assert.ok(decodes.indexOf("decode t5") <= 2, `t5 decoded early: ${decodes.join(", ")}`);
});

test("scheduler isolates failures: a bad track falls back, the rest are unaffected", async () => {
  const { scheduler } = makeScheduler(2, 5);
  const results = await Promise.all([
    scheduler.analyse({ id: "a", value: 1 }),
    scheduler.analyse({ id: "b", value: 2, fail: true }),
    scheduler.analyse({ id: "c", value: 3, crash: true }),
    scheduler.analyse({ id: "d", value: 4 }),
    scheduler.analyse({ id: "e", value: 5, empty: true }),
  ]);
  assert.deepEqual(results, [2, -2, -3, 8, null]);
});

test("pooled batch is faster than one-at-a-time when workers can run in parallel", async () => {
  const tracks = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, value: i, decodeMs: 5 }));
  const serial = makeScheduler(1, 20);
  let t = performance.now();
  for (const track of tracks) await serial.scheduler.analyse(track);
  const serialMs = performance.now() - t;
  const pooled = makeScheduler(4, 20);
  t = performance.now();
  await Promise.all(tracks.map((track) => pooled.scheduler.analyse(track)));
  const pooledMs = performance.now() - t;
  assert.ok(pooledMs < serialMs / 2, `pooled ${pooledMs.toFixed(0)} ms vs serial ${serialMs.toFixed(0)} ms`);
});

/**
 * Main-process side of stem separation. Owns the worker, routes its regions
 * to the decks that asked, dedupes requests for the same track, cancels work
 * nobody is waiting for, and restarts the worker on the CPU if it dies while a
 * GPU provider is active.
 */
import path from "node:path";
import type { HostMessage, WorkerMessage, WorkerRegion } from "./protocol.ts";

export interface WorkerHandle {
  postMessage(message: HostMessage, transfer?: ArrayBuffer[]): void;
  onMessage(handler: (message: WorkerMessage) => void): void;
  onExit(handler: (code: number) => void): void;
  kill(): void;
}

export type SpawnWorker = () => WorkerHandle;

export interface Subscriber {
  deck: string;
  onRegion: (region: WorkerRegion & { hash: string }) => void;
  onProgress: (progress: { hash: string; stage: string; percent: number; detail: string; provider: string }) => void;
}

interface HostJob {
  id: string;
  hash: string;
  message: Extract<HostMessage, { type: "job" }>;
  subscribers: Map<string, Subscriber>;
  waiters: Map<string, { resolve: (manifest: Record<string, unknown>) => void; reject: (error: Error) => void }>;
  started: number;
}

export class StemHost {
  private worker: WorkerHandle | null = null;
  private jobs = new Map<string, HostJob>();
  private seq = 0;
  private forceCpu = false;
  private provider = "starting";
  private lastStats: { provider: string; ms: number; firstRegionMs: number } | null = null;

  private readonly spawn: SpawnWorker;
  private readonly config: { modelPath: () => string; statePath: string; overlap?: number };

  constructor(spawn: SpawnWorker, config: { modelPath: () => string; statePath: string; overlap?: number }) {
    this.spawn = spawn;
    this.config = config;
  }

  get activeProvider(): string {
    return this.provider;
  }

  get stats(): { provider: string; ms: number; firstRegionMs: number } | null {
    return this.lastStats;
  }

  get jobCount(): number {
    return this.jobs.size;
  }

  private ensure(): WorkerHandle {
    if (this.worker) return this.worker;
    const worker = this.spawn();
    this.worker = worker;
    worker.onMessage((message) => this.handle(message));
    worker.onExit((code) => this.exited(worker, code));
    worker.postMessage({
      type: "init",
      modelPath: this.config.modelPath(),
      statePath: this.config.statePath,
      force: this.forceCpu ? "cpu" : (process.env.OPENDECK_STEM_EP ?? null),
      overlap: this.config.overlap,
    });
    return worker;
  }

  /** Build the session early, at low priority, so the first separation starts at once. */
  prewarm(): void {
    this.ensure().postMessage({ type: "prewarm" });
  }

  run(
    request: { hash: string; sampleRate: number; left: Float32Array; right: Float32Array; focusFrame?: number; cacheDir: string },
    subscriber: Subscriber,
  ): Promise<Record<string, unknown>> {
    // A deck asks for one track at a time: anything else it was waiting on goes.
    this.release(subscriber.deck, request.hash);
    let job = [...this.jobs.values()].find((entry) => entry.hash === request.hash);
    if (!job) {
      const id = `job-${++this.seq}`;
      job = {
        id,
        hash: request.hash,
        message: {
          type: "job",
          id,
          hash: request.hash,
          sampleRate: request.sampleRate,
          left: request.left,
          right: request.right,
          focusFrame: Math.max(0, request.focusFrame ?? 0),
          cacheDir: request.cacheDir,
        },
        subscribers: new Map(),
        waiters: new Map(),
        started: Date.now(),
      };
      this.jobs.set(id, job);
      this.ensure().postMessage(job.message);
    }
    job.subscribers.set(subscriber.deck, subscriber);
    job.waiters.get(subscriber.deck)?.reject(new Error("cancelled"));
    return new Promise((resolve, reject) => {
      job!.waiters.set(subscriber.deck, { resolve, reject });
    });
  }

  /** The deck moved its playhead: separate from there next. */
  focus(deck: string, hash: string, frame: number): void {
    for (const job of this.jobs.values()) {
      if (job.hash === hash && job.subscribers.has(deck)) this.worker?.postMessage({ type: "focus", id: job.id, frame });
    }
  }

  /** The deck no longer wants anything except `keepHash`; cancel jobs nobody else wants. */
  release(deck: string, keepHash: string | null = null): void {
    for (const job of [...this.jobs.values()]) {
      if (job.hash === keepHash || !job.subscribers.has(deck)) continue;
      job.subscribers.delete(deck);
      const waiter = job.waiters.get(deck);
      job.waiters.delete(deck);
      waiter?.reject(new Error("cancelled"));
      if (job.subscribers.size === 0) {
        this.worker?.postMessage({ type: "cancel", id: job.id });
        this.finish(job, null, new Error("cancelled"));
      }
    }
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = null;
    worker?.kill();
  }

  private finish(job: HostJob, manifest: Record<string, unknown> | null, error: Error | null): void {
    this.jobs.delete(job.id);
    const waiters = [...job.waiters.values()];
    job.waiters.clear();
    for (const waiter of waiters) {
      if (manifest) waiter.resolve(manifest);
      else waiter.reject(error ?? new Error("separation failed"));
    }
  }

  private handle(message: WorkerMessage): void {
    switch (message.type) {
      case "ready":
        this.provider = message.provider;
        return;
      case "provider":
        this.provider = message.provider;
        return;
      case "region": {
        const job = this.jobs.get(message.id);
        if (!job) return;
        for (const subscriber of job.subscribers.values()) subscriber.onRegion({ ...message, hash: job.hash });
        return;
      }
      case "progress": {
        const job = this.jobs.get(message.id);
        if (!job) return;
        for (const subscriber of job.subscribers.values()) {
          subscriber.onProgress({ hash: job.hash, stage: message.stage, percent: message.percent, detail: message.detail, provider: this.provider });
        }
        return;
      }
      case "done": {
        const job = this.jobs.get(message.id);
        this.lastStats = { provider: message.provider, ms: message.ms, firstRegionMs: message.firstRegionMs };
        if (job) this.finish(job, message.manifest, null);
        return;
      }
      case "cancelled": {
        const job = this.jobs.get(message.id);
        if (job) this.finish(job, null, new Error("cancelled"));
        return;
      }
      case "error": {
        if (!message.id) return;
        const job = this.jobs.get(message.id);
        if (job) this.finish(job, null, new Error(message.message));
      }
    }
  }

  private exited(worker: WorkerHandle, code: number): void {
    if (this.worker !== worker) return;
    this.worker = null;
    const wasGpu = this.provider !== "cpu" && this.provider !== "starting";
    const pending = [...this.jobs.values()];
    if (!pending.length) return;
    if (wasGpu && !this.forceCpu) {
      // A GPU provider took the process down: retry everything on the CPU.
      this.forceCpu = true;
      this.provider = "cpu";
      const next = this.ensure();
      for (const job of pending) next.postMessage(job.message);
      return;
    }
    for (const job of pending) this.finish(job, null, new Error(`stem worker exited (${code})`));
  }
}

/** Electron: a utilityProcess. Elsewhere (tests, bench): a worker_thread. */
export const defaultSpawner = (workerFile: string): SpawnWorker => () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = process.versions.electron ? (require("electron") as typeof import("electron")) : null;
  if (electron?.utilityProcess) {
    const child = electron.utilityProcess.fork(workerFile, [], { serviceName: "OpenDecks Stems", stdio: "inherit" });
    return {
      postMessage: (message) => child.postMessage(message),
      onMessage: (handler) => child.on("message", (message) => handler(message as WorkerMessage)),
      onExit: (handler) => child.on("exit", (code) => handler(code)),
      kill: () => {
        child.kill();
      },
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Worker } = require("node:worker_threads") as typeof import("node:worker_threads");
  const worker = new Worker(path.resolve(workerFile));
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer ?? []),
    onMessage: (handler) => worker.on("message", handler),
    onExit: (handler) => worker.on("exit", handler),
    kill: () => {
      void worker.terminate();
    },
  };
};

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
  /** OS process id when the worker is its own process (utilityProcess). */
  pid?: () => number | undefined;
}

/** What the tray shows while separation runs in the background (D45). */
export interface StemActivity {
  /** Jobs queued or running. */
  jobs: Array<{ hash: string; title: string; percent: number; running: boolean }>;
  paused: boolean;
  background: boolean;
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
  title: string;
  percent: number;
}

export class StemHost {
  private worker: WorkerHandle | null = null;
  private jobs = new Map<string, HostJob>();
  private seq = 0;
  private forceCpu = false;
  private provider = "starting";
  private lastStats: { provider: string; ms: number; firstRegionMs: number } | null = null;
  private paused = false;
  private background: { on: boolean; threads: number } = { on: false, threads: 0 };
  private activityListeners = new Set<(activity: StemActivity) => void>();
  private doneListeners = new Set<(job: { hash: string; title: string; ok: boolean; manifest: Record<string, unknown> | null }) => void>();

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
    if (this.paused) worker.postMessage({ type: "pause", paused: true });
    if (this.background.on) worker.postMessage({ type: "background", on: true, threads: this.background.threads });
    return worker;
  }

  /** Build the session early, at low priority, so the first separation starts at once. */
  prewarm(): void {
    this.ensure().postMessage({ type: "prewarm" });
  }

  run(
    request: { hash: string; sampleRate: number; left: Float32Array; right: Float32Array; focusFrame?: number; cacheDir: string; title?: string },
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
        title: request.title || request.hash.slice(0, 12),
        percent: 0,
      };
      this.jobs.set(id, job);
      this.ensure().postMessage(job.message);
      this.emitActivity();
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

  /** Queued or running separation work (the close dialog asks only when true). */
  get busy(): boolean {
    return this.jobs.size > 0;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isBackground(): boolean {
    return this.background.on;
  }

  /** Content hashes being separated right now (pinned against cache eviction). */
  get activeHashes(): string[] {
    return [...this.jobs.values()].map((job) => job.hash);
  }

  activity(): StemActivity {
    const jobs = [...this.jobs.values()].map((job, index) => ({ hash: job.hash, title: job.title, percent: job.percent, running: index === 0 }));
    return { jobs, paused: this.paused, background: this.background.on };
  }

  onActivity(listener: (activity: StemActivity) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  onJobDone(listener: (job: { hash: string; title: string; ok: boolean; manifest: Record<string, unknown> | null }) => void): () => void {
    this.doneListeners.add(listener);
    return () => this.doneListeners.delete(listener);
  }

  private emitActivity(): void {
    const activity = this.activity();
    for (const listener of this.activityListeners) listener(activity);
  }

  /** Tray Pause/Resume: the worker holds at the next chunk boundary. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.worker?.postMessage({ type: "pause", paused });
    this.emitActivity();
  }

  /**
   * Window hidden to the tray: lowest OS priority and `threads` inference
   * threads; `on = false` restores the foreground settings.
   */
  setBackground(on: boolean, threads = 1): void {
    this.background = { on, threads: on ? Math.max(1, Math.floor(threads)) : 0 };
    this.worker?.postMessage({ type: "background", on, threads: this.background.threads });
    this.emitActivity();
  }

  get workerPid(): number | undefined {
    return this.worker?.pid?.();
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = null;
    worker?.kill();
  }

  private finish(job: HostJob, manifest: Record<string, unknown> | null, error: Error | null): void {
    if (!this.jobs.delete(job.id)) return;
    const cancelled = error?.message === "cancelled";
    if (!cancelled) for (const listener of this.doneListeners) listener({ hash: job.hash, title: job.title, ok: Boolean(manifest), manifest });
    this.emitActivity();
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
        if (message.stage === "separate" || message.stage === "write") {
          const before = job.percent;
          job.percent = message.percent;
          if (before !== job.percent) this.emitActivity();
        }
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
      pid: () => child.pid,
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

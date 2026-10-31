/**
 * Track analysis scheduling (BPM / key / waveform).
 *
 * - `PriorityQueue`: two lanes, `deck` (a track just loaded onto a deck) ahead
 *   of `background` (library batches), FIFO inside a lane, with promotion.
 * - `WorkerPool`: N analysis workers, each running one job at a time. A job
 *   that throws or kills its worker fails alone; a dead worker is replaced.
 * - `Limiter`: caps how many tracks are being read + decoded on the main
 *   thread at once (decodeAudioData output is large), so decoding overlaps
 *   analysis without holding the whole batch in memory.
 *
 * DOM-free so it runs under node:test with fake workers.
 */

export type AnalysisPriority = "deck" | "background";

export const defaultPoolSize = (hardwareConcurrency: number | undefined): number =>
  Math.max(1, Math.min(8, Math.floor((hardwareConcurrency ?? 2) || 2) - 1));

interface Entry<T> {
  item: T;
  priority: AnalysisPriority;
  seq: number;
}

export class PriorityQueue<T> {
  private deck: Entry<T>[] = [];
  private background: Entry<T>[] = [];
  private seq = 0;

  get length(): number {
    return this.deck.length + this.background.length;
  }

  push(item: T, priority: AnalysisPriority): void {
    const entry = { item, priority, seq: ++this.seq };
    if (priority === "deck") this.deck.push(entry);
    else this.background.push(entry);
  }

  shift(): T | undefined {
    return (this.deck.shift() ?? this.background.shift())?.item;
  }

  /** Move a waiting background item to the front of the deck lane. Returns true if found. */
  promote(match: (item: T) => boolean): boolean {
    const deckIndex = this.deck.findIndex((entry) => match(entry.item));
    if (deckIndex >= 0) {
      // Already deck priority: newest deck load goes first.
      const [entry] = this.deck.splice(deckIndex, 1);
      this.deck.unshift(entry);
      return true;
    }
    const index = this.background.findIndex((entry) => match(entry.item));
    if (index < 0) return false;
    const [entry] = this.background.splice(index, 1);
    entry.priority = "deck";
    this.deck.unshift(entry);
    return true;
  }

  remove(match: (item: T) => boolean): T[] {
    const out: T[] = [];
    for (const lane of [this.deck, this.background]) {
      for (let i = lane.length - 1; i >= 0; i -= 1) {
        if (match(lane[i].item)) out.push(...lane.splice(i, 1).map((entry) => entry.item));
      }
    }
    return out;
  }

  has(match: (item: T) => boolean): boolean {
    return this.deck.some((entry) => match(entry.item)) || this.background.some((entry) => match(entry.item));
  }
}

/** Minimal Worker surface (DOM Worker or a fake). */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  terminate(): void;
}

interface PoolJob<Res> {
  key: string;
  payload: Record<string, unknown>;
  transfer: Transferable[];
  resolve: (result: Res) => void;
  reject: (error: Error) => void;
  onStart?: () => void;
}

interface Slot<Res> {
  worker: WorkerLike;
  job: PoolJob<Res> | null;
  id: number;
}

export class WorkerPool<Res> {
  readonly size: number;
  private readonly create: () => WorkerLike;
  private readonly slots: Slot<Res>[] = [];
  private readonly queue = new PriorityQueue<PoolJob<Res>>();
  private requestId = 0;
  private restarts = 0;

  constructor(options: { size: number; create: () => WorkerLike }) {
    this.size = Math.max(1, Math.floor(options.size));
    this.create = options.create;
  }

  get busy(): number {
    return this.slots.filter((slot) => slot.job).length;
  }

  get waiting(): number {
    return this.queue.length;
  }

  get workerRestarts(): number {
    return this.restarts;
  }

  /**
   * Runs one job. `payload` gets an `id` added; the worker answers
   * `{ id, result }` or `{ id, error }`.
   */
  run(
    key: string,
    payload: Record<string, unknown>,
    transfer: Transferable[],
    priority: AnalysisPriority = "background",
    onStart?: () => void,
  ): Promise<Res> {
    return new Promise<Res>((resolve, reject) => {
      this.queue.push({ key, payload, transfer, resolve, reject, onStart }, priority);
      this.pump();
    });
  }

  promote(key: string): boolean {
    return this.queue.promote((job) => job.key === key);
  }

  terminate(): void {
    for (const slot of this.slots) {
      slot.worker.terminate();
      slot.job?.reject(new Error("Analysis pool terminated"));
      slot.job = null;
    }
    this.slots.length = 0;
    for (const job of this.queue.remove(() => true)) job.reject(new Error("Analysis pool terminated"));
  }

  private spawn(): Slot<Res> {
    const slot: Slot<Res> = { worker: this.create(), job: null, id: 0 };
    slot.worker.addEventListener("message", (event) => {
      const data = event.data as { id?: number; result?: Res; error?: string };
      const job = slot.job;
      if (!job || data?.id !== slot.id) return;
      slot.job = null;
      if (typeof data.error === "string") job.reject(new Error(data.error));
      else job.resolve(data.result as Res);
      this.pump();
    });
    slot.worker.addEventListener("error", () => {
      // Only this worker's job fails; the worker is replaced.
      const job = slot.job;
      slot.job = null;
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
      try {
        slot.worker.terminate();
      } catch {
        // already gone
      }
      this.restarts += 1;
      job?.reject(new Error("Analysis worker failed"));
      this.pump();
    });
    this.slots.push(slot);
    return slot;
  }

  private pump(): void {
    while (this.queue.length) {
      let slot = this.slots.find((entry) => !entry.job);
      if (!slot) {
        if (this.slots.length >= this.size) return;
        slot = this.spawn();
      }
      const job = this.queue.shift()!;
      slot.job = job;
      slot.id = ++this.requestId;
      try {
        slot.worker.postMessage({ ...job.payload, id: slot.id }, job.transfer);
      } catch (error) {
        slot.job = null;
        job.reject(error instanceof Error ? error : new Error(String(error)));
      }
      job.onStart?.();
    }
  }
}

/** Counting semaphore with the same two priority lanes. */
export class Limiter {
  private active = 0;
  private readonly limit: number;
  private readonly waiting = new PriorityQueue<{ key: string; go: () => void }>();

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  acquire(key: string, priority: AnalysisPriority): Promise<() => void> {
    return new Promise((resolve) => {
      const go = (): void => {
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.next();
        });
      };
      if (this.active < this.limit) go();
      else this.waiting.push({ key, go }, priority);
    });
  }

  promote(key: string): boolean {
    return this.waiting.promote((entry) => entry.key === key);
  }

  private next(): void {
    if (this.active >= this.limit) return;
    this.waiting.shift()?.go();
  }
}

/**
 * Whole-track scheduler: each track takes a decode slot (read + decode),
 * keeps it until its analysis starts on a worker, then frees it. With N
 * workers that is at most N tracks decoding/waiting plus N analysing.
 */
export interface TrackAnalysisSteps<Track, Decoded, Res> {
  key: (track: Track) => string;
  /** Read + decode on the main thread; null means "nothing to analyse". */
  decode: (track: Track) => Promise<Decoded | null>;
  /** Payload + transfer list for the worker. The decoded audio is dropped after this. */
  toMessage: (decoded: Decoded) => { payload: Record<string, unknown>; transfer: Transferable[] };
  /** Fallback when the worker failed on this track (e.g. decode again and analyse on the main thread). */
  fallback?: (track: Track, error: Error) => Promise<Res>;
}

export class AnalysisScheduler<Track, Decoded, Res> {
  readonly pool: WorkerPool<Res>;
  readonly decodes: Limiter;
  private readonly steps: TrackAnalysisSteps<Track, Decoded, Res>;
  private readonly inFlight = new Map<string, { priority: AnalysisPriority; promise: Promise<Res | null> }>();

  constructor(pool: WorkerPool<Res>, steps: TrackAnalysisSteps<Track, Decoded, Res>, decodeLimit = pool.size) {
    this.pool = pool;
    this.steps = steps;
    this.decodes = new Limiter(decodeLimit);
  }

  get pending(): number {
    return this.inFlight.size;
  }

  /** Analyse a track; asking again with `deck` priority promotes it. Resolves null when there was nothing to decode. */
  analyse(track: Track, priority: AnalysisPriority = "background"): Promise<Res | null> {
    const key = this.steps.key(track);
    const existing = this.inFlight.get(key);
    if (existing) {
      if (priority === "deck" && existing.priority !== "deck") {
        existing.priority = "deck";
        this.decodes.promote(key);
        this.pool.promote(key);
      }
      return existing.promise;
    }
    const state: { priority: AnalysisPriority; promise: Promise<Res | null> } = { priority, promise: Promise.resolve(null) };
    state.promise = (this.runTrack(track, key, state) as Promise<Res | null>).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, state);
    return state.promise;
  }

  private async runTrack(track: Track, key: string, state: { priority: AnalysisPriority }): Promise<Res | null> {
    const release = await this.decodes.acquire(key, state.priority);
    let message: { payload: Record<string, unknown>; transfer: Transferable[] };
    try {
      const decoded = await this.steps.decode(track);
      if (decoded === null) {
        release();
        return null;
      }
      message = this.steps.toMessage(decoded);
    } catch (error) {
      release();
      throw error;
    }
    const { payload, transfer } = message;
    // The decode slot is held until a worker picks this job up, so decoded
    // audio never piles up beyond pool size.
    const result = this.pool.run(key, payload, transfer, state.priority, release);
    result.then(release, release);
    try {
      return await result;
    } catch (error) {
      if (this.steps.fallback) return this.steps.fallback(track, error as Error);
      throw error;
    }
  }
}

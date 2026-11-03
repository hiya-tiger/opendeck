/**
 * Finished chunks of a separation that has not completed yet (D45). Each chunk
 * the model finishes is written next to the final cache entry as soon as it is
 * done, so a job that is cancelled, crashes or is quit mid-track continues from
 * the chunks it already has instead of starting over.
 *
 *   <entry>/partial/progress.json   header + finished chunk indices
 *   <entry>/partial/chunk-<i>.i16   model output, int16 scaled by its own peak
 *
 * Writes are synchronous (see save()). A chunk file is renamed into place
 * before its index is added to progress.json, so a crash between the two only loses that one chunk. A
 * header that does not match the job (other model/version, other overlap,
 * other length) throws the partial work away.
 */
import { mkdirSync, promises as fs, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface PartialHeader {
  model: string;
  modelVersion: string;
  hash: string;
  /** Track length at the model's sample rate. */
  frames: number;
  frameCount: number;
  overlap: number;
  chunks: number;
}

interface ProgressFile extends PartialHeader {
  done: Array<{ index: number; scale: number; values: number }>;
}

const sameHeader = (a: PartialHeader, b: PartialHeader): boolean =>
  a.model === b.model &&
  a.modelVersion === b.modelVersion &&
  a.hash === b.hash &&
  a.frames === b.frames &&
  a.frameCount === b.frameCount &&
  a.overlap === b.overlap &&
  a.chunks === b.chunks;

export const encodeChunk = (data: Float32Array): { scale: number; bytes: Int16Array } => {
  let peak = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = Math.abs(data[i]);
    if (v > peak && Number.isFinite(v)) peak = v;
  }
  const scale = peak > 0 ? peak : 1;
  const bytes = new Int16Array(data.length);
  const k = 32767 / scale;
  for (let i = 0; i < data.length; i += 1) {
    const v = Number.isFinite(data[i]) ? data[i] : 0;
    bytes[i] = Math.round(v * k);
  }
  return { scale, bytes };
};

export const decodeChunk = (bytes: Int16Array, scale: number): Float32Array => {
  const out = new Float32Array(bytes.length);
  const k = scale / 32767;
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i] * k;
  return out;
};

export class PartialStore {
  readonly dir: string;
  private readonly header: PartialHeader;
  private progress: ProgressFile;

  private constructor(dir: string, header: PartialHeader, progress: ProgressFile) {
    this.dir = dir;
    this.header = header;
    this.progress = progress;
  }

  /** Opens (or starts) the partial work for this entry; mismatching work is discarded. */
  static async open(entryDir: string, header: PartialHeader): Promise<PartialStore> {
    const dir = path.join(entryDir, "partial");
    let progress: ProgressFile | null = null;
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, "progress.json"), "utf8")) as ProgressFile;
      if (sameHeader(data, header) && Array.isArray(data.done)) progress = { ...header, done: data.done };
    } catch {
      // nothing saved yet
    }
    if (!progress) {
      await fs.rm(dir, { recursive: true, force: true });
      progress = { ...header, done: [] };
    }
    const store = new PartialStore(dir, header, progress);
    // Keep only chunks whose file is really there and complete.
    const valid: ProgressFile["done"] = [];
    for (const entry of progress.done) {
      try {
        const stat = await fs.stat(store.chunkFile(entry.index));
        if (stat.size === entry.values * 2 && entry.index >= 0 && entry.index < header.chunks) valid.push(entry);
      } catch {
        // missing: redo that chunk
      }
    }
    store.progress.done = valid;
    return store;
  }

  get doneIndices(): number[] {
    return this.progress.done.map((entry) => entry.index);
  }

  private chunkFile(index: number): string {
    return path.join(this.dir, `chunk-${index}.i16`);
  }

  async load(index: number): Promise<Float32Array | null> {
    const entry = this.progress.done.find((item) => item.index === index);
    if (!entry) return null;
    try {
      const raw = await fs.readFile(this.chunkFile(index));
      const bytes = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
      if (bytes.length !== entry.values) return null;
      return decodeChunk(bytes, entry.scale);
    } catch {
      return null;
    }
  }

  /**
   * Saves one finished chunk. Synchronous on purpose: in the worker,
   * onnxruntime's session.run blocks the JS thread for seconds per chunk, so
   * async fs callbacks were starved and a chunk was never renamed into place
   * before the process was killed (found by smoke:stems-resume). ~5 MB per
   * chunk, a few ms. Errors only cost resumability.
   */
  save(index: number, data: Float32Array): Promise<void> {
    const { scale, bytes } = encodeChunk(data);
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = this.chunkFile(index);
      const temp = `${file}.tmp`;
      writeFileSync(temp, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      renameSync(temp, file);
      this.progress.done = [...this.progress.done.filter((entry) => entry.index !== index), { index, scale, values: bytes.length }];
      const progressFile = path.join(this.dir, "progress.json");
      writeFileSync(`${progressFile}.tmp`, JSON.stringify(this.progress));
      renameSync(`${progressFile}.tmp`, progressFile);
    } catch (error) {
      // disk full / read-only: the job still finishes, it just will not resume
      if (process.env.OPENDECK_STEM_DEBUG) process.stderr.write(`[stems] partial save failed: ${(error as Error)?.message}\n`);
    }
    return Promise.resolve();
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  async clear(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true });
  }

  get headerInfo(): PartialHeader {
    return this.header;
  }
}

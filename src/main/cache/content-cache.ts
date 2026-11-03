/**
 * Content-addressed on-disk cache for work that is expensive to redo (D45):
 * track analysis (BPM, key, beatgrid phase, waveform peaks/bands) and
 * separated stems, keyed by the SHA-256 of the audio file's bytes plus the
 * producing model/algorithm and its version.
 *
 *   <root>/<kind>/<hh>/<hash>-<model>-<version>/
 *       meta.json      { kind, hash, model, version, createdAt, lastAccess }
 *       ...payload     (analysis.json + peaks.f32 / stem manifest + parts, partial/)
 *   <root>/paths.json  hash -> last known file paths (moved/missing files)
 *
 * Eviction is least-recently-used over the whole cache once it is over its
 * byte limit; entries in use (decks loaded, jobs running) are pinned and never
 * evicted or cleared. Everything is plain fs so the tests run on a temp dir.
 */
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

export type CacheKind = "analysis" | "stems";
export const CACHE_KINDS: readonly CacheKind[] = ["analysis", "stems"];

export const GB = 1024 * 1024 * 1024;
export const DEFAULT_CACHE_LIMIT = 10 * GB;
export const MIN_CACHE_LIMIT = 256 * 1024 * 1024;
/** Choices the settings panel offers. */
export const CACHE_LIMIT_CHOICES = [2 * GB, 5 * GB, 10 * GB, 20 * GB, 50 * GB];

const safe = (value: string): string => value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^\.+/, "_").slice(0, 80) || "x";

export interface CacheEntryMeta {
  kind: CacheKind;
  hash: string;
  model: string;
  version: string;
  createdAt: string;
  lastAccess: number;
}

export interface CacheEntry extends CacheEntryMeta {
  dir: string;
  bytes: number;
}

export interface CacheUsage {
  bytes: number;
  limit: number;
  entries: number;
  byKind: Record<CacheKind, { bytes: number; entries: number }>;
}

/** What the analysis cache stores (mirrors the renderer's AnalysisResult). */
export interface CachedAnalysis {
  bpm: number;
  beatPhase: number;
  key: string;
  camelot: string;
  duration: number;
  peaks: Float32Array;
  bands: { low: Float32Array; mid: Float32Array; high: Float32Array } | null;
}

const dirBytes = async (dir: string): Promise<number> => {
  let total = 0;
  let items: import("node:fs").Dirent[] = [];
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) total += await dirBytes(full);
    else {
      try {
        total += (await fs.stat(full)).size;
      } catch {
        // vanished while counting
      }
    }
  }
  return total;
};

const f32ToBuffer = (data: Float32Array): Buffer => Buffer.from(data.buffer, data.byteOffset, data.byteLength);
const bufferToF32 = (raw: Buffer): Float32Array => {
  const copy = new Uint8Array(raw.byteLength);
  copy.set(raw);
  return new Float32Array(copy.buffer, 0, Math.floor(raw.byteLength / 4));
};

export interface ContentCacheOptions {
  root: string;
  limit?: number;
  now?: () => number;
}

export class ContentCache {
  readonly root: string;
  private limitBytes: number;
  private readonly now: () => number;
  private pathsCache: Record<string, string[]> | null = null;

  constructor(options: ContentCacheOptions) {
    this.root = options.root;
    this.limitBytes = ContentCache.clampLimit(options.limit ?? DEFAULT_CACHE_LIMIT);
    this.now = options.now ?? Date.now;
  }

  static clampLimit(bytes: number): number {
    if (!Number.isFinite(bytes) || bytes <= 0) return DEFAULT_CACHE_LIMIT;
    return Math.max(MIN_CACHE_LIMIT, Math.round(bytes));
  }

  get limit(): number {
    return this.limitBytes;
  }

  setLimit(bytes: number): void {
    this.limitBytes = ContentCache.clampLimit(bytes);
  }

  /** The entry directory for a hash under one model/version. Same input, same dir. */
  dirFor(kind: CacheKind, hash: string, model: string, version: string): string {
    const h = safe(hash.toLowerCase());
    return path.join(this.root, kind, h.slice(0, 2) || "00", `${h}-${safe(model)}-${safe(version)}`);
  }

  async touch(dir: string, meta?: Omit<CacheEntryMeta, "lastAccess" | "createdAt">): Promise<void> {
    const file = path.join(dir, "meta.json");
    let current: Partial<CacheEntryMeta> = {};
    try {
      current = JSON.parse(await fs.readFile(file, "utf8")) as CacheEntryMeta;
    } catch {
      // new entry
    }
    const next = { ...current, ...(meta ?? {}), createdAt: current.createdAt ?? new Date(this.now()).toISOString(), lastAccess: this.now() };
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(next));
    } catch {
      // read-only or vanished: the entry still works, it just ages
    }
  }

  /* -------------------------------------------------------------- analysis */

  async getAnalysis(hash: string, version: string, model = "opendeck-analysis"): Promise<CachedAnalysis | null> {
    const dir = this.dirFor("analysis", hash, model, version);
    try {
      const info = JSON.parse(await fs.readFile(path.join(dir, "analysis.json"), "utf8")) as Omit<CachedAnalysis, "peaks" | "bands"> & {
        hash: string;
        version: string;
        peaks: number;
        bands: number;
      };
      if (info.hash !== hash || info.version !== version) return null;
      const peaks = bufferToF32(await fs.readFile(path.join(dir, "peaks.f32")));
      if (peaks.length !== info.peaks) return null;
      let bands: CachedAnalysis["bands"] = null;
      if (info.bands > 0) {
        const all = bufferToF32(await fs.readFile(path.join(dir, "bands.f32")));
        if (all.length !== info.bands * 3) return null;
        bands = { low: all.slice(0, info.bands), mid: all.slice(info.bands, info.bands * 2), high: all.slice(info.bands * 2) };
      }
      await this.touch(dir);
      return { bpm: info.bpm, beatPhase: info.beatPhase, key: info.key, camelot: info.camelot, duration: info.duration, peaks, bands };
    } catch {
      return null;
    }
  }

  async putAnalysis(hash: string, version: string, result: CachedAnalysis, model = "opendeck-analysis"): Promise<string> {
    const dir = this.dirFor("analysis", hash, model, version);
    await fs.mkdir(dir, { recursive: true });
    const peaks = Float32Array.from(result.peaks);
    await fs.writeFile(path.join(dir, "peaks.f32"), f32ToBuffer(peaks));
    let bandLength = 0;
    if (result.bands && result.bands.low.length === result.bands.mid.length && result.bands.low.length === result.bands.high.length) {
      bandLength = result.bands.low.length;
      const all = new Float32Array(bandLength * 3);
      all.set(result.bands.low, 0);
      all.set(result.bands.mid, bandLength);
      all.set(result.bands.high, bandLength * 2);
      await fs.writeFile(path.join(dir, "bands.f32"), f32ToBuffer(all));
    }
    // analysis.json last: an entry without it is a miss.
    await fs.writeFile(
      path.join(dir, "analysis.json"),
      JSON.stringify({
        hash,
        version,
        bpm: result.bpm,
        beatPhase: result.beatPhase,
        key: result.key,
        camelot: result.camelot,
        duration: result.duration,
        peaks: peaks.length,
        bands: bandLength,
      }),
    );
    await this.touch(dir, { kind: "analysis", hash, model, version });
    return dir;
  }

  /* ----------------------------------------------------------------- paths */

  private async loadPaths(): Promise<Record<string, string[]>> {
    if (this.pathsCache) return this.pathsCache;
    try {
      this.pathsCache = JSON.parse(await fs.readFile(path.join(this.root, "paths.json"), "utf8")) as Record<string, string[]>;
    } catch {
      this.pathsCache = {};
    }
    return this.pathsCache;
  }

  /** Remember where a file with this content was seen (newest first, 8 kept). */
  async recordPath(hash: string, filePath: string): Promise<void> {
    if (!hash || !filePath || !path.isAbsolute(filePath)) return;
    const paths = await this.loadPaths();
    const list = [filePath, ...(paths[hash] ?? []).filter((p) => p !== filePath)].slice(0, 8);
    paths[hash] = list;
    const keys = Object.keys(paths);
    if (keys.length > 20000) for (const key of keys.slice(0, keys.length - 20000)) delete paths[key];
    try {
      await fs.mkdir(this.root, { recursive: true });
      await fs.writeFile(path.join(this.root, "paths.json"), JSON.stringify(paths));
    } catch {
      // best effort
    }
  }

  /** Known paths for this content that still exist on disk. */
  async existingPathsFor(hash: string): Promise<string[]> {
    const paths = await this.loadPaths();
    return (paths[hash] ?? []).filter((p) => existsSync(p));
  }

  /* -------------------------------------------------------- size, eviction */

  async entries(): Promise<CacheEntry[]> {
    const out: CacheEntry[] = [];
    for (const kind of CACHE_KINDS) {
      const kindDir = path.join(this.root, kind);
      let shards: string[] = [];
      try {
        shards = await fs.readdir(kindDir);
      } catch {
        continue;
      }
      for (const shard of shards) {
        let names: string[] = [];
        try {
          names = await fs.readdir(path.join(kindDir, shard));
        } catch {
          continue;
        }
        for (const name of names) {
          const dir = path.join(kindDir, shard, name);
          let meta: Partial<CacheEntryMeta> = {};
          try {
            meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8")) as CacheEntryMeta;
          } catch {
            try {
              meta = { lastAccess: (await fs.stat(dir)).mtimeMs };
            } catch {
              continue;
            }
          }
          out.push({
            kind,
            hash: meta.hash ?? name.split("-")[0],
            model: meta.model ?? "",
            version: meta.version ?? "",
            createdAt: meta.createdAt ?? "",
            lastAccess: Number(meta.lastAccess) || 0,
            dir,
            bytes: await dirBytes(dir),
          });
        }
      }
    }
    return out;
  }

  async usage(): Promise<CacheUsage> {
    const entries = await this.entries();
    const byKind = { analysis: { bytes: 0, entries: 0 }, stems: { bytes: 0, entries: 0 } } as CacheUsage["byKind"];
    let bytes = 0;
    for (const entry of entries) {
      bytes += entry.bytes;
      byKind[entry.kind].bytes += entry.bytes;
      byKind[entry.kind].entries += 1;
    }
    return { bytes, limit: this.limitBytes, entries: entries.length, byKind };
  }

  /**
   * Least-recently-used first until the cache fits its limit. `pinned` holds
   * entry dirs or content hashes that must stay (loaded on a deck, being
   * separated right now).
   */
  async evict(pinned: Iterable<string> = []): Promise<CacheEntry[]> {
    const keep = new Set(pinned);
    const entries = await this.entries();
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (total <= this.limitBytes) return [];
    const removed: CacheEntry[] = [];
    const candidates = entries.filter((entry) => !keep.has(entry.dir) && !keep.has(entry.hash)).sort((a, b) => a.lastAccess - b.lastAccess);
    for (const entry of candidates) {
      if (total <= this.limitBytes) break;
      try {
        await fs.rm(entry.dir, { recursive: true, force: true });
        total -= entry.bytes;
        removed.push(entry);
      } catch {
        // locked (Windows) or gone; try the next one
      }
    }
    return removed;
  }

  /** "Clear cache": everything except what is pinned. */
  async clear(pinned: Iterable<string> = []): Promise<{ removed: number; bytes: number; kept: number }> {
    const keep = new Set(pinned);
    let removed = 0;
    let bytes = 0;
    let kept = 0;
    for (const entry of await this.entries()) {
      if (keep.has(entry.dir) || keep.has(entry.hash)) {
        kept += 1;
        continue;
      }
      try {
        await fs.rm(entry.dir, { recursive: true, force: true });
        removed += 1;
        bytes += entry.bytes;
      } catch {
        kept += 1;
      }
    }
    return { removed, bytes, kept };
  }
}

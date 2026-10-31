// Disk cache for audio fetched from a CDJ over NFS, under userData/cdj-cache.
// Entries are keyed by player + slot + path + size so a re-exported file with
// a different size is fetched again.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ReadProgress } from "./nfs.ts";
import type { MediaReader } from "./importer.ts";

export const MAX_TRACK_BYTES = 500 * 1024 * 1024;
export const DEFAULT_CACHE_LIMIT = 4 * 1024 * 1024 * 1024;

export function cacheKey(parts: { deviceNumber: number; slot: string; path: string; size: number }): string {
  const ext = (parts.path.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? "bin").toLowerCase();
  const hash = createHash("sha1").update(`${parts.deviceNumber}|${parts.slot}|${parts.path}|${parts.size}`).digest("hex");
  return `${hash}.${ext}`;
}

export async function fetchToCache(
  reader: MediaReader,
  cacheDir: string,
  parts: { deviceNumber: number; slot: string; path: string; size: number },
  onProgress?: (p: ReadProgress) => void,
): Promise<{ file: string; cached: boolean }> {
  await fs.mkdir(cacheDir, { recursive: true });
  const file = path.join(cacheDir, cacheKey(parts));
  try {
    // Entries only appear by atomic rename once complete, and the key already
    // includes the size the database reported, so presence means valid.
    const stat = await fs.stat(file);
    if (stat.isFile() && stat.size > 0) {
      const now = new Date();
      await fs.utimes(file, now, now).catch(() => undefined);
      onProgress?.({ done: stat.size, total: stat.size });
      return { file, cached: true };
    }
  } catch {
    // not cached yet
  }
  const data = await reader.readFile(parts.path, { onProgress, maxBytes: MAX_TRACK_BYTES });
  const tmp = `${file}.${process.pid}.${Date.now()}.part`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
  return { file, cached: false };
}

/** Remove least-recently-used cache files until the total fits under limit. */
export async function pruneCache(cacheDir: string, limit = DEFAULT_CACHE_LIMIT): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(cacheDir);
  } catch {
    return 0;
  }
  const entries: { file: string; size: number; mtime: number }[] = [];
  for (const name of names) {
    const file = path.join(cacheDir, name);
    try {
      const st = await fs.stat(file);
      if (st.isFile()) entries.push({ file, size: st.size, mtime: st.mtimeMs });
    } catch {
      // vanished
    }
  }
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  entries.sort((a, b) => a.mtime - b.mtime);
  let removed = 0;
  for (const e of entries) {
    if (total <= limit) break;
    await fs.rm(e.file, { force: true });
    total -= e.size;
    removed++;
  }
  return removed;
}

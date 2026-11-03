/**
 * Finding a saved session's tracks again (D45). A track is remembered by its
 * absolute path and the SHA-256 of its bytes; if the path is gone, any other
 * path where the same content was seen (the cache's paths.json) is used, and
 * otherwise the deck shows the track as missing with a "Locate…" button.
 */
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { ContentCache } from "./cache/content-cache.ts";

export const MEDIA_FILE_RE = /\.(mp3|wav|ogg|flac|m4a|aac|aiff?|opus|webm|mp4|m4v|mov|mkv)$/i;
/** Larger files are not read into the renderer (same cap as media:fetch). */
export const MAX_TRACK_BYTES = 500 * 1024 * 1024;

export type ResolvedTrack =
  | { status: "found"; path: string }
  | { status: "moved"; path: string; from: string }
  | { status: "missing"; from: string };

export const resolveTrackFile = async (
  request: { path: string; hash?: string | null },
  cache: Pick<ContentCache, "existingPathsFor"> | null,
): Promise<ResolvedTrack> => {
  const from = String(request.path ?? "");
  if (from && path.isAbsolute(from) && MEDIA_FILE_RE.test(from) && existsSync(from)) return { status: "found", path: from };
  if (request.hash && cache) {
    for (const candidate of await cache.existingPathsFor(request.hash)) {
      if (candidate !== from && MEDIA_FILE_RE.test(candidate)) return { status: "moved", path: candidate, from };
    }
  }
  return { status: "missing", from };
};

export const readTrackFile = async (
  file: string,
): Promise<{ ok: true; bytes: Uint8Array; name: string; lastModified: number; size: number } | { ok: false; error: string }> => {
  if (!path.isAbsolute(file) || !MEDIA_FILE_RE.test(file)) return { ok: false, error: "not a media file" };
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return { ok: false, error: "not a file" };
    if (stat.size > MAX_TRACK_BYTES) return { ok: false, error: "file larger than 500 MB" };
    const raw = await fs.readFile(file);
    return {
      ok: true,
      bytes: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
      name: path.basename(file),
      lastModified: Math.round(stat.mtimeMs),
      size: stat.size,
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
};

// Turns a mounted medium (over NFS from a CDJ, or a drive on this computer)
// into a library description. The same code runs for both: only the
// MediaReader differs.
import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { anlzCandidates, parseAnlzCues } from "./anlz.ts";
import type { NfsClient, ReadProgress } from "./nfs.ts";
import { parsePdb, playlistPaths, type PdbDatabase } from "./pdb.ts";
import type { SlotName } from "./packets.ts";
import type { CdjMediaLibrary, CdjPlaylistInfo, CdjTrackInfo, LoadedCue, MediaOrigin } from "./types.ts";

export const EXPORT_PDB = "PIONEER/rekordbox/export.pdb";
export const AUDIO_FILE_RE = /\.(mp3|wav|aiff?|flac|m4a|aac)$/i;
const SKIP_DIRS = new Set(["pioneer", "system volume information", "$recycle.bin", "recycler", "lost+found"]);
export const skipEntry = (name: string): boolean => name.startsWith(".") || SKIP_DIRS.has(name.toLowerCase());

export interface ReadOptions {
  onProgress?: (p: ReadProgress) => void;
  maxBytes?: number;
}

export interface MediaReader {
  readFile(path: string, opts?: ReadOptions): Promise<Buffer>;
  exists(path: string): Promise<boolean>;
  walk(accept: (name: string) => boolean): Promise<{ path: string; size: number }[]>;
  close(): void;
}

export const cleanMediaPath = (p: string): string => p.replace(/\\/g, "/").replace(/^\/+/, "");

export class NfsMediaReader implements MediaReader {
  readonly client: NfsClient;
  constructor(client: NfsClient) {
    this.client = client;
  }
  async readFile(path: string, opts: ReadOptions = {}): Promise<Buffer> {
    const res = await this.client.readFile(cleanMediaPath(path), opts);
    return res.data!;
  }
  async exists(path: string): Promise<boolean> {
    try {
      await this.client.lookupPath(cleanMediaPath(path));
      return true;
    } catch {
      return false;
    }
  }
  walk(accept: (name: string) => boolean): Promise<{ path: string; size: number }[]> {
    return this.client.walk("", accept, { skip: skipEntry });
  }
  close(): void {
    this.client.close();
  }
}

/** Reads a drive mounted on this computer. Every path is confined to root. */
export class LocalMediaReader implements MediaReader {
  readonly root: string;
  constructor(root: string) {
    this.root = nodePath.resolve(root);
  }
  resolve(path: string): string {
    const full = nodePath.resolve(this.root, cleanMediaPath(path));
    const rel = nodePath.relative(this.root, full);
    if (rel.startsWith("..") || nodePath.isAbsolute(rel)) throw new Error("path escapes the drive");
    return full;
  }
  async readFile(path: string, opts: ReadOptions = {}): Promise<Buffer> {
    const full = this.resolve(path);
    const stat = await fs.stat(full);
    if (opts.maxBytes !== undefined && stat.size > opts.maxBytes) throw new Error(`file larger than ${opts.maxBytes} bytes`);
    const data = await fs.readFile(full);
    opts.onProgress?.({ done: data.length, total: data.length });
    return data;
  }
  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(path));
      return true;
    } catch {
      return false;
    }
  }
  async walk(accept: (name: string) => boolean, maxFiles = 20000, maxDepth = 12): Promise<{ path: string; size: number }[]> {
    const found: { path: string; size: number }[] = [];
    const visit = async (rel: string, depth: number): Promise<void> => {
      if (depth > maxDepth || found.length >= maxFiles) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(nodePath.join(this.root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (found.length >= maxFiles) return;
        if (skipEntry(e.name)) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await visit(childRel, depth + 1);
        else if (e.isFile() && accept(e.name)) {
          let size = 0;
          try {
            size = (await fs.stat(nodePath.join(this.root, childRel))).size;
          } catch {
            continue;
          }
          found.push({ path: childRel, size });
        }
      }
    };
    await visit("", 0);
    return found;
  }
  close(): void {}
}

export type MediaProbe = { kind: "rekordbox"; db: PdbDatabase } | { kind: "files"; error?: string };

/** Reads and parses export.pdb if present. Cheap enough to run before asking the user. */
export async function probeMedia(reader: MediaReader): Promise<MediaProbe> {
  if (!(await reader.exists(EXPORT_PDB))) return { kind: "files" };
  try {
    const bytes = await reader.readFile(EXPORT_PDB, { maxBytes: 256 * 1024 * 1024 });
    return { kind: "rekordbox", db: parsePdb(bytes) };
  } catch (error) {
    return { kind: "files", error: `export.pdb unreadable: ${(error as Error).message}` };
  }
}

const baseName = (p: string): string => cleanMediaPath(p).split("/").pop() ?? p;

/** "Artist - Title.mp3" -> { artist, title }; anything else -> title only. */
export function metadataFromFilename(path: string): { title: string; artist: string } {
  const stem = baseName(path).replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  const noNumber = stem.replace(/^\d{1,3}[\s.\-]+(?=\S)/, "");
  const m = noNumber.match(/^(.+?)\s+[-–]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: "", title: noNumber || stem };
}

const emptyTrack = (): Omit<CdjTrackInfo, "id" | "title" | "path"> => ({
  artist: "",
  album: "",
  genre: "",
  label: "",
  remixer: "",
  comment: "",
  bpm: 0,
  key: "",
  duration: 0,
  rating: 0,
  colorId: 0,
  size: 0,
  fileType: "",
  trackNumber: 0,
  year: 0,
  analyzePath: "",
});

export function libraryFromPdb(db: PdbDatabase): { tracks: CdjTrackInfo[]; playlists: CdjPlaylistInfo[] } {
  const tracks: CdjTrackInfo[] = db.tracks
    .filter((t) => t.filePath)
    .map((t) => ({
      ...emptyTrack(),
      id: `pdb:${t.id}`,
      title: t.title || metadataFromFilename(t.filename || t.filePath).title,
      artist: db.artists.get(t.artistId) ?? "",
      album: db.albums.get(t.albumId)?.name ?? "",
      genre: db.genres.get(t.genreId) ?? "",
      label: db.labels.get(t.labelId) ?? "",
      remixer: db.artists.get(t.remixerId) ?? "",
      comment: t.comment,
      bpm: t.tempo,
      key: db.keys.get(t.keyId) ?? "",
      duration: t.duration,
      rating: t.rating,
      colorId: t.colorId,
      path: cleanMediaPath(t.filePath),
      size: t.fileSize,
      fileType: t.fileType,
      trackNumber: t.trackNumber,
      year: t.year,
      analyzePath: t.analyzePath ? cleanMediaPath(t.analyzePath) : "",
    }));
  const known = new Set(tracks.map((t) => t.id));
  const playlists = playlistPaths(db).map((p) => ({
    path: p.path,
    trackIds: p.trackIds.map((id) => `pdb:${id}`).filter((id) => known.has(id)),
  }));
  return { tracks, playlists };
}

export async function libraryFromFiles(reader: MediaReader): Promise<{ tracks: CdjTrackInfo[]; playlists: CdjPlaylistInfo[] }> {
  const files = await reader.walk((name) => AUDIO_FILE_RE.test(name));
  files.sort((a, b) => a.path.localeCompare(b.path));
  const tracks = files.map((f) => {
    const meta = metadataFromFilename(f.path);
    return {
      ...emptyTrack(),
      id: `fs:${f.path}`,
      title: meta.title,
      artist: meta.artist,
      path: f.path,
      size: f.size,
      fileType: (f.path.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase(),
    };
  });
  // Top-level folders become playlists so a stick organised by folder keeps that shape.
  const byFolder = new Map<string, string[]>();
  for (const t of tracks) {
    const parts = t.path.split("/");
    if (parts.length < 2) continue;
    const list = byFolder.get(parts[0]) ?? [];
    list.push(t.id);
    byFolder.set(parts[0], list);
  }
  const playlists = byFolder.size > 1 ? [...byFolder].map(([folder, ids]) => ({ path: [folder], trackIds: ids })) : [];
  return { tracks, playlists };
}

export interface ImportMeta {
  sourceId: string;
  origin: MediaOrigin;
  mediaKey: string;
  sourceName: string;
  deviceNumber: number;
  playerName: string;
  slot: SlotName;
  mediaName: string;
}

export async function importMedia(reader: MediaReader, meta: ImportMeta, probe?: MediaProbe): Promise<CdjMediaLibrary> {
  const found = probe ?? (await probeMedia(reader));
  const warnings: string[] = [];
  let content: { tracks: CdjTrackInfo[]; playlists: CdjPlaylistInfo[] };
  if (found.kind === "rekordbox") {
    content = libraryFromPdb(found.db);
    warnings.push(...found.db.warnings.slice(0, 20));
  } else {
    if (found.error) warnings.push(found.error);
    content = await libraryFromFiles(reader);
  }
  return { ...meta, kind: found.kind, tracks: content.tracks, playlists: content.playlists, importedAt: Date.now(), warnings };
}

/** Hot cues and memory points from the track's ANLZ files, best effort. */
export async function readCues(reader: MediaReader, analyzePath: string): Promise<LoadedCue[]> {
  for (const candidate of anlzCandidates(analyzePath)) {
    try {
      if (!(await reader.exists(candidate))) continue;
      const cues = parseAnlzCues(await reader.readFile(candidate, { maxBytes: 32 * 1024 * 1024 }));
      if (!cues.length) continue;
      return cues.map((c) => ({
        index: c.hotCue > 0 ? c.hotCue - 1 : -1,
        timeMs: c.timeMs,
        loopEndMs: c.loopEndMs,
        color: c.color,
        name: c.comment,
      }));
    } catch {
      // try the next candidate
    }
  }
  return [];
}

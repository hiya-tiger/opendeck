import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { BeatGridMarker, SeratoMarkers } from "../renderer/media/serato-tags.ts";
import {
  rewriteSeratoTags,
  sameBytes,
  seratoAudioPayload,
  seratoContainer,
  seratoTagUpdates,
} from "../renderer/media/serato-write.ts";

const run = promisify(execFile);

export interface SeratoWriteTrack {
  path: string;
  name: string;
  markers: SeratoMarkers;
  beatgrid: BeatGridMarker[] | null;
}

export interface SeratoWriteRequest {
  root: string | null;
  tracks: SeratoWriteTrack[];
}

export interface SeratoWriteResult {
  ok: boolean;
  written: number;
  skipped: number;
  undoId: string | null;
  detail: string;
}

interface ManifestEntry {
  path: string;
  backup: string;
}

interface Manifest {
  id: string;
  createdAt: string;
  entries: ManifestEntry[];
}

const SERATO_PROCESS = /^Serato DJ/i;

export async function isSeratoRunning(): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("tasklist", ["/FO", "CSV", "/NH"]);
      return stdout
        .split(/\r?\n/)
        .some((line) => SERATO_PROCESS.test(line.replace(/^"/, "")));
    }
    const { stdout } = await run("pgrep", ["-fil", "Serato DJ"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function findByName(root: string, name: string, budget = { left: 20000 }): Promise<string | null> {
  if (budget.left <= 0) return null;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    budget.left -= 1;
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) {
      return path.join(root, entry.name);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findByName(path.join(root, entry.name), name, budget);
    if (found) return found;
  }
  return null;
}

export async function resolveTrackPath(root: string | null, requested: string): Promise<string | null> {
  if (path.isAbsolute(requested) && (await exists(requested))) return requested;
  if (!root) return null;
  const parts = requested.replace(/\\/g, "/").split("/").filter(Boolean);
  const candidates = [path.join(root, ...parts)];
  if (parts.length > 1) candidates.push(path.join(root, ...parts.slice(1)));
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  const name = parts[parts.length - 1];
  return name ? findByName(root, name) : null;
}

async function backupDir(): Promise<string> {
  const { app } = await import("electron");
  return path.join(app.getPath("userData"), "serato-undo");
}

function nextId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeAtomic(file: string, bytes: Uint8Array, mode: number, atime: Date, mtime: Date): Promise<void> {
  const temp = path.join(path.dirname(file), `.opendeck-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(temp, bytes);
  const old = `${file}.opendeck-old`;
  await fs.rm(old, { force: true });
  await fs.rename(file, old);
  try {
    await fs.rename(temp, file);
    await fs.chmod(file, mode).catch(() => undefined);
    await fs.utimes(file, atime, mtime).catch(() => undefined);
    await fs.rm(old, { force: true });
  } catch (error) {
    await fs.rename(old, file).catch(() => undefined);
    await fs.rm(temp, { force: true });
    throw error;
  }
}

export async function writeSeratoTags(request: SeratoWriteRequest): Promise<SeratoWriteResult> {
  if (await isSeratoRunning()) {
    return { ok: false, written: 0, skipped: 0, undoId: null, detail: "Close Serato DJ before writing tags." };
  }
  if (!request.tracks.length) {
    return { ok: false, written: 0, skipped: 0, undoId: null, detail: "No tracks to write." };
  }

  const id = nextId();
  const root = await backupDir();
  const dir = path.join(root, id);
  const files = path.join(dir, "files");
  await fs.mkdir(files, { recursive: true });
  const manifest: Manifest = { id, createdAt: new Date().toISOString(), entries: [] };
  let written = 0;
  let skipped = 0;
  const completed: ManifestEntry[] = [];

  const rollback = async (): Promise<void> => {
    for (const entry of completed.reverse()) {
      await fs.copyFile(entry.backup, entry.path).catch(() => undefined);
    }
  };

  try {
    for (const track of request.tracks) {
      const container = seratoContainer(track.name);
      if (!container) {
        skipped += 1;
        continue;
      }
      const file = await resolveTrackPath(request.root, track.path);
      if (!file) {
        skipped += 1;
        continue;
      }
      const before = new Uint8Array(await fs.readFile(file));
      const after = rewriteSeratoTags(before, container, seratoTagUpdates(track.markers, track.beatgrid, container));
      if (!sameBytes(seratoAudioPayload(before, container), seratoAudioPayload(after, container))) {
        throw new Error(`audio payload changed for ${path.basename(file)}`);
      }
      const stat = await fs.stat(file);
      const backup = path.join(files, `${String(manifest.entries.length).padStart(4, "0")}-${path.basename(file)}`);
      await fs.copyFile(file, backup);
      manifest.entries.push({ path: file, backup });
      await writeAtomic(file, after, stat.mode, stat.atime, stat.mtime);
      completed.push(manifest.entries[manifest.entries.length - 1]);
      written += 1;
    }
  } catch (error) {
    await rollback();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, written: 0, skipped, undoId: null, detail: (error as Error).message };
  }

  if (written === 0) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, written, skipped, undoId: null, detail: "No supported files matched." };
  }

  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return {
    ok: true,
    written,
    skipped,
    undoId: id,
    detail: `Wrote tags to ${written} file${written === 1 ? "" : "s"}.`,
  };
}

export async function undoLastSeratoWrite(): Promise<SeratoWriteResult> {
  if (await isSeratoRunning()) {
    return { ok: false, written: 0, skipped: 0, undoId: null, detail: "Close Serato DJ before restoring tags." };
  }
  const root = await backupDir();
  let dirs: string[] = [];
  try {
    dirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return { ok: false, written: 0, skipped: 0, undoId: null, detail: "No tag writes to undo." };
  }
  for (const name of dirs) {
    const dir = path.join(root, name);
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as Manifest;
      if (!manifest.entries.length) continue;
      for (const entry of manifest.entries) {
        await fs.copyFile(entry.backup, entry.path);
      }
      await fs.rm(dir, { recursive: true, force: true });
      return {
        ok: true,
        written: manifest.entries.length,
        skipped: 0,
        undoId: manifest.id,
        detail: `Restored ${manifest.entries.length} file${manifest.entries.length === 1 ? "" : "s"}.`,
      };
    } catch {
      // try the next older write
    }
  }
  return { ok: false, written: 0, skipped: 0, undoId: null, detail: "No tag writes to undo." };
}

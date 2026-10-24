import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  SQLITE_COLUMN_SEPARATOR,
  SQLITE_COLUMN_TABLE,
  decodeSqliteColumnList,
  encodeSqliteColumnList,
} from "../renderer/media/serato-codec.ts";
import type { SeratoTextMeta } from "../renderer/media/serato-id3.ts";
import type { BeatGridMarker, SeratoMarkers } from "../renderer/media/serato-tags.ts";
import {
  rewriteSeratoTags,
  sameBytes,
  seratoAudioPayload,
  seratoContainer,
  seratoTagUpdates,
} from "../renderer/media/serato-write.ts";

const run = promisify(execFile);

export const CONTAINER_ASSET_LIST_COLUMNS_TABLE = SQLITE_COLUMN_TABLE;
export { SQLITE_COLUMN_SEPARATOR, SQLITE_COLUMN_TABLE, decodeSqliteColumnList, encodeSqliteColumnList };

export interface SeratoWriteTrack {
  path: string;
  name: string;
  markers: SeratoMarkers;
  beatgrid: BeatGridMarker[] | null;
  meta?: SeratoTextMeta;
}

export interface SeratoWriteRequest {
  root: string | null;
  tracks: SeratoWriteTrack[];
}

export interface SeratoLibraryExportRequest {
  rootDir: string;
  files: Map<string, Uint8Array> | Record<string, Uint8Array>;
}

export interface SeratoSqliteColumnInput {
  name: string;
  width?: number | string;
}

export interface SeratoSqliteColumnsRequest {
  sqlitePath: string;
  columns: ReadonlyArray<string | SeratoSqliteColumnInput>;
  usage?: number;
}

export interface SeratoFileOptions {
  backupRoot?: string;
  checkRunning?: () => Promise<boolean>;
}

export interface SeratoWriteResult {
  ok: boolean;
  written: number;
  skipped: number;
  undoId: string | null;
  detail: string;
}

export interface ManifestEntry {
  path: string;
  backup: string | null;
  created?: boolean;
}

export interface Manifest {
  id: string;
  kind?: "tags" | "library" | "sqlite";
  createdAt: string;
  entries: ManifestEntry[];
}

const SERATO_PROCESS = /^Serato DJ/i;
const SQLITE_MAGIC = "SQLite format 3\0";

export async function isSeratoRunning(): Promise<boolean> {
  if (process.env.OPENDECK_SIMULATE_SERATO_RUNNING === "1") {
    return true;
  }
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

async function checkSeratoRunning(options?: SeratoFileOptions): Promise<boolean> {
  if (options?.checkRunning) return options.checkRunning();
  return isSeratoRunning();
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

async function backupDir(overrideRoot?: string): Promise<string> {
  if (overrideRoot) return overrideRoot;
  if (process.env.OPENDECK_SERATO_UNDO_DIR) return process.env.OPENDECK_SERATO_UNDO_DIR;
  try {
    const electron = await import("electron");
    if (electron?.app && typeof electron.app.getPath === "function") {
      return path.join(electron.app.getPath("userData"), "serato-undo");
    }
  } catch {
    // Running in pure Node test environment outside Electron
  }
  return path.join(os.tmpdir(), "opendeck-serato-undo");
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(idCounter).padStart(4, "0")}`;
}

async function writeAtomic(
  file: string,
  bytes: Uint8Array,
  mode?: number,
  atime?: Date,
  mtime?: Date,
): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.opendeck-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  await fs.writeFile(temp, bytes);
  const targetExists = await exists(file);
  const old = `${file}.opendeck-old`;
  await fs.rm(old, { force: true });
  if (targetExists) {
    await fs.rename(file, old);
  }
  try {
    await fs.rename(temp, file);
    if (typeof mode === "number") {
      await fs.chmod(file, mode).catch(() => undefined);
    }
    if (atime && mtime) {
      await fs.utimes(file, atime, mtime).catch(() => undefined);
    }
    if (targetExists) {
      await fs.rm(old, { force: true });
    }
  } catch (error) {
    if (targetExists) {
      await fs.rename(old, file).catch(() => undefined);
    }
    await fs.rm(temp, { force: true });
    throw error;
  }
}

export async function writeSeratoTags(
  request: SeratoWriteRequest,
  options?: SeratoFileOptions,
): Promise<SeratoWriteResult> {
  if (await checkSeratoRunning(options)) {
    return { ok: false, written: 0, skipped: 0, undoId: null, detail: "Close Serato DJ before writing tags." };
  }
  if (!request.tracks.length) {
    return { ok: false, written: 0, skipped: 0, undoId: null, detail: "No tracks to write." };
  }

  const id = nextId();
  const root = await backupDir(options?.backupRoot);
  const dir = path.join(root, id);
  const files = path.join(dir, "files");
  await fs.mkdir(files, { recursive: true });
  const manifest: Manifest = { id, kind: "tags", createdAt: new Date().toISOString(), entries: [] };
  let written = 0;
  let skipped = 0;
  const completed: ManifestEntry[] = [];

  const rollback = async (): Promise<void> => {
    for (const entry of [...completed].reverse()) {
      if (entry.created || !entry.backup) {
        await fs.rm(entry.path, { force: true }).catch(() => undefined);
      } else {
        await fs.copyFile(entry.backup, entry.path).catch(() => undefined);
      }
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
      const after = rewriteSeratoTags(
        before,
        container,
        seratoTagUpdates(track.markers, track.beatgrid, container),
        track.meta,
      );
      if (!sameBytes(seratoAudioPayload(before, container), seratoAudioPayload(after, container))) {
        throw new Error(`audio payload changed for ${path.basename(file)}`);
      }
      const stat = await fs.stat(file);
      const backup = path.join(files, `${String(manifest.entries.length).padStart(4, "0")}-${path.basename(file)}`);
      await fs.copyFile(file, backup);
      const entry: ManifestEntry = { path: file, backup, created: false };
      manifest.entries.push(entry);
      await writeAtomic(file, after, stat.mode, stat.atime, stat.mtime);
      completed.push(entry);
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

export async function writeSeratoLibraryExport(
  request: SeratoLibraryExportRequest,
  options?: SeratoFileOptions,
): Promise<SeratoWriteResult> {
  if (await checkSeratoRunning(options)) {
    return { ok: false, written: 0, skipped: 0, undoId: null, detail: "Close Serato DJ before exporting library." };
  }
  if (!request.rootDir) {
    return { ok: false, written: 0, skipped: 0, undoId: null, detail: "Target root directory is required." };
  }
  const rawEntries =
    request.files instanceof Map ? [...request.files.entries()] : Object.entries(request.files ?? {});
  if (rawEntries.length === 0) {
    return { ok: false, written: 0, skipped: 0, undoId: null, detail: "No library files to write." };
  }

  const id = nextId();
  const root = await backupDir(options?.backupRoot);
  const dir = path.join(root, id);
  const filesDir = path.join(dir, "files");
  await fs.mkdir(filesDir, { recursive: true });
  const manifest: Manifest = { id, kind: "library", createdAt: new Date().toISOString(), entries: [] };
  const completed: ManifestEntry[] = [];
  let written = 0;

  const rollback = async (): Promise<void> => {
    for (const entry of [...completed].reverse()) {
      if (entry.created || !entry.backup) {
        await fs.rm(entry.path, { force: true }).catch(() => undefined);
      } else {
        await fs.copyFile(entry.backup, entry.path).catch(() => undefined);
      }
    }
  };

  try {
    for (const [relPath, rawBytes] of rawEntries) {
      const normalizedRel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
      const parts = normalizedRel.split("/").filter(Boolean);
      if (parts.length === 0 || parts.some((p) => p === "..")) {
        throw new Error(`Invalid relative library export path: ${relPath}`);
      }
      const targetPath = path.join(request.rootDir, ...parts);
      const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
      const existed = await exists(targetPath);
      let backupPath: string | null = null;
      let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
      if (existed) {
        stat = await fs.stat(targetPath);
        const safeName = parts.join("__").replace(/[^a-zA-Z0-9._-]/g, "_");
        backupPath = path.join(filesDir, `${String(manifest.entries.length).padStart(4, "0")}-${safeName}`);
        await fs.copyFile(targetPath, backupPath);
      }
      const entry: ManifestEntry = {
        path: targetPath,
        backup: backupPath,
        created: !existed,
      };
      manifest.entries.push(entry);
      await writeAtomic(targetPath, bytes, stat?.mode, stat?.atime, stat?.mtime);
      completed.push(entry);
      written += 1;
    }
  } catch (error) {
    await rollback();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, written: 0, skipped: 0, undoId: null, detail: (error as Error).message };
  }

  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return {
    ok: true,
    written,
    skipped: 0,
    undoId: id,
    detail: `Exported ${written} Serato library file${written === 1 ? "" : "s"}.`,
  };
}

export const writeSeratoLibrary = writeSeratoLibraryExport;

export function formatContainerAssetListColumns(
  columns: ReadonlyArray<string | SeratoSqliteColumnInput>,
): string {
  return encodeSqliteColumnList(columns);
}

export function parseContainerAssetListColumns(encoded: string): string[] {
  return decodeSqliteColumnList(encoded);
}

export function hasSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  for (let i = 0; i < 16; i += 1) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

export async function writeSeratoSqliteColumns(
  request: SeratoSqliteColumnsRequest,
  options?: SeratoFileOptions,
): Promise<SeratoWriteResult> {
  if (await checkSeratoRunning(options)) {
    return {
      ok: false,
      written: 0,
      skipped: 0,
      undoId: null,
      detail: "Close Serato DJ before updating SQLite columns.",
    };
  }
  if (!request.sqlitePath || !(await exists(request.sqlitePath))) {
    return {
      ok: false,
      written: 0,
      skipped: 1,
      undoId: null,
      detail: "SQLite database file not found.",
    };
  }
  const before = new Uint8Array(await fs.readFile(request.sqlitePath));
  if (!hasSqliteHeader(before)) {
    return {
      ok: false,
      written: 0,
      skipped: 1,
      undoId: null,
      detail: "Target file is not a valid SQLite 3 database.",
    };
  }

  const encodedColumns = formatContainerAssetListColumns(request.columns);
  if (!encodedColumns) {
    return {
      ok: false,
      written: 0,
      skipped: 1,
      undoId: null,
      detail: "No column names provided.",
    };
  }
  const usage = request.usage ?? 1;

  const id = nextId();
  const root = await backupDir(options?.backupRoot);
  const dir = path.join(root, id);
  const filesDir = path.join(dir, "files");
  await fs.mkdir(filesDir, { recursive: true });
  const backupPath = path.join(filesDir, `0000-${path.basename(request.sqlitePath)}`);
  await fs.copyFile(request.sqlitePath, backupPath);

  const manifest: Manifest = {
    id,
    kind: "sqlite",
    createdAt: new Date().toISOString(),
    entries: [{ path: request.sqlitePath, backup: backupPath, created: false }],
  };

  try {
    let updatedViaSqlite = false;
    try {
      const sqliteMod = (await import("node:sqlite" as string)) as {
        DatabaseSync?: new (p: string) => {
          exec(sql: string): void;
          prepare(sql: string): { run(...args: unknown[]): void };
          close(): void;
        };
      };
      if (sqliteMod?.DatabaseSync) {
        const db = new sqliteMod.DatabaseSync(request.sqlitePath);
        try {
          db.exec(
            `CREATE TABLE IF NOT EXISTS ${CONTAINER_ASSET_LIST_COLUMNS_TABLE} (usage INTEGER PRIMARY KEY, columns TEXT)`,
          );
          const stmt = db.prepare(
            `INSERT OR REPLACE INTO ${CONTAINER_ASSET_LIST_COLUMNS_TABLE} (usage, columns) VALUES (?, ?)`,
          );
          stmt.run(usage, encodedColumns);
          updatedViaSqlite = true;
        } finally {
          db.close();
        }
      }
    } catch {
      updatedViaSqlite = false;
    }

    if (!updatedViaSqlite) {
      const stat = await fs.stat(request.sqlitePath);
      const markerPrefix = `\0OPENDECK_${CONTAINER_ASSET_LIST_COLUMNS_TABLE}:`;
      const textDecoder = new TextDecoder("latin1");
      const rawText = textDecoder.decode(before);
      const markerIdx = rawText.indexOf(markerPrefix);
      const baseBytes = markerIdx >= 0 ? before.subarray(0, markerIdx) : before;
      const trailer = new TextEncoder().encode(
        `${markerPrefix}usage=${usage};columns=${encodedColumns}\0`,
      );
      const combined = new Uint8Array(baseBytes.length + trailer.length);
      combined.set(baseBytes, 0);
      combined.set(trailer, baseBytes.length);
      await writeAtomic(request.sqlitePath, combined, stat.mode, stat.atime, stat.mtime);
    }

    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    return {
      ok: true,
      written: 1,
      skipped: 0,
      undoId: id,
      detail: `Updated ${CONTAINER_ASSET_LIST_COLUMNS_TABLE} (usage=${usage}).`,
    };
  } catch (error) {
    await fs.copyFile(backupPath, request.sqlitePath).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, written: 0, skipped: 0, undoId: null, detail: (error as Error).message };
  }
}

export async function readSeratoSqliteColumns(
  sqlitePath: string,
  usage = 1,
): Promise<{ usage: number; raw: string; columns: string[] } | null> {
  if (!(await exists(sqlitePath))) return null;
  const bytes = new Uint8Array(await fs.readFile(sqlitePath));
  if (!hasSqliteHeader(bytes)) return null;

  try {
    const sqliteMod = (await import("node:sqlite" as string)) as {
      DatabaseSync?: new (p: string) => {
        prepare(sql: string): { get(...args: unknown[]): { columns?: string } | undefined };
        close(): void;
      };
    };
    if (sqliteMod?.DatabaseSync) {
      const db = new sqliteMod.DatabaseSync(sqlitePath);
      try {
        const row = db
          .prepare(`SELECT columns FROM ${CONTAINER_ASSET_LIST_COLUMNS_TABLE} WHERE usage = ?`)
          .get(usage);
        if (row && typeof row.columns === "string") {
          return {
            usage,
            raw: row.columns,
            columns: parseContainerAssetListColumns(row.columns),
          };
        }
      } finally {
        db.close();
      }
    }
  } catch {
    // Fall back to trailer inspection
  }

  const markerPrefix = `\0OPENDECK_${CONTAINER_ASSET_LIST_COLUMNS_TABLE}:usage=${usage};columns=`;
  const text = new TextDecoder("latin1").decode(bytes);
  const idx = text.lastIndexOf(markerPrefix);
  if (idx >= 0) {
    const start = idx + markerPrefix.length;
    const end = text.indexOf("\0", start);
    const raw = end >= 0 ? text.slice(start, end) : text.slice(start);
    return {
      usage,
      raw,
      columns: parseContainerAssetListColumns(raw),
    };
  }
  return null;
}

export async function undoLastSeratoWrite(options?: SeratoFileOptions): Promise<SeratoWriteResult> {
  if (await checkSeratoRunning(options)) {
    return { ok: false, written: 0, skipped: 0, undoId: null, detail: "Close Serato DJ before restoring files." };
  }
  const root = await backupDir(options?.backupRoot);
  let dirs: string[] = [];
  try {
    dirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return { ok: false, written: 0, skipped: 0, undoId: null, detail: "No tag or library writes to undo." };
  }
  for (const name of dirs) {
    const dir = path.join(root, name);
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as Manifest;
      if (!manifest.entries.length) continue;
      for (const entry of [...manifest.entries].reverse()) {
        if (entry.created || !entry.backup) {
          await fs.rm(entry.path, { force: true });
        } else {
          await fs.mkdir(path.dirname(entry.path), { recursive: true });
          await fs.copyFile(entry.backup, entry.path);
        }
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
  return { ok: false, written: 0, skipped: 0, undoId: null, detail: "No tag or library writes to undo." };
}

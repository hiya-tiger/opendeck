export interface PlayedEntry {
  id: string;
  trackId: string;
  name: string;
  path: string;
  crate: string;
  bpm: number;
  key: string;
  startedAt: string;
  duration: number;
}

const LOG_DEFAULT_MAX = 500;
const SCRATCHPAD_MAX = 100;

export class PlayedLog {
  private entries: PlayedEntry[];
  private readonly max: number;

  constructor(entries: PlayedEntry[] = [], max: number = LOG_DEFAULT_MAX) {
    if (!Number.isInteger(max) || max < 0) throw new Error("PlayedLog max must be a non-negative integer");
    this.max = max;
    this.entries = entries.slice(0, max);
  }

  add(entry: Omit<PlayedEntry, "id"> & { id?: string }): PlayedEntry {
    if (this.entries.length > 0) {
      const previous = this.entries[0];
      if (previous.trackId === entry.trackId) {
        this.entries[0] = { ...entry, id: entry.id ?? previous.id } as PlayedEntry;
        return this.entries[0];
      }
    }
    const id = entry.id ?? cryptoId();
    const stored: PlayedEntry = { ...entry, id } as PlayedEntry;
    this.entries.unshift(stored);
    if (this.entries.length > this.max) this.entries.length = this.max;
    return stored;
  }

  list(): PlayedEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.entries = [];
  }

  remove(id: string): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    this.entries.splice(index, 1);
    return true;
  }

  exportCsv(): string {
    const rows = [csvLine("name", "path", "crate", "bpm", "key", "startedAt", "duration")];
    for (const entry of this.entries) {
      rows.push(csvLine(entry.name, entry.path, entry.crate, String(entry.bpm), entry.key, entry.startedAt, String(entry.duration)));
    }
    return rows.join("\r\n") + "\r\n";
  }
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function csvLine(...fields: string[]): string {
  return fields.map(csvField).join(",");
}

function cryptoId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class Scratchpad {
  private ids: string[];

  constructor(ids: string[] = []) {
    this.ids = [];
    for (const id of ids) {
      if (this.ids.length >= SCRATCHPAD_MAX) break;
      this.insert(id, false);
    }
  }

  private insert(id: string, enforceMax: boolean): boolean {
    if (typeof id !== "string" || id.length === 0) throw new Error("Scratchpad ids must be non-empty strings");
    if (this.ids.includes(id)) return false;
    if (enforceMax && this.ids.length >= SCRATCHPAD_MAX) {
      throw new Error(`Scratchpad is full at ${SCRATCHPAD_MAX} ids`);
    }
    this.ids.push(id);
    return true;
  }

  add(id: string): boolean {
    return this.insert(id, true);
  }

  remove(id: string): boolean {
    const index = this.ids.indexOf(id);
    if (index === -1) return false;
    this.ids.splice(index, 1);
    return true;
  }

  has(id: string): boolean {
    return this.ids.includes(id);
  }

  list(): string[] {
    return [...this.ids];
  }

  clear(): void {
    this.ids = [];
  }

  move(from: number, to: number): boolean {
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from < 0 || from >= this.ids.length) return false;
    if (to < 0 || to >= this.ids.length) return false;
    if (from === to) return false;
    const [id] = this.ids.splice(from, 1);
    this.ids.splice(to, 0, id);
    return true;
  }
}

export type TrackSortKey = "title" | "bpm" | "key" | "duration" | "crate";

export interface TrackLike {
  name: string;
  path?: string;
  crate?: string;
  bpm?: number;
  key?: string;
  duration?: number;
}

export function filterTracks<T extends { name: string; path?: string; crate?: string; key?: string }>(
  tracks: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...tracks];
  return tracks.filter((track) =>
    [track.name, track.path, track.crate, track.key]
      .filter((field): field is string => typeof field === "string")
      .some((field) => field.toLowerCase().includes(needle)),
  );
}

export function sortTracks<T extends { name: string; bpm?: number; key?: string; duration?: number; crate?: string }>(
  tracks: readonly T[],
  key: TrackSortKey,
  direction: "asc" | "desc" = "asc",
): T[] {
  const field = key === "title" ? "name" : key;
  const isNumeric = key === "bpm" || key === "duration";
  const orderFactor = direction === "desc" ? -1 : 1;
  const indexed = tracks.map((track, index) => ({ track, order: index }));
  indexed.sort((x, y) => {
    const aMissing = missingValue(x.track, field);
    const bMissing = missingValue(y.track, field);
    if (aMissing && bMissing) return x.order - y.order;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (isNumeric) {
      const difference = ((x.track as unknown as Record<string, number>)[field] as number) - ((y.track as unknown as Record<string, number>)[field] as number);
      if (difference !== 0) return difference * orderFactor;
    } else {
      const aa = String((x.track as unknown as Record<string, unknown>)[field]).toLowerCase();
      const bb = String((y.track as unknown as Record<string, unknown>)[field]).toLowerCase();
      if (aa < bb) return -1 * orderFactor;
      if (aa > bb) return 1 * orderFactor;
    }
    return x.order - y.order;
  });
  return indexed.map(({ track }) => track);
}

function missingValue(track: TrackLike, field: string): boolean {
  const value = ((track as unknown as Record<string, unknown>))[field];
  if (field === "name") return false;
  if (typeof value === "number") return !Number.isFinite(value);
  return value === undefined || value === null || value === "";
}


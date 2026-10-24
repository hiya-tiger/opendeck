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

export const TRACK_COLOR_PALETTE = [
  "#FF9999",
  "#FFCC99",
  "#FFFF99",
  "#CCFF99",
  "#99FF99",
  "#99FFCC",
  "#99FFFF",
  "#99CCFF",
  "#9999FF",
  "#CC99FF",
  "#FF99FF",
  "#FF99CC",
] as const;

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

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
  createdAt: string;
}

export class PlaylistStore {
  private playlists: Playlist[] = [];

  constructor(initial: Playlist[] = []) {
    for (const pl of initial) {
      if (pl && typeof pl.id === "string" && typeof pl.name === "string" && Array.isArray(pl.trackIds)) {
        this.playlists.push({
          id: pl.id,
          name: pl.name.trim() || "Untitled Playlist",
          trackIds: [...new Set(pl.trackIds.filter((id): id is string => typeof id === "string" && id.length > 0))],
          createdAt: typeof pl.createdAt === "string" ? pl.createdAt : new Date().toISOString(),
        });
      }
    }
  }

  create(name: string, trackIds: string[] = [], id?: string): Playlist {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Playlist name must not be empty");
    const playlist: Playlist = {
      id: id ?? cryptoId(),
      name: cleanName,
      trackIds: [...new Set(trackIds.filter((tid) => typeof tid === "string" && tid.length > 0))],
      createdAt: new Date().toISOString(),
    };
    this.playlists.push(playlist);
    return { ...playlist, trackIds: [...playlist.trackIds] };
  }

  rename(id: string, name: string): boolean {
    const cleanName = name.trim();
    if (!cleanName) return false;
    const found = this.playlists.find((p) => p.id === id);
    if (!found) return false;
    found.name = cleanName;
    return true;
  }

  remove(id: string): boolean {
    const idx = this.playlists.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    this.playlists.splice(idx, 1);
    return true;
  }

  get(id: string): Playlist | undefined {
    const found = this.playlists.find((p) => p.id === id);
    return found ? { ...found, trackIds: [...found.trackIds] } : undefined;
  }

  list(): Playlist[] {
    return this.playlists.map((p) => ({ ...p, trackIds: [...p.trackIds] }));
  }

  addTrack(playlistId: string, trackId: string): boolean {
    if (!trackId) return false;
    const found = this.playlists.find((p) => p.id === playlistId);
    if (!found || found.trackIds.includes(trackId)) return false;
    found.trackIds.push(trackId);
    return true;
  }

  removeTrack(playlistId: string, trackId: string): boolean {
    const found = this.playlists.find((p) => p.id === playlistId);
    if (!found) return false;
    const idx = found.trackIds.indexOf(trackId);
    if (idx === -1) return false;
    found.trackIds.splice(idx, 1);
    return true;
  }

  moveTrack(playlistId: string, from: number, to: number): boolean {
    const found = this.playlists.find((p) => p.id === playlistId);
    if (!found) return false;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from < 0 || from >= found.trackIds.length || to < 0 || to >= found.trackIds.length || from === to) return false;
    const [tid] = found.trackIds.splice(from, 1);
    found.trackIds.splice(to, 0, tid);
    return true;
  }

  movePlaylist(from: number, to: number): boolean {
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from < 0 || from >= this.playlists.length || to < 0 || to >= this.playlists.length || from === to) return false;
    const [pl] = this.playlists.splice(from, 1);
    this.playlists.splice(to, 0, pl);
    return true;
  }

  toJSON(): Playlist[] {
    return this.list();
  }

  static fromJSON(raw: unknown): PlaylistStore {
    if (!Array.isArray(raw)) return new PlaylistStore();
    return new PlaylistStore(raw as Playlist[]);
  }
}

export type LivePlaylistField =
  | "title"
  | "artist"
  | "crate"
  | "genre"
  | "key"
  | "color"
  | "bpm"
  | "duration"
  | "playCount"
  | "played";

export type LivePlaylistOperator =
  | "contains"
  | "equals"
  | "startsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between";

export interface LivePlaylistRule {
  field: LivePlaylistField;
  operator: LivePlaylistOperator;
  value: string | number | boolean;
  valueTo?: number;
}

export interface LivePlaylist {
  id: string;
  name: string;
  match: "all" | "any";
  rules: LivePlaylistRule[];
  limit?: number;
}

export type TrackSortKey =
  | "title"
  | "bpm"
  | "key"
  | "duration"
  | "crate"
  | "playCount"
  | "color"
  | "artist"
  | "genre";

export interface TrackLike {
  id?: string;
  name: string;
  path?: string;
  crate?: string;
  crates?: string[];
  artist?: string;
  genre?: string;
  bpm?: number;
  key?: string;
  duration?: number;
  color?: string;
  playCount?: number;
  played?: boolean;
}

export function evaluateLivePlaylistRule(track: TrackLike, rule: LivePlaylistRule): boolean {
  if (rule.field === "played") {
    const isPlayed = Boolean(track.played ?? (track.playCount ?? 0) > 0);
    const expected = typeof rule.value === "boolean" ? rule.value : String(rule.value).toLowerCase() === "true";
    return isPlayed === expected;
  }

  if (rule.field === "bpm" || rule.field === "duration" || rule.field === "playCount") {
    const raw =
      rule.field === "bpm"
        ? track.bpm
        : rule.field === "duration"
          ? track.duration
          : track.playCount ?? 0;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return false;
    const target = typeof rule.value === "number" ? rule.value : Number.parseFloat(String(rule.value));
    if (!Number.isFinite(target)) return false;
    switch (rule.operator) {
      case "equals":
        return Math.abs(raw - target) < 1e-6;
      case "gt":
        return raw > target;
      case "gte":
        return raw >= target;
      case "lt":
        return raw < target;
      case "lte":
        return raw <= target;
      case "between": {
        const hi = typeof rule.valueTo === "number" && Number.isFinite(rule.valueTo) ? rule.valueTo : target;
        const min = Math.min(target, hi);
        const max = Math.max(target, hi);
        return raw >= min && raw <= max;
      }
      default:
        return String(raw).includes(String(rule.value));
    }
  }

  const rawText =
    rule.field === "title"
      ? track.name ?? ""
      : rule.field === "artist"
        ? track.artist ?? ""
        : rule.field === "crate"
          ? [track.crate ?? "", ...(track.crates ?? [])].filter(Boolean).join(" ")
          : rule.field === "genre"
            ? track.genre ?? ""
            : rule.field === "key"
              ? track.key ?? ""
              : track.color ?? "";

  const hay = rawText.toLowerCase();
  const needle = String(rule.value ?? "").trim().toLowerCase();
  if (!needle) return false;
  switch (rule.operator) {
    case "equals":
      return hay === needle;
    case "startsWith":
      return hay.startsWith(needle);
    case "contains":
    default:
      return hay.includes(needle);
  }
}

export function evaluateLivePlaylist<T extends TrackLike>(tracks: readonly T[], live: LivePlaylist): T[] {
  if (!live.rules || live.rules.length === 0) {
    const all = [...tracks];
    return live.limit && live.limit > 0 ? all.slice(0, live.limit) : all;
  }
  const matched = tracks.filter((track) =>
    live.match === "any"
      ? live.rules.some((rule) => evaluateLivePlaylistRule(track, rule))
      : live.rules.every((rule) => evaluateLivePlaylistRule(track, rule)),
  );
  return live.limit && live.limit > 0 ? matched.slice(0, live.limit) : matched;
}

export class LivePlaylistStore {
  private items: LivePlaylist[] = [];

  constructor(initial: LivePlaylist[] = []) {
    for (const item of initial) {
      if (item && typeof item.id === "string" && typeof item.name === "string" && Array.isArray(item.rules)) {
        this.items.push({
          id: item.id,
          name: item.name.trim() || "Smart Crate",
          match: item.match === "any" ? "any" : "all",
          rules: item.rules.map((r) => ({ ...r })),
          limit: item.limit,
        });
      }
    }
  }

  create(
    name: string,
    rules: LivePlaylistRule[],
    match: "all" | "any" = "all",
    limit?: number,
    id?: string,
  ): LivePlaylist {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Live playlist name must not be empty");
    const created: LivePlaylist = {
      id: id ?? cryptoId(),
      name: cleanName,
      match,
      rules: rules.map((r) => ({ ...r })),
      limit,
    };
    this.items.push(created);
    return { ...created, rules: created.rules.map((r) => ({ ...r })) };
  }

  update(id: string, patch: Partial<Omit<LivePlaylist, "id">>): boolean {
    const found = this.items.find((item) => item.id === id);
    if (!found) return false;
    if (patch.name !== undefined && patch.name.trim()) found.name = patch.name.trim();
    if (patch.match === "all" || patch.match === "any") found.match = patch.match;
    if (Array.isArray(patch.rules)) found.rules = patch.rules.map((r) => ({ ...r }));
    if (patch.limit !== undefined) found.limit = patch.limit;
    return true;
  }

  remove(id: string): boolean {
    const idx = this.items.findIndex((item) => item.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    return true;
  }

  get(id: string): LivePlaylist | undefined {
    const found = this.items.find((item) => item.id === id);
    return found ? { ...found, rules: found.rules.map((r) => ({ ...r })) } : undefined;
  }

  list(): LivePlaylist[] {
    return this.items.map((item) => ({ ...item, rules: item.rules.map((r) => ({ ...r })) }));
  }

  evaluate<T extends TrackLike>(id: string, tracks: readonly T[]): T[] {
    const found = this.items.find((item) => item.id === id);
    if (!found) return [];
    return evaluateLivePlaylist(tracks, found);
  }

  toJSON(): LivePlaylist[] {
    return this.list();
  }

  static fromJSON(raw: unknown): LivePlaylistStore {
    if (!Array.isArray(raw)) return new LivePlaylistStore();
    return new LivePlaylistStore(raw as LivePlaylist[]);
  }
}

export function cycleTrackColor(currentColor?: string): string {
  const clean = (currentColor ?? "").toUpperCase();
  if (!clean) return TRACK_COLOR_PALETTE[0];
  const idx = TRACK_COLOR_PALETTE.findIndex((c) => c.toUpperCase() === clean);
  if (idx === -1) return TRACK_COLOR_PALETTE[0];
  if (idx === TRACK_COLOR_PALETTE.length - 1) return "";
  return TRACK_COLOR_PALETTE[idx + 1];
}

export function filterTracks<
  T extends {
    name: string;
    path?: string;
    crate?: string;
    key?: string;
    artist?: string;
    genre?: string;
    color?: string;
  },
>(tracks: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...tracks];
  return tracks.filter((track) =>
    [track.name, track.path, track.crate, track.key, track.artist, track.genre, track.color]
      .filter((field): field is string => typeof field === "string")
      .some((field) => field.toLowerCase().includes(needle)),
  );
}

export function sortTracks<
  T extends {
    name: string;
    bpm?: number;
    key?: string;
    duration?: number;
    crate?: string;
    playCount?: number;
    color?: string;
    artist?: string;
    genre?: string;
  },
>(
  tracks: readonly T[],
  key: TrackSortKey,
  direction: "asc" | "desc" = "asc",
): T[] {
  const field = key === "title" ? "name" : key;
  const isNumeric = key === "bpm" || key === "duration" || key === "playCount";
  const orderFactor = direction === "desc" ? -1 : 1;
  const indexed = tracks.map((track, index) => ({ track, order: index }));
  indexed.sort((x, y) => {
    const aMissing = missingValue(x.track, field);
    const bMissing = missingValue(y.track, field);
    if (aMissing && bMissing) return x.order - y.order;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (isNumeric) {
      const difference =
        ((x.track as unknown as Record<string, number>)[field] as number) -
        ((y.track as unknown as Record<string, number>)[field] as number);
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
  const value = (track as unknown as Record<string, unknown>)[field];
  if (field === "name") return false;
  if (typeof value === "number") return !Number.isFinite(value);
  return value === undefined || value === null || value === "";
}

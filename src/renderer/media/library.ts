import { formatTime, type BandPeaks } from "../engine/analyze.ts";
import { baseName } from "./serato.ts";
import {
  LivePlaylistStore,
  PlayedLog,
  PlaylistStore,
  Scratchpad,
  cycleTrackColor,
  filterTracks,
  sortTracks,
  type LivePlaylistRule,
  type TrackSortKey,
} from "./library-ux.ts";

export type TrackSource = "local" | "crate" | "stream" | "removable";

export interface Track {
  id: string;
  name: string;
  path: string;
  source: TrackSource;
  file: File | null;
  url: string | null;
  provider: string;
  bpm: number;
  beatPhase: number;
  key: string;
  camelot: string;
  duration: number;
  peaks: Float32Array | null;
  bands: BandPeaks | null;
  artwork: string | null;
  analyzed: boolean;
  missing: boolean;
  queued: boolean;
  crate: string;
  crates?: string[];
  color?: string;
  playCount?: number;
  artist?: string;
  album?: string;
  genre?: string;
  comment?: string;
  grouping?: string;
  remixer?: string;
  beatgridLocked?: boolean;
  /** Set for tracks on a detected drive (CDJ slot or USB on this computer). */
  media?: { sourceId: string; trackId: string; origin: "cdj" | "local"; rating?: number };
}

export const AUDIO_ACCEPT =
  "audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.aif,.aiff,.opus,.webm";
const AUDIO_RE = /\.(mp3|wav|ogg|flac|m4a|aac|aiff?|opus|webm)$/i;

export function isAudioFile(name: string): boolean {
  return AUDIO_RE.test(name);
}

export function trackFromFile(file: File): Track {
  return {
    id: `${file.name}:${file.size}:${file.lastModified}`,
    name: file.name.replace(/\.[^.]+$/, ""),
    path: file.webkitRelativePath || file.name,
    source: "local",
    file,
    url: null,
    provider: "local",
    bpm: 0,
    beatPhase: 0,
    key: "--",
    camelot: "--",
    duration: 0,
    peaks: null,
    bands: null,
    artwork: null,
    analyzed: false,
    missing: false,
    queued: false,
    crate: "",
    color: "",
    playCount: 0,
    beatgridLocked: false,
  };
}

export function trackFromCrate(entry: { path: string; name: string }, crate: string): Track {
  return {
    id: `crate:${entry.path.toLowerCase()}`,
    name: entry.name.replace(/\.[^.]+$/, ""),
    path: entry.path,
    source: "crate",
    file: null,
    url: null,
    provider: "local",
    bpm: 0,
    beatPhase: 0,
    key: "--",
    camelot: "--",
    duration: 0,
    peaks: null,
    bands: null,
    artwork: null,
    analyzed: false,
    missing: true,
    queued: false,
    crate,
    crates: crate ? [crate] : [],
    color: "",
    playCount: 0,
    beatgridLocked: false,
  };
}

export type LibraryDeckId = "A" | "B" | "C" | "D";

interface LibraryElements {
  listEl: HTMLElement;
  countEl: HTMLElement;
  onLoad: (track: Track, deck: LibraryDeckId) => void;
  onQueue: (track: Track) => void;
}

interface LibraryRow {
  row: HTMLTableRowElement;
  num: HTMLTableCellElement;
  title: HTMLTableCellElement;
  bpm: HTMLTableCellElement;
  key: HTMLTableCellElement;
  length: HTMLTableCellElement;
  actions: HTMLTableCellElement;
  buttons: HTMLButtonElement[];
  colorBtn: HTMLButtonElement;
  scratch: HTMLButtonElement;
}

const STORAGE_PLAYLISTS_KEY = "opendeck.playlists.v1";
const STORAGE_LIVE_PLAYLISTS_KEY = "opendeck.livePlaylists.v1";
const STORAGE_TRACK_META_KEY = "opendeck.trackMeta.v1";

export class Library {
  tracks: Track[] = [];
  filter = "";
  crateName = "";
  activeView = "all"; // "all" | "crate:<name>" | "playlist:<id>" | "live:<id>"
  colorFilter = "";
  sortKey: TrackSortKey = "title";
  sortDirection: "asc" | "desc" = "asc";
  scratchOnly = false;
  fourDeckMode = false;
  readonly playedLog = new PlayedLog();
  readonly scratchpad = new Scratchpad();
  readonly playlists: PlaylistStore;
  readonly livePlaylists: LivePlaylistStore;
  private elements: LibraryElements;
  private rows = new Map<string, LibraryRow>();
  private persistedMeta = new Map<string, { color?: string; playCount?: number; beatgridLocked?: boolean }>();

  constructor(elements: LibraryElements) {
    this.elements = elements;
    this.playlists = this.loadPlaylists();
    this.livePlaylists = this.loadLivePlaylists();
    this.loadPersistedTrackMeta();
  }

  private loadPlaylists(): PlaylistStore {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_PLAYLISTS_KEY);
      if (raw) return PlaylistStore.fromJSON(JSON.parse(raw));
    } catch {
      // ignore storage errors
    }
    return new PlaylistStore();
  }

  private loadLivePlaylists(): LivePlaylistStore {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_LIVE_PLAYLISTS_KEY);
      if (raw) return LivePlaylistStore.fromJSON(JSON.parse(raw));
    } catch {
      // ignore storage errors
    }
    return new LivePlaylistStore();
  }

  private loadPersistedTrackMeta(): void {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_TRACK_META_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, { color?: string; playCount?: number; beatgridLocked?: boolean }>;
      for (const [k, v] of Object.entries(parsed)) {
        this.persistedMeta.set(k, v);
      }
    } catch {
      // ignore
    }
  }

  saveStores(): void {
    try {
      globalThis.localStorage?.setItem(STORAGE_PLAYLISTS_KEY, JSON.stringify(this.playlists.toJSON()));
      globalThis.localStorage?.setItem(STORAGE_LIVE_PLAYLISTS_KEY, JSON.stringify(this.livePlaylists.toJSON()));
      const metaObj: Record<string, { color?: string; playCount?: number; beatgridLocked?: boolean }> = {};
      for (const track of this.tracks) {
        if (track.color || (track.playCount ?? 0) > 0 || track.beatgridLocked) {
          metaObj[track.path || track.id] = {
            color: track.color,
            playCount: track.playCount,
            beatgridLocked: track.beatgridLocked,
          };
        }
      }
      globalThis.localStorage?.setItem(STORAGE_TRACK_META_KEY, JSON.stringify(metaObj));
    } catch {
      // ignore storage errors
    }
  }

  private applyPersistedMeta(track: Track): void {
    const saved = this.persistedMeta.get(track.path) ?? this.persistedMeta.get(track.id);
    if (!saved) return;
    if (saved.color && !track.color) track.color = saved.color;
    if (typeof saved.playCount === "number" && !track.playCount) track.playCount = saved.playCount;
    if (saved.beatgridLocked !== undefined && track.beatgridLocked === undefined) {
      track.beatgridLocked = saved.beatgridLocked;
    }
  }

  addFiles(files: FileList | File[]): Track[] {
    const added: Track[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("audio/") && !AUDIO_RE.test(file.name)) continue;
      const track = trackFromFile(file);
      this.applyPersistedMeta(track);
      if (this.tracks.some((existing) => existing.id === track.id)) continue;
      this.tracks.push(track);
      added.push(track);
    }
    this.render();
    return added;
  }

  addCrate(crateName: string, entries: { path: string; name: string }[]): Track[] {
    const existingByBase = new Map(this.tracks.map((track) => [baseName(track.path).toLowerCase(), track]));
    const added: Track[] = [];
    for (const entry of entries) {
      const key = baseName(entry.name).toLowerCase();
      const found = existingByBase.get(key);
      if (found) {
        if (!found.crate) found.crate = crateName;
        const crates = new Set(found.crates ?? (found.crate ? [found.crate] : []));
        crates.add(crateName);
        found.crates = [...crates];
        continue;
      }
      const track = trackFromCrate(entry, crateName);
      this.applyPersistedMeta(track);
      existingByBase.set(key, track);
      this.tracks.push(track);
      added.push(track);
    }
    this.crateName = crateName;
    this.render();
    return added;
  }

  /** Add (or replace) every track of a detected drive. Returns the tracks added. */
  addMediaSource(sourceId: string, tracks: Track[]): Track[] {
    this.tracks = this.tracks.filter((t) => t.media?.sourceId !== sourceId);
    for (const track of tracks) {
      this.applyPersistedMeta(track);
      this.tracks.push(track);
    }
    this.render();
    return tracks;
  }

  /** The drive went away: drop its tracks. Tracks already on a deck keep playing. */
  removeMediaSource(sourceId: string): number {
    const before = this.tracks.length;
    this.tracks = this.tracks.filter((t) => t.media?.sourceId !== sourceId);
    if (this.activeView.startsWith("crate:") && !this.crates().includes(this.activeView.slice(6))) this.activeView = "all";
    this.render();
    return before - this.tracks.length;
  }

  resolveFolder(files: File[]): Track[] {
    const byName = new Map<string, File>();
    for (const file of files) {
      const key = baseName(file.name).toLowerCase();
      if (!byName.has(key)) byName.set(key, file);
    }
    const linked: Track[] = [];
    for (const track of this.tracks) {
      if (!track.missing) continue;
      const match = byName.get(baseName(track.path).toLowerCase());
      if (!match) continue;
      track.file = match;
      track.missing = false;
      linked.push(track);
    }
    this.render();
    return linked;
  }

  addStreamTrack(track: Omit<Track, "source" | "file" | "missing" | "queued" | "crate" | "artwork">): Track {
    const full: Track = {
      ...track,
      source: "stream",
      file: null,
      missing: false,
      queued: false,
      crate: "",
      artwork: null,
      color: track.color ?? "",
      playCount: track.playCount ?? 0,
    };
    this.tracks.push(full);
    this.render();
    return full;
  }

  setMeta(track: Track, meta: Partial<Track>): void {
    Object.assign(track, meta, { analyzed: true });
    this.saveStores();
    this.render();
  }

  setFilter(value: string): void {
    this.filter = value.trim();
    this.render();
  }

  setActiveView(view: string): void {
    this.activeView = view || "all";
    this.render();
  }

  setColorFilter(color: string): void {
    this.colorFilter = color.trim();
    this.render();
  }

  setFourDeckMode(enabled: boolean): void {
    this.fourDeckMode = enabled;
    this.render();
  }

  setSort(key: TrackSortKey, direction: "asc" | "desc" = this.sortDirection): void {
    this.sortKey = key;
    this.sortDirection = direction;
    this.render();
  }

  setScratchOnly(value: boolean): void {
    this.scratchOnly = value;
    this.render();
  }

  toggleScratchpad(track: Track): void {
    if (this.scratchpad.has(track.id)) this.scratchpad.remove(track.id);
    else this.scratchpad.add(track.id);
    this.render();
  }

  setTrackColor(trackId: string, color: string): void {
    const track = this.find(trackId);
    if (!track) return;
    track.color = color;
    this.saveStores();
    this.render();
  }

  cycleColor(track: Track): void {
    track.color = cycleTrackColor(track.color);
    this.saveStores();
    this.render();
  }

  createPlaylist(name: string, trackIds: string[] = []): string {
    const created = this.playlists.create(name, trackIds);
    this.saveStores();
    this.render();
    return created.id;
  }

  createLivePlaylist(name: string, rules: LivePlaylistRule[], match: "all" | "any" = "all"): string {
    const created = this.livePlaylists.create(name, rules, match);
    this.saveStores();
    this.render();
    return created.id;
  }

  crates(): string[] {
    const set = new Set<string>();
    for (const track of this.tracks) {
      if (track.crate) set.add(track.crate);
      for (const c of track.crates ?? []) {
        if (c) set.add(c);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  recordPlay(track: Track, startedAt = new Date().toISOString()): void {
    track.playCount = (track.playCount ?? 0) + 1;
    this.playedLog.add({
      trackId: track.id,
      name: track.name,
      path: track.path,
      crate: track.crate,
      bpm: track.bpm,
      key: track.key,
      startedAt,
      duration: track.duration,
    });
    this.saveStores();
    this.render();
  }

  get missingCount(): number {
    return this.tracks.filter((track) => track.missing).length;
  }

  find(id: string): Track | undefined {
    return this.tracks.find((track) => track.id === id);
  }

  /** The rendered table row of a track, when it is on screen. */
  rowFor(id: string): HTMLTableRowElement | null {
    return this.rows.get(id)?.row ?? null;
  }

  visible(): Track[] {
    let base: Track[] = this.tracks;
    if (this.activeView.startsWith("crate:")) {
      const targetCrate = this.activeView.slice("crate:".length);
      base = base.filter((t) => t.crate === targetCrate || (t.crates?.includes(targetCrate) ?? false));
    } else if (this.activeView.startsWith("playlist:")) {
      const plId = this.activeView.slice("playlist:".length);
      const pl = this.playlists.get(plId);
      if (pl) {
        const byId = new Map(base.map((t) => [t.id, t]));
        base = pl.trackIds.map((id) => byId.get(id)).filter((t): t is Track => Boolean(t));
      }
    } else if (this.activeView.startsWith("live:")) {
      const liveId = this.activeView.slice("live:".length);
      base = this.livePlaylists.evaluate(liveId, base);
    }

    if (this.colorFilter) {
      const targetColor = this.colorFilter.toUpperCase();
      base = base.filter((t) => (t.color ?? "").toUpperCase() === targetColor);
    }

    const filtered = filterTracks(base, this.filter);
    const scoped = this.scratchOnly
      ? filtered.filter((track) => this.scratchpad.has(track.id))
      : filtered;
    return sortTracks(scoped, this.sortKey, this.sortDirection);
  }

  private createRow(track: Track): LibraryRow {
    const row = document.createElement("tr");
    const num = document.createElement("td");
    num.className = "num";
    const title = document.createElement("td");
    title.className = "title-cell";
    const bpm = document.createElement("td");
    bpm.className = "mono";
    const key = document.createElement("td");
    key.className = "mono";
    const length = document.createElement("td");
    length.className = "mono";
    const actions = document.createElement("td");
    actions.className = "load-btns";
    const buttons: HTMLButtonElement[] = [];
    for (const deckId of ["A", "B", "C", "D"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `mini deck-load-btn deck-load-${deckId.toLowerCase()}`;
      button.textContent = deckId;
      button.addEventListener("click", () => {
        if (!track.missing) this.elements.onLoad(track, deckId);
      });
      buttons.push(button);
      actions.append(button);
    }
    const colorBtn = document.createElement("button");
    colorBtn.type = "button";
    colorBtn.className = "mini track-color-btn";
    colorBtn.textContent = "●";
    colorBtn.title = "Cycle track colour";
    colorBtn.addEventListener("click", () => this.cycleColor(track));

    const queueButton = document.createElement("button");
    queueButton.type = "button";
    queueButton.className = "mini";
    queueButton.textContent = "+Q";
    queueButton.title = "Add to stream queue";
    queueButton.addEventListener("click", () => this.elements.onQueue(track));
    const scratch = document.createElement("button");
    scratch.type = "button";
    scratch.className = "mini scratch-toggle";
    scratch.addEventListener("click", () => this.toggleScratchpad(track));
    actions.append(colorBtn, queueButton, scratch);
    row.addEventListener("dblclick", () => {
      if (!track.missing) this.elements.onLoad(track, "A");
    });
    row.append(num, title, bpm, key, length, actions);
    return { row, num, title, bpm, key, length, actions, buttons, colorBtn, scratch };
  }

  private updateRow(entry: LibraryRow, track: Track, position: number): void {
    entry.row.className = track.missing ? "missing" : "";
    if (track.color) {
      entry.row.style.borderLeft = `3px solid ${track.color}`;
      entry.colorBtn.style.color = track.color;
    } else {
      entry.row.style.borderLeft = "";
      entry.colorBtn.style.color = "";
    }
    entry.num.textContent = String(position);
    const plays = track.playCount && track.playCount > 0 ? ` (${track.playCount}×)` : "";
    entry.title.textContent = `${track.name}${plays}`;
    entry.title.title = track.path || track.name;
    entry.bpm.textContent = track.bpm ? track.bpm.toFixed(1) : "--";
    entry.key.textContent = track.key === "--" ? "--" : `${track.camelot} ${track.key}`;
    entry.length.textContent = track.duration ? formatTime(track.duration) : "--:--";
    const deckIds: LibraryDeckId[] = ["A", "B", "C", "D"];
    for (const [index, button] of entry.buttons.entries()) {
      const deckId = deckIds[index] ?? "A";
      button.title = track.missing ? "File not linked: link the music folder first" : `Load into deck ${deckId}`;
      button.disabled = Boolean(track.missing) || (!track.file && !track.url && !track.media);
      if (deckId === "C" || deckId === "D") {
        button.hidden = !this.fourDeckMode;
      }
    }
    const starred = this.scratchpad.has(track.id);
    entry.scratch.textContent = starred ? "S*" : "S";
    entry.scratch.title = starred ? "Remove from scratchpad" : "Add to scratchpad";
    entry.scratch.setAttribute("aria-pressed", String(starred));
  }

  render(): void {
    const positions = new Map<string, number>();
    this.tracks.forEach((track, index) => positions.set(track.id, index + 1));

    const visible = this.visible();
    const visibleIds = new Set(visible.map((track) => track.id));
    for (const [id, entry] of this.rows) {
      if (!visibleIds.has(id)) {
        entry.row.remove();
        this.rows.delete(id);
      }
    }

    let cursor = this.elements.listEl.firstElementChild;
    for (const track of visible) {
      let entry = this.rows.get(track.id);
      if (!entry) {
        entry = this.createRow(track);
        this.rows.set(track.id, entry);
      }
      this.updateRow(entry, track, positions.get(track.id) ?? 0);
      if (entry.row !== cursor) this.elements.listEl.insertBefore(entry.row, cursor);
      else cursor = cursor.nextElementSibling;
    }

    const parts = [`${this.tracks.length} track${this.tracks.length === 1 ? "" : "s"}`];
    if (this.crateName) parts.push(this.crateName);
    if (this.activeView !== "all") parts.push(`${visible.length} shown`);
    if (this.scratchOnly) parts.push(`${visible.length} in scratchpad`);
    if (this.missingCount) parts.push(`${this.missingCount} unlinked`);
    this.elements.countEl.textContent = parts.join(" · ");
  }
}

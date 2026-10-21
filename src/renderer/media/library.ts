import { formatTime, type BandPeaks } from "../engine/analyze.ts";
import { baseName } from "./serato.ts";

export type TrackSource = "local" | "crate" | "stream";

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
  };
}

interface LibraryElements {
  listEl: HTMLElement;
  countEl: HTMLElement;
  onLoad: (track: Track, deck: "A" | "B") => void;
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
}

export class Library {
  tracks: Track[] = [];
  filter = "";
  crateName = "";
  private elements: LibraryElements;
  private rows = new Map<string, LibraryRow>();

  constructor(elements: LibraryElements) {
    this.elements = elements;
  }

  addFiles(files: FileList | File[]): Track[] {
    const added: Track[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("audio/") && !AUDIO_RE.test(file.name)) continue;
      const track = trackFromFile(file);
      if (this.tracks.some((existing) => existing.id === track.id)) continue;
      this.tracks.push(track);
      added.push(track);
    }
    this.render();
    return added;
  }

  addCrate(crateName: string, entries: { path: string; name: string }[]): Track[] {
    const existing = new Set(this.tracks.map((track) => baseName(track.path).toLowerCase()));
    const added: Track[] = [];
    for (const entry of entries) {
      const key = baseName(entry.name).toLowerCase();
      if (existing.has(key)) continue;
      existing.add(key);
      const track = trackFromCrate(entry, crateName);
      this.tracks.push(track);
      added.push(track);
    }
    this.crateName = crateName;
    this.render();
    return added;
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
    const full: Track = { ...track, source: "stream", file: null, missing: false, queued: false, crate: "", artwork: null };
    this.tracks.push(full);
    this.render();
    return full;
  }

  setMeta(track: Track, meta: Partial<Track>): void {
    Object.assign(track, meta, { analyzed: true });
    this.render();
  }

  setFilter(value: string): void {
    this.filter = value.trim().toLowerCase();
    this.render();
  }

  get missingCount(): number {
    return this.tracks.filter((track) => track.missing).length;
  }

  find(id: string): Track | undefined {
    return this.tracks.find((track) => track.id === id);
  }

  visible(): Track[] {
    return this.tracks.filter(
      (track) =>
        !this.filter ||
        track.name.toLowerCase().includes(this.filter) ||
        track.path.toLowerCase().includes(this.filter) ||
        track.key.toLowerCase().includes(this.filter),
    );
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
    for (const deckId of ["A", "B"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mini";
      button.textContent = deckId;
      button.addEventListener("click", () => {
        if (!track.missing) this.elements.onLoad(track, deckId);
      });
      buttons.push(button);
      actions.append(button);
    }
    const queueButton = document.createElement("button");
    queueButton.type = "button";
    queueButton.className = "mini";
    queueButton.textContent = "+Q";
    queueButton.title = "Add to stream queue";
    queueButton.addEventListener("click", () => this.elements.onQueue(track));
    actions.append(queueButton);
    row.addEventListener("dblclick", () => {
      if (!track.missing) this.elements.onLoad(track, "A");
    });
    row.append(num, title, bpm, key, length, actions);
    return { row, num, title, bpm, key, length, actions, buttons };
  }

  private updateRow(entry: LibraryRow, track: Track, position: number): void {
    entry.row.className = track.missing ? "missing" : "";
    entry.num.textContent = String(position);
    entry.title.textContent = track.name;
    entry.title.title = track.path || track.name;
    entry.bpm.textContent = track.bpm ? track.bpm.toFixed(1) : "--";
    entry.key.textContent = track.key === "--" ? "--" : `${track.camelot} ${track.key}`;
    entry.length.textContent = track.duration ? formatTime(track.duration) : "--:--";
    for (const [index, button] of entry.buttons.entries()) {
      const deckId = index === 0 ? "A" : "B";
      button.title = track.missing ? "File not linked: link the music folder first" : `Load into deck ${deckId}`;
      button.disabled = Boolean(track.missing) || (!track.file && !track.url);
    }
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
    if (this.missingCount) parts.push(`${this.missingCount} unlinked`);
    this.elements.countEl.textContent = parts.join(" · ");
  }
}


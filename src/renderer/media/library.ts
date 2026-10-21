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

const AUDIO_RE = /\.(mp3|wav|ogg|flac|m4a|aac|aiff?|opus|webm)$/i;

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

export class Library {
  tracks: Track[] = [];
  filter = "";
  crateName = "";
  private elements: LibraryElements;

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

  render(): void {
    const visible = this.visible();
    const frag = document.createDocumentFragment();

    visible.forEach((track) => {
      const row = document.createElement("tr");
      if (track.missing) row.className = "missing";

      const num = document.createElement("td");
      num.className = "num";
      num.textContent = String(this.tracks.indexOf(track) + 1);
      row.append(num);

      const title = document.createElement("td");
      title.className = "title-cell";
      title.textContent = track.name;
      title.title = track.path || track.name;
      row.append(title);

      const bpm = document.createElement("td");
      bpm.className = "mono";
      bpm.textContent = track.bpm ? track.bpm.toFixed(1) : "--";
      row.append(bpm);

      const key = document.createElement("td");
      key.className = "mono";
      key.textContent = track.key === "--" ? "--" : `${track.camelot} ${track.key}`;
      row.append(key);

      const len = document.createElement("td");
      len.className = "mono";
      len.textContent = track.duration ? formatTime(track.duration) : "--:--";
      row.append(len);

      const actions = document.createElement("td");
      actions.className = "load-btns";
      for (const deckId of ["A", "B"] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "mini";
        button.textContent = deckId;
        button.title = track.missing ? "File not linked: link the music folder first" : `Load into deck ${deckId}`;
        button.disabled = Boolean(track.missing) || (!track.file && !track.url);
        button.addEventListener("click", () => {
          if (!track.missing) this.elements.onLoad(track, deckId);
        });
        actions.append(button);
      }
      const queueButton = document.createElement("button");
      queueButton.type = "button";
      queueButton.className = "mini";
      queueButton.textContent = "+Q";
      queueButton.title = "Add to stream queue";
      queueButton.addEventListener("click", () => this.elements.onQueue(track));
      actions.append(queueButton);
      row.append(actions);

      row.addEventListener("dblclick", () => {
        if (!track.missing) this.elements.onLoad(track, "A");
      });
      frag.append(row);
    });

    this.elements.listEl.replaceChildren(frag);
    const parts = [`${this.tracks.length} track${this.tracks.length === 1 ? "" : "s"}`];
    if (this.crateName) parts.push(this.crateName);
    if (this.missingCount) parts.push(`${this.missingCount} unlinked`);
    this.elements.countEl.textContent = parts.join(" · ");
  }
}


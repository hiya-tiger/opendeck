// Converts a detected-media library (CDJ slot or a USB drive on this computer)
// into OpenDecks library tracks, and shapes the in-app "Add it?" prompt.
import type { CdjMediaLibrary, CdjTrackInfo, MediaPrompt } from "../../main/prolink/types.ts";
import type { Track } from "./library.ts";

const PITCH = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLATS: Record<string, string> = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#", Cb: "B", Fb: "E", "E#": "F", "B#": "C" };
const CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];

/** rekordbox key text ("Am", "F#", "Bbm", "8A") -> OpenDecks { key, camelot }. */
export function convertKey(raw: string): { key: string; camelot: string } {
  const text = (raw ?? "").trim();
  if (!text) return { key: "--", camelot: "--" };
  const cam = text.match(/^(\d{1,2})\s*([ABab])$/);
  if (cam) {
    const code = `${Number(cam[1])}${cam[2].toUpperCase()}`;
    const minor = code.endsWith("A");
    const root = (minor ? CAMELOT_MINOR : CAMELOT_MAJOR).indexOf(code);
    if (root === -1) return { key: "--", camelot: "--" };
    return { key: `${PITCH[root]} ${minor ? "min" : "maj"}`, camelot: code };
  }
  const m = text.match(/^([A-Ga-g])([#b♯♭]?)\s*(m|min|minor|maj|major)?$/);
  if (!m) return { key: text, camelot: "--" };
  let note = m[1].toUpperCase() + (m[2] === "♯" ? "#" : m[2] === "♭" ? "b" : m[2]);
  note = FLATS[note] ?? note;
  const root = PITCH.indexOf(note);
  if (root === -1) return { key: text, camelot: "--" };
  const minor = m[3] === "m" || m[3] === "min" || m[3] === "minor";
  return { key: `${PITCH[root]} ${minor ? "min" : "maj"}`, camelot: (minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[root] };
}

/** rekordbox colour ids 1-8 mapped to the nearest OpenDecks palette colour. */
export const REKORDBOX_COLORS: Record<number, string> = {
  1: "#FF99CC", // pink
  2: "#FF9999", // red
  3: "#FFCC99", // orange
  4: "#FFFF99", // yellow
  5: "#99FF99", // green
  6: "#99FFFF", // aqua
  7: "#99CCFF", // blue
  8: "#CC99FF", // purple
};

export const playlistCrateName = (sourceName: string, path: string[]): string => [sourceName, ...path].join(" / ");

export function mediaTrackId(sourceId: string, trackId: string): string {
  return `media:${sourceId}:${trackId}`;
}

export function trackFromMedia(lib: CdjMediaLibrary, info: CdjTrackInfo, crates: string[]): Track {
  const key = convertKey(info.key);
  const display = info.artist ? `${info.artist} - ${info.title}` : info.title;
  return {
    id: mediaTrackId(lib.sourceId, info.id),
    name: display || info.path.split("/").pop() || "Untitled",
    path: `${lib.sourceName}/${info.path}`,
    source: "removable",
    file: null,
    url: null,
    provider: lib.origin === "cdj" ? "cdj" : "usb",
    bpm: info.bpm || 0,
    beatPhase: 0,
    key: key.key,
    camelot: key.camelot,
    duration: info.duration || 0,
    peaks: null,
    bands: null,
    artwork: null,
    analyzed: false,
    missing: false,
    queued: false,
    crate: lib.sourceName,
    crates: [lib.sourceName, ...crates],
    color: REKORDBOX_COLORS[info.colorId] ?? "",
    playCount: 0,
    artist: info.artist || undefined,
    album: info.album || undefined,
    genre: info.genre || undefined,
    comment: info.comment || undefined,
    remixer: info.remixer || undefined,
    beatgridLocked: false,
    media: { sourceId: lib.sourceId, trackId: info.id, origin: lib.origin, rating: info.rating },
  };
}

/** All tracks of a library, each tagged with the playlist sub-crates it belongs to. */
export function tracksFromMedia(lib: CdjMediaLibrary): Track[] {
  const memberOf = new Map<string, string[]>();
  for (const pl of lib.playlists) {
    const crate = playlistCrateName(lib.sourceName, pl.path);
    for (const id of pl.trackIds) {
      const list = memberOf.get(id) ?? [];
      if (!list.includes(crate)) list.push(crate);
      memberOf.set(id, list);
    }
  }
  return lib.tracks.map((t) => trackFromMedia(lib, t, memberOf.get(t.id) ?? []));
}

/** Ordered sub-crate names for a library (for the crate picker). */
export function mediaCrates(lib: CdjMediaLibrary): string[] {
  return [lib.sourceName, ...lib.playlists.map((p) => playlistCrateName(lib.sourceName, p.path))];
}

/** What the prompt banner shows; remembering is per drive (mediaKey). */
export function promptView(p: MediaPrompt): { text: string; addLabel: string; dismissLabel: string; rememberLabel: string } {
  return { text: p.message, addLabel: "Add", dismissLabel: "Not now", rememberLabel: "Always do this for this drive" };
}

// Shapes shared between the main-process Pro DJ Link service and the renderer.
// Plain data only: these cross the IPC boundary.
import type { SlotName } from "./packets.ts";

export interface CdjTrackInfo {
  /** Unique within its media: "pdb:<rekordbox id>" or "fs:<path>". */
  id: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  label: string;
  remixer: string;
  comment: string;
  bpm: number;
  /** rekordbox key name as exported, e.g. "Am", "F#", "8A". */
  key: string;
  duration: number;
  rating: number;
  /** rekordbox colour id 0-8 (0 = none). */
  colorId: number;
  /** Path on the media, relative to the export root, without a leading slash. */
  path: string;
  size: number;
  fileType: string;
  trackNumber: number;
  year: number;
  /** rekordbox analysis file path (ANLZ .DAT), empty when not analysed. */
  analyzePath: string;
}

export interface CdjPlaylistInfo {
  /** Folder path ending in the playlist name. */
  path: string[];
  trackIds: string[];
}

export type MediaOrigin = "cdj" | "local";

export interface CdjMediaLibrary {
  sourceId: string;
  origin: MediaOrigin;
  /** Stable identity of the drive, used for the remembered "always" choice. */
  mediaKey: string;
  /** Library source / crate name, e.g. "CDJ 2 · USB · NAME" or "USB · LABEL". */
  sourceName: string;
  deviceNumber: number;
  playerName: string;
  slot: SlotName;
  mediaName: string;
  kind: "rekordbox" | "files";
  tracks: CdjTrackInfo[];
  playlists: CdjPlaylistInfo[];
  importedAt: number;
  warnings: string[];
}

export interface CdjPlayerSnapshot {
  deviceNumber: number;
  name: string;
  ip: string;
  kind: "player" | "mixer" | "other";
  usb: string;
  sd: string;
}

export interface CdjMediaSnapshot {
  sourceId: string;
  origin: MediaOrigin;
  mediaKey: string;
  sourceName: string;
  deviceNumber: number;
  playerName: string;
  slot: SlotName;
  name: string;
  /** detected: waiting for the user; ignored: user said not now. */
  state: "detected" | "importing" | "ready" | "ignored" | "error";
  trackCount: number;
  playlistCount: number;
  kind: "rekordbox" | "files" | "unknown";
  error?: string;
}

export interface ProlinkSettings {
  enabled: boolean;
  /** Network interface name, or "auto" to follow the first DJ Link traffic seen. */
  interface: string;
  /** Virtual player number, or "auto". */
  deviceNumber: number | "auto";
  /** Watch for USB drives plugged into this computer. */
  localDrives: boolean;
  /** Remembered "Always do this for this drive" choices, keyed by mediaKey. */
  remembered: Record<string, "add" | "ignore">;
}

export const DEFAULT_PROLINK_SETTINGS: ProlinkSettings = {
  enabled: true,
  interface: "auto",
  deviceNumber: "auto",
  localDrives: true,
  remembered: {},
};

/** A detected drive waiting for the user's Add / Not now. */
export interface MediaPrompt {
  sourceId: string;
  origin: MediaOrigin;
  mediaKey: string;
  sourceName: string;
  mediaName: string;
  slot: SlotName;
  /** "CDJ 2" or "this computer". */
  where: string;
  trackCount: number | null;
  kind: "rekordbox" | "files" | "unknown";
  message: string;
}

export interface LoadedCue {
  /** 0-based hot cue slot, or -1 for a memory point. */
  index: number;
  timeMs: number;
  loopEndMs?: number;
  color?: string;
  name?: string;
}

export interface LoadedTrack {
  ok: boolean;
  bytes?: Uint8Array;
  name?: string;
  cues?: LoadedCue[];
  error?: string;
}

export interface ProlinkSnapshot {
  enabled: boolean;
  running: boolean;
  interfaceName: string | null;
  address: string | null;
  deviceNumber: number | null;
  players: CdjPlayerSnapshot[];
  media: CdjMediaSnapshot[];
  prompts: MediaPrompt[];
  error: string | null;
  interfaces: { name: string; address: string; netmask: string }[];
  settings: ProlinkSettings;
}

export interface CdjFetchProgress {
  sourceId: string;
  trackId: string;
  done: number;
  total: number;
}

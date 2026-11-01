// Turns a StreamTrack into what the deck loader needs: a File (decodable
// audio, same path as a local file: analysis, waveform, stems, FX) or an
// official-player embed (monitor-only), or an honest refusal.

import { streamTrackKey, StreamSourceError, type PlaybackPlan, type StreamSource, type StreamTrack } from "./source.ts";
import { monitorOnlyLabel } from "./embed.ts";

export interface FetchedAudio {
  ok: boolean;
  bytes?: Uint8Array;
  type?: string;
  error?: string;
}

export type AudioFetcher = (sourceId: string, plan: Extract<PlaybackPlan, { kind: "decodable" }>) => Promise<FetchedAudio>;

export type StreamLoad =
  | { kind: "file"; file: File; preview: boolean; plan: PlaybackPlan }
  | { kind: "monitor"; embedUrl: string; label: string; needsWidevine: boolean; plan: PlaybackPlan }
  | { kind: "unavailable"; reason: string };

function extFor(type: string | undefined, container: string): string {
  if (type?.includes("mpeg") || type?.includes("mp3")) return "mp3";
  if (type?.includes("aac")) return "aac";
  if (type?.includes("mp4") || type?.includes("m4a")) return "m4a";
  if (type?.includes("flac")) return "flac";
  return container === "hls" ? "aac" : "mp3";
}

export function safeFileName(track: Pick<StreamTrack, "artist" | "title">, ext: string): string {
  const base = `${track.artist} - ${track.title}`.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120);
  return `${base}.${ext}`;
}

export async function loadStreamTrack(
  source: StreamSource,
  track: StreamTrack,
  fetchAudio: AudioFetcher,
  widevineAvailable: boolean,
): Promise<StreamLoad> {
  let plan: PlaybackPlan;
  try {
    plan = await source.resolve(track);
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
  if (plan.kind === "unavailable") return { kind: "unavailable", reason: plan.reason };
  if (plan.kind === "monitor-only") {
    const needsWidevine = plan.reason === "widevine";
    return {
      kind: "monitor",
      embedUrl: plan.embedUrl,
      label: `${monitorOnlyLabel(source.name, needsWidevine, widevineAvailable)} ${plan.note}`.trim(),
      needsWidevine,
      plan,
    };
  }
  const audio = await fetchAudio(source.id, plan);
  if (!audio.ok || !audio.bytes || audio.bytes.byteLength === 0) {
    const reason = audio.error ?? "no audio returned";
    // An encrypted stream is never decrypted here; say so instead of failing silently.
    return { kind: "unavailable", reason: `${source.name}: ${reason}` };
  }
  const ext = extFor(audio.type ?? plan.mimeHint, plan.container);
  const file = new File([audio.bytes as BlobPart], safeFileName(track, ext), { type: audio.type || plan.mimeHint || "application/octet-stream" });
  return { kind: "file", file, preview: plan.preview, plan };
}

/** Fields for Library.addStreamTrack so a streamed track sits in the library like a local one. */
export function libraryFieldsFor(track: StreamTrack): {
  id: string;
  name: string;
  path: string;
  url: string;
  provider: string;
  bpm: number;
  beatPhase: number;
  key: string;
  camelot: string;
  duration: number;
  peaks: null;
  bands: null;
  analyzed: boolean;
  artist: string;
  album?: string;
  genre?: string;
} {
  return {
    id: streamTrackKey(track),
    name: track.title,
    path: track.permalink ?? streamTrackKey(track),
    url: streamTrackKey(track),
    provider: track.source,
    // Provider BPM/key are hints; the deck's own analysis replaces them once decoded.
    bpm: track.bpm ?? 0,
    beatPhase: 0,
    key: track.key ?? "--",
    camelot: "--",
    duration: track.durationSec,
    peaks: null,
    bands: null,
    analyzed: false,
    artist: track.artist,
    album: track.album,
    genre: track.genre,
  };
}

export function describeError(error: unknown): string {
  if (error instanceof StreamSourceError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

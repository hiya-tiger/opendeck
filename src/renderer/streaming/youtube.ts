import { parseCommercialSearchPayload } from "./drm.ts";
import type { QueueTrack } from "./queue.ts";

interface Runs {
  text?: string;
}

interface FlexColumn {
  musicResponsiveListItemFlexColumnRenderer?: {
    text?: { runs?: Runs[] };
  };
}

interface Renderer {
  musicResponsiveListItemRenderer?: {
    flexColumns?: FlexColumn[];
    playlistItemData?: { videoId?: string };
    overlay?: unknown;
  };
}

function textOf(column: FlexColumn | undefined): string {
  const runs = column?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
  if (!runs) return "";
  return runs.map((run) => run.text ?? "").join("").trim();
}

function findVideoId(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 8) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.videoId === "string") return record.videoId;
  for (const key of Object.keys(record)) {
    const found = findVideoId(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function parseDuration(text: string): number {
  const match = text.match(/(\d+):(\d{2})(?::(\d{2}))?/);
  if (!match) return 0;
  if (match[3]) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function videoIdFromTrackUrl(url: string, fallbackId = ""): string {
  try {
    const parsed = new URL(url);
    const id = parsed.searchParams.get("v") ?? "";
    if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
  } catch {
    // not an absolute URL
  }
  return /^[A-Za-z0-9_-]{11}$/.test(fallbackId) ? fallbackId : "";
}

export function youtubeEmbedUrl(videoId: string): string {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return "";
  return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&playsinline=1`;
}

export function extractYtInitialData(html: string): unknown | null {
  const marker = /ytInitialData\s*[=:]\s*/g;
  let match = marker.exec(html);
  while (match) {
    let start = match.index + match[0].length;
    while (start < html.length && (html[start] === " " || html[start] === "\n")) start += 1;
    if (html[start] === "{") {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < html.length; i += 1) {
        const char = html[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') inString = true;
        else if (char === "{") depth += 1;
        else if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            try {
              return JSON.parse(html.slice(start, i + 1));
            } catch {
              return null;
            }
          }
        }
      }
    }
    match = marker.exec(html);
  }
  return null;
}

export function parseTracks(data: unknown): QueueTrack[] {
  const tracks: QueueTrack[] = [];
  const seen = new Set<string>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    const renderer = (record as Renderer).musicResponsiveListItemRenderer;
    if (renderer) {
      const title = textOf(renderer.flexColumns?.[0]);
      const subtitle = textOf(renderer.flexColumns?.[1]);
      const id = renderer.playlistItemData?.videoId ?? findVideoId(renderer.overlay) ?? null;
      if (id && title && !seen.has(id)) {
        seen.add(id);
        const artist = subtitle.split("•")[0].trim();
        tracks.push({
          id,
          title,
          artist: artist || "Unknown artist",
          durationSec: /(\d+):\d{2}/.test(subtitle) ? parseDuration(subtitle) : 0,
          provider: "youtube-music",
          url: `https://music.youtube.com/watch?v=${encodeURIComponent(id)}`,
        });
      }
      return;
    }
    for (const key of Object.keys(record)) visit(record[key]);
  };

  visit(data);
  return tracks;
}

export function parseSearchHtml(html: string): QueueTrack[] {
  const data = extractYtInitialData(html);
  return data ? parseTracks(data) : [];
}

export function parseSearchResponse(body: string, providerId = "youtube-music"): QueueTrack[] {
  try {
    const payload = JSON.parse(body) as { tracks?: QueueTrack[] };
    if (Array.isArray(payload?.tracks) && payload.tracks.every((t) => typeof t?.id === "string" && typeof t?.title === "string")) {
      return payload.tracks;
    }
  } catch {
    /* not a native payload; fall back to HTML or commercial parser */
  }
  const yt = parseSearchHtml(body);
  if (yt.length > 0) return yt;
  return parseCommercialSearchPayload(providerId, body);
}

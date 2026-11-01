// SoundCloud adapter against the public API (https://developers.soundcloud.com/docs/api/guide).
//
// - OAuth 2.1: PKCE authorization code at secure.soundcloud.com for user
//   resources (likes, playlists); client_credentials (HTTP Basic) for public
//   search and playback. All clients are confidential, so the app needs the
//   client id AND secret from a registered SoundCloud app.
// - Header scheme is `Authorization: OAuth <token>`.
// - Playback: GET /tracks/{urn}/streams returns transcodings. Progressive MP3
//   is preferred (decode once to PCM, full deck path); plain HLS is next; a
//   preview URL is labelled preview. Tracks with access=blocked are refused.
//   No api-v2, no scraped client ids.
// - Attribution (Terms of Use): the deck shows the uploader and links the
//   SoundCloud permalink.

import {
  checkResponse,
  msToSec,
  standardAuthStatus,
  StreamSourceError,
  type BrowseResult,
  type CredentialStatus,
  type OAuthEndpoints,
  type PlaybackPlan,
  type SourceCapabilities,
  type StreamHttp,
  type StreamSource,
  type StreamTrack,
  type TrackAccess,
} from "../source.ts";
import { soundcloudWidgetUrl } from "../embed.ts";

const API = "https://api.soundcloud.com";

export const SOUNDCLOUD_OAUTH: OAuthEndpoints = {
  authorizeUrl: "https://secure.soundcloud.com/authorize",
  tokenUrl: "https://secure.soundcloud.com/oauth/token",
  scopes: [],
  clientAuth: "body",
  tokenType: "OAuth",
  clientCredentials: true,
  revokeUrl: `${API}/disconnect`,
};

const CAPS: SourceCapabilities = {
  search: true,
  browse: true,
  decodable: true,
  embed: true,
  userAuth: true,
  userAuthRequired: false,
};

export interface ScTrack {
  id?: number;
  urn?: string;
  title?: string;
  metadata_artist?: string | null;
  user?: { username?: string } | null;
  duration?: number;
  bpm?: number | null;
  key_signature?: string | null;
  genre?: string | null;
  isrc?: string | null;
  artwork_url?: string | null;
  permalink_url?: string;
  access?: string;
  streamable?: boolean;
}

export interface ScStreams {
  http_mp3_128_url?: string;
  hls_mp3_128_url?: string;
  hls_aac_160_url?: string;
  hls_opus_64_url?: string;
  preview_mp3_128_url?: string;
}

function access(value: string | undefined, streamable: boolean | undefined): TrackAccess {
  if (value === "playable") return "full";
  if (value === "preview") return "preview";
  if (value === "blocked") return "blocked";
  return streamable === false ? "blocked" : "unknown";
}

export function mapSoundcloudTrack(raw: ScTrack): StreamTrack | null {
  const id = raw.urn || (raw.id != null ? String(raw.id) : "");
  const title = (raw.title ?? "").trim();
  if (!id || !title) return null;
  return {
    source: "soundcloud",
    id,
    title,
    artist: (raw.metadata_artist || raw.user?.username || "Unknown artist").trim(),
    durationSec: msToSec(raw.duration),
    bpm: typeof raw.bpm === "number" && raw.bpm > 0 ? raw.bpm : undefined,
    key: raw.key_signature || undefined,
    genre: raw.genre || undefined,
    isrc: raw.isrc || undefined,
    // -large is 100x100; t500x500 is the documented larger size.
    artworkUrl: raw.artwork_url ? raw.artwork_url.replace("-large.", "-t500x500.") : undefined,
    permalink: raw.permalink_url,
    access: access(raw.access, raw.streamable),
  };
}

function collection(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const c = (data as { collection?: unknown[] } | null)?.collection;
  return Array.isArray(c) ? c : [];
}

/** Picks the best transcoding the app may decode, or null. */
export function pickSoundcloudStream(streams: ScStreams, trackAccess: TrackAccess): { url: string; container: "progressive" | "hls"; preview: boolean } | null {
  if (trackAccess !== "preview") {
    if (streams.http_mp3_128_url) return { url: streams.http_mp3_128_url, container: "progressive", preview: false };
    if (streams.hls_mp3_128_url) return { url: streams.hls_mp3_128_url, container: "hls", preview: false };
    if (streams.hls_aac_160_url) return { url: streams.hls_aac_160_url, container: "hls", preview: false };
  }
  if (streams.preview_mp3_128_url) return { url: streams.preview_mp3_128_url, container: "progressive", preview: true };
  return null;
}

export function createSoundcloudSource(http: StreamHttp): StreamSource {
  const name = "SoundCloud";
  const keyHelp = "Register an app at soundcloud.com/you/apps (or the SoundCloud API CLI) and paste its client id and client secret. Check SoundCloud's API Terms before public DJ use.";
  const get = async (path: string, auth: "app-or-user" | "user" = "app-or-user"): Promise<unknown> =>
    checkResponse(name, await http.request({ url: `${API}${path}`, auth, accept: "application/json; charset=utf-8" }));
  const mapAll = (list: unknown[]): StreamTrack[] =>
    list.map((item) => mapSoundcloudTrack(item as ScTrack)).filter((t): t is StreamTrack => t !== null);

  return {
    id: "soundcloud",
    name,
    capabilities: CAPS,
    oauth: SOUNDCLOUD_OAUTH,
    apiHosts: ["api.soundcloud.com", "secure.soundcloud.com"],
    audioHostSuffixes: ["sndcdn.com", "soundcloud.cloud", "soundcloud.com"],
    keyHelp,
    authStatus: (creds: CredentialStatus | undefined) => {
      if (creds?.hasClientId && !creds.hasClientSecret && !creds.userSignedIn) {
        return { state: "needs-partner-key", message: "Needs partner API key: SoundCloud also requires the app's client secret." };
      }
      return standardAuthStatus(creds, CAPS, keyHelp);
    },

    async search(query: string, limit = 25): Promise<StreamTrack[]> {
      const q = encodeURIComponent(query.trim());
      if (!q) return [];
      return mapAll(collection(await get(`/tracks?q=${q}&access=playable,preview&limit=${limit}&linked_partitioning=true`)));
    },

    async browse(nodeId?: string): Promise<BrowseResult> {
      if (!nodeId) {
        return {
          nodes: [
            { id: "likes", title: "Liked tracks", kind: "collection" },
            { id: "playlists", title: "My playlists", kind: "folder" },
          ],
          tracks: [],
          note: "Likes and playlists need you to sign in with SoundCloud.",
        };
      }
      if (nodeId === "likes") return { nodes: [], tracks: mapAll(collection(await get("/me/likes/tracks?limit=100&linked_partitioning=true", "user"))) };
      if (nodeId === "playlists") {
        const list = collection(await get("/me/playlists?show_tracks=false&limit=50&linked_partitioning=true", "user")) as Array<{ urn?: string; id?: number; title?: string }>;
        return {
          nodes: list.filter((p) => p.urn || p.id != null).map((p) => ({ id: `playlist:${p.urn ?? p.id}`, title: p.title ?? "Playlist", kind: "playlist" as const })),
          tracks: [],
        };
      }
      const playlist = /^playlist:(.+)$/.exec(nodeId);
      if (playlist) {
        return { nodes: [], tracks: mapAll(collection(await get(`/playlists/${encodeURIComponent(playlist[1])}/tracks?limit=200&linked_partitioning=true`))) };
      }
      throw new StreamSourceError("not-found", `${name}: unknown folder ${nodeId}`);
    },

    async metadata(id: string): Promise<StreamTrack> {
      const track = mapSoundcloudTrack((await get(`/tracks/${encodeURIComponent(id)}`)) as ScTrack);
      if (!track) throw new StreamSourceError("parse", `${name}: track ${id} had no title`);
      return track;
    },

    async resolve(track: StreamTrack): Promise<PlaybackPlan> {
      if (track.access === "blocked") {
        return { kind: "unavailable", source: "soundcloud", reason: `${name}: the uploader doesn't allow off-platform streaming for this track.` };
      }
      let streams: ScStreams;
      try {
        streams = (await get(`/tracks/${encodeURIComponent(track.id)}/streams`)) as ScStreams;
      } catch (error) {
        if (error instanceof StreamSourceError && (error.code === "forbidden" || error.code === "not-found")) {
          return { kind: "unavailable", source: "soundcloud", reason: `${name}: no stream available for this track (${error.status}).` };
        }
        throw error;
      }
      const pick = pickSoundcloudStream(streams, track.access);
      if (pick) return { kind: "decodable", source: "soundcloud", ...pick, mimeHint: "audio/mpeg", auth: "app-or-user" };
      if (track.permalink) {
        return {
          kind: "monitor-only",
          source: "soundcloud",
          embedUrl: soundcloudWidgetUrl(track.permalink),
          reason: "widget",
          note: "SoundCloud gave no decodable stream for this track; playing it in SoundCloud's own widget.",
        };
      }
      return { kind: "unavailable", source: "soundcloud", reason: `${name}: no stream available for this track.` };
    },
  };
}

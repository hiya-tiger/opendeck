// Beatport LINK / Beatsource LINK adapter against the Beatport v4 API
// (https://api.beatport.com/v4/docs/, same API family on api.beatsource.com).
//
// Access is partner-gated: Beatport issues a client id to licensed DJ-software
// partners, and streaming needs the user's own LINK subscription, so every
// call is made with the user's OAuth token (authorization code + PKCE).
//
// [verify] The stream endpoint shape (`GET /catalog/tracks/{id}/stream/` ->
// `{ stream_url, sample_start_ms, sample_end_ms }`) is the one exposed in the
// v4 docs; the exact contract, formats and any encryption are defined in the
// partner SDK docs, which need a partner login. Until a partner key confirms
// it, encrypted streams are refused (never decrypted) and the deck shows why.

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
} from "../source.ts";

type Brand = "beatport" | "beatsource";

interface BpArtist {
  name?: string;
}
interface BpImage {
  uri?: string;
  dynamic_uri?: string;
}
export interface BpTrack {
  id?: number | string;
  name?: string;
  mix_name?: string;
  artists?: BpArtist[];
  remixers?: BpArtist[];
  bpm?: number;
  key?: { name?: string; camelot_number?: number; camelot_letter?: string } | null;
  length_ms?: number;
  isrc?: string;
  slug?: string;
  genre?: { name?: string } | null;
  image?: BpImage | null;
  release?: { name?: string; image?: BpImage | null } | null;
  is_available_for_streaming?: boolean;
  url?: string;
}

const CAPS: SourceCapabilities = {
  search: true,
  browse: true,
  decodable: true,
  embed: false,
  userAuth: true,
  userAuthRequired: true,
};

export function beatportBase(brand: Brand): string {
  return brand === "beatport" ? "https://api.beatport.com/v4" : "https://api.beatsource.com/v4";
}

export function beatportOAuth(brand: Brand): OAuthEndpoints {
  const base = beatportBase(brand);
  return {
    authorizeUrl: `${base}/auth/o/authorize/`,
    tokenUrl: `${base}/auth/o/token/`,
    scopes: [],
    clientAuth: "body",
    tokenType: "Bearer",
    clientCredentials: false,
    revokeUrl: `${base}/auth/o/revoke_token/`,
  };
}

function webBase(brand: Brand): string {
  return brand === "beatport" ? "https://www.beatport.com" : "https://www.beatsource.com";
}

export function mapBeatportTrack(brand: Brand, raw: BpTrack): StreamTrack | null {
  const id = raw.id == null ? "" : String(raw.id);
  const name = (raw.name ?? "").trim();
  if (!id || !name) return null;
  const mix = (raw.mix_name ?? "").trim();
  const title = mix && !name.includes(mix) ? `${name} (${mix})` : name;
  const artist = (raw.artists ?? []).map((a) => a?.name ?? "").filter(Boolean).join(", ") || "Unknown artist";
  const key = raw.key?.name?.trim() || undefined;
  const art = raw.image?.uri || raw.release?.image?.uri || undefined;
  return {
    source: brand,
    id,
    title,
    artist,
    durationSec: msToSec(raw.length_ms),
    bpm: typeof raw.bpm === "number" && raw.bpm > 0 ? raw.bpm : undefined,
    key,
    isrc: raw.isrc || undefined,
    album: raw.release?.name || undefined,
    genre: raw.genre?.name || undefined,
    artworkUrl: art,
    permalink: `${webBase(brand)}/track/${encodeURIComponent(raw.slug || "-")}/${encodeURIComponent(id)}`,
    access: raw.is_available_for_streaming === false ? "blocked" : "unknown",
  };
}

function results(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  if (Array.isArray(d.results)) return d.results;
  if (Array.isArray(d.tracks)) return d.tracks;
  if (d.tracks && typeof d.tracks === "object" && Array.isArray((d.tracks as { data?: unknown[] }).data)) return (d.tracks as { data: unknown[] }).data;
  return [];
}

export function createBeatportSource(brand: Brand, http: StreamHttp): StreamSource {
  const base = beatportBase(brand);
  const name = brand === "beatport" ? "Beatport LINK" : "Beatsource LINK";
  const keyHelp = `${name} streaming is licensed to DJ-software partners: apply through the ${brand === "beatport" ? "Beatport" : "Beatsource"} partner portal, then paste the client id here. Each DJ also needs a LINK subscription.`;
  const get = async (path: string): Promise<unknown> =>
    checkResponse(name, await http.request({ url: `${base}${path}`, auth: "user" }));
  const mapAll = (list: unknown[]): StreamTrack[] =>
    list
      .map((item) => {
        const rec = item as Record<string, unknown>;
        // Playlist items wrap the track: { position, track: {...} }.
        const raw = (rec.track && typeof rec.track === "object" ? rec.track : rec) as BpTrack;
        return mapBeatportTrack(brand, raw);
      })
      .filter((t): t is StreamTrack => t !== null);

  return {
    id: brand,
    name,
    capabilities: CAPS,
    oauth: beatportOAuth(brand),
    apiHosts: [new URL(base).hostname],
    // [verify] the CDN hosts the stream endpoint returns; tighten once confirmed.
    audioHostSuffixes: [brand === "beatport" ? "beatport.com" : "beatsource.com", "beatportprod.com"],
    keyHelp,
    authStatus: (creds: CredentialStatus | undefined) => standardAuthStatus(creds, CAPS, keyHelp),

    async search(query: string, limit = 25): Promise<StreamTrack[]> {
      const q = encodeURIComponent(query.trim());
      if (!q) return [];
      return mapAll(results(await get(`/catalog/search/?q=${q}&type=tracks&per_page=${limit}`)));
    },

    async browse(nodeId?: string): Promise<BrowseResult> {
      if (!nodeId) {
        return {
          nodes: [
            { id: "my-playlists", title: "My playlists", kind: "folder" },
            { id: "genres", title: "Genres: Top 100", kind: "folder" },
          ],
          tracks: [],
        };
      }
      if (nodeId === "my-playlists") {
        const data = (await get("/my/playlists/?per_page=100")) as { results?: Array<{ id?: number; name?: string }> };
        return {
          nodes: (data.results ?? []).filter((p) => p.id != null).map((p) => ({ id: `playlist:${p.id}`, title: p.name ?? `Playlist ${p.id}`, kind: "playlist" as const })),
          tracks: [],
        };
      }
      if (nodeId === "genres") {
        const data = (await get("/catalog/genres/?per_page=100")) as { results?: Array<{ id?: number; name?: string }> };
        return {
          nodes: (data.results ?? []).filter((g) => g.id != null).map((g) => ({ id: `genre:${g.id}`, title: g.name ?? `Genre ${g.id}`, kind: "genre" as const })),
          tracks: [],
        };
      }
      const playlist = /^playlist:(\d+)$/.exec(nodeId);
      if (playlist) return { nodes: [], tracks: mapAll(results(await get(`/my/playlists/${playlist[1]}/tracks/?per_page=100`))) };
      const genre = /^genre:(\d+)$/.exec(nodeId);
      if (genre) return { nodes: [], tracks: mapAll(results(await get(`/catalog/genres/${genre[1]}/top/100/`))) };
      throw new StreamSourceError("not-found", `${name}: unknown folder ${nodeId}`);
    },

    async metadata(id: string): Promise<StreamTrack> {
      const track = mapBeatportTrack(brand, (await get(`/catalog/tracks/${encodeURIComponent(id)}/`)) as BpTrack);
      if (!track) throw new StreamSourceError("parse", `${name}: track ${id} had no title`);
      return track;
    },

    async resolve(track: StreamTrack): Promise<PlaybackPlan> {
      if (track.access === "blocked") return { kind: "unavailable", source: brand, reason: `${name}: not available for streaming in your region or plan.` };
      let data: unknown;
      try {
        data = await get(`/catalog/tracks/${encodeURIComponent(track.id)}/stream/`);
      } catch (error) {
        if (error instanceof StreamSourceError && error.code === "forbidden") {
          return { kind: "unavailable", source: brand, reason: `${name}: this account has no LINK streaming access (403).` };
        }
        throw error;
      }
      const url = (data as { stream_url?: unknown }).stream_url;
      if (typeof url !== "string" || !url.startsWith("https://")) {
        return { kind: "unavailable", source: brand, reason: `${name}: the stream endpoint returned no stream URL.` };
      }
      const sample = data as { sample_start_ms?: number; sample_end_ms?: number };
      const preview = typeof sample.sample_end_ms === "number" && sample.sample_end_ms > 0 && msToSec(sample.sample_end_ms - (sample.sample_start_ms ?? 0)) < Math.max(1, track.durationSec - 1);
      return {
        kind: "decodable",
        source: brand,
        url,
        container: /\.m3u8(\?|$)/i.test(url) ? "hls" : "progressive",
        preview,
        auth: "user",
      };
    },
  };
}

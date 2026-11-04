// TIDAL adapter against the TIDAL developer platform (JSON:API at
// https://openapi.tidal.com/v2, reference: https://tidal-music.github.io/tidal-api-reference/).
//
// - Auth: client_credentials (HTTP Basic) at https://auth.tidal.com/v1/oauth2/token
//   for catalogue calls; authorization code + PKCE at https://login.tidal.com/authorize
//   for user context (scopes below).
// - Search: GET /searchResults?filter[query]=..&include=tracks, then
//   GET /tracks?filter[id]=..&include=artists,albums for names (20 ids per call).
// - Playback: GET /trackManifests/{id}. The schema says "absence [of drmData]
//   implies no DRM". When drmData is present (Widevine/FairPlay) the track can
//   only play in TIDAL's own player, so the deck embeds embed.tidal.com and is
//   monitor-only. When it is absent and the manifest is plain HLS, the deck
//   decodes it like a local file (often a 30 s preview: trackPresentation).
//   The DJ-grade TIDAL integration in Serato/rekordbox is a separate partner
//   programme with no public docs; nothing here pretends to be it.

import {
  checkResponse,
  isoDurationToSec,
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
import { tidalEmbedUrl } from "../embed.ts";

const API = "https://openapi.tidal.com/v2";

export const TIDAL_OAUTH: OAuthEndpoints = {
  authorizeUrl: "https://login.tidal.com/authorize",
  tokenUrl: "https://auth.tidal.com/v1/oauth2/token",
  scopes: ["playback", "search.read", "collection.read", "playlists.read", "user.read"],
  clientAuth: "body",
  tokenType: "Bearer",
  clientCredentials: true,
};

const CAPS: SourceCapabilities = {
  search: true,
  browse: false,
  decodable: true,
  embed: true,
  userAuth: true,
  userAuthRequired: false,
};

interface JsonApiResource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: Array<{ id?: string; type?: string }> | { id?: string; type?: string } | null }>;
}

interface JsonApiDoc {
  data?: JsonApiResource | JsonApiResource[];
  included?: JsonApiResource[];
}

function relIds(res: JsonApiResource | undefined, rel: string): string[] {
  const data = res?.relationships?.[rel]?.data;
  if (!data) return [];
  const list = Array.isArray(data) ? data : [data];
  return list.map((d) => d?.id ?? "").filter(Boolean);
}

export function tidalSearchTrackIds(doc: JsonApiDoc): string[] {
  const data = Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : [];
  const ids: string[] = [];
  for (const res of data) ids.push(...relIds(res, "tracks"));
  // Some responses only carry the tracks in `included`.
  if (!ids.length) for (const inc of doc.included ?? []) if (inc.type === "tracks" && inc.id) ids.push(inc.id);
  return Array.from(new Set(ids));
}

export function mapTidalTracks(doc: JsonApiDoc): StreamTrack[] {
  const data = Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : [];
  const included = new Map<string, JsonApiResource>();
  for (const inc of doc.included ?? []) if (inc.id && inc.type) included.set(`${inc.type}:${inc.id}`, inc);
  const out: StreamTrack[] = [];
  for (const res of data) {
    if (res.type !== "tracks" || !res.id) continue;
    const a = res.attributes ?? {};
    const baseTitle = typeof a.title === "string" ? a.title.trim() : "";
    if (!baseTitle) continue;
    const version = typeof a.version === "string" ? a.version.trim() : "";
    const artists = relIds(res, "artists")
      .map((id) => included.get(`artists:${id}`)?.attributes?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    const album = relIds(res, "albums").map((id) => included.get(`albums:${id}`)?.attributes?.title).find((t): t is string => typeof t === "string");
    const key = typeof a.key === "string" && a.key !== "UNKNOWN" ? `${a.key}${a.keyScale === "MINOR" ? "m" : ""}` : undefined;
    out.push({
      source: "tidal",
      id: res.id,
      title: version && !baseTitle.includes(version) ? `${baseTitle} (${version})` : baseTitle,
      artist: artists.join(", ") || "Unknown artist",
      durationSec: isoDurationToSec(a.duration),
      bpm: typeof a.bpm === "number" && a.bpm > 0 ? a.bpm : undefined,
      key,
      isrc: typeof a.isrc === "string" ? a.isrc : undefined,
      album,
      permalink: `https://tidal.com/browse/track/${res.id}`,
      access: "unknown",
    });
  }
  return out;
}

export interface TidalManifest {
  uri?: string;
  trackPresentation?: "FULL" | "PREVIEW";
  previewReason?: string;
  drmData?: { drmSystem?: string; licenseUrl?: string } | null;
  formats?: string[];
}

export function tidalPlanFromManifest(trackId: string, manifest: TidalManifest): PlaybackPlan {
  const embedUrl = tidalEmbedUrl(trackId);
  if (manifest.drmData) {
    return {
      kind: "monitor-only",
      source: "tidal",
      embedUrl,
      reason: "widevine",
      note: `TIDAL serves this track with ${manifest.drmData.drmSystem ?? "DRM"}; only TIDAL's own player may play it.`,
    };
  }
  if (typeof manifest.uri === "string" && manifest.uri.startsWith("https://")) {
    return {
      kind: "decodable",
      source: "tidal",
      url: manifest.uri,
      container: "hls",
      preview: manifest.trackPresentation === "PREVIEW",
      auth: "none",
    };
  }
  return embedUrl
    ? { kind: "monitor-only", source: "tidal", embedUrl, reason: "widevine", note: "TIDAL returned no playable manifest; showing TIDAL's own player." }
    : { kind: "unavailable", source: "tidal", reason: "TIDAL returned no playable manifest." };
}

export function createTidalSource(http: StreamHttp, countryCode = "US"): StreamSource {
  const name = "TIDAL";
  const keyHelp = "Create an app at developer.tidal.com and paste its client id and client secret. Full-track DJ streaming is a separate TIDAL partner agreement.";
  const get = async (path: string): Promise<JsonApiDoc> =>
    checkResponse(name, await http.request({ url: `${API}${path}`, auth: "app-or-user", accept: "application/vnd.api+json" })) as JsonApiDoc;
  const cc = encodeURIComponent(countryCode);

  const tracksById = async (ids: string[]): Promise<StreamTrack[]> => {
    const out: StreamTrack[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20).map(encodeURIComponent).join(",");
      out.push(...mapTidalTracks(await get(`/tracks?countryCode=${cc}&filter[id]=${chunk}&include=artists,albums`)));
    }
    const order = new Map(ids.map((id, index) => [id, index]));
    return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  };

  return {
    id: "tidal",
    name,
    capabilities: CAPS,
    oauth: TIDAL_OAUTH,
    apiHosts: ["openapi.tidal.com", "auth.tidal.com", "login.tidal.com"],
    audioHostSuffixes: ["tidal.com", "tidalhifi.com"],
    keyHelp,
    authStatus: (creds: CredentialStatus | undefined) => {
      if (creds?.hasClientId && !creds.hasClientSecret && !creds.userSignedIn) {
        return { state: "needs-partner-key", message: "Needs partner API key: TIDAL catalogue calls also need the app's client secret." };
      }
      return standardAuthStatus(creds, CAPS, keyHelp);
    },

    async search(query: string, limit = 20): Promise<StreamTrack[]> {
      const q = encodeURIComponent(query.trim());
      if (!q) return [];
      const ids = tidalSearchTrackIds(await get(`/searchResults?filter[query]=${q}&countryCode=${cc}&include=tracks`)).slice(0, limit);
      return ids.length ? tracksById(ids) : [];
    },

    async browse(): Promise<BrowseResult> {
      return { nodes: [], tracks: [], note: "TIDAL browsing isn't wired yet; use search." };
    },

    async metadata(id: string): Promise<StreamTrack> {
      const [track] = await tracksById([id]);
      if (!track) throw new StreamSourceError("not-found", `${name}: track ${id} not found`);
      return track;
    },

    async resolve(track: StreamTrack): Promise<PlaybackPlan> {
      const query = `adaptive=false&manifestType=HLS&formats=AACLC&uriScheme=HTTPS&usage=PLAYBACK`;
      let doc: JsonApiDoc;
      try {
        doc = await get(`/trackManifests/${encodeURIComponent(track.id)}?${query}`);
      } catch (error) {
        if (error instanceof StreamSourceError && (error.code === "forbidden" || error.code === "not-found")) {
          const embedUrl = tidalEmbedUrl(track.id);
          return embedUrl
            ? { kind: "monitor-only", source: "tidal", embedUrl, reason: "widevine", note: `TIDAL refused a manifest (${error.status}); showing TIDAL's own player.` }
            : { kind: "unavailable", source: "tidal", reason: error.message };
        }
        throw error;
      }
      const res = Array.isArray(doc.data) ? doc.data[0] : doc.data;
      return tidalPlanFromManifest(track.id, (res?.attributes ?? {}) as TidalManifest);
    },
  };
}

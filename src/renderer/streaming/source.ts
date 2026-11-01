// StreamSource: the one interface every streaming service implements so the
// library browser and the deck loader can treat a streamed track like a local
// file. See docs/decisions.md D42.
//
// An adapter never touches tokens or secrets. It builds requests and parses
// responses; the transport (StreamHttp) attaches credentials. In the app the
// transport is the main process (src/main/streaming.ts), in tests it is a fake.

export const NEEDS_PARTNER_KEY = "needs partner API key";

export type StreamSourceId = "beatport" | "beatsource" | "tidal" | "soundcloud" | "web-player";

/** What the source can access right now, derived from stored credentials. */
export type AuthState =
  | "needs-partner-key" // no client id / partner key stored: nothing works
  | "signed-out" // app key stored, user sign-in required for this source
  | "app-only" // app key works for catalogue/public calls; user sign-in optional
  | "signed-in"
  | "expired"; // user token expired and could not be refreshed

export interface CredentialStatus {
  source: string;
  hasClientId: boolean;
  hasClientSecret: boolean;
  userSignedIn: boolean;
  userExpiresAt: number | null;
  userRefreshable: boolean;
}

export interface AuthStatus {
  state: AuthState;
  /** Text the UI shows as-is. */
  message: string;
}

export type TrackAccess = "full" | "preview" | "blocked" | "unknown";

export interface StreamTrack {
  source: StreamSourceId;
  id: string;
  title: string;
  artist: string;
  durationSec: number;
  bpm?: number;
  key?: string;
  isrc?: string;
  album?: string;
  genre?: string;
  artworkUrl?: string;
  /** The track's page on the service (attribution link). */
  permalink?: string;
  access: TrackAccess;
}

export interface BrowseNode {
  id: string;
  title: string;
  kind: "folder" | "playlist" | "chart" | "genre" | "collection";
}

export interface BrowseResult {
  nodes: BrowseNode[];
  tracks: StreamTrack[];
  /** Shown when there is nothing to browse (for example: sign in first). */
  note?: string;
}

/**
 * How a resolved track plays.
 * - decodable: plain audio the app may fetch and decode, so it goes through the
 *   normal deck path (analysis, waveform, stems, FX).
 * - monitor-only: the service only allows its own (usually Widevine/EME) player.
 *   The official player is embedded in the deck panel; its audio never reaches
 *   Web Audio, so no EQ/FX/analysis. Bring it into the mix with system capture.
 * - unavailable: the service refused (blocked, region, no subscription, no key).
 */
export type PlaybackPlan =
  | {
      kind: "decodable";
      source: StreamSourceId;
      url: string;
      container: "progressive" | "hls";
      preview: boolean;
      mimeHint?: string;
      /** Where the audio must be fetched with the user's/app's token. */
      auth: RequestAuth;
    }
  | {
      kind: "monitor-only";
      source: StreamSourceId;
      embedUrl: string;
      reason: "widevine" | "widget";
      note: string;
    }
  | { kind: "unavailable"; source: StreamSourceId; reason: string };

export type RequestAuth = "none" | "app" | "user" | "app-or-user";

export interface StreamRequest {
  url: string;
  method?: "GET" | "POST" | "DELETE";
  auth: RequestAuth;
  accept?: string;
}

export interface StreamResponse {
  status: number;
  body: string;
  /** Set by the transport when it refused before sending (e.g. no key stored). */
  error?: "missing-credentials" | "auth-required" | "host-not-allowed" | "network";
  detail?: string;
}

export interface StreamHttp {
  request(req: StreamRequest): Promise<StreamResponse>;
}

export type StreamErrorCode =
  | "missing-credentials"
  | "auth-required"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "http"
  | "parse"
  | "not-streamable"
  | "encrypted"
  | "unsupported";

export class StreamSourceError extends Error {
  readonly code: StreamErrorCode;
  readonly status: number;

  constructor(code: StreamErrorCode, message: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "StreamSourceError";
  }
}

export interface SourceCapabilities {
  search: boolean;
  browse: boolean;
  /** The service can hand out audio the app is allowed to decode. */
  decodable: boolean;
  /** The service has an official embeddable player. */
  embed: boolean;
  /** User sign-in (OAuth authorization code + PKCE) is supported. */
  userAuth: boolean;
  /** User sign-in is required for any catalogue call (Beatport/Beatsource LINK). */
  userAuthRequired: boolean;
}

export interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** How the client authenticates at the token endpoint. */
  clientAuth: "basic" | "body" | "none";
  /** Header scheme used on API calls ("Bearer" or SoundCloud's "OAuth"). */
  tokenType: "Bearer" | "OAuth";
  /** Whether client_credentials is supported for catalogue calls. */
  clientCredentials: boolean;
  revokeUrl?: string;
}

export interface StreamSource {
  readonly id: StreamSourceId;
  readonly name: string;
  readonly capabilities: SourceCapabilities;
  readonly oauth: OAuthEndpoints | null;
  /** Hosts the transport may call for this source (API and auth). */
  readonly apiHosts: string[];
  /** Host suffixes audio may be fetched from once resolved. */
  readonly audioHostSuffixes: string[];
  /** One line on where the key comes from, shown next to "needs partner API key". */
  readonly keyHelp: string;
  authStatus(creds: CredentialStatus | undefined): AuthStatus;
  search(query: string, limit?: number): Promise<StreamTrack[]>;
  browse(nodeId?: string): Promise<BrowseResult>;
  metadata(id: string): Promise<StreamTrack>;
  resolve(track: StreamTrack): Promise<PlaybackPlan>;
}

/** Default auth-state logic shared by the adapters. */
export function standardAuthStatus(
  creds: CredentialStatus | undefined,
  caps: SourceCapabilities,
  keyHelp: string,
  now = Date.now(),
): AuthStatus {
  if (!creds?.hasClientId) {
    return { state: "needs-partner-key", message: `${capitalize(NEEDS_PARTNER_KEY)}. ${keyHelp}` };
  }
  if (creds.userSignedIn) {
    const expired = creds.userExpiresAt != null && creds.userExpiresAt <= now && !creds.userRefreshable;
    if (expired) return { state: "expired", message: "Session expired. Sign in again." };
    return { state: "signed-in", message: "Signed in" };
  }
  if (caps.userAuthRequired) {
    return { state: "signed-out", message: "Key saved. Sign in with your account to stream." };
  }
  return { state: "app-only", message: "Key saved. Catalogue search works; sign in for your own library." };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Maps a transport response to data or a typed error. Never treats a refusal as success. */
export function checkResponse(sourceName: string, res: StreamResponse): unknown {
  if (res.error === "missing-credentials") {
    throw new StreamSourceError("missing-credentials", `${sourceName}: ${NEEDS_PARTNER_KEY}.`);
  }
  if (res.error === "auth-required") {
    throw new StreamSourceError("auth-required", `${sourceName}: sign in first.`);
  }
  if (res.error) {
    throw new StreamSourceError("http", `${sourceName}: ${res.detail ?? res.error}`);
  }
  if (res.status === 401) throw new StreamSourceError("auth-required", `${sourceName}: sign-in rejected (401).`, 401);
  if (res.status === 403) throw new StreamSourceError("forbidden", `${sourceName}: not allowed for this account (403).`, 403);
  if (res.status === 404) throw new StreamSourceError("not-found", `${sourceName}: not found (404).`, 404);
  if (res.status === 429) throw new StreamSourceError("rate-limited", `${sourceName}: rate limited, try again shortly (429).`, 429);
  if (res.status < 200 || res.status >= 300) {
    throw new StreamSourceError("http", `${sourceName}: HTTP ${res.status}.`, res.status);
  }
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    throw new StreamSourceError("parse", `${sourceName}: response was not JSON.`, res.status);
  }
}

export function hostAllowed(url: string, hosts: string[], suffixes: string[] = []): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (hosts.includes(host)) return true;
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Registry the UI iterates; order is the order shown in the Stream tab. */
export class StreamSourceRegistry {
  private readonly sources = new Map<string, StreamSource>();

  register(source: StreamSource): void {
    if (this.sources.has(source.id)) throw new Error(`stream source ${source.id} registered twice`);
    this.sources.set(source.id, source);
  }

  get(id: string): StreamSource | undefined {
    return this.sources.get(id);
  }

  list(): StreamSource[] {
    return Array.from(this.sources.values());
  }
}

/** Stable library id for a streamed track: the deck loader resolves it lazily. */
export function streamTrackKey(track: Pick<StreamTrack, "source" | "id">): string {
  return `stream:${track.source}:${track.id}`;
}

export function parseStreamTrackKey(key: string): { source: string; id: string } | null {
  const match = /^stream:([a-z0-9-]+):(.+)$/.exec(key);
  return match ? { source: match[1], id: match[2] } : null;
}

export function msToSec(ms: unknown): number {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
}

/** ISO 8601 durations as TIDAL returns them (PT3M21S). */
export function isoDurationToSec(value: unknown): number {
  if (typeof value !== "string") return 0;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match) return 0;
  const [, d, h, m, s] = match;
  return Math.round(Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0));
}

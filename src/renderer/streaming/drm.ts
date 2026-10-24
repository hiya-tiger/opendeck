import type { QueueTrack } from "./queue.ts";

export type DrmScheme = "widevine" | "fairplay" | "playready" | "clearkey";

export const DRM_KEY_SYSTEMS: Record<DrmScheme, string> = {
  widevine: "com.widevine.alpha",
  fairplay: "com.apple.fps.1_0",
  playready: "com.microsoft.playready",
  clearkey: "org.w3.clearkey",
};

export interface DrmLicenseConfig {
  provider: string;
  scheme: DrmScheme;
  licenseUrl?: string;
  bearerToken?: string;
  clientId?: string;
  clearKeys?: Record<string, string>;
  serverCertificate?: Uint8Array;
}

export interface DrmCapabilitiesReport {
  supportedSchemes: DrmScheme[];
  keySystems: Record<DrmScheme, boolean>;
  activeScheme: DrmScheme | null;
}

export interface DrmSessionStatus {
  provider: string;
  scheme: DrmScheme;
  keySystem: string;
  sessionId: string;
  state: "initialized" | "license-requested" | "usable" | "expired" | "closed" | "error";
  keyStatuses: Array<{ keyIdHex: string; status: string }>;
  updatedAt: number;
  error?: string;
}

export interface ProviderCredentials {
  provider: string;
  clientId?: string;
  developerToken?: string;
  accessToken?: string;
  licenseUrl?: string;
  preferredDrm?: DrmScheme;
  updatedAt: number;
}

export function defaultMediaKeySystemConfig(): MediaKeySystemConfiguration[] {
  return [
    {
      initDataTypes: ["cenc", "cbcs", "webm", "keyids"],
      audioCapabilities: [
        { contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness: "SW_SECURE_CRYPTO" },
        { contentType: 'audio/mp4; codecs="flac"', robustness: "SW_SECURE_CRYPTO" },
        { contentType: 'audio/webm; codecs="opus"', robustness: "" },
      ],
      distinctiveIdentifier: "optional",
      persistentState: "optional",
      sessionTypes: ["temporary"],
    },
  ];
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  if (typeof atob === "function") {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(padded, "base64"));
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.byteLength; i += 1) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

export function buildClearKeyLicense(clearKeys: Record<string, string>): Uint8Array {
  const keys = Object.entries(clearKeys).map(([kidHexOrB64, keyHexOrB64]) => {
    const kidBytes = /^[0-9a-fA-F]{32}$/.test(kidHexOrB64)
      ? hexToBytes(kidHexOrB64)
      : base64UrlDecode(kidHexOrB64);
    const keyBytes = /^[0-9a-fA-F]{32}$/.test(keyHexOrB64)
      ? hexToBytes(keyHexOrB64)
      : base64UrlDecode(keyHexOrB64);
    return {
      kty: "oct",
      k: base64UrlEncode(keyBytes),
      kid: base64UrlEncode(kidBytes),
    };
  });
  const payload = JSON.stringify({ keys, type: "temporary" });
  return new TextEncoder().encode(payload);
}

export async function generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
  const random = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(random);
  } else {
    for (let i = 0; i < random.length; i += 1) random[i] = (i * 37 + 19) & 0xff;
  }
  const verifier = base64UrlEncode(random);
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
  }
  return { verifier, challenge: verifier };
}

export function buildOAuthAuthorizeUrl(opts: {
  authorizeEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  state?: string;
}): string {
  const url = new URL(opts.authorizeEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", opts.scope);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", opts.codeChallenge);
  if (opts.state) url.searchParams.set("state", opts.state);
  return url.toString();
}

export type RequestMediaKeySystemAccessFn = (
  keySystem: string,
  supportedConfigurations: MediaKeySystemConfiguration[],
) => Promise<MediaKeySystemAccess>;

export async function probeKeySystems(
  requestAccess?: RequestMediaKeySystemAccessFn,
): Promise<DrmCapabilitiesReport> {
  const fn =
    requestAccess ??
    (typeof navigator !== "undefined" && typeof navigator.requestMediaKeySystemAccess === "function"
      ? navigator.requestMediaKeySystemAccess.bind(navigator)
      : undefined);

  const keySystems: Record<DrmScheme, boolean> = {
    widevine: false,
    fairplay: false,
    playready: false,
    clearkey: false,
  };
  const supportedSchemes: DrmScheme[] = [];

  if (!fn) {
    return { supportedSchemes, keySystems, activeScheme: null };
  }

  const schemes: DrmScheme[] = ["widevine", "playready", "fairplay", "clearkey"];
  const configs = defaultMediaKeySystemConfig();
  for (const scheme of schemes) {
    try {
      await fn(DRM_KEY_SYSTEMS[scheme], configs);
      keySystems[scheme] = true;
      supportedSchemes.push(scheme);
    } catch {
      keySystems[scheme] = false;
    }
  }

  return {
    supportedSchemes,
    keySystems,
    activeScheme: supportedSchemes[0] ?? null,
  };
}

export class ProviderCredentialStore {
  private readonly map = new Map<string, ProviderCredentials>();

  set(creds: ProviderCredentials): ProviderCredentials {
    const normalized: ProviderCredentials = {
      ...this.map.get(creds.provider),
      ...creds,
      updatedAt: Date.now(),
    };
    this.map.set(creds.provider, normalized);
    return normalized;
  }

  get(provider: string): ProviderCredentials | undefined {
    return this.map.get(provider);
  }

  hasCredentials(provider: string): boolean {
    const c = this.map.get(provider);
    return Boolean(c && (c.clientId || c.developerToken || c.accessToken));
  }

  revoke(provider: string): boolean {
    return this.map.delete(provider);
  }

  list(): ProviderCredentials[] {
    return Array.from(this.map.values());
  }
}

export class DrmSessionManager {
  private readonly sessions = new Map<string, DrmSessionStatus>();
  readonly credentials = new ProviderCredentialStore();

  getStatus(provider: string): DrmSessionStatus | undefined {
    return this.sessions.get(provider);
  }

  listStatuses(): DrmSessionStatus[] {
    return Array.from(this.sessions.values());
  }

  async negotiateLicense(
    challenge: ArrayBuffer | Uint8Array,
    config: DrmLicenseConfig,
    fetchImpl: typeof fetch = globalThis.fetch,
  ): Promise<Uint8Array> {
    if (config.scheme === "clearkey" || (config.clearKeys && Object.keys(config.clearKeys).length > 0)) {
      const keys = config.clearKeys ?? {
        "00112233445566778899aabbccddeeff": "0123456789abcdef0123456789abcdef",
      };
      return buildClearKeyLicense(keys);
    }
    if (!config.licenseUrl) {
      throw new Error(`No DRM license server URL configured for ${config.provider} (${config.scheme})`);
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
    };
    if (config.bearerToken) {
      headers.Authorization = `Bearer ${config.bearerToken}`;
    }
    if (config.clientId) {
      headers["X-Client-Id"] = config.clientId;
    }
    const body = challenge instanceof Uint8Array ? challenge : new Uint8Array(challenge);
    const response = await fetchImpl(config.licenseUrl, {
      method: "POST",
      headers,
      body: body as unknown as BodyInit,
    });
    if (!response.ok) {
      throw new Error(`DRM license server returned HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async attachToMediaElement(
    element: HTMLMediaElement,
    config: DrmLicenseConfig,
    requestAccess?: RequestMediaKeySystemAccessFn,
    fetchImpl?: typeof fetch,
  ): Promise<DrmSessionStatus> {
    const keySystem = DRM_KEY_SYSTEMS[config.scheme];
    const fn =
      requestAccess ??
      (typeof navigator !== "undefined" && typeof navigator.requestMediaKeySystemAccess === "function"
        ? navigator.requestMediaKeySystemAccess.bind(navigator)
        : undefined);

    if (!fn) {
      const fallback: DrmSessionStatus = {
        provider: config.provider,
        scheme: config.scheme,
        keySystem,
        sessionId: `eme-unavailable-${Date.now()}`,
        state: "error",
        keyStatuses: [],
        updatedAt: Date.now(),
        error: "EME MediaKeySystemAccess is not available in this environment",
      };
      this.sessions.set(config.provider, fallback);
      return fallback;
    }

    const access = await fn(keySystem, defaultMediaKeySystemConfig());
    const mediaKeys = await access.createMediaKeys();
    if (config.serverCertificate && typeof mediaKeys.setServerCertificate === "function") {
      await mediaKeys.setServerCertificate(config.serverCertificate as unknown as BufferSource);
    }
    if (typeof element.setMediaKeys === "function") {
      await element.setMediaKeys(mediaKeys);
    }

    const status: DrmSessionStatus = {
      provider: config.provider,
      scheme: config.scheme,
      keySystem,
      sessionId: `session-${config.provider}-${Date.now()}`,
      state: "initialized",
      keyStatuses: [],
      updatedAt: Date.now(),
    };
    this.sessions.set(config.provider, status);

    element.addEventListener("encrypted", async (event: Event) => {
      const enc = event as MediaEncryptedEvent;
      if (!enc.initData) return;
      try {
        const session = mediaKeys.createSession("temporary");
        status.sessionId = session.sessionId || status.sessionId;
        status.state = "license-requested";
        status.updatedAt = Date.now();

        session.addEventListener("message", async (msgEvent: Event) => {
          const msg = msgEvent as MediaKeyMessageEvent;
          try {
            const license = await this.negotiateLicense(msg.message, config, fetchImpl);
            await session.update(license as unknown as BufferSource);
            status.state = "usable";
            status.updatedAt = Date.now();
          } catch (error) {
            status.state = "error";
            status.error = (error as Error).message;
            status.updatedAt = Date.now();
          }
        });

        session.addEventListener("keystatuseschange", () => {
          const list: Array<{ keyIdHex: string; status: string }> = [];
          session.keyStatuses.forEach((val, keyId) => {
            list.push({
              keyIdHex: bytesToHex(keyId as ArrayBuffer),
              status: String(val),
            });
          });
          status.keyStatuses = list;
          if (list.some((k) => k.status === "usable")) status.state = "usable";
          else if (list.some((k) => k.status === "expired")) status.state = "expired";
          status.updatedAt = Date.now();
        });

        await session.generateRequest(enc.initDataType || "cenc", enc.initData);
      } catch (error) {
        status.state = "error";
        status.error = (error as Error).message;
        status.updatedAt = Date.now();
      }
    });

    return status;
  }
}

export function providerEmbedUrl(providerId: string, trackUrl: string, trackId = ""): string {
  const cleanId = trackId.trim();
  try {
    const parsed = new URL(trackUrl);
    switch (providerId) {
      case "youtube-music": {
        const v = parsed.searchParams.get("v") || cleanId;
        if (/^[A-Za-z0-9_-]{11}$/.test(v)) {
          return `https://www.youtube-nocookie.com/embed/${v}?autoplay=1&rel=0&playsinline=1`;
        }
        return "";
      }
      case "spotify": {
        const match = parsed.pathname.match(/\/track\/([A-Za-z0-9]+)/);
        const id = match?.[1] || cleanId;
        return id ? `https://open.spotify.com/embed/track/${encodeURIComponent(id)}?utm_source=generator&theme=0` : "";
      }
      case "tidal": {
        const match = parsed.pathname.match(/\/track\/(\d+)/);
        const id = match?.[1] || cleanId;
        return id ? `https://embed.tidal.com/tracks/${encodeURIComponent(id)}` : "";
      }
      case "soundcloud": {
        return `https://w.soundcloud.com/player/?url=${encodeURIComponent(parsed.toString())}&auto_play=true&visual=true`;
      }
      case "apple-music": {
        const host = parsed.host.replace(/^music\.apple\.com$/, "embed.music.apple.com");
        return `https://${host}${parsed.pathname}${parsed.search}`;
      }
      case "beatport": {
        const match = parsed.pathname.match(/\/(\d+)(?:\/|$)/);
        const id = match?.[1] || cleanId;
        return id ? `https://embed.beatport.com/?id=${encodeURIComponent(id)}&type=track` : "";
      }
      case "beatsource": {
        const match = parsed.pathname.match(/\/(\d+)(?:\/|$)/);
        const id = match?.[1] || cleanId;
        return id ? `https://embed.beatsource.com/?id=${encodeURIComponent(id)}&type=track` : "";
      }
      case "deezer": {
        const match = parsed.pathname.match(/\/track\/(\d+)/);
        const id = match?.[1] || cleanId;
        return id ? `https://widget.deezer.com/widget/dark/track/${encodeURIComponent(id)}` : "";
      }
      default:
        return "";
    }
  } catch {
    if (providerId === "youtube-music" && /^[A-Za-z0-9_-]{11}$/.test(cleanId)) {
      return `https://www.youtube-nocookie.com/embed/${cleanId}?autoplay=1&rel=0&playsinline=1`;
    }
    if (providerId === "spotify" && /^[A-Za-z0-9]+$/.test(cleanId)) {
      return `https://open.spotify.com/embed/track/${encodeURIComponent(cleanId)}?utm_source=generator&theme=0`;
    }
    if (providerId === "tidal" && /^\d+$/.test(cleanId)) {
      return `https://embed.tidal.com/tracks/${cleanId}`;
    }
    if ((providerId === "beatport" || providerId === "beatsource") && /^\d+$/.test(cleanId)) {
      return `https://embed.${providerId}.com/?id=${cleanId}&type=track`;
    }
    if (providerId === "deezer" && /^\d+$/.test(cleanId)) {
      return `https://widget.deezer.com/widget/dark/track/${cleanId}`;
    }
    return "";
  }
}

export function parseCommercialSearchPayload(providerId: string, body: string): QueueTrack[] {
  const out: QueueTrack[] = [];
  const seen = new Set<string>();

  const pushTrack = (raw: {
    id?: string | number;
    title?: string;
    name?: string;
    mix_name?: string;
    artist?: string;
    artists?: Array<{ name?: string }> | string;
    user?: { username?: string };
    duration?: number;
    duration_ms?: number;
    durationSec?: number;
    length_ms?: number;
    url?: string;
    permalink_url?: string;
    external_urls?: { spotify?: string };
  }): void => {
    const id = String(raw.id ?? "").trim();
    const baseTitle = String(raw.title ?? raw.name ?? "").trim();
    if (!id || !baseTitle || seen.has(id)) return;
    seen.add(id);
    const title = raw.mix_name && !baseTitle.includes(raw.mix_name) ? `${baseTitle} (${raw.mix_name})` : baseTitle;
    let artist = "Unknown artist";
    if (typeof raw.artist === "string" && raw.artist.trim()) {
      artist = raw.artist.trim();
    } else if (Array.isArray(raw.artists) && raw.artists.length > 0) {
      artist = raw.artists.map((a) => a?.name ?? "").filter(Boolean).join(", ") || artist;
    } else if (raw.user?.username) {
      artist = raw.user.username;
    }
    const durationSec =
      typeof raw.durationSec === "number"
        ? raw.durationSec
        : typeof raw.duration_ms === "number"
          ? Math.round(raw.duration_ms / 1000)
          : typeof raw.length_ms === "number"
            ? Math.round(raw.length_ms / 1000)
            : typeof raw.duration === "number"
              ? raw.duration > 36000
                ? Math.round(raw.duration / 1000)
                : Math.round(raw.duration)
              : 0;
    const defaultUrls: Record<string, string> = {
      spotify: `https://open.spotify.com/track/${encodeURIComponent(id)}`,
      tidal: `https://listen.tidal.com/track/${encodeURIComponent(id)}`,
      beatport: `https://www.beatport.com/track/-/${encodeURIComponent(id)}`,
      beatsource: `https://www.beatsource.com/track/-/${encodeURIComponent(id)}`,
      soundcloud: `https://soundcloud.com/tracks/${encodeURIComponent(id)}`,
      "apple-music": `https://music.apple.com/song/${encodeURIComponent(id)}`,
      deezer: `https://www.deezer.com/track/${encodeURIComponent(id)}`,
      "youtube-music": `https://music.youtube.com/watch?v=${encodeURIComponent(id)}`,
    };
    const url =
      raw.url ||
      raw.permalink_url ||
      raw.external_urls?.spotify ||
      defaultUrls[providerId] ||
      `https://open.opendeck.local/${providerId}/${encodeURIComponent(id)}`;
    out.push({
      id,
      title,
      artist,
      durationSec,
      provider: providerId,
      url,
    });
  };

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (Array.isArray(parsed.tracks)) {
      for (const item of parsed.tracks) pushTrack(item as Parameters<typeof pushTrack>[0]);
    } else if (parsed.tracks && typeof parsed.tracks === "object") {
      const nested = parsed.tracks as { items?: unknown[]; data?: unknown[] };
      for (const item of nested.items ?? nested.data ?? []) {
        pushTrack(item as Parameters<typeof pushTrack>[0]);
      }
    }
    if (Array.isArray(parsed.items)) {
      for (const item of parsed.items) pushTrack(item as Parameters<typeof pushTrack>[0]);
    }
    if (Array.isArray(parsed.results)) {
      for (const item of parsed.results) pushTrack(item as Parameters<typeof pushTrack>[0]);
    }
    if (Array.isArray(parsed.data)) {
      for (const item of parsed.data) {
        const rec = item as Record<string, unknown>;
        if (rec.attributes && typeof rec.attributes === "object") {
          const attr = rec.attributes as Record<string, unknown>;
          pushTrack({
            id: String(rec.id ?? ""),
            title: String(attr.name ?? ""),
            artist: String(attr.artistName ?? ""),
            duration_ms: Number(attr.durationInMillis ?? 0),
            url: String(attr.url ?? ""),
          });
        } else {
          pushTrack(rec as Parameters<typeof pushTrack>[0]);
        }
      }
    }
    if (parsed.results && typeof parsed.results === "object" && !Array.isArray(parsed.results)) {
      const songs = (parsed.results as { songs?: { data?: unknown[] } }).songs?.data ?? [];
      for (const item of songs) {
        const rec = item as Record<string, unknown>;
        const attr = (rec.attributes ?? {}) as Record<string, unknown>;
        pushTrack({
          id: String(rec.id ?? ""),
          title: String(attr.name ?? ""),
          artist: String(attr.artistName ?? ""),
          duration_ms: Number(attr.durationInMillis ?? 0),
          url: String(attr.url ?? ""),
        });
      }
    }
  } catch {
    const nextDataMatch = body.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextDataMatch?.[1]) {
      return parseCommercialSearchPayload(providerId, nextDataMatch[1]);
    }
  }

  return out;
}

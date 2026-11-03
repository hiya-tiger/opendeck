// OAuth 2.0 / 2.1 helpers for the stream sources: PKCE (RFC 7636), the
// authorization URL, token requests and a token manager that refreshes.
// Pure TypeScript with injected fetch/storage, so the main process uses it and
// tests run it without Electron. Secrets never leave the main process.

import type { OAuthEndpoints } from "./source.ts";

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    // A predictable verifier would defeat PKCE; refuse instead of faking it.
    throw new Error("No secure random source available for PKCE");
  }
  globalThis.crypto.getRandomValues(out);
  return out;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest !== "function") {
    throw new Error("SHA-256 is not available; cannot build an S256 PKCE challenge");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(randomBytes(32));
  return { verifier, challenge: await pkceChallenge(verifier) };
}

export function randomState(): string {
  return base64UrlEncode(randomBytes(16));
}

export function buildAuthorizeUrl(
  endpoints: OAuthEndpoints,
  opts: { clientId: string; redirectUri: string; codeChallenge: string; state: string },
): string {
  const url = new URL(endpoints.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  if (endpoints.scopes.length) url.searchParams.set("scope", endpoints.scopes.join(" "));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("state", opts.state);
  return url.toString();
}

export interface ClientCredentials {
  clientId: string;
  clientSecret?: string;
}

export type TokenGrant =
  | { grant: "authorization_code"; code: string; redirectUri: string; codeVerifier: string }
  | { grant: "refresh_token"; refreshToken: string }
  | { grant: "client_credentials" };

export interface TokenHttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

function basicAuth(id: string, secret: string): string {
  const raw = `${id}:${secret}`;
  const b64 = typeof btoa === "function" ? btoa(raw) : Buffer.from(raw).toString("base64");
  return `Basic ${b64}`;
}

export function buildTokenRequest(endpoints: OAuthEndpoints, client: ClientCredentials, grant: TokenGrant): TokenHttpRequest {
  const form = new URLSearchParams();
  form.set("grant_type", grant.grant);
  if (grant.grant === "authorization_code") {
    form.set("code", grant.code);
    form.set("redirect_uri", grant.redirectUri);
    form.set("code_verifier", grant.codeVerifier);
  } else if (grant.grant === "refresh_token") {
    form.set("refresh_token", grant.refreshToken);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  // client_credentials always needs the secret; SoundCloud and TIDAL take it
  // via HTTP Basic only for that grant.
  const useBasic =
    Boolean(client.clientSecret) && (endpoints.clientAuth === "basic" || grant.grant === "client_credentials");
  if (useBasic) {
    headers.Authorization = basicAuth(client.clientId, client.clientSecret!);
  } else {
    form.set("client_id", client.clientId);
    if (client.clientSecret && endpoints.clientAuth === "body") form.set("client_secret", client.clientSecret);
  }
  return { url: endpoints.tokenUrl, method: "POST", headers, body: form.toString() };
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  scope?: string;
}

export function parseTokenResponse(status: number, body: string, now = Date.now()): TokenSet {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error(`token endpoint returned HTTP ${status} without JSON`);
  }
  if (status < 200 || status >= 300 || typeof json.access_token !== "string" || !json.access_token) {
    const reason = typeof json.error_description === "string" ? json.error_description : typeof json.error === "string" ? json.error : `HTTP ${status}`;
    throw new Error(`token request refused: ${reason}`);
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : Number(json.expires_in ?? 3600);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expiresAt: now + Math.max(0, (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000),
    scope: typeof json.scope === "string" ? json.scope : undefined,
  };
}

export function isExpired(token: TokenSet | undefined, now = Date.now(), skewMs = 60_000): boolean {
  return !token || token.expiresAt - skewMs <= now;
}

/** Parse the loopback redirect and check state (CSRF). */
export function parseRedirect(url: string, expectedState: string): { code: string } {
  const parsed = new URL(url);
  const error = parsed.searchParams.get("error");
  if (error) throw new Error(`sign-in refused: ${parsed.searchParams.get("error_description") ?? error}`);
  if (parsed.searchParams.get("state") !== expectedState) throw new Error("sign-in state mismatch; try again");
  const code = parsed.searchParams.get("code");
  if (!code) throw new Error("sign-in returned no authorization code");
  return { code };
}

export interface StoredSourceSecrets {
  clientId?: string;
  clientSecret?: string;
  app?: TokenSet;
  user?: TokenSet;
}

export interface SecretStore {
  load(source: string): StoredSourceSecrets;
  save(source: string, value: StoredSourceSecrets): void;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * Hands out a valid access token per source: refreshes user tokens (refresh
 * tokens may be single-use, so the new one is stored) and mints app tokens with
 * client_credentials when the source supports it.
 */
export class TokenManager {
  private readonly store: SecretStore;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(store: SecretStore, fetchImpl: FetchLike, now: () => number = Date.now) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  credentials(source: string): ClientCredentials | null {
    const s = this.store.load(source);
    return s.clientId ? { clientId: s.clientId, clientSecret: s.clientSecret } : null;
  }

  private async exchange(source: string, endpoints: OAuthEndpoints, grant: TokenGrant): Promise<TokenSet> {
    const client = this.credentials(source);
    if (!client) throw new Error("missing-credentials");
    const req = buildTokenRequest(endpoints, client, grant);
    const res = await this.fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
    return parseTokenResponse(res.status, await res.text(), this.now());
  }

  async completeAuthorization(source: string, endpoints: OAuthEndpoints, code: string, redirectUri: string, codeVerifier: string): Promise<TokenSet> {
    const token = await this.exchange(source, endpoints, { grant: "authorization_code", code, redirectUri, codeVerifier });
    this.store.save(source, { ...this.store.load(source), user: token });
    return token;
  }

  async userToken(source: string, endpoints: OAuthEndpoints): Promise<string | null> {
    const s = this.store.load(source);
    if (!s.user) return null;
    if (!isExpired(s.user, this.now())) return s.user.accessToken;
    if (!s.user.refreshToken) return null;
    try {
      const fresh = await this.exchange(source, endpoints, { grant: "refresh_token", refreshToken: s.user.refreshToken });
      this.store.save(source, { ...this.store.load(source), user: { ...fresh, refreshToken: fresh.refreshToken ?? s.user.refreshToken } });
      return fresh.accessToken;
    } catch {
      const { user: _dropped, ...rest } = this.store.load(source);
      this.store.save(source, rest);
      return null;
    }
  }

  async appToken(source: string, endpoints: OAuthEndpoints): Promise<string | null> {
    if (!endpoints.clientCredentials) return null;
    const s = this.store.load(source);
    if (!s.clientId || !s.clientSecret) return null;
    if (!isExpired(s.app, this.now())) return s.app!.accessToken;
    if (s.app?.refreshToken) {
      try {
        const fresh = await this.exchange(source, endpoints, { grant: "refresh_token", refreshToken: s.app.refreshToken });
        this.store.save(source, { ...this.store.load(source), app: fresh });
        return fresh.accessToken;
      } catch {
        /* fall through to a new client_credentials token */
      }
    }
    const token = await this.exchange(source, endpoints, { grant: "client_credentials" });
    this.store.save(source, { ...this.store.load(source), app: token });
    return token.accessToken;
  }

  signOut(source: string): void {
    const { user: _u, ...rest } = this.store.load(source);
    this.store.save(source, rest);
  }
}

/** In-memory SecretStore (tests, and the fallback when no disk store exists). */
export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, StoredSourceSecrets>();
  load(source: string): StoredSourceSecrets {
    return { ...(this.map.get(source) ?? {}) };
  }
  save(source: string, value: StoredSourceSecrets): void {
    this.map.set(source, { ...value });
  }
}

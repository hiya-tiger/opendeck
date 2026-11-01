// Main-process side of the stream sources (docs/decisions.md D42).
//
// Holds the partner keys and OAuth tokens (encrypted with safeStorage when the
// OS offers it), attaches them to API calls the renderer's adapters build, runs
// the PKCE sign-in through the system browser with a loopback redirect
// (RFC 8252), and fetches decodable audio for the deck path. It never opens a
// player window, never reads a service's cookies and never talks to a DRM
// licence server.

import { app, ipcMain, safeStorage, shell } from "electron";
import * as electronModule from "electron";
import http from "node:http";
import path from "node:path";
import { promises as fsp, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createDefaultSources, NO_HTTP } from "../renderer/streaming/index.ts";
import {
  buildAuthorizeUrl,
  generatePkcePair,
  parseRedirect,
  randomState,
  TokenManager,
  type FetchLike,
  type SecretStore,
  type StoredSourceSecrets,
} from "../renderer/streaming/oauth.ts";
import { fetchHlsAudio, HlsError } from "../renderer/streaming/hls.ts";
import { hostAllowed, type CredentialStatus, type PlaybackPlan, type StreamRequest, type StreamResponse, type StreamSource } from "../renderer/streaming/source.ts";

export const REDIRECT_PORT = 43827;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

class FileSecretStore implements SecretStore {
  private cache: Record<string, StoredSourceSecrets> | null = null;
  constructor(private readonly file: string) {}

  private read(): Record<string, StoredSourceSecrets> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { enc?: boolean; data?: string; plain?: Record<string, StoredSourceSecrets> };
      if (raw.enc && raw.data && safeStorage.isEncryptionAvailable()) {
        this.cache = JSON.parse(safeStorage.decryptString(Buffer.from(raw.data, "base64"))) as Record<string, StoredSourceSecrets>;
      } else {
        this.cache = raw.plain ?? {};
      }
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  load(source: string): StoredSourceSecrets {
    return { ...(this.read()[source] ?? {}) };
  }

  save(source: string, value: StoredSourceSecrets): void {
    const all = { ...this.read(), [source]: { ...value } };
    this.cache = all;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const payload = safeStorage.isEncryptionAvailable()
      ? { enc: true, data: safeStorage.encryptString(JSON.stringify(all)).toString("base64") }
      : { enc: false, plain: all };
    writeFileSync(this.file, JSON.stringify(payload), { mode: 0o600 });
  }
}

const fetchLike: FetchLike = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { status: res.status, text: () => res.text() };
};

export function isWidevineBuild(): boolean {
  // castlabs ECS exposes `components` (the Widevine CDM installer); stock Electron does not.
  return typeof (electronModule as unknown as { components?: { whenReady?: unknown } }).components?.whenReady === "function";
}

export function setupStreaming(): void {
  const registry = createDefaultSources(NO_HTTP);
  const store = new FileSecretStore(path.join(app.getPath("userData"), "stream-credentials.json"));
  const tokens = new TokenManager(store, fetchLike);
  const pending = new Map<string, Promise<unknown>>();

  const sourceOf = (id: unknown): StreamSource => {
    const source = typeof id === "string" ? registry.get(id) : undefined;
    if (!source) throw new Error("unknown stream source");
    return source;
  };

  const status = (source: StreamSource): CredentialStatus => {
    const s = store.load(source.id);
    return {
      source: source.id,
      hasClientId: Boolean(s.clientId),
      hasClientSecret: Boolean(s.clientSecret),
      userSignedIn: Boolean(s.user),
      userExpiresAt: s.user?.expiresAt ?? null,
      userRefreshable: Boolean(s.user?.refreshToken),
    };
  };

  const tokenFor = async (source: StreamSource, auth: StreamRequest["auth"]): Promise<{ header?: string; error?: StreamResponse["error"] }> => {
    if (auth === "none" || !source.oauth) return {};
    const s = store.load(source.id);
    if (!s.clientId) return { error: "missing-credentials" };
    let token: string | null = null;
    if (auth === "user" || auth === "app-or-user") token = await tokens.userToken(source.id, source.oauth);
    if (!token && (auth === "app" || auth === "app-or-user")) {
      if (!s.clientSecret || !source.oauth.clientCredentials) {
        return { error: source.oauth.clientCredentials ? "missing-credentials" : "auth-required" };
      }
      token = await tokens.appToken(source.id, source.oauth);
    }
    if (!token) return { error: "auth-required" };
    return { header: `${source.oauth.tokenType} ${token}` };
  };

  ipcMain.handle("stream:status", () => ({
    sources: registry.list().map(status),
    widevineBuild: isWidevineBuild(),
    redirectUri: REDIRECT_URI,
  }));

  ipcMain.handle("stream:set-key", (_e, id: string, clientId: string, clientSecret?: string) => {
    const source = sourceOf(id);
    const cid = String(clientId ?? "").trim();
    const secret = String(clientSecret ?? "").trim();
    if (!cid || cid.length > 512 || /\s/.test(cid)) return { ok: false, error: "Client id looks wrong." };
    const prev = store.load(source.id);
    // A different app invalidates every token minted for the old one.
    const next: StoredSourceSecrets = prev.clientId === cid ? { ...prev } : {};
    next.clientId = cid;
    if (secret) next.clientSecret = secret;
    delete next.app;
    store.save(source.id, next);
    return { ok: true, status: status(source) };
  });

  ipcMain.handle("stream:clear-key", (_e, id: string) => {
    const source = sourceOf(id);
    store.save(source.id, {});
    return { ok: true, status: status(source) };
  });

  ipcMain.handle("stream:sign-in", async (_e, id: string) => {
    const source = sourceOf(id);
    if (!source.oauth || !source.capabilities.userAuth) return { ok: false, error: `${source.name} has no sign-in.` };
    const client = tokens.credentials(source.id);
    if (!client) return { ok: false, error: `${source.name}: needs partner API key.` };
    if (pending.has("sign-in")) return { ok: false, error: "Another sign-in is already waiting in your browser." };
    const oauth = source.oauth;
    const run = (async () => {
      const { verifier, challenge } = await generatePkcePair();
      const state = randomState();
      const authUrl = buildAuthorizeUrl(oauth, { clientId: client.clientId, redirectUri: REDIRECT_URI, codeChallenge: challenge, state });
      const code = await new Promise<string>((resolve, reject) => {
        const server = http.createServer((req, res) => {
          const url = new URL(req.url ?? "/", REDIRECT_URI);
          if (url.pathname !== "/callback") {
            res.writeHead(404).end();
            return;
          }
          try {
            const { code: c } = parseRedirect(url.toString(), state);
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<!doctype html><title>OpenDecks</title><p>Signed in. You can close this tab and go back to OpenDecks.</p>");
            finish(null, c);
          } catch (error) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end("<!doctype html><title>OpenDecks</title><p>Sign-in failed. Go back to OpenDecks and try again.</p>");
            finish(error as Error);
          }
        });
        const timer = setTimeout(() => finish(new Error("Sign-in timed out after 5 minutes.")), SIGN_IN_TIMEOUT_MS);
        const finish = (error: Error | null, value?: string): void => {
          clearTimeout(timer);
          server.close();
          if (error) reject(error);
          else resolve(value!);
        };
        server.on("error", (error) => finish(error));
        server.listen(REDIRECT_PORT, "127.0.0.1", () => {
          void shell.openExternal(authUrl);
        });
      });
      await tokens.completeAuthorization(source.id, oauth, code, REDIRECT_URI, verifier);
    })();
    pending.set("sign-in", run);
    try {
      await run;
      return { ok: true, status: status(source) };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    } finally {
      pending.delete("sign-in");
    }
  });

  ipcMain.handle("stream:sign-out", async (_e, id: string) => {
    const source = sourceOf(id);
    if (source.oauth?.revokeUrl) {
      try {
        const token = await tokens.userToken(source.id, source.oauth);
        if (token) {
          await fetch(source.oauth.revokeUrl, { method: "POST", headers: { Authorization: `${source.oauth.tokenType} ${token}` } });
        }
      } catch {
        /* revocation is best effort; the local token is dropped either way */
      }
    }
    tokens.signOut(source.id);
    return { ok: true, status: status(source) };
  });

  ipcMain.handle("stream:request", async (_e, id: string, req: StreamRequest): Promise<StreamResponse> => {
    const source = sourceOf(id);
    if (!req || typeof req.url !== "string" || !hostAllowed(req.url, source.apiHosts)) {
      return { status: 0, body: "", error: "host-not-allowed", detail: "API host not allowed for this source" };
    }
    try {
      const auth = await tokenFor(source, req.auth);
      if (auth.error) return { status: 0, body: "", error: auth.error };
      const headers: Record<string, string> = { Accept: req.accept ?? "application/json" };
      if (auth.header) headers.Authorization = auth.header;
      const res = await fetch(req.url, { method: req.method ?? "GET", headers });
      return { status: res.status, body: await res.text() };
    } catch (error) {
      return { status: 0, body: "", error: "network", detail: (error as Error).message };
    }
  });

  ipcMain.handle("stream:audio", async (_e, id: string, plan: Extract<PlaybackPlan, { kind: "decodable" }>) => {
    const source = sourceOf(id);
    const allowed = (url: string): boolean => hostAllowed(url, source.apiHosts, source.audioHostSuffixes);
    if (!plan || plan.kind !== "decodable" || !allowed(plan.url)) return { ok: false, error: "stream host not allowed" };
    try {
      const auth = await tokenFor(source, plan.auth);
      if (auth.error) return { ok: false, error: auth.error === "missing-credentials" ? "needs partner API key" : "sign in first" };
      const fetchBytes = async (url: string): Promise<{ status: number; bytes: Uint8Array; type: string }> => {
        if (!allowed(url)) throw new Error(`stream host not allowed: ${new URL(url).hostname}`);
        // The token goes only to the source's own API hosts; fetch drops it on
        // cross-origin redirects to the CDN.
        const headers: Record<string, string> = {};
        if (auth.header && hostAllowed(url, source.apiHosts)) headers.Authorization = auth.header;
        const res = await fetch(url, { headers });
        if (res.url && !allowed(res.url)) throw new Error(`redirected to a host that is not allowed: ${new URL(res.url).hostname}`);
        return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "" };
      };
      if (plan.container === "hls") {
        const bytes = await fetchHlsAudio(plan.url, fetchBytes);
        return { ok: true, bytes, type: plan.mimeHint ?? "" };
      }
      const res = await fetchBytes(plan.url);
      if (res.status < 200 || res.status >= 300) return { ok: false, error: `audio HTTP ${res.status}` };
      if (/mpegurl/i.test(res.type)) {
        return { ok: true, bytes: await fetchHlsAudio(plan.url, fetchBytes), type: plan.mimeHint ?? "" };
      }
      return { ok: true, bytes: res.bytes, type: res.type || plan.mimeHint || "" };
    } catch (error) {
      if (error instanceof HlsError && error.code === "encrypted") {
        return { ok: false, error: "the stream is encrypted, and OpenDecks doesn't decrypt service streams. Use the service's own player instead." };
      }
      return { ok: false, error: (error as Error).message };
    }
  });

  // Keep the file around for debugging permissions on first run.
  void fsp.mkdir(app.getPath("userData"), { recursive: true }).catch(() => undefined);
}

import test from "node:test";
import assert from "node:assert/strict";
import {
  checkResponse,
  hostAllowed,
  isoDurationToSec,
  parseStreamTrackKey,
  standardAuthStatus,
  streamTrackKey,
  StreamSourceError,
  type CredentialStatus,
  type StreamHttp,
  type StreamRequest,
  type StreamResponse,
  type StreamTrack,
} from "../src/renderer/streaming/source.ts";
import {
  buildTokenRequest,
  isExpired,
  MemorySecretStore,
  parseRedirect,
  parseTokenResponse,
  pkceChallenge,
  TokenManager,
  type FetchLike,
} from "../src/renderer/streaming/oauth.ts";
import { fetchHlsAudio, HlsError, parseMasterPlaylist, parseMediaPlaylist } from "../src/renderer/streaming/hls.ts";
import { createBeatportSource, beatportOAuth } from "../src/renderer/streaming/adapters/beatport.ts";
import { createSoundcloudSource, pickSoundcloudStream, SOUNDCLOUD_OAUTH } from "../src/renderer/streaming/adapters/soundcloud.ts";
import { createTidalSource, tidalPlanFromManifest, TIDAL_OAUTH } from "../src/renderer/streaming/adapters/tidal.ts";
import { createWebPlayerSource } from "../src/renderer/streaming/adapters/web-player.ts";
import { libraryFieldsFor, loadStreamTrack, safeFileName } from "../src/renderer/streaming/loader.ts";
import { monitorOnlyLabel } from "../src/renderer/streaming/embed.ts";

class FakeHttp implements StreamHttp {
  calls: StreamRequest[] = [];
  routes: Array<[RegExp, StreamResponse | ((req: StreamRequest) => StreamResponse)]> = [];
  on(pattern: RegExp, res: StreamResponse | ((req: StreamRequest) => StreamResponse)): this {
    this.routes.push([pattern, res]);
    return this;
  }
  async request(req: StreamRequest): Promise<StreamResponse> {
    this.calls.push(req);
    for (const [pattern, res] of this.routes) if (pattern.test(req.url)) return typeof res === "function" ? res(req) : res;
    return { status: 404, body: "{}" };
  }
}

const json = (status: number, body: unknown): StreamResponse => ({ status, body: JSON.stringify(body) });
const creds = (over: Partial<CredentialStatus> = {}): CredentialStatus => ({
  source: "x",
  hasClientId: true,
  hasClientSecret: true,
  userSignedIn: false,
  userExpiresAt: null,
  userRefreshable: false,
  ...over,
});
const scTrack = (over: Partial<StreamTrack> = {}): StreamTrack => ({
  source: "soundcloud",
  id: "soundcloud:tracks:1",
  title: "Glue",
  artist: "bicep",
  durationSec: 269,
  access: "full",
  permalink: "https://soundcloud.com/bicep/glue",
  ...over,
});

/* ------------------------------------------------------------ auth status */

test("auth status says 'needs partner API key' until a key is stored, never signed in", () => {
  const caps = { search: true, browse: true, decodable: true, embed: false, userAuth: true, userAuthRequired: true };
  const missing = standardAuthStatus(undefined, caps, "Apply to the partner programme.");
  assert.equal(missing.state, "needs-partner-key");
  assert.match(missing.message, /^Needs partner API key\. Apply/);
  assert.equal(standardAuthStatus(creds({ hasClientId: false }), caps, "").state, "needs-partner-key");
  assert.equal(standardAuthStatus(creds(), caps, "").state, "signed-out");
  assert.equal(standardAuthStatus(creds(), { ...caps, userAuthRequired: false }, "").state, "app-only");
  assert.equal(standardAuthStatus(creds({ userSignedIn: true, userExpiresAt: Date.now() + 60_000 }), caps, "").state, "signed-in");
  assert.equal(standardAuthStatus(creds({ userSignedIn: true, userExpiresAt: 1 }), caps, "", 10).state, "expired");
  assert.equal(standardAuthStatus(creds({ userSignedIn: true, userExpiresAt: 1, userRefreshable: true }), caps, "", 10).state, "signed-in");
});

test("SoundCloud and TIDAL need the client secret too", () => {
  const sc = createSoundcloudSource(new FakeHttp());
  assert.equal(sc.authStatus(creds({ hasClientSecret: false })).state, "needs-partner-key");
  assert.equal(sc.authStatus(creds()).state, "app-only");
  const tidal = createTidalSource(new FakeHttp());
  assert.equal(tidal.authStatus(creds({ hasClientSecret: false })).state, "needs-partner-key");
  assert.equal(createBeatportSource("beatport", new FakeHttp()).authStatus(creds({ hasClientSecret: false })).state, "signed-out");
});

test("transport refusals and HTTP errors become typed errors, never empty success", () => {
  assert.throws(() => checkResponse("Beatport", { status: 0, body: "", error: "missing-credentials" }), (e: unknown) => e instanceof StreamSourceError && e.code === "missing-credentials" && /needs partner API key/.test(e.message));
  assert.throws(() => checkResponse("X", { status: 0, body: "", error: "auth-required" }), (e: unknown) => (e as StreamSourceError).code === "auth-required");
  assert.throws(() => checkResponse("X", { status: 401, body: "{}" }), (e: unknown) => (e as StreamSourceError).code === "auth-required");
  assert.throws(() => checkResponse("X", { status: 403, body: "{}" }), (e: unknown) => (e as StreamSourceError).code === "forbidden");
  assert.throws(() => checkResponse("X", { status: 429, body: "{}" }), (e: unknown) => (e as StreamSourceError).code === "rate-limited");
  assert.throws(() => checkResponse("X", { status: 500, body: "{}" }), (e: unknown) => (e as StreamSourceError).status === 500);
  assert.throws(() => checkResponse("X", { status: 200, body: "<html>" }), (e: unknown) => (e as StreamSourceError).code === "parse");
  assert.deepEqual(checkResponse("X", json(200, { a: 1 })), { a: 1 });
});

test("search with no key surfaces 'needs partner API key' from every partner source", async () => {
  const refuse: StreamHttp = { request: async () => ({ status: 0, body: "", error: "missing-credentials" }) };
  for (const source of [createBeatportSource("beatport", refuse), createBeatportSource("beatsource", refuse), createTidalSource(refuse), createSoundcloudSource(refuse)]) {
    await assert.rejects(source.search("house"), /needs partner API key/, source.id);
  }
});

/* ------------------------------------------------------------------ OAuth */

test("PKCE S256 challenge matches the RFC 7636 test vector", async () => {
  assert.equal(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("token requests use Basic for client_credentials and body auth for code exchange", () => {
  const cc = buildTokenRequest(SOUNDCLOUD_OAUTH, { clientId: "id", clientSecret: "sec" }, { grant: "client_credentials" });
  assert.equal(cc.url, "https://secure.soundcloud.com/oauth/token");
  assert.equal(cc.headers.Authorization, `Basic ${Buffer.from("id:sec").toString("base64")}`);
  assert.equal(new URLSearchParams(cc.body).get("grant_type"), "client_credentials");
  assert.equal(new URLSearchParams(cc.body).get("client_secret"), null);

  const code = buildTokenRequest(SOUNDCLOUD_OAUTH, { clientId: "id", clientSecret: "sec" }, { grant: "authorization_code", code: "c1", redirectUri: "http://127.0.0.1:43827/callback", codeVerifier: "v1" });
  const form = new URLSearchParams(code.body);
  assert.equal(code.headers.Authorization, undefined);
  assert.equal(form.get("client_id"), "id");
  assert.equal(form.get("client_secret"), "sec");
  assert.equal(form.get("code_verifier"), "v1");
  assert.equal(form.get("redirect_uri"), "http://127.0.0.1:43827/callback");

  const bp = buildTokenRequest(beatportOAuth("beatport"), { clientId: "bp" }, { grant: "refresh_token", refreshToken: "r1" });
  assert.equal(bp.url, "https://api.beatport.com/v4/auth/o/token/");
  assert.equal(new URLSearchParams(bp.body).get("refresh_token"), "r1");
  assert.equal(new URLSearchParams(bp.body).get("client_id"), "bp");
  assert.equal(TIDAL_OAUTH.tokenUrl, "https://auth.tidal.com/v1/oauth2/token");
});

test("token responses parse expiry and refuse errors", () => {
  const t = parseTokenResponse(200, JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }), 1_000);
  assert.deepEqual(t, { accessToken: "a", refreshToken: "r", expiresAt: 3_601_000, scope: undefined });
  assert.equal(isExpired(t, 3_550_000), true); // inside the 60 s skew
  assert.equal(isExpired(t, 1_000_000), false);
  assert.throws(() => parseTokenResponse(400, JSON.stringify({ error: "invalid_grant", error_description: "bad code" })), /bad code/);
  assert.throws(() => parseTokenResponse(200, JSON.stringify({ token_type: "bearer" })), /refused/);
  assert.throws(() => parseTokenResponse(502, "<html>"), /without JSON/);
});

test("loopback redirect checks state and surfaces provider errors", () => {
  assert.deepEqual(parseRedirect("http://127.0.0.1:43827/callback?code=abc&state=s1", "s1"), { code: "abc" });
  assert.throws(() => parseRedirect("http://127.0.0.1:43827/callback?code=abc&state=evil", "s1"), /state mismatch/);
  assert.throws(() => parseRedirect("http://127.0.0.1:43827/callback?error=access_denied&state=s1", "s1"), /access_denied/);
  assert.throws(() => parseRedirect("http://127.0.0.1:43827/callback?state=s1", "s1"), /no authorization code/);
});

test("token manager mints app tokens, refreshes user tokens and drops dead ones", async () => {
  let now = 1_000_000;
  const store = new MemorySecretStore();
  const seen: string[] = [];
  let refreshOk = true;
  const fetchImpl: FetchLike = async (_url, init) => {
    const form = new URLSearchParams(init.body);
    seen.push(form.get("grant_type")!);
    if (form.get("grant_type") === "refresh_token" && !refreshOk) return { status: 400, text: async () => JSON.stringify({ error: "invalid_grant" }) };
    const n = seen.length;
    return { status: 200, text: async () => JSON.stringify({ access_token: `tok${n}`, refresh_token: `ref${n}`, expires_in: 3600 }) };
  };
  const tm = new TokenManager(store, fetchImpl, () => now);
  assert.equal(await tm.appToken("soundcloud", SOUNDCLOUD_OAUTH), null); // no key stored: no fake token
  store.save("soundcloud", { clientId: "id", clientSecret: "sec" });
  assert.equal(await tm.appToken("soundcloud", SOUNDCLOUD_OAUTH), "tok1");
  assert.equal(await tm.appToken("soundcloud", SOUNDCLOUD_OAUTH), "tok1"); // cached
  await tm.completeAuthorization("soundcloud", SOUNDCLOUD_OAUTH, "code", "http://127.0.0.1:43827/callback", "ver");
  assert.equal(await tm.userToken("soundcloud", SOUNDCLOUD_OAUTH), "tok2");
  now += 2 * 3600 * 1000;
  assert.equal(await tm.userToken("soundcloud", SOUNDCLOUD_OAUTH), "tok3"); // refreshed
  assert.equal(store.load("soundcloud").user?.refreshToken, "ref3"); // single-use refresh token rotated
  now += 2 * 3600 * 1000;
  refreshOk = false;
  assert.equal(await tm.userToken("soundcloud", SOUNDCLOUD_OAUTH), null);
  assert.equal(store.load("soundcloud").user, undefined);
  assert.deepEqual(seen, ["client_credentials", "authorization_code", "refresh_token", "refresh_token"]);
  // Beatport has no client_credentials grant: no app token, only user tokens.
  store.save("beatport", { clientId: "bp", clientSecret: "x" });
  assert.equal(await tm.appToken("beatport", beatportOAuth("beatport")), null);
});

/* -------------------------------------------------------------------- HLS */

test("HLS parsing picks the best variant and flags encryption", () => {
  const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS=\"mp4a.40.5\"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=160000\nhigh/index.m3u8\n";
  const variants = parseMasterPlaylist(master, "https://cdn.example/a/master.m3u8");
  assert.deepEqual(variants.map((v) => v.uri), ["https://cdn.example/a/low.m3u8", "https://cdn.example/a/high/index.m3u8"]);
  assert.equal(variants[0].codecs, "mp4a.40.5");
  const media = parseMediaPlaylist("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:10,\nseg1.m4s\n#EXTINF:10,\nseg2.m4s\n#EXT-X-ENDLIST\n", "https://cdn.example/a/high/index.m3u8");
  assert.equal(media.initUri, "https://cdn.example/a/high/init.mp4");
  assert.equal(media.segments.length, 2);
  assert.equal(media.encrypted, false);
  assert.equal(parseMediaPlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\nseg.ts\n", "https://x/").encrypted, true);
  assert.equal(parseMediaPlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\nseg.ts\n", "https://x/").encrypted, false);
  assert.throws(() => parseMasterPlaylist("#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES\n", "https://x/"), HlsError);
  assert.throws(() => parseMediaPlaylist("<html>", "https://x/"), HlsError);
});

test("HLS fetch concatenates plain segments and refuses encrypted or live streams", async () => {
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    "https://cdn/m.m3u8": enc.encode("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n"),
    "https://cdn/v.m3u8": enc.encode("#EXTM3U\n#EXTINF:1,\na.mp3\n#EXTINF:1,\nb.mp3\n#EXT-X-ENDLIST\n"),
    "https://cdn/a.mp3": new Uint8Array([1, 2]),
    "https://cdn/b.mp3": new Uint8Array([3]),
    "https://cdn/enc.m3u8": enc.encode("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://cdn/key\"\n#EXTINF:1,\na.mp3\n#EXT-X-ENDLIST\n"),
    "https://cdn/live.m3u8": enc.encode("#EXTM3U\n#EXTINF:1,\na.mp3\n"),
  };
  const fetched: string[] = [];
  const fetchBytes = async (url: string) => {
    fetched.push(url);
    return files[url] ? { status: 200, bytes: files[url] } : { status: 404, bytes: new Uint8Array() };
  };
  assert.deepEqual(Array.from(await fetchHlsAudio("https://cdn/m.m3u8", fetchBytes)), [1, 2, 3]);
  await assert.rejects(fetchHlsAudio("https://cdn/enc.m3u8", fetchBytes), (e: unknown) => (e as HlsError).code === "encrypted");
  assert.ok(!fetched.includes("https://cdn/key"), "never fetches a decryption key");
  await assert.rejects(fetchHlsAudio("https://cdn/live.m3u8", fetchBytes), (e: unknown) => (e as HlsError).code === "live");
  await assert.rejects(fetchHlsAudio("https://cdn/missing.m3u8", fetchBytes), (e: unknown) => (e as HlsError).code === "fetch");
});

/* --------------------------------------------------------------- Beatport */

test("Beatport LINK search, browse and stream resolve use the v4 API with the user's token", async () => {
  const http = new FakeHttp()
    .on(/\/catalog\/search\//, json(200, { tracks: [{ id: 1, name: "Glue", mix_name: "Original Mix", artists: [{ name: "Bicep" }], length_ms: 269000, bpm: 124, key: { name: "F Minor" }, release: { name: "Bicep", image: { uri: "https://geo-media.beatport.com/a.jpg" } } }] }))
    .on(/\/my\/playlists\/\?/, json(200, { results: [{ id: 9, name: "Peak time" }] }))
    .on(/\/my\/playlists\/9\/tracks\//, json(200, { results: [{ position: 1, track: { id: 2, name: "Opal", artists: [{ name: "Bicep" }] } }] }))
    .on(/\/catalog\/tracks\/1\/stream\//, json(200, { stream_url: "https://needledrop.beatport.com/1/file.m3u8", sample_start_ms: 0, sample_end_ms: 269000 }))
    .on(/\/catalog\/tracks\/3\/stream\//, json(403, { detail: "no subscription" }));
  const bp = createBeatportSource("beatport", http);
  const [track] = await bp.search("glue");
  assert.equal(http.calls[0].url, "https://api.beatport.com/v4/catalog/search/?q=glue&type=tracks&per_page=25");
  assert.equal(http.calls[0].auth, "user");
  assert.equal(track.title, "Glue (Original Mix)");
  assert.equal(track.bpm, 124);
  assert.equal(track.key, "F Minor");
  assert.equal(track.artworkUrl, "https://geo-media.beatport.com/a.jpg");
  const root = await bp.browse();
  assert.deepEqual(root.nodes.map((n) => n.id), ["my-playlists", "genres"]);
  const playlists = await bp.browse("my-playlists");
  assert.deepEqual(playlists.nodes, [{ id: "playlist:9", title: "Peak time", kind: "playlist" }]);
  const inPlaylist = await bp.browse("playlist:9");
  assert.equal(inPlaylist.tracks[0].title, "Opal");
  const plan = await bp.resolve(track);
  assert.deepEqual(plan, { kind: "decodable", source: "beatport", url: "https://needledrop.beatport.com/1/file.m3u8", container: "hls", preview: false, auth: "user" });
  const refused = await bp.resolve({ ...track, id: "3" });
  assert.equal(refused.kind, "unavailable");
  assert.match((refused as { reason: string }).reason, /no LINK streaming access/);
});

test("Beatsource LINK talks to api.beatsource.com", async () => {
  const http = new FakeHttp().on(/catalog\/search/, json(200, { tracks: [] }));
  const bs = createBeatportSource("beatsource", http);
  await bs.search("x");
  assert.match(http.calls[0].url, /^https:\/\/api\.beatsource\.com\/v4\//);
  assert.deepEqual(bs.apiHosts, ["api.beatsource.com"]);
  assert.equal(bs.oauth!.authorizeUrl, "https://api.beatsource.com/v4/auth/o/authorize/");
});

/* ------------------------------------------------------------- SoundCloud */

test("SoundCloud search filters to streamable access and maps blocked tracks", async () => {
  const http = new FakeHttp().on(/\/tracks\?q=/, json(200, { collection: [{ urn: "soundcloud:tracks:1", title: "A", user: { username: "u" }, access: "playable" }, { id: 2, title: "B", access: "blocked" }], next_href: null }));
  const sc = createSoundcloudSource(http);
  const tracks = await sc.search("deep house");
  assert.equal(http.calls[0].url, "https://api.soundcloud.com/tracks?q=deep%20house&access=playable,preview&limit=25&linked_partitioning=true");
  assert.equal(http.calls[0].auth, "app-or-user");
  assert.deepEqual(tracks.map((t) => [t.id, t.access]), [["soundcloud:tracks:1", "full"], ["2", "blocked"]]);
  assert.equal(SOUNDCLOUD_OAUTH.tokenType, "OAuth");
});

test("SoundCloud resolve prefers progressive MP3, falls back to HLS, preview, then the widget", async () => {
  assert.deepEqual(pickSoundcloudStream({ http_mp3_128_url: "https://api.soundcloud.com/s.mp3", hls_aac_160_url: "https://x/h.m3u8" }, "full"), { url: "https://api.soundcloud.com/s.mp3", container: "progressive", preview: false });
  assert.deepEqual(pickSoundcloudStream({ hls_aac_160_url: "https://x/h.m3u8" }, "full"), { url: "https://x/h.m3u8", container: "hls", preview: false });
  assert.deepEqual(pickSoundcloudStream({ http_mp3_128_url: "https://x/full.mp3", preview_mp3_128_url: "https://x/p.mp3" }, "preview"), { url: "https://x/p.mp3", container: "progressive", preview: true });
  assert.equal(pickSoundcloudStream({}, "full"), null);

  const http = new FakeHttp()
    .on(/tracks\/soundcloud%3Atracks%3A1\/streams/, json(200, { http_mp3_128_url: "https://api.soundcloud.com/tracks/1/stream" }))
    .on(/tracks\/soundcloud%3Atracks%3A2\/streams/, json(200, {}));
  const sc = createSoundcloudSource(http);
  const plan = await sc.resolve(scTrack());
  assert.equal(plan.kind, "decodable");
  const widget = await sc.resolve(scTrack({ id: "soundcloud:tracks:2" }));
  assert.equal(widget.kind, "monitor-only");
  assert.match((widget as { embedUrl: string }).embedUrl, /^https:\/\/w\.soundcloud\.com\/player\/\?url=https%3A%2F%2Fsoundcloud\.com%2Fbicep%2Fglue/);
  const blocked = await sc.resolve(scTrack({ access: "blocked" }));
  assert.equal(blocked.kind, "unavailable");
  assert.equal(http.calls.length, 2, "blocked tracks are refused without calling the API");
});

/* ------------------------------------------------------------------ TIDAL */

test("TIDAL search resolves ids, then names via /tracks with artists", async () => {
  const http = new FakeHttp()
    .on(/\/searchResults\?/, json(200, { data: [{ id: "glue", type: "searchResults", relationships: { tracks: { data: [{ id: "11", type: "tracks" }, { id: "12", type: "tracks" }] } } }] }))
    .on(/\/tracks\?/, json(200, {
      data: [
        { id: "12", type: "tracks", attributes: { title: "Opal", duration: "PT5M1S" }, relationships: { artists: { data: [{ id: "a", type: "artists" }] } } },
        { id: "11", type: "tracks", attributes: { title: "Glue", version: "Extended", duration: "PT4M29S", bpm: 129 }, relationships: { artists: { data: [{ id: "a", type: "artists" }] } } },
      ],
      included: [{ id: "a", type: "artists", attributes: { name: "Bicep" } }],
    }));
  const tidal = createTidalSource(http, "GB");
  const tracks = await tidal.search("glue");
  assert.equal(http.calls[0].url, "https://openapi.tidal.com/v2/searchResults?filter[query]=glue&countryCode=GB&include=tracks");
  assert.equal(http.calls[1].url, "https://openapi.tidal.com/v2/tracks?countryCode=GB&filter[id]=11,12&include=artists,albums");
  assert.equal(http.calls[0].accept, "application/vnd.api+json");
  assert.deepEqual(tracks.map((t) => t.title), ["Glue (Extended)", "Opal"]); // search order kept
  assert.equal(tracks[0].durationSec, 269);
  assert.equal(tracks[0].artist, "Bicep");
});

test("TIDAL manifests with drmData go to TIDAL's own player, plain ones to the deck", async () => {
  const drm = tidalPlanFromManifest("11", { uri: "https://x/m.mpd", drmData: { drmSystem: "WIDEVINE", licenseUrl: "https://x/lic" } });
  assert.equal(drm.kind, "monitor-only");
  assert.equal((drm as { embedUrl: string }).embedUrl, "https://embed.tidal.com/tracks/11");
  assert.equal((drm as { reason: string }).reason, "widevine");
  const plain = tidalPlanFromManifest("11", { uri: "https://sp-pr.audio.tidal.com/x.m3u8", trackPresentation: "PREVIEW" });
  assert.deepEqual(plain, { kind: "decodable", source: "tidal", url: "https://sp-pr.audio.tidal.com/x.m3u8", container: "hls", preview: true, auth: "none" });

  const http = new FakeHttp().on(/trackManifests\/11\?/, json(200, { data: { id: "11", type: "trackManifests", attributes: { uri: "https://x/a.m3u8", drmData: { drmSystem: "WIDEVINE" } } } }));
  const tidal = createTidalSource(http);
  const plan = await tidal.resolve({ source: "tidal", id: "11", title: "Glue", artist: "Bicep", durationSec: 269, access: "unknown" });
  assert.equal(plan.kind, "monitor-only");
  assert.match(http.calls[0].url, /manifestType=HLS/);
  assert.match(http.calls[0].url, /usage=PLAYBACK/);
});

/* ---------------------------------------------------- web player & loader */

test("web-player source turns a pasted link into a monitor-only official player", async () => {
  const web = createWebPlayerSource();
  assert.equal(web.authStatus(undefined).state, "app-only");
  assert.deepEqual(await web.search("just words"), []);
  const [track] = await web.search("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
  const plan = await web.resolve(track);
  assert.equal(plan.kind, "monitor-only");
  assert.equal((plan as { reason: string }).reason, "widevine");
});

test("loader decodes plain audio into a File, embeds DRM players and reports refusals", async () => {
  const http = new FakeHttp().on(/streams/, json(200, { http_mp3_128_url: "https://api.soundcloud.com/tracks/1/stream" }));
  const sc = createSoundcloudSource(http);
  const file = await loadStreamTrack(sc, scTrack(), async () => ({ ok: true, bytes: new Uint8Array([0xff, 0xfb, 0x90]), type: "audio/mpeg" }), false);
  assert.equal(file.kind, "file");
  if (file.kind === "file") {
    assert.equal(file.file.name, "bicep - Glue.mp3");
    assert.equal(file.file.size, 3);
    assert.equal(file.preview, false);
  }
  const refused = await loadStreamTrack(sc, scTrack(), async () => ({ ok: false, error: "the stream is encrypted, and OpenDecks doesn't decrypt service streams." }), false);
  assert.equal(refused.kind, "unavailable");
  assert.match((refused as { reason: string }).reason, /doesn't decrypt/);

  const tidalHttp = new FakeHttp().on(/trackManifests/, json(200, { data: { attributes: { drmData: { drmSystem: "WIDEVINE" } } } }));
  const monitor = await loadStreamTrack(createTidalSource(tidalHttp), { source: "tidal", id: "5", title: "t", artist: "a", durationSec: 1, access: "unknown" }, async () => {
    throw new Error("must not fetch DRM audio");
  }, false);
  assert.equal(monitor.kind, "monitor");
  if (monitor.kind === "monitor") {
    assert.match(monitor.label, /monitor only/);
    assert.match(monitor.label, /castlabs ECS/);
  }
  const failing = await loadStreamTrack(createTidalSource({ request: async () => ({ status: 0, body: "", error: "missing-credentials" }) }), { source: "tidal", id: "5", title: "t", artist: "a", durationSec: 1, access: "unknown" }, async () => ({ ok: true }), false);
  assert.equal(failing.kind, "unavailable");
  assert.match((failing as { reason: string }).reason, /needs partner API key/);
});

test("monitor-only label only mentions castlabs when Widevine is missing", () => {
  assert.doesNotMatch(monitorOnlyLabel("TIDAL", true, true), /castlabs/);
  assert.match(monitorOnlyLabel("TIDAL", true, false), /castlabs/);
  assert.doesNotMatch(monitorOnlyLabel("SoundCloud", false, false), /castlabs/);
  assert.match(monitorOnlyLabel("SoundCloud", false, false), /EQ, FX, waveform or analysis/);
});

test("streamed tracks get stable library ids and library fields like local files", () => {
  const t = scTrack({ bpm: 124, key: "Fm", album: "Isles" });
  const key = streamTrackKey(t);
  assert.equal(key, "stream:soundcloud:soundcloud:tracks:1");
  assert.deepEqual(parseStreamTrackKey(key), { source: "soundcloud", id: "soundcloud:tracks:1" });
  assert.equal(parseStreamTrackKey("file.mp3"), null);
  const fields = libraryFieldsFor(t);
  assert.equal(fields.id, key);
  assert.equal(fields.provider, "soundcloud");
  assert.equal(fields.bpm, 124);
  assert.equal(fields.analyzed, false, "deck analysis still runs on decoded audio");
  assert.equal(safeFileName({ artist: "A/B", title: 'x:"y"' }, "mp3"), "A_B - x__y_.mp3");
});

test("host allowlist is https-only and suffix-safe; ISO durations parse", () => {
  assert.equal(hostAllowed("https://api.soundcloud.com/tracks", ["api.soundcloud.com"]), true);
  assert.equal(hostAllowed("http://api.soundcloud.com/tracks", ["api.soundcloud.com"]), false);
  assert.equal(hostAllowed("https://cf-media.sndcdn.com/x", [], ["sndcdn.com"]), true);
  assert.equal(hostAllowed("https://evilsndcdn.com/x", [], ["sndcdn.com"]), false);
  assert.equal(hostAllowed("not a url", ["x"]), false);
  assert.equal(isoDurationToSec("PT3M21S"), 201);
  assert.equal(isoDurationToSec("PT1H0M0.4S"), 3600);
  assert.equal(isoDurationToSec("garbage"), 0);
});

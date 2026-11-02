import test from "node:test";
import assert from "node:assert/strict";
import { PlayQueue } from "../src/renderer/streaming/queue.ts";
import { createDefaultSources, NO_HTTP } from "../src/renderer/streaming/index.ts";
import { DRM_KEY_SYSTEMS, probeKeySystems, widevineStatusText } from "../src/renderer/streaming/drm.ts";
import { buildAuthorizeUrl, generatePkcePair } from "../src/renderer/streaming/oauth.ts";
import { officialEmbed, videoIdFromTrackUrl, youtubeEmbedUrl } from "../src/renderer/streaming/embed.ts";
import { mapBeatportTrack } from "../src/renderer/streaming/adapters/beatport.ts";
import { mapSoundcloudTrack } from "../src/renderer/streaming/adapters/soundcloud.ts";
import { mapTidalTracks, TIDAL_OAUTH } from "../src/renderer/streaming/adapters/tidal.ts";
import { parseWhipAnswer, resolveWhipLocation, validateOffer, whipHeaders } from "../src/renderer/broadcast/whip.ts";

const track = (id: string) => ({
  id,
  title: `Track ${id}`,
  artist: "Tester",
  durationSec: 180,
  provider: "youtube-music",
  url: `https://music.youtube.com/watch?v=${id}`,
});

test("queue adds, navigates, repeats and shuffles", () => {
  const queue = new PlayQueue();
  queue.addMany([track("a"), track("b"), track("c")]);
  assert.equal(queue.current?.id, "a");
  assert.equal(queue.next()?.id, "b");
  assert.equal(queue.previous()?.id, "a");
  assert.equal(queue.jump(2)?.id, "c");
  assert.equal(queue.next(), null);
  queue.repeat = "all";
  assert.equal(queue.next()?.id, "a");
  queue.repeat = "one";
  assert.equal(queue.next()?.id, "a");
  queue.shuffle = true;
  queue.repeat = "off";
  const shuffled = queue.next();
  assert.ok(shuffled && shuffled.id !== "a");
});

test("queue removal keeps the index valid", () => {
  const queue = new PlayQueue();
  queue.addMany([track("a"), track("b"), track("c")]);
  queue.jump(2);
  queue.remove("c");
  assert.equal(queue.current?.id, "b");
  queue.move(0, 1);
  assert.equal(queue.items[1].id, "a");
  queue.clear();
  assert.equal(queue.current, null);
});

test("stream source registry lists the partner sources and the web-player fallback", () => {
  const registry = createDefaultSources(NO_HTTP);
  assert.deepEqual(registry.list().map((s) => s.id), ["beatport", "beatsource", "tidal", "soundcloud", "web-player"]);
  for (const id of ["beatport", "beatsource", "tidal", "soundcloud"]) {
    const source = registry.get(id)!;
    assert.ok(source.oauth, id);
    assert.ok(source.oauth!.authorizeUrl.startsWith("https://"), id);
    assert.ok(source.oauth!.tokenUrl.startsWith("https://"), id);
    assert.equal(source.authStatus(undefined).state, "needs-partner-key", id);
    assert.match(source.authStatus(undefined).message, /needs partner API key/i, id);
  }
  assert.equal(registry.get("web-player")!.oauth, null);
  // No source points at a private DRM licence endpoint or a scraped web API any more.
  for (const source of registry.list()) {
    for (const host of source.apiHosts) assert.doesNotMatch(host, /api-v2\.soundcloud|amp-api|spclient|youtube/, source.id);
  }
});

test("WHIP headers, SDP validation and location", () => {
  const sdp = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
  assert.equal(validateOffer(sdp), true);
  assert.equal(validateOffer("v=0\r\nm=video 9 UDP\r\n"), false);
  const answer = parseWhipAnswer(sdp, "https://whip.example/resource/1");
  assert.equal(answer.type, "answer");
  assert.equal(answer.location, "https://whip.example/resource/1");
  assert.throws(() => parseWhipAnswer("bad"));
  assert.equal(resolveWhipLocation("https://whip.example/endpoint", "/resource/9"), "https://whip.example/resource/9");
  assert.equal(resolveWhipLocation("https://whip.example/endpoint", null), "https://whip.example/endpoint");
  assert.deepEqual(whipHeaders(), { "Content-Type": "application/sdp", Accept: "application/sdp" });
  assert.equal(whipHeaders("tok").Authorization, "Bearer tok");
});


test("youtube track urls resolve to an embeddable video id", () => {
  assert.equal(videoIdFromTrackUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(videoIdFromTrackUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RD"), "dQw4w9WgXcQ");
  assert.equal(videoIdFromTrackUrl("not a url", "dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(videoIdFromTrackUrl("https://music.youtube.com/watch?v=bad", "also-bad"), "");
  assert.equal(videoIdFromTrackUrl("https://example.com/watch", ""), "");
});

test("embed urls use the no-cookie player and reject bad ids", () => {
  assert.equal(
    youtubeEmbedUrl("dQw4w9WgXcQ"),
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&playsinline=1",
  );
  assert.equal(youtubeEmbedUrl("short"), "");
  assert.equal(youtubeEmbedUrl("../../evil"), "");
});


test("pasted links map to the services' official embed players", () => {
  assert.equal(officialEmbed("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")?.embedUrl, "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC");
  assert.equal(officialEmbed("https://listen.tidal.com/track/12345678")?.embedUrl, "https://embed.tidal.com/tracks/12345678");
  assert.equal(officialEmbed("https://www.beatport.com/track/glue/987654")?.embedUrl, "https://embed.beatport.com/?id=987654&type=track");
  assert.equal(officialEmbed("https://www.deezer.com/track/3135556")?.embedUrl, "https://widget.deezer.com/widget/dark/track/3135556");
  assert.match(officialEmbed("https://soundcloud.com/bicep/glue")!.embedUrl, /^https:\/\/w\.soundcloud\.com\/player\//);
  assert.equal(officialEmbed("https://music.apple.com/us/album/glue/123?i=456")?.embedUrl, "https://embed.music.apple.com/us/album/glue/123?i=456");
  assert.equal(officialEmbed("https://music.youtube.com/watch?v=dQw4w9WgXcQ")?.embedUrl, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&playsinline=1");
  assert.equal(officialEmbed("https://open.spotify.com/track/abc")?.needsWidevine, true);
  assert.equal(officialEmbed("http://open.spotify.com/track/abc"), null);
  assert.equal(officialEmbed("https://example.com/track/1"), null);
  assert.equal(officialEmbed("not a link"), null);
});

test("EME probe reports Widevine honestly and PKCE builds an S256 authorize URL", async () => {
  const report = await probeKeySystems(async (ks) => {
    if (ks === DRM_KEY_SYSTEMS.widevine || ks === DRM_KEY_SYSTEMS.clearkey) return {} as MediaKeySystemAccess;
    throw new Error("unsupported");
  });
  assert.deepEqual(report.supportedSchemes, ["widevine", "clearkey"]);
  assert.equal(report.activeScheme, "widevine");
  assert.match(widevineStatusText(report), /monitor only/);
  const none = await probeKeySystems(async () => {
    throw new Error("no CDM");
  });
  assert.match(widevineStatusText(none), /castlabs ECS/);

  const pkce = await generatePkcePair();
  assert.ok(pkce.verifier.length >= 43);
  assert.ok(pkce.challenge.length >= 43);
  assert.notEqual(pkce.verifier, pkce.challenge);
  const authUrl = new URL(buildAuthorizeUrl(TIDAL_OAUTH, { clientId: "client-123", redirectUri: "http://127.0.0.1:43827/callback", codeChallenge: pkce.challenge, state: "st-1" }));
  assert.equal(authUrl.origin, "https://login.tidal.com");
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authUrl.searchParams.get("client_id"), "client-123");
  assert.equal(authUrl.searchParams.get("state"), "st-1");
});

test("Beatport, SoundCloud and TIDAL payloads map to stream tracks", () => {
  const bp = mapBeatportTrack("beatport", { id: 991122, name: "Delilah", mix_name: "Original Mix", artists: [{ name: "Fred again.." }], length_ms: 241000, bpm: 124, key: { name: "A Minor" }, slug: "delilah" });
  assert.equal(bp?.title, "Delilah (Original Mix)");
  assert.equal(bp?.artist, "Fred again..");
  assert.equal(bp?.durationSec, 241);
  assert.equal(bp?.permalink, "https://www.beatport.com/track/delilah/991122");

  const sc = mapSoundcloudTrack({ urn: "soundcloud:tracks:7", title: "Glue", user: { username: "bicep" }, duration: 269000, access: "playable", permalink_url: "https://soundcloud.com/bicep/glue", artwork_url: "https://i1.sndcdn.com/a-large.jpg" });
  assert.equal(sc?.id, "soundcloud:tracks:7");
  assert.equal(sc?.durationSec, 269);
  assert.equal(sc?.access, "full");
  assert.equal(sc?.artworkUrl, "https://i1.sndcdn.com/a-t500x500.jpg");

  const tidal = mapTidalTracks({
    data: [{ id: "77", type: "tracks", attributes: { title: "Nanana", duration: "PT3M50S", bpm: 122, key: "A", keyScale: "MINOR" }, relationships: { artists: { data: [{ id: "a1", type: "artists" }] } } }],
    included: [{ id: "a1", type: "artists", attributes: { name: "Peggy Gou" } }],
  });
  assert.equal(tidal.length, 1);
  assert.equal(tidal[0].artist, "Peggy Gou");
  assert.equal(tidal[0].durationSec, 230);
  assert.equal(tidal[0].key, "Am");
});

import test from "node:test";
import assert from "node:assert/strict";
import { PlayQueue } from "../src/renderer/streaming/queue.ts";
import { PROVIDERS, findProvider } from "../src/renderer/streaming/providers.ts";
import {
  DRM_KEY_SYSTEMS,
  DrmSessionManager,
  buildClearKeyLicense,
  buildOAuthAuthorizeUrl,
  generatePkcePair,
  parseCommercialSearchPayload,
  probeKeySystems,
  providerEmbedUrl,
} from "../src/renderer/streaming/drm.ts";
import { extractYtInitialData, parseTracks, parseSearchHtml, parseSearchResponse, videoIdFromTrackUrl, youtubeEmbedUrl } from "../src/renderer/streaming/youtube.ts";
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

test("provider catalogue has sign-in and URL builders", () => {
  assert.ok(PROVIDERS.length >= 8);
  for (const id of ["spotify", "apple-music", "tidal", "soundcloud", "beatport", "beatsource"]) {
    assert.ok(findProvider(id), id);
  }
  assert.ok(findProvider("beatport")!.searchUrl("house").startsWith("https://www.beatport.com/search"));
  const ytm = findProvider("youtube-music")!;
  assert.match(ytm.searchUrl("fred again"), /^https:\/\/music\.youtube\.com\/search\?q=fred%20again$/);
  assert.equal(ytm.trackUrl("abc123"), "https://music.youtube.com/watch?v=abc123");
  assert.ok(ytm.cookieHints.includes("SAPISID"));
  for (const provider of PROVIDERS) {
    assert.ok(provider.loginUrl.startsWith("https://"), provider.id);
    assert.ok(provider.trackUrl("x").startsWith("https://"), provider.id);
  }
});

test("YouTube Music search payload becomes queue tracks", () => {
  const payload = {
    contents: {
      sectionListRenderer: {
        contents: [
          {
            musicShelfRenderer: {
              contents: [
                {
                  musicResponsiveListItemRenderer: {
                    playlistItemData: { videoId: "vid1" },
                    flexColumns: [
                      {
                        musicResponsiveListItemFlexColumnRenderer: {
                          text: { runs: [{ text: "Track One" }] },
                        },
                      },
                      {
                        musicResponsiveListItemFlexColumnRenderer: {
                          text: { runs: [{ text: "Artist One" }, { text: " • " }, { text: "Album" }, { text: " • 3:45" }] },
                        },
                      },
                    ],
                  },
                },
                {
                  musicResponsiveListItemRenderer: {
                    overlay: {
                      musicItemThumbnailOverlayRenderer: {
                        content: {
                          musicPlayButtonRenderer: {
                            playNavigationEndpoint: { watchEndpoint: { videoId: "vid2" } },
                          },
                        },
                      },
                    },
                    flexColumns: [
                      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Track Two" }] } } },
                      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Artist Two" }] } } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  };

  const tracks = parseTracks(payload);
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].id, "vid1");
  assert.equal(tracks[0].artist, "Artist One");
  assert.equal(tracks[0].durationSec, 225);
  assert.equal(tracks[1].id, "vid2");
});

test("ytInitialData is extracted from a page", () => {
  const html = `<html><script>var ytInitialData = {"a":{"b":[1,2]}};</script></html>`;
  assert.deepEqual(extractYtInitialData(html), { a: { b: [1, 2] } });
  assert.deepEqual(parseSearchHtml(html), []);
  assert.equal(extractYtInitialData("<html></html>"), null);
});

test("native YouTube Music payloads parse and HTML still falls back", () => {
  const native = JSON.stringify({ tracks: [track("native-1")] });
  assert.deepEqual(parseSearchResponse(native), [track("native-1")]);
  const html = `<script>var ytInitialData = {"contents":[]};</script>`;
  assert.deepEqual(parseSearchResponse(html), []);
  assert.deepEqual(parseSearchResponse("not json"), []);
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


test("all 8 commercial streaming providers declare EME DRM schemes, license URLs, and embed builders", () => {
  assert.equal(PROVIDERS.length, 8);
  for (const p of PROVIDERS) {
    assert.equal(p.supportsSearch, true, p.id);
    assert.ok(p.drmSchemes.length >= 1, p.id);
    assert.ok(p.licenseUrl.startsWith("https://"), p.id);
    assert.ok(typeof p.apiSearchUrl === "function", p.id);
    assert.ok(typeof p.embedUrl === "function", p.id);
  }
  assert.equal(
    providerEmbedUrl("spotify", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"),
    "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC?utm_source=generator&theme=0",
  );
  assert.equal(
    providerEmbedUrl("tidal", "https://listen.tidal.com/track/12345678"),
    "https://embed.tidal.com/tracks/12345678",
  );
  assert.equal(
    providerEmbedUrl("beatport", "https://www.beatport.com/track/glue/987654"),
    "https://embed.beatport.com/?id=987654&type=track",
  );
  assert.equal(
    providerEmbedUrl("beatsource", "https://www.beatsource.com/track/delilah/543210"),
    "https://embed.beatsource.com/?id=543210&type=track",
  );
  assert.equal(
    providerEmbedUrl("deezer", "https://www.deezer.com/track/3135556"),
    "https://widget.deezer.com/widget/dark/track/3135556",
  );
  assert.match(
    providerEmbedUrl("soundcloud", "https://soundcloud.com/bicep/glue"),
    /^https:\/\/w\.soundcloud\.com\/player\//,
  );
  assert.equal(
    providerEmbedUrl("apple-music", "https://music.apple.com/us/album/glue/123?i=456"),
    "https://embed.music.apple.com/us/album/glue/123?i=456",
  );
});

test("W3C EME probeKeySystems, ClearKey JWK builder, PKCE OAuth, and DrmSessionManager license exchange", async () => {
  const report = await probeKeySystems(async (ks) => {
    if (ks === DRM_KEY_SYSTEMS.widevine || ks === DRM_KEY_SYSTEMS.clearkey) {
      return {} as MediaKeySystemAccess;
    }
    throw new Error("unsupported");
  });
  assert.deepEqual(report.supportedSchemes, ["widevine", "clearkey"]);
  assert.equal(report.activeScheme, "widevine");

  const clearKeyBytes = buildClearKeyLicense({
    "00112233445566778899aabbccddeeff": "0123456789abcdef0123456789abcdef",
  });
  const clearKeyJson = JSON.parse(new TextDecoder().decode(clearKeyBytes)) as {
    keys: Array<{ kty: string; k: string; kid: string }>;
    type: string;
  };
  assert.equal(clearKeyJson.type, "temporary");
  assert.equal(clearKeyJson.keys.length, 1);
  assert.equal(clearKeyJson.keys[0].kty, "oct");

  const pkce = await generatePkcePair();
  assert.ok(pkce.verifier.length >= 32);
  assert.ok(pkce.challenge.length >= 32);
  const authUrl = buildOAuthAuthorizeUrl({
    authorizeEndpoint: "https://accounts.spotify.com/authorize",
    clientId: "client-123",
    redirectUri: "http://127.0.0.1:43821/callback",
    scope: "streaming user-read-private",
    codeChallenge: pkce.challenge,
    state: "st-1",
  });
  assert.match(authUrl, /code_challenge_method=S256/);
  assert.match(authUrl, /client_id=client-123/);

  const manager = new DrmSessionManager();
  manager.credentials.set({
    provider: "tidal",
    accessToken: "tidal-tok-99",
    preferredDrm: "widevine",
    updatedAt: Date.now(),
  });
  assert.equal(manager.credentials.hasCredentials("tidal"), true);

  const licenseBytes = await manager.negotiateLicense(
    new Uint8Array([1, 2, 3, 4]),
    {
      provider: "tidal",
      scheme: "widevine",
      licenseUrl: "https://api.tidal.com/v1/drm/licenses/widevine",
      bearerToken: "tidal-tok-99",
    },
    (async (url: string, init?: RequestInit) => {
      assert.equal(url, "https://api.tidal.com/v1/drm/licenses/widevine");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer tidal-tok-99");
      return new Response(new Uint8Array([9, 8, 7, 6]), { status: 200 });
    }) as typeof fetch,
  );
  assert.deepEqual(Array.from(licenseBytes), [9, 8, 7, 6]);
});

test("parseCommercialSearchPayload parses Spotify, Beatport, TIDAL, SoundCloud, and Apple Music payloads", () => {
  const spotifyTracks = parseCommercialSearchPayload(
    "spotify",
    JSON.stringify({
      tracks: {
        items: [
          {
            id: "sp1",
            name: "Glue",
            artists: [{ name: "Bicep" }],
            duration_ms: 269000,
            external_urls: { spotify: "https://open.spotify.com/track/sp1" },
          },
        ],
      },
    }),
  );
  assert.equal(spotifyTracks.length, 1);
  assert.equal(spotifyTracks[0].title, "Glue");
  assert.equal(spotifyTracks[0].artist, "Bicep");
  assert.equal(spotifyTracks[0].durationSec, 269);

  const beatportTracks = parseCommercialSearchPayload(
    "beatport",
    JSON.stringify({
      results: [
        {
          id: 991122,
          name: "Delilah",
          mix_name: "Original Mix",
          artists: [{ name: "Fred again.." }],
          length_ms: 241000,
        },
      ],
    }),
  );
  assert.equal(beatportTracks.length, 1);
  assert.equal(beatportTracks[0].title, "Delilah (Original Mix)");
  assert.equal(beatportTracks[0].url, "https://www.beatport.com/track/-/991122");

  const appleTracks = parseCommercialSearchPayload(
    "apple-music",
    JSON.stringify({
      results: {
        songs: {
          data: [
            {
              id: "am77",
              attributes: {
                name: "Nanana",
                artistName: "Peggy Gou",
                durationInMillis: 230000,
                url: "https://music.apple.com/us/song/nanana/am77",
              },
            },
          ],
        },
      },
    }),
  );
  assert.equal(appleTracks.length, 1);
  assert.equal(appleTracks[0].artist, "Peggy Gou");
  assert.equal(appleTracks[0].durationSec, 230);
});

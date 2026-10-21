import test from "node:test";
import assert from "node:assert/strict";
import { PlayQueue } from "../src/renderer/streaming/queue.ts";
import { PROVIDERS, findProvider } from "../src/renderer/streaming/providers.ts";
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

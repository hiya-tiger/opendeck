import test from "node:test";
import assert from "node:assert/strict";
import { readId3Artwork, readId3Info, readMediaInfo, readMp4Info } from "../src/renderer/media/artwork.ts";
import { artworkQuery, lookupCoverArt, parseItunesArtwork, pickItunesArtwork } from "../src/renderer/media/artwork-lookup.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function syncsafe(value: number): Uint8Array {
  return Uint8Array.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

function uint32(value: number): Uint8Array {
  return Uint8Array.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function apic(version: 3 | 4, pictureType: number, mime: string): Uint8Array {
  const mimeBytes = Uint8Array.from([...mime].map((char) => char.charCodeAt(0)));
  const body = Uint8Array.from([
    0,
    ...mimeBytes,
    0,
    pictureType,
    ...Array.from("cover").map((char) => char.charCodeAt(0)),
    0,
    ...PNG,
  ]);
  const size = version === 3 ? uint32(body.length) : syncsafe(body.length);
  return Uint8Array.from([
    ...Array.from("APIC").map((char) => char.charCodeAt(0)),
    ...size,
    0,
    0,
    ...body,
  ]);
}

function tag(version: 3 | 4, frames: Uint8Array[]): Uint8Array {
  const body = Uint8Array.from(frames.flatMap((frame) => Array.from(frame)));
  return Uint8Array.from([0x49, 0x44, 0x33, version, 0, 0, ...syncsafe(body.length), ...body]);
}

test("reads a front cover from an ID3v2.3 APIC frame", () => {
  const art = readId3Artwork(tag(3, [apic(3, 3, "image/png")]));
  assert.ok(art);
  assert.equal(art.mime, "image/png");
  assert.deepEqual(Array.from(art.data), Array.from(PNG));
});

test("prefers the front cover over other pictures", () => {
  const art = readId3Artwork(tag(3, [apic(3, 4, "image/png"), apic(3, 3, "image/jpeg")]));
  assert.ok(art);
  assert.equal(art.mime, "image/jpeg");
});

test("reads a front cover from an ID3v2.4 APIC frame", () => {
  const art = readId3Artwork(tag(4, [apic(4, 3, "image/png")]));
  assert.ok(art);
  assert.equal(art.mime, "image/png");
});

test("returns null for files without an ID3v2 tag", () => {
  assert.equal(readId3Artwork(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])), null);
});

function textFrame(id: string, value: string): Uint8Array {
  const body = Uint8Array.from([3, ...Array.from(value).map((char) => char.charCodeAt(0))]);
  return Uint8Array.from([
    ...Array.from(id).map((char) => char.charCodeAt(0)),
    ...uint32(body.length),
    0,
    0,
    ...body,
  ]);
}

test("reads artist, title and album text frames", () => {
  const info = readId3Info(
    tag(3, [textFrame("TPE1", "Daft Punk"), textFrame("TIT2", "One More Time"), textFrame("TALB", "Discovery")]),
  );
  assert.equal(info.artist, "Daft Punk");
  assert.equal(info.title, "One More Time");
  assert.equal(info.album, "Discovery");
  assert.equal(info.artwork, null);
});

test("builds an artwork query from tags or the file name", () => {
  assert.equal(artworkQuery({ artist: "Daft Punk", title: "One More Time" }, "track"), "Daft Punk One More Time");
  assert.equal(artworkQuery({ artist: "Daft Punk", album: "Discovery" }, "track"), "Daft Punk Discovery");
  assert.equal(artworkQuery(null, "artist_-_title"), "artist - title");
  assert.equal(artworkQuery(null, "12 6 Man"), "6 Man");
  assert.equal(artworkQuery(null, "07 - One More Time"), "One More Time");
});

test("parses an iTunes artwork URL and upgrades its size", () => {
  const json = JSON.stringify({
    results: [{ artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg" }],
  });
  assert.equal(parseItunesArtwork(json), "https://is1-ssl.mzstatic.com/image/thumb/x/600x600bb.jpg");
  assert.equal(parseItunesArtwork("not json"), null);
});

test("picks the iTunes result that matches the query", () => {
  const json = JSON.stringify({
    results: [
      {
        trackName: "6, 8, 12",
        artistName: "Brian McKnight",
        collectionName: "Back At One",
        artworkUrl100: "https://example.test/thumb/wrong/100x100bb.jpg",
      },
      {
        trackName: "6 Man",
        artistName: "Drake",
        collectionName: "If You're Reading This It's Too Late",
        artworkUrl100: "https://example.test/thumb/right/100x100bb.jpg",
      },
    ],
  });
  assert.equal(
    pickItunesArtwork(json, "6 Man"),
    "https://example.test/thumb/right/600x600bb.jpg",
  );
  assert.equal(pickItunesArtwork(json, "zzz"), null);
  assert.equal(pickItunesArtwork(JSON.stringify({ results: [{ artworkUrl100: "https://example.test/a/100x100bb.jpg" }] }), "x y"), "https://example.test/a/600x600bb.jpg");
});

function asciiBytes(text: string): Uint8Array {
  return Uint8Array.from([...text].map((char) => char.charCodeAt(0)));
}

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const payload = Uint8Array.from(payloads.flatMap((part) => Array.from(part)));
  return Uint8Array.from([...uint32(8 + payload.length), ...asciiBytes(type), ...payload]);
}

function dataAtom(kind: number, payload: Uint8Array): Uint8Array {
  return box("data", uint32(kind), uint32(0), payload);
}

function mp4File(withArt: boolean): Uint8Array {
  const items = [
    box("\u00a9nam", dataAtom(1, asciiBytes("6 Man"))),
    box("\u00a9ART", dataAtom(1, asciiBytes("Drake"))),
    box("\u00a9alb", dataAtom(1, asciiBytes("If You're Reading This It's Too Late"))),
  ];
  if (withArt) items.push(box("covr", dataAtom(14, PNG)));
  const ilst = box("ilst", ...items);
  const meta = box("meta", uint32(0), ilst);
  const udta = box("udta", meta);
  const moov = box("moov", udta);
  const ftyp = box("ftyp", asciiBytes("M4A "), uint32(0));
  return Uint8Array.from([...ftyp, ...moov]);
}

test("reads MP4/M4A cover art and tags", () => {
  const info = readMp4Info(mp4File(true));
  assert.ok(info);
  assert.equal(info.title, "6 Man");
  assert.equal(info.artist, "Drake");
  assert.equal(info.album, "If You're Reading This It's Too Late");
  assert.ok(info.artwork);
  assert.equal(info.artwork.mime, "image/png");
  assert.deepEqual(Array.from(info.artwork.data), Array.from(PNG));

  const noArt = readMp4Info(mp4File(false));
  assert.ok(noArt);
  assert.equal(noArt.artwork, null);
  assert.equal(noArt.title, "6 Man");

  assert.equal(readMp4Info(Uint8Array.from([0x52, 0x49, 0x46, 0x46])), null);
  assert.equal(readMediaInfo(mp4File(true)).artist, "Drake");
});

test("looks up cover art through the injected fetchers", async () => {
  const calls: string[] = [];
  const result = await lookupCoverArt("daft punk one more time", {
    text: async (url) => {
      calls.push(url);
      return JSON.stringify({ results: [{ artworkUrl100: "https://example.test/100x100bb.jpg" }] });
    },
    bytes: async () => Uint8Array.from([...PNG, ...new Array(300).fill(0)]),
  });
  assert.ok(result);
  assert.equal(result.mime, "image/png");
  assert.equal(result.source, "itunes");
  assert.ok(calls[0].includes("entity=song"));
});

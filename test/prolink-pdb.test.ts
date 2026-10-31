import assert from "node:assert/strict";
import test from "node:test";
import { parsePdb, playlistPaths, readDeviceSqlString, TABLE, PdbError } from "../src/main/prolink/pdb.ts";
import { anlzCandidates, parseAnlzCues } from "../src/main/prolink/anlz.ts";
import { libraryFromPdb } from "../src/main/prolink/importer.ts";
import { anlzWithHotCues, buildPdb, deviceSqlString, idNameRow, sampleDatabase } from "./helpers/pdb-builder.ts";

test("DeviceSQL strings: short ASCII, long UTF-16LE and long ASCII", () => {
  assert.equal(readDeviceSqlString(deviceSqlString("House"), 0), "House");
  assert.equal(readDeviceSqlString(deviceSqlString("Ünïcödé ☂"), 0), "Ünïcödé ☂");
  const long = Buffer.alloc(4 + 3);
  long[0] = 0x40;
  long.writeUInt16LE(7, 1);
  long.write("abc", 4, "latin1");
  assert.equal(readDeviceSqlString(long, 0), "abc");
  assert.equal(readDeviceSqlString(Buffer.from([0x03]), 0), "");
});

test("parses tracks, lookups, colours and playlists from a synthetic export.pdb", () => {
  const db = parsePdb(sampleDatabase());
  assert.equal(db.pageSize, 4096);
  assert.deepEqual(db.warnings, []);
  assert.deepEqual(db.tracks.map((t) => t.id), [1, 2, 3], "deleted row is skipped");
  const t1 = db.tracks[0];
  assert.equal(t1.title, "Opening Track");
  assert.equal(t1.filePath, "/Contents/Artist One/Opening Track.mp3");
  assert.equal(t1.filename, "Opening Track.mp3");
  assert.equal(t1.tempo, 124.5);
  assert.equal(t1.duration, 301);
  assert.equal(t1.rating, 4);
  assert.equal(t1.colorId, 5);
  assert.equal(t1.fileType, "mp3");
  assert.equal(t1.analyzePath, "/PIONEER/USBANLZ/P001/00000001/ANLZ0000.DAT");
  assert.equal(db.tracks[1].title, "Ünïcödé Dub ☂");
  assert.equal(db.tracks[1].fileType, "flac");
  assert.equal(db.artists.get(10), "Artist One");
  assert.equal(db.artists.get(11), "Artist Two", "far-name artist variant");
  assert.deepEqual(db.albums.get(20), { name: "First Album", artistId: 10 });
  assert.equal(db.genres.get(30), "House");
  assert.equal(db.keys.get(40), "Am");
  assert.equal(db.colors.get(5), "Green");
  const paths = playlistPaths(db);
  assert.deepEqual(paths.map((p) => p.path), [["Warmup"], ["Gigs", "Friday"]].sort((a, b) => a.length - b.length));
  const friday = paths.find((p) => p.path.join("/") === "Gigs/Friday")!;
  assert.deepEqual(friday.trackIds, [3, 1], "ordered by entry_index");
});

test("tables spanning many pages and more than 16 rows per page", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ data: idNameRow(i + 1, `Genre ${i + 1}`) }));
  const db = parsePdb(buildPdb([{ type: TABLE.genres, rows: many }], 512));
  assert.equal(db.genres.size, 40);
  assert.equal(db.genres.get(17), "Genre 17");
  assert.equal(db.genres.get(40), "Genre 40");
  const one = parsePdb(sampleDatabase(512));
  assert.deepEqual(one.tracks.map((t) => t.title), ["Opening Track", "Ünïcödé Dub ☂", "Closer"]);
});

test("library conversion maps lookups and playlist sub-crates", () => {
  const lib = libraryFromPdb(parsePdb(sampleDatabase()));
  assert.equal(lib.tracks.length, 3);
  assert.deepEqual(lib.tracks[0], {
    id: "pdb:1",
    title: "Opening Track",
    artist: "Artist One",
    album: "First Album",
    genre: "House",
    label: "",
    remixer: "",
    comment: "",
    bpm: 124.5,
    key: "Am",
    duration: 301,
    rating: 4,
    colorId: 5,
    path: "Contents/Artist One/Opening Track.mp3",
    size: 9,
    fileType: "mp3",
    trackNumber: 0,
    year: 0,
    analyzePath: "PIONEER/USBANLZ/P001/00000001/ANLZ0000.DAT",
  });
  assert.deepEqual(lib.playlists.find((p) => p.path[1] === "Friday")!.trackIds, ["pdb:3", "pdb:1"]);
});

test("rejects garbage instead of looping", () => {
  assert.throws(() => parsePdb(Buffer.alloc(10)), PdbError);
  assert.throws(() => parsePdb(Buffer.alloc(4096, 0xff)), PdbError);
  const db = sampleDatabase();
  // Make the tracks table's data page link back to its index page and claim a far last page.
  db.writeUInt32LE(99, 0x1c + 12);
  const first = db.readUInt32LE(0x1c + 8);
  db.writeUInt32LE(first, (first + 1) * 4096 + 0x0c);
  const parsed = parsePdb(db);
  assert.ok(parsed.warnings.some((w) => /loop/.test(w)));
});

test("ANLZ PCO2 hot cues with colours, comments and loops", () => {
  const cues = parseAnlzCues(
    anlzWithHotCues([
      { hotCue: 2, timeMs: 32_000, rgb: [0x10, 0x20, 0x30], comment: "Drop" },
      { hotCue: 1, timeMs: 1_000 },
      { hotCue: 0, timeMs: 5_000, loopEndMs: 9_000 },
    ]),
  );
  assert.deepEqual(cues, [
    { hotCue: 0, timeMs: 5000, loopEndMs: 9000 },
    { hotCue: 1, timeMs: 1000 },
    { hotCue: 2, timeMs: 32000, color: "#102030", comment: "Drop" },
  ]);
  assert.deepEqual(parseAnlzCues(Buffer.from("nope")), []);
  assert.deepEqual(anlzCandidates("PIONEER/USBANLZ/P1/ANLZ0000.DAT"), ["PIONEER/USBANLZ/P1/ANLZ0000.EXT", "PIONEER/USBANLZ/P1/ANLZ0000.DAT"]);
});

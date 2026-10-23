import assert from "node:assert/strict";
import test from "node:test";
import {
  PlayedLog,
  Scratchpad,
  filterTracks,
  sortTracks,
  type PlayedEntry,
} from "../src/renderer/media/library-ux.ts";

function entry(overrides: Partial<PlayedEntry> & { id?: string } = {}): Omit<PlayedEntry, "id"> & { id?: string } {
  return {
    trackId: overrides.trackId ?? "track-1",
    name: overrides.name ?? "Song",
    path: overrides.path ?? "C:/music/Song.mp3",
    crate: overrides.crate ?? "House",
    bpm: overrides.bpm ?? 124,
    key: overrides.key ?? "Am",
    startedAt: overrides.startedAt ?? "2026-10-22T12:00:00Z",
    duration: overrides.duration ?? 320,
    ...overrides,
  };
}

test("PlayedLog add prepends newest first and assigns an id", () => {
  const log = new PlayedLog();
  const first = log.add(entry({ trackId: "a" }));
  assert.ok(first.id.length > 0);
  const second = log.add(entry({ trackId: "b" }));
  assert.deepEqual(log.list().map((item) => item.trackId), ["b", "a"]);
  assert.notEqual(second.id, first.id);
});

test("PlayedLog dedupes consecutive plays of the same track", () => {
  const log = new PlayedLog();
  const first = log.add(entry({ trackId: "a" }));
  const second = log.add(entry({ trackId: "a", startedAt: "2026-10-22T13:00:00Z" }));
  assert.equal(log.list().length, 1);
  assert.equal(log.list()[0].startedAt, "2026-10-22T13:00:00Z");
  assert.equal(second.id, first.id);
  log.add(entry({ trackId: "b" }));
  log.add(entry({ trackId: "a" }));
  assert.deepEqual(log.list().map((item) => item.trackId), ["a", "b", "a"]);
});

test("PlayedLog accepts a caller-supplied id and timestamp only", () => {
  const log = new PlayedLog();
  const added = log.add(entry({ id: "custom-id", startedAt: "2026-10-22T14:00:00Z" }));
  assert.equal(added.id, "custom-id");
  assert.equal(added.startedAt, "2026-10-22T14:00:00Z");
});

test("PlayedLog trims to max", () => {
  const log = new PlayedLog([], 3);
  for (const trackId of ["a", "b", "c", "d", "e"]) log.add(entry({ trackId }));
  assert.deepEqual(log.list().map((item) => item.trackId), ["e", "d", "c"]);
});

test("PlayedLog clear, remove", () => {
  const log = new PlayedLog();
  const first = log.add(entry({ trackId: "a" }));
  const second = log.add(entry({ trackId: "b" }));
  assert.equal(log.remove(first.id), true);
  assert.equal(log.remove(first.id), false);
  assert.deepEqual(log.list().map((item) => item.trackId), [second.trackId]);
  log.clear();
  assert.deepEqual(log.list(), []);
});

test("PlayedLog exportCsv quotes RFC4180 specials", () => {
  const log = new PlayedLog();
  log.add(
    {
      ...entry({ trackId: "c" }),
      name: "Track, with \"quotes\"",
      crate: "Anime\nSoundtracks",
    },
  );
  const csv = log.exportCsv();
  const rows = csv.split("\r\n");
  assert.equal(rows[0], "name,path,crate,bpm,key,startedAt,duration");
  assert.ok(rows[1].startsWith('"Track, with ""quotes""",'), rows[1]);
  assert.ok(rows[1].includes('"Anime\nSoundtracks"'));
  const parsed = csvParse(rows[1]);
  assert.equal(parsed[0], 'Track, with "quotes"');
  assert.equal(parsed[2], "Anime\nSoundtracks");
  assert.equal(parsed[3], "124");
});

function csvParse(row: string): string[] {
  const fields: string[] = [];
  let index = 0;
  while (index <= row.length) {
    let field = "";
    if (row[index] === '"') {
      index += 1;
      while (index < row.length) {
        if (row[index] === '"' && row[index + 1] === '"') {
          field += '"';
          index += 2;
        } else if (row[index] === '"') {
          index += 1;
          break;
        } else {
          field += row[index];
          index += 1;
        }
      }
    }
    while (index < row.length && row[index] !== ",") {
      field += row[index];
      index += 1;
    }
    fields.push(field);
    index += 1;
    if (index >= row.length) break;
  }
  return fields;
}

test("PlayedLog exportCsv has header only when empty", () => {
  const log = new PlayedLog();
  assert.equal(log.exportCsv(), "name,path,crate,bpm,key,startedAt,duration\r\n");
});

test("Scratchpad add/has/remove/list dedupe and reject empty ids", () => {
  const pad = new Scratchpad();
  assert.equal(pad.add("a"), true);
  assert.equal(pad.add("a"), false);
  assert.equal(pad.has("a"), true);
  assert.equal(pad.remove("b"), false);
  assert.equal(pad.remove("a"), true);
  assert.equal(pad.has("a"), false);
  assert.throws(() => pad.add(""));
  const seeded = new Scratchpad(["x", "y"]);
  assert.deepEqual(seeded.list(), ["x", "y"]);
});

test("Scratchpad caps at 100 ids", () => {
  const pad = new Scratchpad();
  for (let index = 0; index < 100; index += 1) pad.add(`id-${index}`);
  assert.equal(pad.list().length, 100);
  assert.throws(() => pad.add("id-100"), /full/);
  assert.equal(pad.remove("id-0"), true);
  assert.equal(pad.add("id-100"), true);
});

test("Scratchpad move", () => {
  const pad = new Scratchpad(["a", "b", "c"]);
  assert.equal(pad.move(0, 2), true);
  assert.deepEqual(pad.list(), ["b", "c", "a"]);
  assert.equal(pad.move(9, 0), false);
  assert.equal(pad.move(1.5, 0), false);
  assert.equal(pad.move(0, -1), false);
  assert.equal(pad.move(1, 1), false);
  assert.deepEqual(pad.list(), ["b", "c", "a"]);
});

test("filterTracks matches name, path, crate, key case-insensitively", () => {
  const tracks = [
    { name: "Pick It Up", crate: "House" },
    { name: "Other Song", path: "C:/funk/pick.mp3" },
    { name: "Different", key: "Am" },
    { name: "Nothing" },
  ];
  assert.deepEqual(filterTracks(tracks, "  pick ").map((track) => track.name), ["Pick It Up", "Other Song"]);
  assert.deepEqual(filterTracks(tracks, "HOUSE").map((track) => track.name), ["Pick It Up"]);
  assert.deepEqual(filterTracks(tracks, "AM").map((track) => track.name), ["Different"]);
  assert.deepEqual(filterTracks(tracks, "").map((track) => track.name), tracks.map((track) => track.name));
  assert.deepEqual(filterTracks([], "x"), []);
});

test("sortTracks numeric sorts bpm with missing values last and stays stable", () => {
  const tracks = [
    { name: "a", bpm: 120 },
    { name: "b", bpm: 90 },
    { name: "c" },
    { name: "d", bpm: 120 },
  ];
  assert.deepEqual(sortTracks(tracks, "bpm").map((track) => track.name), ["b", "a", "d", "c"]);
  assert.deepEqual(
    sortTracks(tracks, "bpm", "desc").map((track) => track.name),
    ["a", "d", "b", "c"],
    "missing values stay last in desc too",
  );
  const stable = [
    { name: "x" },
    { name: "y" },
  ];
  assert.deepEqual(sortTracks(stable, "bpm").map((track) => track.name), ["x", "y"]);
});

test("sortTracks duration numeric and title/crate/key alphabetical", () => {
  const tracks = [
    { name: "Bee", duration: 100, crate: "zed" },
    { name: "alpha", duration: 40 },
    { name: "Co", crate: "abc" },
  ];
  assert.deepEqual(sortTracks(tracks, "duration").map((track) => track.name), ["alpha", "Bee", "Co"]);
  assert.deepEqual(sortTracks(tracks, "title").map((track) => track.name), ["alpha", "Bee", "Co"]);
  assert.deepEqual(sortTracks(tracks, "crate").map((track) => track.name), ["Co", "Bee", "alpha"], "missing crate last");
  const keyed = [
    { name: "a", key: "Cm" },
    { name: "b", key: "Am" },
  ];
  assert.deepEqual(sortTracks(keyed, "key").map((track) => track.name), ["b", "a"]);
});

test("sortTracks searches do not mutate the input", () => {
  const tracks = [{ name: "b", bpm: 100 }, { name: "a", bpm: 200 }];
  const sorted = sortTracks(tracks, "bpm");
  assert.deepEqual(sorted.map((track) => track.name), ["b", "a"]);
  assert.deepEqual(tracks.map((track) => track.name), ["b", "a"]);
  assert.notEqual(sorted, tracks);
});

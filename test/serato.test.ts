import assert from "node:assert/strict";
import test from "node:test";
import { readId3, readSeratoGeoB, writeSeratoGeoB } from "../src/renderer/media/serato-id3.ts";
import { readSeratoTagsFromFile } from "../src/renderer/media/serato-file.ts";
import { beatgridTempo, firstSavedLoop } from "../src/renderer/media/serato-import.ts";
import { buildSeratoExport } from "../src/renderer/media/serato-export.ts";
import {
  decodeCrate,
  decodeDatabase,
  decodeNeworder,
  DEFAULT_COLUMNS,
  encodeCrate,
  encodeDatabase,
  encodeNeworder,
  readChunks,
  readText,
  seratoType,
  writeChunk,
  writeText,
} from "../src/renderer/media/serato-codec.ts";
import {
  base64Decode,
  base64Encode,
  decodeBeatGrid,
  decodeMarkers2,
  decodeMarkers_,
  encodeBeatGrid,
  encodeMarkers2,
  encodeMarkers_,
  nearestCueColor,
  serato32Decode,
  serato32Encode,
} from "../src/renderer/media/serato-tags.ts";

const MARKERS2 =
  "AQFBUUZEVDB4UFVnQUFBQUFFQVAvLy8wTlZSUUFBQUFBTkFBQUFBQVFxQU13QUFBQUFBRUpRVFV4UFEwc0FBQUFBQVFBQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const MARKERS_ = "AgUAAAAOAAAACCp/f39/fwB/f39/fwYwAAABAH9/f39/f39/f38Af39/f38AAAAAAAB/f39/f39/f39/AH9/f39/AAAAAAAAf39/f39/f39/fwB/f39/fwAAAAAAAH9/f39/f39/f38Af39/f38AAAAAAAB/f39/f39/f39/AH9/f39/AAAAAAMAf39/f39/f39/fwB/f39/fwAAAAADAH9/f39/f39/f38Af39/f38AAAAAAwB/f39/f39/f39/AH9/f39/AAAAAAMAf39/f39/f39/fwB/f39/fwAAAAADAH9/f39/f39/f38Af39/f38AAAAAAwB/f39/f39/f39/AH9/f39/AAAAAAMAf39/f39/f39/fwB/f39/fwAAAAADAH9/f39/f39/f38Af39/f38AAAAAAwAHf39/";
const BEATGRID = "AQAAAAABP4jnpELOR64=";

function fixture(text: string): Uint8Array {
  return base64Decode(text);
}

test("serato32 round-trips 24-bit values and matches Serato's layout", () => {
  for (const value of [0, 1066, 0xcc0000, 0xffffff, 0x7f7f7f, 0x2a]) {
    assert.equal(serato32Decode(serato32Encode(value)), value);
  }
  assert.deepEqual(serato32Encode(0xcc0000), [0x06, 0x30, 0x00, 0x00]);
});

test("base64 handles Serato's missing padding and line breaks", () => {
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  const encoded = base64Encode(data);
  assert.deepEqual(Array.from(base64Decode(`${encoded.slice(0, 2)}\n${encoded.slice(2)}`)), Array.from(data));
});

test("decodes a Serato-written Markers2 tag", () => {
  const markers = decodeMarkers2(fixture(MARKERS2));
  assert.equal(markers.cues.length, 1);
  assert.equal(markers.cues[0].positionMs, 1066);
  assert.equal(markers.cues[0].color, "#CC0000");
  assert.equal(markers.cues[0].name, "");
  assert.equal(markers.trackColor, "#FFFFFF");
  assert.equal(markers.bpmLocked, false);
});

test("Markers2 round-trips cues, loops, colour and beatgrid lock", () => {
  const source = {
    cues: [
      { index: 0, positionMs: 1066, color: "#CC0000", name: "Intro" },
      { index: 3, positionMs: 64000, color: "#0000CC", name: "" },
    ],
    loops: [
      { index: 0, startMs: 2000, endMs: 4000, color: "#27AAE1", name: "Loop 1", locked: true },
    ],
    trackColor: "#99FF99",
    bpmLocked: true,
  };
  const encoded = encodeMarkers2(source);
  assert.equal(encoded[0], 1);
  assert.equal(encoded[1], 1);
  assert.ok(encoded.length >= 470);
  const decoded = decodeMarkers2(encoded);
  assert.deepEqual(decoded, source);
});

test("decodes a Serato-written Markers_ tag", () => {
  const markers = decodeMarkers_(fixture(MARKERS_));
  assert.equal(markers.cues.length, 1);
  assert.equal(markers.cues[0].positionMs, 1066);
  assert.equal(markers.cues[0].color, "#CC0000");
  assert.equal(markers.trackColor, "#FFFFFF");
});

test("Markers_ writes the documented 14 legacy slots", () => {
  const encoded = encodeMarkers_(decodeMarkers2(fixture(MARKERS2)));
  assert.equal(encoded[0], 0x02);
  assert.equal(encoded[1], 0x05);
  assert.equal(new DataView(encoded.buffer).getUint32(2, false), 14);
  assert.equal(encoded.length, 6 + 14 * 22 + 4);
  const decoded = decodeMarkers_(encoded);
  assert.equal(decoded.cues[0].positionMs, 1066);
});

test("Markers_ round-trips loops without relying on Markers2 labels", () => {
  const source = {
    cues: [{ index: 1, positionMs: 500, color: "#CC8800", name: "" }],
    loops: [{ index: 2, startMs: 1000, endMs: 2500, color: "#27AAE1", name: "Saved", locked: true }],
    trackColor: "#FF99FF",
    bpmLocked: false,
  };
  const decoded = decodeMarkers_(encodeMarkers_(source));
  assert.deepEqual(decoded.cues, source.cues);
  assert.equal(decoded.loops[0].startMs, 1000);
  assert.equal(decoded.loops[0].endMs, 2500);
  assert.equal(decoded.loops[0].locked, true);
  assert.equal(decoded.trackColor, "#FF99FF");
});

test("decodes a Serato-written BeatGrid", () => {
  const markers = decodeBeatGrid(fixture(BEATGRID));
  assert.equal(markers.length, 1);
  assert.ok(Math.abs(markers[0].position - 1.0697) < 0.001);
  assert.ok(Math.abs((markers[0].bpm ?? 0) - 103.14) < 0.01);
});

test("BeatGrid encodes non-terminal beats and a terminal BPM", () => {
  const source = [
    { position: 1.5, beatsTillNext: 4 },
    { position: 9.5, bpm: 128 },
  ];
  const encoded = encodeBeatGrid(source);
  const decoded = decodeBeatGrid(encoded);
  assert.equal(decoded.length, 2);
  assert.ok(Math.abs(decoded[0].position - 1.5) < 1e-6);
  assert.equal(decoded[0].beatsTillNext, 4);
  assert.ok(Math.abs((decoded[1].bpm ?? 0) - 128) < 1e-6);
});

test("cue colours quantise to the 18-value palette", () => {
  assert.equal(nearestCueColor("#CB0101"), "#CC0000");
  assert.equal(nearestCueColor("#2101A0"), "#0000CC");
});

test("crate export writes the exact header and UTF-16BE paths", () => {
  const encoded = encodeCrate(["Music/Artist/Track.mp3"]);
  const chunks = readChunks(encoded);
  assert.equal(chunks[0].tag, "vrsn");
  assert.equal(readText(chunks[0].payload), "1.0/Serato ScratchLive Crate");
  const track = chunks[chunks.length - 1];
  assert.equal(track.tag, "otrk");
  const path = readChunks(track.payload)[0];
  assert.equal(path.tag, "ptrk");
  assert.equal(readText(path.payload), "Music/Artist/Track.mp3");
  const decoded = decodeCrate(encoded);
  assert.deepEqual(decoded.paths, ["Music/Artist/Track.mp3"]);
  assert.deepEqual(decoded.columns, DEFAULT_COLUMNS);
});

test("crate export can omit column layout", () => {
  const encoded = encodeCrate(["A.mp3", "B.wav"], []);
  assert.deepEqual(decodeCrate(encoded).paths, ["A.mp3", "B.wav"]);
  assert.equal(encoded.filter((_, index) => index >= 8).length > 0, true);
});

test("database V2 writes tracks with Serato's type names and flags", () => {
  const encoded = encodeDatabase([
    {
      path: "Music/Artist/Track.wav",
      type: seratoType("Track.wav"),
      title: "Track",
      artist: "Artist",
      bpm: "128.00",
      key: "A",
      beatgridLocked: true,
    },
  ]);
  const decoded = decodeDatabase(encoded);
  assert.equal(decoded.version, "2.0/Serato Scratch LIVE Database");
  assert.equal(decoded.tracks.length, 1);
  assert.equal(decoded.tracks[0].pfil, "Music/Artist/Track.wav");
  assert.equal(decoded.tracks[0].ttyp, "wave");
  assert.equal(decoded.tracks[0].tsng, "Track");
  assert.equal(decoded.tracks[0].bbgl, true);
});

test("neworder lists crates in UTF-16BE", () => {
  const encoded = encodeNeworder(["House", "Drum & Bass"]);
  assert.deepEqual(decodeNeworder(encoded), ["House", "Drum & Bass"]);
});

test("chunk helpers reject tags that are not four characters", () => {
  assert.throws(() => writeChunk("abc", new Uint8Array()), /four characters/);
  const text = writeText("vrsn", "x");
  assert.equal(text.length, 10);
});

function id3v23(frames: Array<{ id: string; data: Uint8Array }>, audio: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const frame of frames) {
    const header = new Uint8Array(10);
    for (let i = 0; i < 4; i += 1) header[i] = frame.id.charCodeAt(i);
    header.set([(frame.data.length >>> 24) & 0xff, (frame.data.length >>> 16) & 0xff, (frame.data.length >>> 8) & 0xff, frame.data.length & 0xff], 4);
    parts.push(header, frame.data);
  }
  const content = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0) + 16);
  let offset = 0;
  for (const part of parts) {
    content.set(part, offset);
    offset += part.length;
  }
  const size = content.length;
  const header = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  const out = new Uint8Array(10 + content.length + audio.length);
  out.set(header);
  out.set(content, 10);
  out.set(audio, 10 + content.length);
  return out;
}

test("ID3 GEOB writer replaces Serato tags and keeps audio bytes", () => {
  const audio = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const title = new Uint8Array([0, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  const input = id3v23([{ id: "TIT2", data: title }], audio);
  const markers = decodeMarkers2(fixture(MARKERS2));
  const markers2 = encodeMarkers2(markers);
  const beatgrid = encodeBeatGrid([{ position: 1, bpm: 120 }]);
  const output = writeSeratoGeoB(input, [
    { description: "Serato Markers2", data: markers2 },
    { description: "Serato BeatGrid", data: beatgrid },
  ]);
  assert.deepEqual(Array.from(output.subarray(output.length - audio.length)), Array.from(audio));
  const tags = readSeratoGeoB(output);
  assert.equal(tags.get("Serato Markers2")?.mime, "application/octet-stream");
  assert.deepEqual(Array.from(tags.get("Serato Markers2")?.data ?? []), Array.from(markers2));
  assert.deepEqual(Array.from(tags.get("Serato BeatGrid")?.data ?? []), Array.from(beatgrid));
  const tag = readId3(output);
  assert.equal(tag?.frames.some((frame) => frame.id === "TIT2"), true);
});

test("ID3 GEOB writer updates an existing Serato frame instead of duplicating it", () => {
  const input = id3v23([], new Uint8Array([1, 2, 3]));
  const first = writeSeratoGeoB(input, [{ description: "Serato Markers_", data: new Uint8Array([1, 2]) }]);
  const second = writeSeratoGeoB(first, [{ description: "Serato Markers_", data: new Uint8Array([3, 4, 5]) }]);
  const tags = readSeratoGeoB(second);
  assert.deepEqual(Array.from(tags.get("Serato Markers_")?.data ?? []), [3, 4, 5]);
  assert.equal(second.subarray(second.length - 3).every((value, index) => value === [1, 2, 3][index]), true);
});

test("ID3 reader refuses unsynchronised tags", () => {
  const input = new Uint8Array(20);
  input.set([0x49, 0x44, 0x33, 3, 0, 0x80, 0, 0, 0, 10]);
  assert.throws(() => readId3(input), /Unsynchronised/);
});
test("reads Serato cues from an MP3 File without reading the audio payload", async () => {
  const audio = new Uint8Array(2048);
  audio.fill(0x55);
  const markers = decodeMarkers2(fixture(MARKERS2));
  const input = writeSeratoGeoB(id3v23([], audio), [
    { description: "Serato Markers2", data: encodeMarkers2(markers) },
  ]);
  const file = new File([input], "track.mp3", { type: "audio/mpeg" });
  const tags = await readSeratoTagsFromFile(file);
  assert.equal(tags?.markers?.cues[0]?.positionMs, 1066);
  assert.equal(tags?.markers?.cues[0]?.color, "#CC0000");
});

test("ignores non-MP3 files for Serato tag lookup", async () => {
  const file = new File([new Uint8Array([1, 2, 3])], "track.wav", { type: "audio/wav" });
  assert.equal(await readSeratoTagsFromFile(file), null);
});

test("BeatGrid gives BPM and phase, saved loops give a valid range", () => {
  const grid = decodeBeatGrid(encodeBeatGrid([{ position: 1.5, beatsTillNext: 4 }, { position: 9.5, bpm: 128 }]));
  assert.deepEqual(beatgridTempo(grid), { bpm: 128, phase: 1.5 });
  assert.equal(beatgridTempo([]), null);
  assert.deepEqual(firstSavedLoop([{ index: 0, startMs: 4000, endMs: 8000, color: "#27AAE1", name: "", locked: false }]), {
    start: 4,
    end: 8,
  });
  assert.equal(firstSavedLoop([{ index: 0, startMs: 8000, endMs: 4000, color: "#27AAE1", name: "", locked: false }]), null);
});

test("Serato export writes database, neworder and relative crate paths", () => {
  const result = buildSeratoExport([
    {
      path: "C:\\Music\\House\\One.mp3",
      crate: "Warmup",
      title: "One",
      artist: "Tester",
      bpm: 124,
      duration: 245.6,
    },
    { path: "C:\\Music\\House\\Two.wav", crate: "Warmup" },
    { path: "C:\\Music\\Techno\\Three.flac", crate: "Peak/Time", key: "8A" },
    { path: "C:\\Music\\House\\One.mp3", crate: "Warmup" },
    { path: "https://example.com/stream", crate: "Stream" },
  ]);

  assert.equal(result.trackCount, 3);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.crates, ["Peak_Time", "Warmup"]);

  const database = decodeDatabase(result.files.get("_Serato_/database V2")!);
  assert.equal(database.tracks.length, 3);
  assert.equal(database.tracks[0].tsng, "One");
  assert.equal(database.tracks[0].tbpm, "124.00");
  assert.equal(database.tracks[0].tlen, "4:05");

  const warmup = decodeCrate(result.files.get("_Serato_/Subcrates/Warmup.crate")!);
  assert.deepEqual(warmup.paths, ["House/One.mp3", "House/Two.wav"]);
  assert.equal(warmup.version, "1.0/Serato ScratchLive Crate");

  const peak = decodeCrate(result.files.get("_Serato_/Subcrates/Peak_Time.crate")!);
  assert.deepEqual(peak.paths, ["Techno/Three.flac"]);

  assert.deepEqual(decodeNeworder(result.files.get("_Serato_/neworder.pref")!), ["Peak_Time", "Warmup"]);
});
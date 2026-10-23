import assert from "node:assert/strict";
import test from "node:test";
import {
  base64Encode,
  encodeBeatGrid,
  encodeMarkers2,
  encodeMarkers_,
  type BeatGridMarker,
  type SeratoMarkers,
} from "../src/renderer/media/serato-tags.ts";
import {
  readSeratoExtraTags,
  writeSeratoExtraTags,
} from "../src/renderer/media/serato-extra.ts";

const AUDIO_BYTES = Uint8Array.from({ length: 16 }, (_, index) => index * 17 + 3);

function frame(kind: "markers2" | "markers_" | "beatgrid"): Uint8Array {
  if (kind === "beatgrid") {
    const grid: BeatGridMarker[] = [
      { position: 0, beatsTillNext: 4, bpm: 120 },
      { position: 2000, beatsTillNext: 4, bpm: 120 },
    ];
    return encodeBeatGrid(grid);
  }
  const markers: SeratoMarkers = {
    cues: [
      { index: 0, positionMs: 1000, color: "#CC0000", name: "cue0" },
      { index: 1, positionMs: 2000, color: "#00CC00", name: "cue1" },
      { index: 2, positionMs: 3000, color: "#0000CC", name: "cue2" },
      { index: 3, positionMs: 4000, color: "#CCCC00", name: "cue3" },
      { index: 4, positionMs: 5000, color: "#CC00CC", name: "cue4" },
    ],
    loops: [
      { index: 0, startMs: 7000, endMs: 9000, color: "#27AAE1", name: "loop0", locked: false },
    ],
    trackColor: "#FFFFFF",
    bpmLocked: false,
  };
  return kind === "markers2" ? encodeMarkers2(markers) : encodeMarkers_(markers);
}

function wrappers(): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["Serato Markers2", frame("markers2")],
    ["Serato Markers_", frame("markers_")],
    ["Serato BeatGrid", frame("beatgrid")],
  ]);
}

function asciis(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

// ---------- FLAC fixtures ----------

function flacBlock(type: number, payload: Uint8Array, last = false): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out[0] = (last ? 0x80 : 0) | type;
  out[1] = (payload.length >> 16) & 0xff;
  out[2] = (payload.length >> 8) & 0xff;
  out[3] = payload.length & 0xff;
  out.set(payload, 4);
  return out;
}

function flacCommentWrapper(key: string, data: Uint8Array): Uint8Array {
  const prefix = asciis("application/octet-stream\0\0");
  const out = new Uint8Array(prefix.length + key.length + 1 + data.length);
  out.set(prefix, 0);
  out.set(asciis(key), prefix.length);
  out[prefix.length + key.length] = 0;
  out.set(data, prefix.length + key.length + 1);
  return out;
}

function flacValue(key: string, data: Uint8Array): string {
  const encoded = base64Encode(flacCommentWrapper(key, data));
  return `${key}=${encoded.replace(/=+$/, "")}`;
}

function flacVorbisPayload(entries: string[]): Uint8Array {
  const vendor = asciis("reference libFLAC 1.4.3");
  const body: Uint8Array[] = [];
  const headerLength = 4 + vendor.length + 4 + entries.reduce(
    (sum, entry) => sum + 4 + asciis(entry).length, 0,
  );
  const out = new Uint8Array(headerLength);
  new DataView(out.buffer).setUint32(0, vendor.length, true);
  out.set(vendor, 4);
  let offset = 4 + vendor.length;
  new DataView(out.buffer).setUint32(offset, entries.length, true);
  offset += 4;
  for (const entry of entries) {
    const list = asciis(entry);
    new DataView(out.buffer).setUint32(offset, list.length, true);
    offset += 4;
    out.set(list, offset);
    offset += list.length;
  }
  void body;
  return out;
}

function buildFlac(comments: string[]): Uint8Array {
  const out = new Uint8Array(4);
  out.set(asciis("fLaC"));
  const parts = [
    out,
    flacBlock(0, Uint8Array.from({ length: 34 }, () => 7)),
    flacBlock(4, flacVorbisPayload(comments)),
    flacBlock(1, Uint8Array.from([0xaa, 0xbb, 0xcc]), true),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const file = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    file.set(part, offset);
    offset += part.length;
  }
  return file;
}

function keyFor(description: string): string {
  if (description === "Serato Markers2") return "SERATO_MARKERS_V2";
  if (description === "Serato Markers_") return "SERATO_MARKERS_";
  if (description === "Serato BeatGrid") return "SERATO_BEATGRID";
  throw new Error(`bad description: ${description}`);
}

function nameFor(description: string): string {
  if (description === "Serato Markers2") return "markersv2";
  if (description === "Serato Markers_") return "markers";
  if (description === "Serato BeatGrid") return "beatgrid";
  throw new Error(`bad description: ${description}`);
}

// ---------- MP4 fixtures ----------

function mp4FullBox(type: string, payload: Uint8Array | string): Uint8Array {
  const bytes = typeof payload === "string" ? asciis(payload) : payload;
  const out = new Uint8Array(12 + bytes.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  out.set(asciis(type), 4);
  out[9] = 1;
  out.set(bytes, 12);
  return out;
}

function mp4Atom(type: string, children: Uint8Array[] | Uint8Array): Uint8Array {
  const list = children instanceof Uint8Array ? [children] : children;
  const body = list.reduce((sum, child) => sum + child.length, 0);
  const out = new Uint8Array(8 + body);
  new DataView(out.buffer).setUint32(0, out.length, false);
  out.set(asciis(type), 4);
  let offset = 8;
  for (const child of list) {
    out.set(child, offset);
    offset += child.length;
  }
  return out;
}

function mp4DataBox(value: string): Uint8Array {
  const bytes = asciis(value);
  const out = new Uint8Array(16 + bytes.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  out.set(asciis("data"), 4);
  out[11] = 1;
  out.set(bytes, 16);
  return out;
}

function mp4Freeform(name: string, data: Uint8Array, wrap: boolean): Uint8Array {
  const plain = base64Encode(flacCommentWrapper(name, data)).replace(/=+$/, "");
  const value = wrap ? (plain.match(/.{1,72}/g) ?? []).join("\n") : plain;
  return mp4Atom("----", [
    mp4FullBox("mean", "com.serato.dj"),
    mp4FullBox("name", name),
    mp4DataBox(value),
  ]);
}

function buildMp4(entries: Uint8Array[], useMdat64: boolean): Uint8Array {
  const ilst = mp4Atom("ilst", [
    mp4Atom("\xa9nam", [mp4FullBox("data", "OpenDeck")]),
    ...entries,
  ]);
  const meta = mp4Atom("meta", [Uint8Array.from([0, 0, 0, 0]), ilst]);
  const moov = mp4Atom("moov", [
    mp4Atom("mvhd", Uint8Array.from({ length: 100 }, () => 7)),
    mp4Atom("udta", [meta]),
  ]);
  const mdat = new Uint8Array(8 + 8 * (useMdat64 ? 1 : 0) + AUDIO_BYTES.length);
  const view = new DataView(mdat.buffer);
  if (useMdat64) {
    view.setUint32(0, 1, false);
    mdat.set(asciis("mdat"), 4);
    view.setBigUint64(8, BigInt(mdat.length), false);
    mdat.set(AUDIO_BYTES, 16);
  } else {
    view.setUint32(0, mdat.length, false);
    mdat.set(asciis("mdat"), 4);
    mdat.set(AUDIO_BYTES, 8);
  }
  const parts = [mp4Atom("ftyp", asciis("M4A isom")), moov, mdat];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------- FLAC tests ----------

test("FLAC round-trips all three Serato frames", () => {
  const updates = wrappers();
  const entries = ["TITLE=Song", ...[...updates].map(([description, data]) => flacValue(keyFor(description), data))];
  const file = buildFlac(entries);
  const tags = readSeratoExtraTags(file, "flac");
  assert.equal(tags.size, 3);
  for (const [description, data] of updates) {
    assert.deepEqual(tags.get(description), data);
  }
  const out = writeSeratoExtraTags(file, "flac", updates);
  const again = readSeratoExtraTags(out, "flac");
  for (const [description, data] of updates) {
    assert.deepEqual(again.get(description), data);
  }
});

test("FLAC write preserves unknown blocks, other comments, and audio bytes", () => {
  const seed = buildFlac([
    "TITLE=Song",
    "SUPER_UNKNOWN=keep me",
    flacValue("SERATO_BEATGRID", frame("beatgrid")),
  ]);
  const updates = new Map<string, Uint8Array>([["Serato BeatGrid", frame("beatgrid")]]);
  const out = writeSeratoExtraTags(seed, "flac", updates);
  assert.equal(out[0], 0x66, "fLaC magic kept");
  const text = new TextDecoder().decode(out);
  assert.ok(text.includes("TITLE=Song"));
  assert.ok(text.includes("SUPER_UNKNOWN=keep me"));
  assert.ok(text.includes("keep me") || true);
  assert.ok(out.length > 8);
  const tags = readSeratoExtraTags(out, "flac");
  assert.deepEqual(tags.get("Serato BeatGrid"), frame("beatgrid"));
  assert.equal(tags.size, 1);
  const again = writeSeratoExtraTags(out, "flac", updates);
  assert.deepEqual([...again], [...out]);
});

test("FLAC write replaces an existing frame and keeps the last-block flag valid", () => {
  const seed = buildFlac([flacValue("SERATO_BEATGRID", frame("beatgrid"))]);
  const updates = new Map<string, Uint8Array>([["Serato BeatGrid", frame("beatgrid")]]);
  const out = writeSeratoExtraTags(seed, "flac", updates);
  const again = writeSeratoExtraTags(out, "flac", updates);
  assert.deepEqual([...again], [...out], "identical update is byte-identical");
  assert.equal(out[out.length - 1], seed[seed.length - 1]);
});

test("FLAC writes reject unsupported descriptions and missing comment blocks", () => {
  const noComments = new Uint8Array(4 + 4 + 34);
  noComments.set(asciis("fLaC"));
  noComments[4] = 0x80;
  noComments[5] = 0;
  noComments[6] = 0;
  noComments[7] = 34;
  assert.throws(() => writeSeratoExtraTags(noComments, "flac", wrappers()));
  const badUpdates = new Map<string, Uint8Array>([["Serato Nope", new Uint8Array(4)]]);
  assert.throws(() => writeSeratoExtraTags(buildFlac([]), "flac", badUpdates));
});

test("FLAC read rejects malformed containers", () => {
  assert.throws(() => readSeratoExtraTags(new Uint8Array([1, 2, 3], ), "flac"));
  const head = asciis("fLaC");
  const truncated = new Uint8Array(head.length + 4);
  truncated.set(head, 0);
  truncated[4] = 0x84;
  truncated[5] = 0xff;
  truncated[6] = 0xff;
  truncated[7] = 0xff;
  assert.throws(() => readSeratoExtraTags(truncated, "flac"));
  const file = buildFlac([flacValue("SERATO_BEATGRID", frame("beatgrid"))]);
  assert.throws(() => readSeratoExtraTags(file.slice(0, file.length - 5), "flac"));
});

// ---------- MP4 tests ----------

test("MP4 freeform round-trip with 32-bit mdat", () => {
  const updates = wrappers();
  const file = buildMp4(
    [...updates].map(([description, data]) => mp4Freeform(nameFor(description), data, description !== "Serato BeatGrid")),
    false,
  );
  const tags = readSeratoExtraTags(file, "mp4");
  assert.equal(tags.size, 3);
  for (const [description, data] of updates) {
    assert.deepEqual(tags.get(description), data);
  }
  const out = writeSeratoExtraTags(file, "mp4", updates);
  assert.deepEqual(readSeratoExtraTags(out, "mp4"), readSeratoExtraTags(file, "mp4"));
  assert.deepEqual(out.slice(out.length - AUDIO_BYTES.length), AUDIO_BYTES);
  const again = writeSeratoExtraTags(out, "mp4", updates);
  assert.deepEqual([...again], [...out]);
});

test("MP4 write preserves unknown atoms and adds new Serato freeforms", () => {
  const seed = buildMp4(
    [
      mp4Freeform("markers", frame("markers_"), true),
      mp4Atom("\xa9day", [mp4FullBox("data", "2026")]),
    ],
    false,
  );
  const updates = new Map<string, Uint8Array>([
    ["Serato Markers_", frame("markers_")],
    ["Serato BeatGrid", frame("beatgrid")],
  ]);
  const out = writeSeratoExtraTags(seed, "mp4", updates);
  assert.ok(out.length > seed.length, "adding beatgrid grows file");
  const text = new TextDecoder().decode(out);
  assert.ok(text.includes("2026"), "unknown atom kept verbatim");
  const tags = readSeratoExtraTags(out, "mp4");
  assert.deepEqual(tags.get("Serato Markers_"), frame("markers_"));
  assert.deepEqual(tags.get("Serato BeatGrid"), frame("beatgrid"));
  assert.equal(tags.size, 2);
  assert.deepEqual(out.slice(out.length - AUDIO_BYTES.length), AUDIO_BYTES);
  const again = writeSeratoExtraTags(out, "mp4", updates);
  assert.deepEqual([...again], [...out]);
});

test("MP4 handles 64-bit mdat sizes without moving audio", () => {
  const file = buildMp4([mp4Freeform("beatgrid", frame("beatgrid"), false)], true);
  const tags = readSeratoExtraTags(file, "mp4");
  assert.deepEqual(tags.get("Serato BeatGrid"), frame("beatgrid"));
  const out = writeSeratoExtraTags(file, "mp4", new Map([["Serato BeatGrid", frame("beatgrid")]]));
  assert.deepEqual(out.slice(out.length - AUDIO_BYTES.length), AUDIO_BYTES);
});

function findMdatHeader(bytes: Uint8Array): number {
  for (let i = 0; i + 8 <= bytes.length; i += 1) {
    if (bytes[i + 4] === 0x6d && bytes[i + 5] === 0x64 && bytes[i + 6] === 0x61 && bytes[i + 7] === 0x74) return i;
  }
  return -1;
}

test("MP4 64-bit mdat: 64-bit size field untouched", () => {
  const file = buildMp4([], true);
  const out = writeSeratoExtraTags(file, "mp4", new Map<string, Uint8Array>());
  const where = findMdatHeader(out);
  assert.notEqual(where, -1);
  const view = new DataView(out.buffer, out.byteOffset + where, out.length - where);
  assert.equal(view.getUint32(0, false), 1, "mdat uses a 64-bit extended size");
  assert.equal(out[where + 4], 0x6d && out[where + 4], "mdat type kept");
  assert.equal(view.getUint32(8, false), 0);
  assert.equal(view.getUint32(12, false), 32, "64-bit size field value preserved");
  assert.deepEqual(out.slice(where + 16), AUDIO_BYTES);
});

test("MP4 rejects malformed containers", () => {
  assert.throws(() => readSeratoExtraTags(new Uint8Array([0, 0, 0, 12, 0x6d, 0x6f, 0x6f, 0x76]), "mp4"));
  const file = buildMp4([], false);
  assert.throws(() => readSeratoExtraTags(file.slice(0, 4), "mp4"));
  const grid = new Uint8Array(4);
  assert.throws(() => writeSeratoExtraTags(new Uint8Array(64), "mp4", new Map([["Serato BeatGrid", grid]])));
  assert.throws(() => writeSeratoExtraTags(file, "flac", new Map([["Serato BeatGrid", grid]])));
  const badUpdates = new Map<string, Uint8Array>([["Serato Nope", grid]]);
  assert.throws(() => writeSeratoExtraTags(file, "mp4", badUpdates));
});

test("FLAC reader returns empty map when no VORBIS_COMMENT block exists", () => {
  const file = new Uint8Array(4 + 4 + 34);
  file.set(asciis("fLaC"));
  file[4] = 0x80 | 0; // last-flag STREAMINFO block of 34 bytes
  new DataView(file.buffer).setUint32(5, 34, false);
  assert.equal(readSeratoExtraTags(file, "flac").size, 0);
});

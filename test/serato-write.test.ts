import assert from "node:assert/strict";
import test from "node:test";
import { readSeratoGeoB } from "../src/renderer/media/serato-id3.ts";
import { readRiffId3 } from "../src/renderer/media/serato-riff.ts";
import { decodeMarkers2, type SeratoMarkers } from "../src/renderer/media/serato-tags.ts";
import {
  rewriteSeratoTags,
  sameBytes,
  seratoAudioPayload,
  seratoContainer,
  seratoTagUpdates,
} from "../src/renderer/media/serato-write.ts";

const markers: SeratoMarkers = {
  cues: [
    { index: 0, positionMs: 1000, color: "#CC0000", name: "Intro" },
    { index: 7, positionMs: 60000, color: "#0000CC", name: "Outro" },
  ],
  loops: [{ index: 0, startMs: 2000, endMs: 4000, color: "#27AAE1", name: "", locked: true }],
  trackColor: "#99FF99",
  bpmLocked: true,
};

function id3(audio: Uint8Array): Uint8Array {
  return new Uint8Array([...new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]), ...audio]);
}

function riffChunk(id: string, payload: Uint8Array, little: boolean): Uint8Array {
  const out = new Uint8Array(8 + payload.length + (payload.length & 1));
  for (let index = 0; index < 4; index += 1) out[index] = id.charCodeAt(index);
  new DataView(out.buffer).setUint32(4, payload.length, little);
  out.set(payload, 8);
  return out;
}

function riff(kind: "wav" | "aiff", chunks: Uint8Array[]): Uint8Array {
  const body = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(12 + body);
  const magic = kind === "wav" ? "RIFF" : "FORM";
  const form = kind === "wav" ? "WAVE" : "AIFF";
  for (let index = 0; index < 4; index += 1) {
    out[index] = magic.charCodeAt(index);
    out[8 + index] = form.charCodeAt(index);
  }
  new DataView(out.buffer).setUint32(4, out.length - 8, kind === "wav");
  let offset = 12;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

test("container detection covers the five writable formats", () => {
  assert.equal(seratoContainer("a.mp3"), "mp3");
  assert.equal(seratoContainer("a.wav"), "wav");
  assert.equal(seratoContainer("a.aif"), "aiff");
  assert.equal(seratoContainer("a.flac"), "flac");
  assert.equal(seratoContainer("a.m4a"), "mp4");
  assert.equal(seratoContainer("a.ogg"), null);
});

test("MP3 write keeps the audio payload and writes both marker frames", () => {
  const audio = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const input = id3(audio);
  const output = rewriteSeratoTags(input, "mp3", seratoTagUpdates(markers, [{ position: 1, bpm: 128 }]));
  assert.ok(sameBytes(seratoAudioPayload(input, "mp3"), seratoAudioPayload(output, "mp3")));
  const tags = readSeratoGeoB(output);
  assert.ok(tags.has("Serato Markers2"));
  assert.ok(tags.has("Serato Markers_"));
  assert.ok(tags.has("Serato BeatGrid"));
  assert.deepEqual(decodeMarkers2(tags.get("Serato Markers2")!.data), markers);
});

test("WAV and AIFF writes keep every non-ID3 chunk", () => {
  for (const kind of ["wav", "aiff"] as const) {
    const little = kind === "wav";
    const input = riff(kind, [
      riffChunk("fmt ", new Uint8Array([1, 0, 2, 0]), little),
      riffChunk("data", new Uint8Array([1, 2, 3, 4]), little),
    ]);
    const output = rewriteSeratoTags(input, kind, seratoTagUpdates(markers, null));
    assert.ok(sameBytes(seratoAudioPayload(input, kind), seratoAudioPayload(output, kind)));
    const tag = readRiffId3(output, kind);
    assert.ok(tag);
    assert.ok(readSeratoGeoB(tag).has("Serato Markers2"));
  }
});

test("a second identical write is byte-identical", () => {
  const input = id3(new Uint8Array([1, 2, 3]));
  const updates = seratoTagUpdates(markers, null);
  const once = rewriteSeratoTags(input, "mp3", updates);
  const twice = rewriteSeratoTags(once, "mp3", updates);
  assert.ok(sameBytes(once, twice));
});

function flacBlock(type: number, payload: Uint8Array, last: boolean): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out[0] = (last ? 0x80 : 0) | type;
  out[1] = (payload.length >> 16) & 0xff;
  out[2] = (payload.length >> 8) & 0xff;
  out[3] = payload.length & 0xff;
  out.set(payload, 4);
  return out;
}

function flacWithAudio(): Uint8Array {
  const audio = new Uint8Array([0xf8, 0xff, 0x12, 0x34, 0x56, 0x78]);
  const parts = [
    Uint8Array.from([0x66, 0x4c, 0x61, 0x43]),
    flacBlock(0, new Uint8Array(34), false),
    flacBlock(4, new Uint8Array(8), true),
    audio,
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function atom(type: string, children: Uint8Array[]): Uint8Array {
  const body = children.reduce((sum, child) => sum + child.length, 0);
  const out = new Uint8Array(8 + body);
  new DataView(out.buffer).setUint32(0, out.length, false);
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
  let offset = 8;
  for (const child of children) {
    out.set(child, offset);
    offset += child.length;
  }
  return out;
}

function mp4WithAudio(): Uint8Array {
  const audio = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const mdat = atom("mdat", [audio]);
  const ilst = atom("ilst", []);
  const meta = atom("meta", [new Uint8Array(4), ilst]);
  const moov = atom("moov", [atom("udta", [meta])]);
  const ftyp = atom("ftyp", [Uint8Array.from([0x4d, 0x34, 0x41, 0x20])]);
  const out = new Uint8Array(ftyp.length + moov.length + mdat.length);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  out.set(mdat, ftyp.length + moov.length);
  return out;
}

test("FLAC writes keep the audio stream and embed both marker frames", () => {
  const input = flacWithAudio();
  const output = rewriteSeratoTags(input, "flac", seratoTagUpdates(markers, null));
  assert.ok(sameBytes(seratoAudioPayload(input, "flac"), seratoAudioPayload(output, "flac")));
  assert.ok(output.length > input.length);
});

test("MP4 writes keep the mdat payload and embed both marker frames", () => {
  const input = mp4WithAudio();
  const output = rewriteSeratoTags(input, "mp4", seratoTagUpdates(markers, null, "mp4"));
  assert.ok(sameBytes(seratoAudioPayload(input, "mp4"), seratoAudioPayload(output, "mp4")));
  assert.ok(output.length > input.length);
});

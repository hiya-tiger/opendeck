export interface SeratoCue {
  index: number;
  positionMs: number;
  color: string;
  name: string;
}

export interface SeratoLoop {
  index: number;
  startMs: number;
  endMs: number;
  color: string;
  name: string;
  locked: boolean;
}

export interface SeratoMarkers {
  cues: SeratoCue[];
  loops: SeratoLoop[];
  trackColor: string;
  bpmLocked: boolean;
}

export interface BeatGridMarker {
  position: number;
  beatsTillNext?: number;
  bpm?: number;
}

export const CUE_PALETTE = [
  "#CC0000", "#CC4400", "#CC8800", "#CCCC00",
  "#88CC00", "#44CC00", "#00CC00", "#00CC44",
  "#00CC88", "#00CCCC", "#0088CC", "#0044CC",
  "#0000CC", "#4400CC", "#8800CC", "#CC00CC",
  "#CC0088", "#CC0044",
];

export const DEFAULT_SLOT_COLORS = [0, 2, 12, 3, 6, 15, 9, 14].map((index) => CUE_PALETTE[index]);
export const LOOP_COLOR = "#27AAE1";
export const NO_TRACK_COLOR = "#FFFFFF";
export const MARKERS2_MIN_SIZE = 470;

const NUM_CUES = 5;
const NUM_LOOPS = 9;
const NO_POSITION = 0x7f7f7f7f;

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error(`Invalid RGB color: ${hex}`);
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export function nearestCueColor(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  let best = CUE_PALETTE[0];
  let bestDistance = Infinity;
  for (const candidate of CUE_PALETTE) {
    const [cr, cg, cb] = hexToRgb(candidate);
    const distance = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

export function serato32Encode(value: number): [number, number, number, number] {
  const a = (value >> 16) & 0xff;
  const b = (value >> 8) & 0xff;
  const c = value & 0xff;
  const z = c & 0x7f;
  const y = ((c >> 7) | (b << 1)) & 0x7f;
  const x = ((b >> 6) | (a << 2)) & 0x7f;
  const w = (a >> 5) & 0x7f;
  return [w, x, y, z];
}

export function serato32Decode(bytes: ArrayLike<number>, offset = 0): number {
  const w = bytes[offset];
  const x = bytes[offset + 1];
  const y = bytes[offset + 2];
  const z = bytes[offset + 3];
  const c = (z & 0x7f) | ((y & 0x01) << 7);
  const b = ((y & 0x7f) >> 1) | ((x & 0x03) << 6);
  const a = ((x & 0x7f) >> 2) | ((w & 0x07) << 5);
  return (a << 16) | (b << 8) | c;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64[(triple >> 18) & 63];
    out += BASE64[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(triple >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? BASE64[triple & 63] : "=";
  }
  return out;
}

export function base64Decode(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, "");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const a = BASE64.indexOf(clean[i]);
    const b = BASE64.indexOf(clean[i + 1]);
    const c = clean[i + 2] === "=" || clean[i + 2] === undefined ? 0 : BASE64.indexOf(clean[i + 2]);
    const d = clean[i + 3] === "=" || clean[i + 3] === undefined ? 0 : BASE64.indexOf(clean[i + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error("Invalid base64");
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    out.push((triple >> 16) & 0xff);
    if (clean[i + 2] !== "=" && clean[i + 2] !== undefined) out.push((triple >> 8) & 0xff);
    if (clean[i + 3] !== "=" && clean[i + 3] !== undefined) out.push(triple & 0xff);
  }
  return new Uint8Array(out);
}

function wrap72(text: string): string {
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += 72) lines.push(text.slice(i, i + 72));
  return lines.join("\n");
}

function encodeInnerBase64(inner: Uint8Array): string {
  let data = inner;
  if (data.length % 3) {
    const padded = new Uint8Array(data.length + (3 - (data.length % 3)));
    padded.set(data);
    data = padded;
  }
  return wrap72(base64Encode(data).replace(/=+$/, ""));
}

function bytes(...parts: Array<number[] | Uint8Array>): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part instanceof Uint8Array ? part : Uint8Array.from(part), offset);
    offset += part.length;
  }
  return out;
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function entry(name: string, data: Uint8Array): Uint8Array {
  return bytes(textBytes(name), [0], u32(data.length), data);
}

function markers2Inner(markers: SeratoMarkers): Uint8Array {
  const parts: Uint8Array[] = [bytes([1, 1]), entry("COLOR", bytes([0], hexToRgb(markers.trackColor)))];
  for (const cue of [...markers.cues].sort((a, b) => a.index - b.index)) {
    parts.push(
      entry(
        "CUE",
        bytes(
          [0, cue.index & 0xff],
          u32(cue.positionMs >>> 0),
          [0],
          hexToRgb(cue.color),
          [0, 0],
          textBytes(cue.name.slice(0, 51)),
          [0],
        ),
      ),
    );
  }
  for (const loop of [...markers.loops].sort((a, b) => a.index - b.index)) {
    parts.push(
      entry(
        "LOOP",
        bytes(
          [0, loop.index & 0xff],
          u32(loop.startMs >>> 0),
          u32(loop.endMs >>> 0),
          [0xff, 0xff, 0xff, 0xff, 0],
          hexToRgb(loop.color),
          [0, loop.locked ? 1 : 0],
          textBytes(loop.name.slice(0, 32747)),
          [0],
        ),
      ),
    );
  }
  parts.push(entry("BPMLOCK", bytes([markers.bpmLocked ? 1 : 0])));
  parts.push(bytes([0]));
  return bytes(...parts);
}

export function encodeMarkers2(markers: SeratoMarkers, minSize = MARKERS2_MIN_SIZE): Uint8Array {
  const body = bytes([1, 1], textBytes(encodeInnerBase64(markers2Inner(markers))));
  const size = Math.max(minSize, body.length + 1);
  const out = new Uint8Array(size);
  out.set(body);
  return out;
}

function readU32(bytesIn: Uint8Array, offset: number): number {
  return (
    ((bytesIn[offset] << 24) | (bytesIn[offset + 1] << 16) | (bytesIn[offset + 2] << 8) | bytesIn[offset + 3]) >>> 0
  );
}

export function decodeMarkers2(raw: Uint8Array): SeratoMarkers {
  if (raw.length < 2 || raw[0] !== 1 || raw[1] !== 1) throw new Error("Bad Serato Markers2 header");
  let end = raw.indexOf(0, 2);
  if (end < 0) end = raw.length;
  let text = "";
  for (let i = 2; i < end; i += 1) text += String.fromCharCode(raw[i]);
  text = text.replace(/[\r\n]/g, "");
  const remainder = text.length % 4;
  if (remainder === 1) text += "A==";
  else if (remainder) text += "=".repeat(4 - remainder);
  const inner = base64Decode(text);
  if (inner.length < 2 || inner[0] !== 1 || inner[1] !== 1) throw new Error("Bad Serato Markers2 payload");

  const markers: SeratoMarkers = { cues: [], loops: [], trackColor: NO_TRACK_COLOR, bpmLocked: false };
  let offset = 2;
  while (offset < inner.length) {
    let nameEnd = offset;
    while (nameEnd < inner.length && inner[nameEnd] !== 0) nameEnd += 1;
    if (nameEnd === offset) break;
    let name = "";
    for (let i = offset; i < nameEnd; i += 1) name += String.fromCharCode(inner[i]);
    offset = nameEnd + 1;
    if (offset + 4 > inner.length) break;
    const length = readU32(inner, offset);
    offset += 4;
    const data = inner.subarray(offset, offset + length);
    offset += length;

    if (name === "COLOR" && data.length >= 4) {
      markers.trackColor = rgbToHex(data[1], data[2], data[3]);
    } else if (name === "BPMLOCK" && data.length >= 1) {
      markers.bpmLocked = data[0] !== 0;
    } else if (name === "CUE" && data.length >= 13) {
      let nameEnd2 = 12;
      while (nameEnd2 < data.length && data[nameEnd2] !== 0) nameEnd2 += 1;
      markers.cues.push({
        index: data[1],
        positionMs: readU32(data, 2),
        color: rgbToHex(data[7], data[8], data[9]),
        name: new TextDecoder().decode(data.subarray(12, nameEnd2)),
      });
    } else if (name === "LOOP" && data.length >= 20) {
      let nameEnd2 = 20;
      while (nameEnd2 < data.length && data[nameEnd2] !== 0) nameEnd2 += 1;
      markers.loops.push({
        index: data[1],
        startMs: readU32(data, 2),
        endMs: readU32(data, 6),
        color: rgbToHex(data[15], data[16], data[17]),
        locked: data[19] !== 0,
        name: new TextDecoder().decode(data.subarray(20, nameEnd2)),
      });
    }
  }
  return markers;
}

function legacyCue(markers: SeratoMarkers, index: number): SeratoCue | undefined {
  return markers.cues.find((cue) => cue.index === index);
}

function legacyLoop(markers: SeratoMarkers, index: number): SeratoLoop | undefined {
  return markers.loops.find((loop) => loop.index === index);
}

function colorValue(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (r << 16) | (g << 8) | b;
}

export function encodeMarkers_(markers: SeratoMarkers): Uint8Array {
  const parts: Uint8Array[] = [bytes([0x02, 0x05], u32(NUM_CUES + NUM_LOOPS))];
  const unset = bytes([0x7f], u32(NO_POSITION), [0x7f], u32(NO_POSITION), [0x00, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f], [0, 0, 0, 0]);
  for (let i = 0; i < NUM_CUES; i += 1) {
    const cue = legacyCue(markers, i);
    if (!cue) {
      parts.push(bytes(unset, [0x00, 0x00]));
    } else {
      parts.push(
        bytes(
          [0x00],
          serato32Encode(cue.positionMs & 0xffffff),
          [0x7f],
          [0x7f, 0x7f, 0x7f, 0x7f],
          [0x00, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f],
          serato32Encode(colorValue(cue.color)),
          [0x01, 0x00],
        ),
      );
    }
  }
  for (let i = 0; i < NUM_LOOPS; i += 1) {
    const loop = legacyLoop(markers, i);
    if (!loop) {
      parts.push(bytes(unset, [0x03, 0x00]));
    } else {
      parts.push(
        bytes(
          [0x00],
          serato32Encode(loop.startMs & 0xffffff),
          [0x00],
          serato32Encode(loop.endMs & 0xffffff),
          [0x00, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f],
          [0, 0, 0, 0],
          [0x03, loop.locked ? 0x01 : 0x00],
        ),
      );
    }
  }
  parts.push(bytes(serato32Encode(colorValue(markers.trackColor))));
  return bytes(...parts);
}

export function decodeMarkers_(raw: Uint8Array): SeratoMarkers {
  if (raw.length < 6 + 14 * 22 + 4) throw new Error("Serato Markers_ is too short");
  const version = (raw[0] << 8) | raw[1];
  if (version !== 0x0205) throw new Error("Bad Serato Markers_ version");
  const count = readU32(raw, 2);
  const markers: SeratoMarkers = { cues: [], loops: [], trackColor: NO_TRACK_COLOR, bpmLocked: false };
  for (let i = 0; i < count; i += 1) {
    const offset = 6 + i * 22;
    if (offset + 22 > raw.length) break;
    const hasStart = raw[offset] === 0x00;
    const hasEnd = raw[offset + 5] === 0x00;
    const start = hasStart ? serato32Decode(raw, offset + 1) : 0;
    const end = hasEnd ? serato32Decode(raw, offset + 6) : 0;
    const color = serato32Decode(raw, offset + 16);
    const type = raw[offset + 20];
    const locked = raw[offset + 21] !== 0;
    if (i < NUM_CUES) {
      if (hasStart && type === 1) {
        markers.cues.push({
          index: i,
          positionMs: start,
          color: rgbToHex((color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff),
          name: "",
        });
      }
    } else if (hasStart && hasEnd && type === 3) {
      markers.loops.push({
        index: i - NUM_CUES,
        startMs: start,
        endMs: end,
        color: rgbToHex((color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff),
        name: "",
        locked,
      });
    }
  }
  const footer = 6 + count * 22;
  if (footer + 4 <= raw.length) {
    const color = serato32Decode(raw, footer);
    markers.trackColor = rgbToHex((color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);
  }
  return markers;
}

export function encodeBeatGrid(markers: BeatGridMarker[]): Uint8Array {
  if (!markers.length) return new Uint8Array(0);
  const parts: Uint8Array[] = [bytes([0x01, 0x00], u32(markers.length))];
  const view = new DataView(new ArrayBuffer(4));
  for (const marker of markers.slice(0, -1)) {
    view.setFloat32(0, marker.position, false);
    parts.push(bytes(new Uint8Array(view.buffer.slice(0)), u32(Math.max(1, marker.beatsTillNext ?? 1))));
  }
  const last = markers[markers.length - 1];
  view.setFloat32(0, last.position, false);
  const position = new Uint8Array(view.buffer.slice(0));
  view.setFloat32(0, last.bpm ?? 0, false);
  parts.push(bytes(position, new Uint8Array(view.buffer.slice(0))));
  return bytes(...parts);
}

export function decodeBeatGrid(raw: Uint8Array): BeatGridMarker[] {
  if (raw.length < 6) return [];
  const version = (raw[0] << 8) | raw[1];
  if (version !== 0x0100) throw new Error("Bad Serato BeatGrid version");
  const count = readU32(raw, 2);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const markers: BeatGridMarker[] = [];
  for (let i = 0; i < count; i += 1) {
    const offset = 6 + i * 8;
    if (offset + 8 > raw.length) break;
    const position = view.getFloat32(offset, false);
    if (i === count - 1) {
      markers.push({ position, bpm: view.getFloat32(offset + 4, false) });
    } else {
      markers.push({ position, beatsTillNext: view.getUint32(offset + 4, false) });
    }
  }
  return markers;
}

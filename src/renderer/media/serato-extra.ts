import { base64Decode, base64Encode } from "./serato-tags.ts";
import type { SeratoTextMeta } from "./serato-id3.ts";

export type SeratoExtraKind = "flac" | "mp4";

const FLAC_MAGIC = [0x66, 0x4c, 0x61, 0x43]; // "fLaC"
const FLAC_VORBIS_COMMENT = 4;
const WRAPPER_PREFIX = [0x61, 0x70, 0x70, 0x6c, 0x69, 0x63, 0x61, 0x74, 0x69, 0x6f, 0x6e, 0x2f, 0x6f, 0x63, 0x74, 0x65, 0x74, 0x2d, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x00, 0x00]; // "application/octet-stream\0\0"
const WRAP_CHUNK = 72;
const MARKERS2 = "Serato Markers2";
const MARKERS_ = "Serato Markers_";
const BEATGRID = "Serato BeatGrid";
const FLAC_KEYS = new Map<string, string>([
  ["SERATO_MARKERS_V2", MARKERS2],
  ["SERATO_MARKERS_", MARKERS_],
  ["SERATO_BEATGRID", BEATGRID],
]);
const DESCRIPTION_TO_FLAC_KEY = new Map<string, string>([
  [MARKERS2, "SERATO_MARKERS_V2"],
  [MARKERS_, "SERATO_MARKERS_"],
  [BEATGRID, "SERATO_BEATGRID"],
]);
const MP4_NAMES = new Map<string, string>([
  ["markersv2", MARKERS2],
  ["markers", MARKERS_],
  ["beatgrid", BEATGRID],
]);
const DESCRIPTION_TO_MP4_NAME = new Map<string, string>([
  [MARKERS2, "markersv2"],
  [MARKERS_, "markers"],
  [BEATGRID, "beatgrid"],
]);
export const SERATO_MP4_ATOM_PREFIX = "----:com.serato.dj:";
const MP4_MEAN = "com.serato.dj";

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function requireAscii(bytes: Uint8Array, start: number, end: number, where: string): string {
  const text = ascii(bytes, start, end);
  for (let i = start; i < end; i += 1) {
    if (bytes[i] < 0x20 || bytes[i] > 0x7e) throw new Error(`Serato tag: non-ASCII byte in ${where}`);
  }
  return text;
}

function tolerantAscii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i += 1) {
    if (bytes[i] > 0x7e || (bytes[i] < 0x20 && bytes[i] !== 0x09 && bytes[i] !== 0x0a && bytes[i] !== 0x0d)) {
      throw new Error(`Serato tag: invalid byte in base64 value`);
    }
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function wrapFrameBytes(description: string, data: Uint8Array): Uint8Array {
  const desc = new Uint8Array(description.length + 1);
  for (let i = 0; i < description.length; i += 1) desc[i] = description.charCodeAt(i);
  desc[description.length] = 0;
  const parts: Uint8Array[] = [Uint8Array.from(WRAPPER_PREFIX), desc, data];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function unwrapFrameBytes(bytes: Uint8Array, where: string): { description: string; data: Uint8Array } {
  if (bytes.length < WRAPPER_PREFIX.length + 2) {
    throw new Error(`Serato tag: truncated value in ${where}`);
  }
  for (let i = 0; i < WRAPPER_PREFIX.length; i += 1) {
    if (bytes[i] !== WRAPPER_PREFIX[i]) throw new Error(`Serato tag: unexpected value prefix in ${where}`);
  }
  let cursor = WRAPPER_PREFIX.length;
  while (cursor < bytes.length && bytes[cursor] !== 0) cursor += 1;
  if (cursor >= bytes.length) throw new Error(`Serato tag: unterminated description in ${where}`);
  const description = requireAscii(bytes, WRAPPER_PREFIX.length, cursor, where);
  return { description, data: bytes.slice(cursor + 1) };
}

function b64EncodeField(data: Uint8Array, wrap: boolean): string {
  const plain = base64Encode(data).replace(/=+$/, "");
  if (!wrap) return plain;
  const lines: string[] = [];
  for (let i = 0; i < plain.length; i += WRAP_CHUNK) lines.push(plain.slice(i, i + WRAP_CHUNK));
  return lines.join("\n");
}

function b64DecodeField(value: string, where: string): Uint8Array {
  const text = value.replace(/[\r\n\s]/g, "");
  if (text.length === 0) throw new Error(`Serato tag: empty base64 value in ${where}`);
  if (text.includes("=")) throw new Error(`Serato tag: padded base64 value in ${where}`);
  let clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  if (clean.length !== text.length) throw new Error(`Serato tag: invalid base64 character in ${where}`);
  if (clean.length % 4 === 1) clean = clean.slice(0, -1);
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  return base64Decode(padded);
}

interface FlacBlock {
  type: number;
  isLast: boolean;
  headerStart: number;
  dataStart: number;
  dataEnd: number;
}

function parseFlacBlocks(bytes: Uint8Array): FlacBlock[] {
  if (bytes.length < 8 || bytes[0] !== FLAC_MAGIC[0] || bytes[1] !== FLAC_MAGIC[1] || bytes[2] !== FLAC_MAGIC[2] || bytes[3] !== FLAC_MAGIC[3]) {
    throw new Error("Not a FLAC file: missing fLaC magic");
  }
  const blocks: FlacBlock[] = [];
  let offset = 4;
  for (;;) {
    if (offset + 4 > bytes.length) throw new Error("Truncated FLAC metadata block header");
    const header = bytes[offset];
    const type = header & 0x7f;
    const size = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const dataStart = offset + 4;
    if (dataStart + size > bytes.length) throw new Error(`Truncated FLAC metadata block of type ${type}`);
    blocks.push({ type, isLast: (header & 0x80) !== 0, headerStart: offset, dataStart, dataEnd: dataStart + size });
    if ((header & 0x80) !== 0) {
      return blocks;
    }
    offset = dataStart + size;
  }
}

interface FlacComments {
  vendor: Uint8Array;
  comments: Array<{ key: string; value: string }>;
}

function parseFlacComments(bytes: Uint8Array, start: number, end: number): FlacComments {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  let offset = 0;
  const readU32 = () => {
    if (offset + 4 > view.byteLength) throw new Error("Truncated FLAC vorbis comment");
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const vendorLength = readU32();
  if (offset + vendorLength > view.byteLength) throw new Error("Truncated FLAC vendor string");
  const vendor = bytes.slice(start + offset, start + offset + vendorLength);
  offset += vendorLength;
  const count = readU32();
  if (count > (view.byteLength - offset) / 4) throw new Error("Implausible FLAC vorbis comment count");
  const comments: Array<{ key: string; value: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const length = readU32();
    if (offset + length > view.byteLength) throw new Error("Truncated FLAC vorbis comment");
    const text = tolerantAscii(bytes, start + offset, start + offset + length);
    offset += length;
    const equals = text.indexOf("=");
    if (equals < 1) throw new Error("FLAC vorbis comment without KEY=VALUE separator");
    comments.push({ key: text.slice(0, equals), value: text.slice(equals + 1) });
  }
  if (offset !== view.byteLength) throw new Error("Trailing bytes in FLAC vorbis comment block");
  return { vendor, comments };
}

function buildFlacCommentBlock(comments: FlacComments): Uint8Array {
  const items = comments.comments.map(({ key, value }) => {
    const encoded = new TextEncoder().encode(`${key}=${value}`);
    const item = new Uint8Array(4 + encoded.length);
    new DataView(item.buffer).setUint32(0, encoded.length, true);
    item.set(encoded, 4);
    return item;
  });
  const payloadLength = 4 + comments.vendor.length + 4 + items.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(payloadLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, comments.vendor.length, true);
  out.set(comments.vendor, 4);
  let offset = 4 + comments.vendor.length;
  view.setUint32(offset, items.length, true);
  offset += 4;
  for (const item of items) {
    out.set(item, offset);
    offset += item.length;
  }
  return out;
}

function readFlacTags(bytes: Uint8Array): Map<string, Uint8Array> {
  const tags = new Map<string, Uint8Array>();
  const block = parseFlacBlocks(bytes).find((entry) => entry.type === FLAC_VORBIS_COMMENT);
  if (!block) return tags;
  const comments = parseFlacComments(bytes, block.dataStart, block.dataEnd);
  for (const { key, value } of comments.comments) {
    const description = FLAC_KEYS.get(key.toUpperCase());
    if (!description) continue;
    tags.set(description, unwrapFrameBytes(b64DecodeField(value, `FLAC ${key}`), `FLAC ${key}`).data);
  }
  return tags;
}

function readFlacMeta(bytes: Uint8Array): { bpm?: number; bpmText?: string; key?: string } {
  const out: { bpm?: number; bpmText?: string; key?: string } = {};
  const block = parseFlacBlocks(bytes).find((entry) => entry.type === FLAC_VORBIS_COMMENT);
  if (!block) return out;
  const comments = parseFlacComments(bytes, block.dataStart, block.dataEnd);
  for (const { key, value } of comments.comments) {
    const upper = key.toUpperCase();
    if (upper === "BPM" || upper === "TBPM") {
      out.bpmText = value.trim();
      const parsed = Number.parseFloat(out.bpmText);
      if (Number.isFinite(parsed) && parsed > 0) out.bpm = parsed;
    } else if (upper === "INITIALKEY" || upper === "KEY" || upper === "TKEY") {
      if (value.trim()) out.key = value.trim();
    }
  }
  return out;
}

function writeFlacTags(bytes: Uint8Array, updates: Map<string, Uint8Array>, meta?: SeratoTextMeta): Uint8Array {
  const blocks = parseFlacBlocks(bytes);
  const block = blocks.find((entry) => entry.type === FLAC_VORBIS_COMMENT);
  if (!block) throw new Error("FLAC file has no VORBIS_COMMENT block to hold Serato tags");
  const comments = parseFlacComments(bytes, block.dataStart, block.dataEnd);
  const updated = new Map(updates);
  for (const [description] of updated) {
    if (!DESCRIPTION_TO_FLAC_KEY.has(description)) throw new Error(`Unsupported Serato tag description: ${description}`);
  }
  const metaUpdates = new Map<string, string>();
  if (meta?.bpm !== undefined && meta.bpm !== "" && meta.bpm !== 0) {
    const val = typeof meta.bpm === "number" ? meta.bpm.toFixed(2).replace(/\.00$/, "") : String(meta.bpm).trim();
    if (val) metaUpdates.set("BPM", val);
  }
  if (meta?.key !== undefined && meta.key.trim() !== "" && meta.key.trim() !== "--") {
    metaUpdates.set("INITIALKEY", meta.key.trim());
  }

  const next: Array<{ key: string; value: string }> = [];
  const replaced = new Set<string>();
  const replacedMeta = new Set<string>();
  for (const comment of comments.comments) {
    const upper = comment.key.toUpperCase();
    const description = FLAC_KEYS.get(upper);
    if (description && updated.has(description)) {
      if (replaced.has(description)) continue;
      replaced.add(description);
      const data = updated.get(description) as Uint8Array;
      const key = DESCRIPTION_TO_FLAC_KEY.get(description) as string;
      next.push({ key, value: b64EncodeField(wrapFrameBytes(description, data), true) });
    } else if ((upper === "BPM" || upper === "TBPM") && metaUpdates.has("BPM")) {
      if (replacedMeta.has("BPM")) continue;
      replacedMeta.add("BPM");
      next.push({ key: "BPM", value: metaUpdates.get("BPM")! });
    } else if ((upper === "INITIALKEY" || upper === "KEY" || upper === "TKEY") && metaUpdates.has("INITIALKEY")) {
      if (replacedMeta.has("INITIALKEY")) continue;
      replacedMeta.add("INITIALKEY");
      next.push({ key: "INITIALKEY", value: metaUpdates.get("INITIALKEY")! });
    } else {
      next.push(comment);
    }
  }
  for (const [description, data] of updated) {
    if (replaced.has(description)) continue;
    const key = DESCRIPTION_TO_FLAC_KEY.get(description) as string;
    next.push({ key, value: b64EncodeField(wrapFrameBytes(description, data), true) });
  }
  for (const [key, value] of metaUpdates) {
    if (replacedMeta.has(key)) continue;
    next.push({ key, value });
  }
  const body = buildFlacCommentBlock({ vendor: comments.vendor, comments: next });
  const prefix = bytes.slice(0, block.headerStart);
  const suffix = bytes.slice(block.dataEnd);
  const out = new Uint8Array(prefix.length + 4 + body.length + suffix.length);
  out.set(prefix, 0);
  out[block.headerStart] = (block.isLast ? 0x80 : 0) | FLAC_VORBIS_COMMENT;
  out[block.headerStart + 1] = (body.length >> 16) & 0xff;
  out[block.headerStart + 2] = (body.length >> 8) & 0xff;
  out[block.headerStart + 3] = body.length & 0xff;
  out.set(body, block.headerStart + 4);
  out.set(suffix, block.headerStart + 4 + body.length);
  return out;
}

interface Mp4Atom {
  type: string;
  size: number;
  start: number;
  contentStart: number;
  contentEnd: number;
  end: number;
}

function parseMp4Atoms(bytes: Uint8Array, start: number, end: number, where: string): Mp4Atom[] {
  const atoms: Mp4Atom[] = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) throw new Error(`Truncated MP4 atom header in ${where}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, Math.min(16, end - offset));
    let size = view.getUint32(0, false);
    const type = ascii(bytes, offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) throw new Error(`Truncated 64-bit MP4 atom size in ${where}`);
      const high = view.getUint32(8, false);
      const low = view.getUint32(12, false);
      if (high !== 0) throw new Error(`MP4 atom larger than 4 GB in ${where}`);
      size = low;
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    } else if (size < 8) {
      throw new Error(`Invalid MP4 atom size ${size} in ${where}`);
    }
    if (offset + size > end) throw new Error(`MP4 atom ${type} overruns its parent in ${where}`);
    atoms.push({ type, size, start: offset, contentStart: offset + headerSize, contentEnd: offset + size, end: offset + size });
    if (size === 0) break;
    offset += size;
  }
  return atoms;
}

function findMp4Atom(bytes: Uint8Array, atoms: Mp4Atom[], type: string, where: string): Mp4Atom | null {
  const matches = atoms.filter((atom) => atom.type === type);
  if (matches.length > 1) throw new Error(`Multiple ${type} atoms in ${where}`);
  return matches[0] ?? null;
}

function readMp4Tags(bytes: Uint8Array): Map<string, Uint8Array> {
  const tags = new Map<string, Uint8Array>();
  const ilst = findMp4IlstWith(bytes);
  if (!ilst) return tags;
  const entries = parseMp4Atoms(bytes, ilst.contentStart, ilst.contentEnd, "ilst");
  for (const entry of entries) {
    if (entry.type !== "----") continue;
    const children = parseMp4Atoms(bytes, entry.contentStart, entry.contentEnd, "----");
    const mean = children.find((child) => child.type === "mean" && child.contentEnd - child.contentStart >= 4);
    const name = children.find((child) => child.type === "name" && child.contentEnd - child.contentStart >= 4);
    if (!mean || !name) continue;
    if (requireAscii(bytes, mean.contentStart + 4, mean.contentEnd, "mp4 mean") !== MP4_MEAN) continue;
    const entryName = requireAscii(bytes, name.contentStart + 4, name.contentEnd, "mp4 name");
    const description = MP4_NAMES.get(entryName);
    if (!description) continue;
    const data = children.find((child) => child.type === "data" && child.contentEnd - child.contentStart >= 4);
    if (!data) throw new Error(`freeform atom ${entryName} has no data child`);
    const valueStart =
      data.contentEnd - data.contentStart >= 8 &&
      bytes[data.contentStart + 4] === 0 &&
      bytes[data.contentStart + 5] === 0 &&
      bytes[data.contentStart + 6] === 0 &&
      bytes[data.contentStart + 7] === 0
        ? data.contentStart + 8
        : data.contentStart + 4;
    const value = tolerantAscii(bytes, valueStart, data.contentEnd);
    tags.set(description, unwrapFrameBytes(b64DecodeField(value, `mp4 ${entryName}`), `mp4 ${entryName}`).data);
  }
  return tags;
}

function readMp4Meta(bytes: Uint8Array): { bpm?: number; bpmText?: string; key?: string } {
  const out: { bpm?: number; bpmText?: string; key?: string } = {};
  const ilst = findMp4IlstWith(bytes);
  if (!ilst) return out;
  const entries = parseMp4Atoms(bytes, ilst.contentStart, ilst.contentEnd, "ilst");
  for (const entry of entries) {
    if (entry.type === "tmpo") {
      const children = parseMp4Atoms(bytes, entry.contentStart, entry.contentEnd, "tmpo");
      const data = children.find((child) => child.type === "data" && child.contentEnd - child.contentStart >= 10);
      if (data) {
        const bpm = new DataView(bytes.buffer, bytes.byteOffset + data.contentStart + 8, 2).getUint16(0, false);
        if (bpm > 0) {
          out.bpm = bpm;
          out.bpmText = String(bpm);
        }
      }
      continue;
    }
    if (entry.type !== "----") continue;
    const children = parseMp4Atoms(bytes, entry.contentStart, entry.contentEnd, "----");
    const mean = children.find((child) => child.type === "mean" && child.contentEnd - child.contentStart >= 4);
    const name = children.find((child) => child.type === "name" && child.contentEnd - child.contentStart >= 4);
    const data = children.find((child) => child.type === "data" && child.contentEnd - child.contentStart >= 8);
    if (!mean || !name || !data) continue;
    const meanStr = ascii(bytes, mean.contentStart + 4, mean.contentEnd);
    const nameStr = ascii(bytes, name.contentStart + 4, name.contentEnd).toLowerCase();
    if (meanStr !== MP4_MEAN && meanStr !== "com.apple.iTunes") continue;
    const text = new TextDecoder("utf-8").decode(bytes.subarray(data.contentStart + 8, data.contentEnd)).trim();
    if ((nameStr === "bpm" || nameStr === "tbpm") && text) {
      out.bpmText = text;
      const parsed = Number.parseFloat(text);
      if (Number.isFinite(parsed) && parsed > 0) out.bpm = parsed;
    } else if ((nameStr === "initialkey" || nameStr === "key" || nameStr === "tkey") && text) {
      out.key = text;
    }
  }
  return out;
}

interface Mp4Paths {
  moov: Mp4Atom;
  udta: Mp4Atom;
  meta: Mp4Atom;
  ilst: Mp4Atom;
}

function findMp4IlstWith(bytes: Uint8Array): Mp4Atom | null {
  const paths = findMp4IlstPaths(bytes);
  return paths === null ? null : paths.ilst;
}

function findMp4IlstPaths(bytes: Uint8Array): Mp4Paths | null {
  const top = parseMp4Atoms(bytes, 0, bytes.length, "top level");
  const moov = findMp4Atom(bytes, top, "moov", "top level");
  if (!moov) return null;
  const moovChildren = parseMp4Atoms(bytes, moov.contentStart, moov.contentEnd, "moov");
  const udta = findMp4Atom(bytes, moovChildren, "udta", "moov");
  if (!udta) return null;
  const udtaChildren = parseMp4Atoms(bytes, udta.contentStart, udta.contentEnd, "udta");
  const meta = findMp4Atom(bytes, udtaChildren, "meta", "udta");
  if (!meta) return null;
  const metaChildren = parseMp4Atoms(bytes, meta.contentStart + 4, meta.contentEnd, "meta (after version/flags)");
  const ilst = findMp4Atom(bytes, metaChildren, "ilst", "meta");
  if (!ilst) return null;
  return { moov, udta, meta, ilst };
}

function requireMp4IlstPaths(bytes: Uint8Array): Mp4Paths {
  const paths = findMp4IlstPaths(bytes);
  if (!paths) throw new Error("MP4 file is missing moov/udta/meta/ilst path");
  return paths;
}

function buildFullBox(type: string, flags: number, payload: Uint8Array | string): Uint8Array {
  const text = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const out = new Uint8Array(12 + text.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out[8] = 0;
  out[9] = (flags >> 16) & 0xff;
  out[10] = (flags >> 8) & 0xff;
  out[11] = flags & 0xff;
  out.set(text, 12);
  return out;
}

function buildMp4Atom(type: string, children: Uint8Array[]): Uint8Array {
  const body = children.reduce((sum, child) => sum + child.length, 0);
  const out = new Uint8Array(8 + body);
  new DataView(out.buffer).setUint32(0, out.length, false);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  let offset = 8;
  for (const child of children) {
    out.set(child, offset);
    offset += child.length;
  }
  return out;
}

function buildMp4Data(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const out = new Uint8Array(16 + bytes.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  for (let i = 0; i < 4; i += 1) out[4 + i] = "data".charCodeAt(i);
  out[11] = 1;
  out.set(bytes, 16);
  return out;
}

function buildMp4Freeform(description: string, data: Uint8Array): Uint8Array {
  const name = DESCRIPTION_TO_MP4_NAME.get(description);
  if (!name) throw new Error(`Unsupported Serato tag description: ${description}`);
  const wrap = description !== BEATGRID;
  return buildMp4Atom("----", [
    buildFullBox("mean", 0, MP4_MEAN),
    buildFullBox("name", 0, name),
    buildMp4Data(b64EncodeField(wrapFrameBytes(description, data), wrap)),
  ]);
}

function buildMp4TextFreeform(mean: string, name: string, value: string): Uint8Array {
  return buildMp4Atom("----", [
    buildFullBox("mean", 0, mean),
    buildFullBox("name", 0, name),
    buildMp4Data(value),
  ]);
}

function writeMp4Tags(bytes: Uint8Array, updates: Map<string, Uint8Array>, meta?: SeratoTextMeta): Uint8Array {
  for (const [description] of updates) {
    if (!DESCRIPTION_TO_MP4_NAME.has(description)) throw new Error(`Unsupported Serato tag description: ${description}`);
  }
  const { moov, udta, meta: metaAtom, ilst } = requireMp4IlstPaths(bytes);
  const metaListChildrenStart = metaAtom.contentStart + 4;
  const entries = parseMp4Atoms(bytes, ilst.contentStart, ilst.contentEnd, "ilst");
  const metaPending = new Map<string, string>();
  if (meta?.bpm !== undefined && meta.bpm !== "" && meta.bpm !== 0) {
    const val = typeof meta.bpm === "number" ? meta.bpm.toFixed(2).replace(/\.00$/, "") : String(meta.bpm).trim();
    if (val) metaPending.set("bpm", val);
  }
  if (meta?.key !== undefined && meta.key.trim() !== "" && meta.key.trim() !== "--") {
    metaPending.set("initialkey", meta.key.trim());
  }

  type Entry = { type: string; start: number; end: number; raw: Uint8Array; name: string | null; metaKey: string | null };
  const parsed: Entry[] = entries.map((atom) => {
    const raw = bytes.slice(atom.start, atom.end);
    let entryName: string | null = null;
    let metaKey: string | null = null;
    if (atom.type === "----") {
      const children = parseMp4Atoms(bytes, atom.contentStart, atom.contentEnd, "ilst entry");
      const mean = children.find((child) => child.type === "mean" && child.contentEnd - child.contentStart >= 4);
      const name = children.find((child) => child.type === "name" && child.contentEnd - child.contentStart >= 4);
      if (mean && name) {
        const meanText = requireAscii(bytes, mean.contentStart + 4, mean.contentEnd, "mp4 mean");
        const rawName = requireAscii(bytes, name.contentStart + 4, name.contentEnd, "mp4 name");
        if (meanText === MP4_MEAN && MP4_NAMES.has(rawName)) {
          entryName = rawName;
        } else if ((meanText === MP4_MEAN || meanText === "com.apple.iTunes") && (rawName.toLowerCase() === "bpm" || rawName.toLowerCase() === "initialkey")) {
          metaKey = rawName.toLowerCase();
        }
      }
    }
    return { type: atom.type, start: atom.start, end: atom.end, raw, name: entryName, metaKey };
  });
  const children: Uint8Array[] = [];
  const pending = new Map(updates);
  for (const entry of parsed) {
    if (entry.name) {
      const description = MP4_NAMES.get(entry.name) as string;
      if (pending.has(description)) {
        children.push(buildMp4Freeform(description, pending.get(description) as Uint8Array));
        pending.delete(description);
        continue;
      }
    }
    if (entry.metaKey && metaPending.has(entry.metaKey)) {
      children.push(buildMp4TextFreeform("com.apple.iTunes", entry.metaKey, metaPending.get(entry.metaKey)!));
      metaPending.delete(entry.metaKey);
      continue;
    }
    children.push(entry.raw);
  }
  for (const [description, data] of pending) {
    children.push(buildMp4Freeform(description, data));
  }
  for (const [metaKey, value] of metaPending) {
    children.push(buildMp4TextFreeform("com.apple.iTunes", metaKey, value));
  }
  const newIlst = buildMp4Atom("ilst", children);

  const flagsAndChildren = bytes.slice(metaAtom.contentStart, metaListChildrenStart);
  const newMetaBody = replaceSpan(bytes, metaListChildrenStart, metaAtom.contentEnd, ilst.start, ilst.end, newIlst);
  const newMeta = buildMp4AtomWithHeader("meta", flagsAndChildren, newMetaBody);

  const newUdtaBody = replaceSpan(bytes, udta.contentStart, udta.contentEnd, metaAtom.start, metaAtom.end, newMeta);
  const newUdta = buildMp4Atom("udta", [newUdtaBody]);

  const newMoov = replaceSpan(bytes, moov.start, moov.end, udta.start, udta.end, newUdta);
  new DataView(newMoov.buffer).setUint32(0, newMoov.length, false);
  return replaceSpan(bytes, 0, bytes.length, moov.start, moov.end, newMoov);
}

function buildMp4AtomWithHeader(type: string, headerExtra: Uint8Array, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + headerExtra.length + body.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(headerExtra, 8);
  out.set(body, 8 + headerExtra.length);
  return out;
}

function replaceSpan(bytes: Uint8Array, start: number, end: number, replaceStart: number, replaceEnd: number, replacement: Uint8Array): Uint8Array {
  const before = bytes.slice(start, replaceStart);
  const after = bytes.slice(replaceEnd, end);
  const out = new Uint8Array(before.length + replacement.length + after.length);
  out.set(before, 0);
  out.set(replacement, before.length);
  out.set(after, before.length + replacement.length);
  return out;
}

export function readSeratoExtraTags(bytes: Uint8Array, kind: SeratoExtraKind): Map<string, Uint8Array> {
  if (kind === "flac") return readFlacTags(bytes);
  if (kind === "mp4") return readMp4Tags(bytes);
  throw new Error(`Unsupported Serato extra kind: ${kind as string}`);
}

export function readSeratoExtraMeta(bytes: Uint8Array, kind: SeratoExtraKind): { bpm?: number; bpmText?: string; key?: string } {
  if (kind === "flac") return readFlacMeta(bytes);
  if (kind === "mp4") return readMp4Meta(bytes);
  throw new Error(`Unsupported Serato extra kind: ${kind as string}`);
}

export function writeSeratoExtraTags(
  bytes: Uint8Array,
  kind: SeratoExtraKind,
  updates: Map<string, Uint8Array>,
  meta?: SeratoTextMeta,
): Uint8Array {
  if (kind === "flac") return writeFlacTags(bytes, updates, meta);
  if (kind === "mp4") return writeMp4Tags(bytes, updates, meta);
  throw new Error(`Unsupported Serato extra kind: ${kind as string}`);
}

export const SERATO_EXTRA_DESCRIPTIONS = [MARKERS2, MARKERS_, BEATGRID] as const;

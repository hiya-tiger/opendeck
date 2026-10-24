export interface Id3Frame {
  id: string;
  flags: Uint8Array;
  data: Uint8Array;
}

export interface Id3Tag {
  version: 3 | 4;
  frames: Id3Frame[];
  audioOffset: number;
  padding: number;
}

export interface SeratoTextMeta {
  bpm?: number | string;
  key?: string;
  title?: string;
  artist?: string;
}

function synchsafeDecode(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function synchsafeEncode(value: number): Uint8Array {
  return new Uint8Array([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

export function readId3(bytes: Uint8Array): Id3Tag | null {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;
  const major = bytes[3];
  if (major !== 3 && major !== 4) throw new Error(`Unsupported ID3v2.${major}`);
  const flags = bytes[5];
  if (flags & 0x80) throw new Error("Unsynchronised ID3 tags are not supported");
  if (flags & 0x40) throw new Error("ID3 extended headers are not supported");
  if (major === 4 && flags & 0x10) throw new Error("ID3v2.4 footers are not supported");
  const size = synchsafeDecode(bytes, 6);
  const end = Math.min(bytes.length, 10 + size);
  const frames: Id3Frame[] = [];
  let offset = 10;
  while (offset + 10 <= end) {
    let id = "";
    for (let i = 0; i < 4; i += 1) id += String.fromCharCode(bytes[offset + i]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const length =
      major === 4 ? synchsafeDecode(bytes, offset + 4) : new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, false);
    const start = offset + 10;
    if (start + length > end) break;
    frames.push({ id, flags: bytes.subarray(offset + 8, offset + 10), data: bytes.subarray(start, start + length) });
    offset = start + length;
  }
  return { version: major, frames, audioOffset: 10 + size, padding: Math.max(0, end - offset) };
}

function readNull(bytes: Uint8Array, offset: number): { value: string; next: number } {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  let value = "";
  for (let i = offset; i < end; i += 1) value += String.fromCharCode(bytes[i]);
  return { value, next: Math.min(bytes.length, end + 1) };
}

export function decodeId3Text(data: Uint8Array): string {
  if (data.length === 0) return "";
  const encoding = data[0];
  const body = data.subarray(1);
  let text = "";
  if (encoding === 0 || encoding === 3) {
    text = new TextDecoder(encoding === 3 ? "utf-8" : "latin1").decode(body);
  } else if (encoding === 1) {
    const le = body.length >= 2 && body[0] === 0xff && body[1] === 0xfe;
    const start = body.length >= 2 && ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff)) ? 2 : 0;
    text = new TextDecoder(le ? "utf-16le" : "utf-16be").decode(body.subarray(start));
  } else if (encoding === 2) {
    text = new TextDecoder("utf-16be").decode(body);
  }
  return text.replace(/\0+$/g, "").trim();
}

export function encodeId3Text(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const out = new Uint8Array(1 + encoded.length);
  out[0] = 0; // Latin-1 / ASCII compatible
  out.set(encoded, 1);
  return out;
}

export function readId3TextMeta(bytes: Uint8Array): { bpm?: number; bpmText?: string; key?: string; title?: string; artist?: string } {
  const tag = readId3(bytes);
  if (!tag) return {};
  const out: { bpm?: number; bpmText?: string; key?: string; title?: string; artist?: string } = {};
  for (const frame of tag.frames) {
    if (frame.id === "TBPM") {
      const text = decodeId3Text(frame.data);
      const parsed = Number.parseFloat(text);
      if (text) out.bpmText = text;
      if (Number.isFinite(parsed) && parsed > 0) out.bpm = parsed;
    } else if (frame.id === "TKEY") {
      const text = decodeId3Text(frame.data);
      if (text) out.key = text;
    } else if (frame.id === "TIT2") {
      const text = decodeId3Text(frame.data);
      if (text) out.title = text;
    } else if (frame.id === "TPE1") {
      const text = decodeId3Text(frame.data);
      if (text) out.artist = text;
    }
  }
  return out;
}

export interface GeoBFrame {
  mime: string;
  filename: string;
  description: string;
  data: Uint8Array;
}

export function parseGeoB(data: Uint8Array): GeoBFrame {
  const encoding = data[0] ?? 0;
  if (encoding !== 0) throw new Error("Only Latin-1 GEOB descriptions are supported");
  let offset = 1;
  const mime = readNull(data, offset);
  offset = mime.next;
  const filename = readNull(data, offset);
  offset = filename.next;
  const description = readNull(data, offset);
  offset = description.next;
  return { mime: mime.value, filename: filename.value, description: description.value, data: data.subarray(offset) };
}

export function encodeGeoB(frame: GeoBFrame): Uint8Array {
  const mime = new TextEncoder().encode(frame.mime);
  const filename = new TextEncoder().encode(frame.filename);
  const description = new TextEncoder().encode(frame.description);
  const out = new Uint8Array(1 + mime.length + 1 + filename.length + 1 + description.length + 1 + frame.data.length);
  let offset = 0;
  out[offset++] = 0;
  out.set(mime, offset);
  offset += mime.length + 1;
  out.set(filename, offset);
  offset += filename.length + 1;
  out.set(description, offset);
  offset += description.length + 1;
  out.set(frame.data, offset);
  return out;
}

export function readSeratoGeoB(bytes: Uint8Array): Map<string, GeoBFrame> {
  const tag = readId3(bytes);
  const out = new Map<string, GeoBFrame>();
  if (!tag) return out;
  for (const frame of tag.frames) {
    if (frame.id !== "GEOB") continue;
    const geob = parseGeoB(frame.data);
    if (geob.mime === "application/octet-stream") out.set(geob.description, geob);
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function writeSeratoGeoB(
  bytes: Uint8Array,
  updates: Array<{ description: string; data: Uint8Array }>,
  paddingOrMeta: number | SeratoTextMeta = 1024,
  maybeMeta?: SeratoTextMeta,
): Uint8Array {
  const padding = typeof paddingOrMeta === "number" ? paddingOrMeta : 1024;
  const meta = typeof paddingOrMeta === "object" && paddingOrMeta !== null ? paddingOrMeta : maybeMeta;
  const tag = readId3(bytes);
  const version = tag?.version ?? 3;
  const existing = tag?.frames ?? [];
  const replaced = new Set(updates.map((update) => update.description));
  const textUpdates = new Map<string, string>();
  if (meta?.bpm !== undefined && meta.bpm !== "" && meta.bpm !== 0) {
    const val = typeof meta.bpm === "number" ? meta.bpm.toFixed(2).replace(/\.00$/, "") : String(meta.bpm).trim();
    if (val) textUpdates.set("TBPM", val);
  }
  if (meta?.key !== undefined && meta.key.trim() !== "" && meta.key.trim() !== "--") {
    textUpdates.set("TKEY", meta.key.trim());
  }
  if (meta?.title !== undefined && meta.title.trim() !== "") {
    textUpdates.set("TIT2", meta.title.trim());
  }
  if (meta?.artist !== undefined && meta.artist.trim() !== "") {
    textUpdates.set("TPE1", meta.artist.trim());
  }

  const frames = existing.filter((frame) => {
    if (textUpdates.has(frame.id)) return false;
    if (frame.id !== "GEOB") return true;
    const geob = parseGeoB(frame.data);
    return !replaced.has(geob.description);
  });
  for (const [id, text] of textUpdates) {
    frames.push({
      id,
      flags: new Uint8Array([0, 0]),
      data: encodeId3Text(text),
    });
  }
  for (const update of updates) {
    frames.push({
      id: "GEOB",
      flags: new Uint8Array([0, 0]),
      data: encodeGeoB({
        mime: "application/octet-stream",
        filename: "",
        description: update.description,
        data: update.data,
      }),
    });
  }

  const frameBytes: Uint8Array[] = [];
  for (const frame of frames) {
    const header = new Uint8Array(10);
    for (let i = 0; i < 4; i += 1) header[i] = frame.id.charCodeAt(i);
    const size =
      version === 4
        ? synchsafeEncode(frame.data.length)
        : new Uint8Array([
            (frame.data.length >>> 24) & 0xff,
            (frame.data.length >>> 16) & 0xff,
            (frame.data.length >>> 8) & 0xff,
            frame.data.length & 0xff,
          ]);
    header.set(size, 4);
    header[8] = frame.flags[0] ?? 0;
    header[9] = frame.flags[1] ?? 0;
    frameBytes.push(header, frame.data);
  }
  const content = concat(frameBytes);
  const padLength = Math.max(padding, tag?.padding ?? 0);
  const tagSize = content.length + padLength;
  const header = new Uint8Array(10);
  header[0] = 0x49;
  header[1] = 0x44;
  header[2] = 0x33;
  header[3] = version;
  header[4] = 0;
  header[5] = 0;
  header.set(synchsafeEncode(tagSize), 6);
  const audio = tag ? bytes.subarray(tag.audioOffset) : bytes;
  const out = new Uint8Array(10 + tagSize + audio.length);
  out.set(header, 0);
  out.set(content, 10);
  out.set(audio, 10 + tagSize);
  return out;
}

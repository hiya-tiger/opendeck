export interface Artwork {
  mime: string;
  data: Uint8Array;
}

const FRONT_COVER = 3;

function syncsafe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < start + length && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function desynchronise(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  let write = 0;
  for (let read = 0; read < bytes.length; read += 1) {
    out[write] = bytes[read];
    write += 1;
    if (bytes[read] === 0xff && bytes[read + 1] === 0x00) read += 1;
  }
  return out.subarray(0, write);
}

function sniffMime(data: Uint8Array): string | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && ascii(data, 0, 3) === "GIF") return "image/gif";
  if (data.length >= 12 && ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WEBP") return "image/webp";
  return null;
}

function normaliseMime(mime: string, data: Uint8Array): string {
  const lower = mime.trim().toLowerCase();
  if (lower === "image/jpg" || lower === "jpg" || lower === "jpeg") return "image/jpeg";
  if (lower === "png") return "image/png";
  if (lower.startsWith("image/")) return lower;
  return sniffMime(data) ?? "image/jpeg";
}

function parsePicture(data: Uint8Array, legacy: boolean): (Artwork & { type: number }) | null {
  if (data.length < 6) return null;
  const encoding = data[0];
  let pos = 1;
  let mime = "image/jpeg";
  if (legacy) {
    mime = ascii(data, 1, 3).toLowerCase();
    pos = 4;
  } else {
    const mimeEnd = data.indexOf(0, pos);
    if (mimeEnd < 0) return null;
    mime = ascii(data, pos, mimeEnd - pos) || mime;
    pos = mimeEnd + 1;
  }
  if (pos >= data.length) return null;
  const type = data[pos];
  pos += 1;
  if (encoding === 1 || encoding === 2) {
    while (pos + 1 < data.length && !(data[pos] === 0 && data[pos + 1] === 0)) pos += 2;
    pos += 2;
  } else {
    const descEnd = data.indexOf(0, pos);
    if (descEnd < 0) return null;
    pos = descEnd + 1;
  }
  if (pos >= data.length) return null;
  const picture = data.slice(pos);
  if (picture.length < 8) return null;
  return { mime: normaliseMime(mime, picture), data: picture, type };
}

export interface Id3Info {
  artwork: Artwork | null;
  artist?: string;
  title?: string;
  album?: string;
}

function decodeText(data: Uint8Array): string {
  if (data.length < 2) return "";
  const encoding = data[0];
  let body = data.subarray(1);
  let decoder: TextDecoder;
  if (encoding === 0) {
    decoder = new TextDecoder("iso-8859-1");
  } else if (encoding === 3) {
    decoder = new TextDecoder("utf-8");
  } else if (encoding === 2) {
    decoder = new TextDecoder("utf-16be");
  } else {
    const little = !(body[0] === 0xfe && body[1] === 0xff);
    if ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff)) {
      body = body.subarray(2);
    }
    decoder = new TextDecoder(little ? "utf-16le" : "utf-16be");
  }
  return decoder.decode(body).replace(/\0+$/g, "").trim();
}

export function readId3Info(input: ArrayBuffer | Uint8Array): Id3Info {
  const info: Id3Info = { artwork: null };
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 10) return info;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return info;

  const version = bytes[3];
  if (version < 2 || version > 4) return info;
  const flags = bytes[5];
  const tagEnd = Math.min(bytes.length, 10 + syncsafe(bytes, 6));
  let body = bytes.slice(10, tagEnd);
  if (flags & 0x80) body = desynchronise(body);

  let pos = 0;
  if (flags & 0x40) {
    if (body.length < 4) return info;
    pos = version === 4 ? syncsafe(body, 0) : 4 + uint32(body, 0);
  }

  const headerSize = version === 2 ? 6 : 10;
  let first: Artwork | null = null;
  const textFrames: Record<string, "artist" | "title" | "album"> = {
    TPE1: "artist",
    TIT2: "title",
    TALB: "album",
    TP1: "artist",
    TT2: "title",
    TAL: "album",
  };

  while (pos + headerSize <= body.length) {
    const idLength = version === 2 ? 3 : 4;
    const id = ascii(body, pos, idLength);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const size =
      version === 2
        ? (body[pos + 3] << 16) | (body[pos + 4] << 8) | body[pos + 5]
        : version === 3
          ? uint32(body, pos + 4)
          : syncsafe(body, pos + 4);
    const formatFlags = version === 2 ? 0 : body[pos + 9];
    const dataStart = pos + headerSize;
    if (size <= 0 || dataStart + size > body.length) break;

    if (id === "APIC" || id === "PIC") {
      const compressed = version === 3 ? (formatFlags & 0x80) !== 0 : (formatFlags & 0x08) !== 0;
      const encrypted = version === 3 ? (formatFlags & 0x40) !== 0 : (formatFlags & 0x04) !== 0;
      if (!compressed && !encrypted) {
        let frame = body.slice(dataStart, dataStart + size);
        if (version === 4 && (formatFlags & 0x02) !== 0) frame = desynchronise(frame);
        if (version === 4 && (formatFlags & 0x01) !== 0) frame = frame.subarray(4);
        const picture = parsePicture(frame, id === "PIC");
        if (picture) {
          if (picture.type === FRONT_COVER) {
            info.artwork = { mime: picture.mime, data: picture.data };
          } else {
            first ??= { mime: picture.mime, data: picture.data };
          }
        }
      }
    } else if (textFrames[id]) {
      const slot = textFrames[id];
      if (!info[slot]) {
        const value = decodeText(body.slice(dataStart, dataStart + size));
        if (value) info[slot] = value;
      }
    }

    pos = dataStart + size;
  }

  info.artwork ??= first;
  return info;
}

export function readId3Artwork(input: ArrayBuffer | Uint8Array): Artwork | null {
  return readId3Info(input).artwork;
}

interface Mp4Atom {
  type: string;
  start: number;
  end: number;
}

function mp4Atoms(bytes: Uint8Array, start: number, end: number): Mp4Atom[] {
  const atoms: Mp4Atom[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = uint32(bytes, pos);
    const type = ascii(bytes, pos + 4, 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = uint32(bytes, pos + 8) * 4294967296 + uint32(bytes, pos + 12);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    atoms.push({ type, start: pos + header, end: pos + size });
    pos += size;
  }
  return atoms;
}

function mp4Child(atoms: Mp4Atom[], type: string): Mp4Atom | undefined {
  return atoms.find((atom) => atom.type === type);
}

function mp4Data(bytes: Uint8Array, metadata: Mp4Atom): { kind: number; payload: Uint8Array } | null {
  const data = mp4Child(mp4Atoms(bytes, metadata.start, metadata.end), "data");
  if (!data || data.end - data.start < 8) return null;
  return {
    kind: uint32(bytes, data.start),
    payload: bytes.slice(data.start + 8, data.end),
  };
}

function mp4Text(bytes: Uint8Array, metadata: Mp4Atom): string {
  const data = mp4Data(bytes, metadata);
  if (!data) return "";
  return new TextDecoder("utf-8").decode(data.payload).replace(/\0+$/g, "").trim();
}

export function readMp4Info(input: ArrayBuffer | Uint8Array): Id3Info | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 12 || ascii(bytes, 4, 4) !== "ftyp") return null;

  const info: Id3Info = { artwork: null };
  const top = mp4Atoms(bytes, 0, bytes.length);
  const moov = mp4Child(top, "moov");
  if (!moov) return info;
  const udta = mp4Child(mp4Atoms(bytes, moov.start, moov.end), "udta");
  if (!udta) return info;
  const meta = mp4Child(mp4Atoms(bytes, udta.start, udta.end), "meta");
  if (!meta) return info;
  const ilst = mp4Child(mp4Atoms(bytes, meta.start + 4, meta.end), "ilst");
  if (!ilst) return info;

  for (const item of mp4Atoms(bytes, ilst.start, ilst.end)) {
    if (item.type === "\u00a9nam") info.title = mp4Text(bytes, item) || info.title;
    else if (item.type === "\u00a9ART") info.artist = mp4Text(bytes, item) || info.artist;
    else if (item.type === "\u00a9alb") info.album = mp4Text(bytes, item) || info.album;
    else if (item.type === "covr" && !info.artwork) {
      const data = mp4Data(bytes, item);
      if (data && data.payload.length >= 8) {
        const mime = data.kind === 14 ? "image/png" : data.kind === 13 ? "image/jpeg" : sniffMime(data.payload) ?? "image/jpeg";
        info.artwork = { mime, data: data.payload };
      }
    }
  }
  return info;
}

export function readMediaInfo(input: ArrayBuffer | Uint8Array): Id3Info {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length >= 3 && ascii(bytes, 0, 3) === "ID3") return readId3Info(bytes);
  return readMp4Info(bytes) ?? { artwork: null };
}

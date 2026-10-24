export interface SeratoColumn {
  name: string;
  width: string;
}

export interface SeratoChunk {
  tag: string;
  payload: Uint8Array;
}

export interface SeratoDbTrack {
  path: string;
  type: string;
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  comment?: string;
  grouping?: string;
  remixer?: string;
  length?: string;
  size?: string;
  bitrate?: string;
  sampleRate?: string;
  bpm?: string;
  composer?: string;
  year?: string;
  label?: string;
  added?: string;
  key?: string;
  color?: string;
  uadd?: number;
  utkn?: number;
  utme?: number;
  ufsb?: number;
  udsc?: number;
  utpc?: number;
  ulbl?: number;
  playCount?: number;
  played?: boolean;
  beatgridLocked?: boolean;
  flags?: Record<string, boolean>;
  extraChunks?: SeratoChunk[];
}

export const CRATE_VERSION = "1.0/Serato ScratchLive Crate";
export const DATABASE_VERSION = "2.0/Serato Scratch LIVE Database";
export const SQLITE_COLUMN_TABLE = "container_asset_list_columns";
export const SQLITE_COLUMN_SEPARATOR = "\x1e";

const TEXT_TAGS = new Set([
  "tsng", "tart", "talb", "tgen", "tcom", "tgrp", "trmx", "tlen", "tsiz", "tbit", "tsmp", "tbpm",
  "tcmp", "ttyr", "tlbl", "tadd", "tkey", "tcor",
]);

export const DEFAULT_COLUMNS: SeratoColumn[] = [
  { name: "song", width: "250" },
  { name: "artist", width: "250" },
  { name: "bpm", width: "30" },
  { name: "key", width: "30" },
  { name: "playCount", width: "30" },
  { name: "album", width: "250" },
  { name: "length", width: "250" },
  { name: "comment", width: "250" },
];

export function encodeSqliteColumnList(columns: readonly (string | { name: string })[]): string {
  return columns
    .map((col) => (typeof col === "string" ? col.trim() : String(col?.name ?? "").trim()))
    .filter(Boolean)
    .join(SQLITE_COLUMN_SEPARATOR);
}

export function decodeSqliteColumnList(raw: string): string[] {
  if (!raw) return [];
  return raw.split(SQLITE_COLUMN_SEPARATOR).map((col) => col.trim()).filter(Boolean);
}

const TYPE_BY_EXT: Record<string, string> = {
  ".mp3": "mp3",
  ".m4a": "quicktime",
  ".mp4": "quicktime",
  ".aac": "quicktime",
  ".m4b": "quicktime",
  ".wav": "wave",
  ".aif": "aiff",
  ".aiff": "aiff",
  ".flac": "flac",
  ".ogg": "oggvorbis",
  ".opus": "oggvorbis",
};

export function seratoType(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "mp3";
  return TYPE_BY_EXT[path.slice(dot).toLowerCase()] ?? "mp3";
}

function encodeUtf16be(value: string): Uint8Array {
  const out = new Uint8Array(value.length * 2);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    out[i * 2] = code >> 8;
    out[i * 2 + 1] = code & 0xff;
  }
  return out;
}

function decodeUtf16be(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = (bytes[i] << 8) | bytes[i + 1];
    if (code !== 0) out += String.fromCharCode(code);
  }
  return out;
}

export function writeChunk(tag: string, payload: Uint8Array): Uint8Array {
  if (tag.length !== 4) throw new Error(`Tag must be four characters: ${tag}`);
  const out = new Uint8Array(8 + payload.length);
  for (let i = 0; i < 4; i += 1) out[i] = tag.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, payload.length, false);
  out.set(payload, 8);
  return out;
}

export function writeText(tag: string, value: string): Uint8Array {
  return writeChunk(tag, encodeUtf16be(value));
}

export function writeU32(tag: string, value: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, Math.max(0, Math.min(0xffffffff, value)) >>> 0, false);
  return writeChunk(tag, payload);
}

export function writeBool(tag: string, value: boolean): Uint8Array {
  return writeChunk(tag, new Uint8Array([value ? 1 : 0]));
}

export function readChunks(bytes: Uint8Array): SeratoChunk[] {
  const chunks: SeratoChunk[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let tag = "";
    for (let i = 0; i < 4; i += 1) tag += String.fromCharCode(bytes[offset + i]);
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, false);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) throw new Error(`Truncated ${tag} chunk`);
    chunks.push({ tag, payload: bytes.subarray(start, end) });
    offset = end;
  }
  return chunks;
}

export function readText(payload: Uint8Array): string {
  return decodeUtf16be(payload);
}

export function readU32(payload: Uint8Array): number {
  if (payload.length < 4) throw new Error("u32 chunk is too short");
  return new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, false);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
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

export function decodeCrate(input: Uint8Array): { version: string; columns: SeratoColumn[]; paths: string[] } {
  const chunks = readChunks(input);
  let version = "";
  const columns: SeratoColumn[] = [];
  const paths: string[] = [];
  for (const chunk of chunks) {
    if (chunk.tag === "vrsn") {
      version = readText(chunk.payload);
    } else if (chunk.tag === "ovct") {
      const fields = new Map(readChunks(chunk.payload).map((field) => [field.tag, readText(field.payload)]));
      if (fields.has("tvcn")) columns.push({ name: fields.get("tvcn") ?? "", width: fields.get("tvcw") ?? "250" });
    } else if (chunk.tag === "otrk") {
      for (const field of readChunks(chunk.payload)) {
        if (field.tag === "ptrk" || field.tag === "pfil") paths.push(readText(field.payload));
      }
    }
  }
  return { version, columns, paths };
}

export function encodeCrate(paths: string[], columns: SeratoColumn[] | null = DEFAULT_COLUMNS): Uint8Array {
  const parts: Uint8Array[] = [writeText("vrsn", CRATE_VERSION)];
  for (const column of columns ?? []) {
    parts.push(writeChunk("ovct", concatBytes([writeText("tvcn", column.name), writeText("tvcw", column.width)])));
  }
  for (const path of paths) parts.push(writeChunk("otrk", writeText("ptrk", path)));
  return concatBytes(parts);
}

export function colorHexToU32(color?: string): number | undefined {
  if (!color) return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return undefined;
  return parseInt(m[1], 16) >>> 0;
}

export function colorU32ToHex(value?: number): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rgb = value & 0xffffff;
  return `#${rgb.toString(16).padStart(6, "0").toUpperCase()}`;
}

export function encodeTrack(track: SeratoDbTrack): Uint8Array {
  const parts: Uint8Array[] = [writeText("ttyp", track.type || seratoType(track.path)), writeText("pfil", track.path)];
  const fields: Array<[string, string | undefined]> = [
    ["tsng", track.title],
    ["tart", track.artist],
    ["talb", track.album],
    ["tgen", track.genre],
    ["tcom", track.comment],
    ["tgrp", track.grouping],
    ["trmx", track.remixer],
    ["tlen", track.length],
    ["tsiz", track.size],
    ["tbit", track.bitrate],
    ["tsmp", track.sampleRate],
    ["tbpm", track.bpm],
    ["tcmp", track.composer],
    ["ttyr", track.year],
    ["tlbl", track.label],
    ["tadd", track.added],
    ["tkey", track.key],
  ];
  for (const [tag, value] of fields) {
    if (value) parts.push(writeText(tag, value));
  }
  parts.push(writeU32("uadd", track.uadd ?? 0));
  if (track.utkn) parts.push(writeU32("utkn", track.utkn));
  parts.push(writeU32("utme", track.utme ?? 0));
  parts.push(writeU32("ufsb", track.ufsb ?? 0));
  if (track.udsc) parts.push(writeU32("udsc", track.udsc));
  const playCount = track.utpc ?? track.playCount ?? 0;
  parts.push(writeU32("utpc", playCount));
  const labelColor = track.ulbl ?? colorHexToU32(track.color);
  if (typeof labelColor === "number") {
    parts.push(writeU32("ulbl", labelColor));
  }
  const customFlags = track.flags ?? {};
  const flags: Array<[string, boolean]> = [
    ["bhrt", customFlags.bhrt ?? false],
    ["bmis", customFlags.bmis ?? false],
    ["bply", track.played ?? customFlags.bply ?? playCount > 0],
    ["blop", customFlags.blop ?? false],
    ["bitu", customFlags.bitu ?? false],
    ["bovc", customFlags.bovc ?? true],
    ["bcrt", customFlags.bcrt ?? false],
    ["biro", customFlags.biro ?? false],
    ["bwlb", customFlags.bwlb ?? false],
    ["bwll", customFlags.bwll ?? false],
    ["buns", customFlags.buns ?? false],
    ["bbgl", track.beatgridLocked ?? customFlags.bbgl ?? false],
    ["bkrk", customFlags.bkrk ?? false],
  ];
  for (const [tag, value] of flags) parts.push(writeBool(tag, value));
  if (track.extraChunks) {
    for (const extra of track.extraChunks) {
      parts.push(writeChunk(extra.tag, extra.payload));
    }
  }
  return writeChunk("otrk", concatBytes(parts));
}

export function encodeDatabase(tracks: SeratoDbTrack[]): Uint8Array {
  return concatBytes([writeText("vrsn", DATABASE_VERSION), ...tracks.map(encodeTrack)]);
}

const KNOWN_TRACK_TAGS = new Set([
  "ttyp", "pfil", "tsng", "tart", "talb", "tgen", "tcom", "tgrp", "trmx", "tlen", "tsiz", "tbit",
  "tsmp", "tbpm", "tcmp", "ttyr", "tlbl", "tadd", "tkey", "uadd", "utkn", "utme", "ufsb", "udsc",
  "utpc", "ulbl", "bhrt", "bmis", "bply", "blop", "bitu", "bovc", "bcrt", "biro", "bwlb", "bwll",
  "buns", "bbgl", "bkrk",
]);

export function decodeDatabase(input: Uint8Array): { version: string; tracks: Array<Record<string, string | number | boolean>> } {
  const chunks = readChunks(input);
  let version = "";
  const tracks: Array<Record<string, string | number | boolean>> = [];
  for (const chunk of chunks) {
    if (chunk.tag === "vrsn") {
      version = readText(chunk.payload);
    } else if (chunk.tag === "otrk") {
      const track: Record<string, string | number | boolean> = {};
      for (const field of readChunks(chunk.payload)) {
        if (TEXT_TAGS.has(field.tag) || field.tag === "ttyp" || field.tag === "pfil" || field.tag[0] === "t" || field.tag[0] === "p") {
          track[field.tag] = readText(field.payload);
        } else if (field.tag[0] === "u" && field.payload.length === 4) {
          track[field.tag] = readU32(field.payload);
        } else if (field.tag[0] === "b" && field.payload.length === 1) {
          track[field.tag] = field.payload[0] !== 0;
        }
      }
      tracks.push(track);
    }
  }
  return { version, tracks };
}

export function decodeDatabaseTracks(input: Uint8Array): { version: string; tracks: SeratoDbTrack[] } {
  const chunks = readChunks(input);
  let version = "";
  const tracks: SeratoDbTrack[] = [];
  for (const chunk of chunks) {
    if (chunk.tag === "vrsn") {
      version = readText(chunk.payload);
    } else if (chunk.tag === "otrk") {
      const fields = readChunks(chunk.payload);
      const raw: Record<string, string | number | boolean> = {};
      const flags: Record<string, boolean> = {};
      const extraChunks: SeratoChunk[] = [];
      for (const field of fields) {
        if (!KNOWN_TRACK_TAGS.has(field.tag)) {
          extraChunks.push({ tag: field.tag, payload: new Uint8Array(field.payload) });
          continue;
        }
        if (TEXT_TAGS.has(field.tag) || field.tag === "ttyp" || field.tag === "pfil") {
          raw[field.tag] = readText(field.payload);
        } else if (field.tag[0] === "u" && field.payload.length === 4) {
          raw[field.tag] = readU32(field.payload);
        } else if (field.tag[0] === "b" && field.payload.length === 1) {
          const val = field.payload[0] !== 0;
          raw[field.tag] = val;
          flags[field.tag] = val;
        } else {
          extraChunks.push({ tag: field.tag, payload: new Uint8Array(field.payload) });
        }
      }
      const ulbl = typeof raw.ulbl === "number" ? raw.ulbl : undefined;
      const utpc = typeof raw.utpc === "number" ? raw.utpc : undefined;
      const path = typeof raw.pfil === "string" ? raw.pfil : "";
      tracks.push({
        path,
        type: typeof raw.ttyp === "string" ? raw.ttyp : seratoType(path),
        title: typeof raw.tsng === "string" ? raw.tsng : undefined,
        artist: typeof raw.tart === "string" ? raw.tart : undefined,
        album: typeof raw.talb === "string" ? raw.talb : undefined,
        genre: typeof raw.tgen === "string" ? raw.tgen : undefined,
        comment: typeof raw.tcom === "string" ? raw.tcom : undefined,
        grouping: typeof raw.tgrp === "string" ? raw.tgrp : undefined,
        remixer: typeof raw.trmx === "string" ? raw.trmx : undefined,
        length: typeof raw.tlen === "string" ? raw.tlen : undefined,
        size: typeof raw.tsiz === "string" ? raw.tsiz : undefined,
        bitrate: typeof raw.tbit === "string" ? raw.tbit : undefined,
        sampleRate: typeof raw.tsmp === "string" ? raw.tsmp : undefined,
        bpm: typeof raw.tbpm === "string" ? raw.tbpm : undefined,
        composer: typeof raw.tcmp === "string" ? raw.tcmp : undefined,
        year: typeof raw.ttyr === "string" ? raw.ttyr : undefined,
        label: typeof raw.tlbl === "string" ? raw.tlbl : undefined,
        added: typeof raw.tadd === "string" ? raw.tadd : undefined,
        key: typeof raw.tkey === "string" ? raw.tkey : undefined,
        uadd: typeof raw.uadd === "number" ? raw.uadd : undefined,
        utkn: typeof raw.utkn === "number" ? raw.utkn : undefined,
        utme: typeof raw.utme === "number" ? raw.utme : undefined,
        ufsb: typeof raw.ufsb === "number" ? raw.ufsb : undefined,
        udsc: typeof raw.udsc === "number" ? raw.udsc : undefined,
        utpc,
        playCount: utpc,
        ulbl,
        color: colorU32ToHex(ulbl),
        played: typeof raw.bply === "boolean" ? raw.bply : undefined,
        beatgridLocked: typeof raw.bbgl === "boolean" ? raw.bbgl : undefined,
        flags,
        extraChunks: extraChunks.length > 0 ? extraChunks : undefined,
      });
    }
  }
  return { version, tracks };
}

export function encodeNeworder(crateNames: string[]): Uint8Array {
  const lines = ["[begin record]", ...crateNames.map((name) => `[crate]${name}`), "[end record]"];
  return encodeUtf16be(`${lines.join("\n")}\n`);
}

export function decodeNeworder(input: Uint8Array): string[] {
  const text = decodeUtf16be(input);
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("[crate]"))
    .map((line) => line.slice(7));
}

export const encodeDatabaseTracks = encodeDatabase;
export const encodeDatabaseV2 = encodeDatabase;
export const decodeDatabaseV2 = decodeDatabaseTracks;

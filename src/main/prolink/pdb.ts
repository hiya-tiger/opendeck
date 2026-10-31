// rekordbox export.pdb (DeviceSQL) reader, written from the prose and byte
// diagrams in Deep Symmetry's "Rekordbox Export Structure Analysis"
// (exports.html). No Kaitai struct or other implementation code was used.
//
// Layout recap (all numbers little-endian):
//   page 0: header — len_page @4, num_tables @8, table pointers from 0x1c,
//           each {type, empty_candidate, first_page, last_page}.
//   table pages: a linked list first_page..last_page via next_page @0x0c.
//           page header 0x20 bytes, data header 8 bytes, heap from 0x28.
//           num_row_offsets = low 13 bits of the 24-bit value @0x18.
//           page_flags @0x1b; bit 0x40 marks an index page (no rows).
//           Row index grows backwards from the page end in groups of 16:
//           [ofs15 .. ofs0][presence u16][txn u16] = 0x24 bytes per group.
//           A row lives at page + 0x28 + ofs.

export const TABLE = {
  tracks: 0x00,
  genres: 0x01,
  artists: 0x02,
  albums: 0x03,
  labels: 0x04,
  keys: 0x05,
  colors: 0x06,
  playlistTree: 0x07,
  playlistEntries: 0x08,
  artwork: 0x0d,
} as const;

export const PAGE_HEADER = 0x28;
export const ROW_GROUP = 0x24;
export const PAGE_FLAG_INDEX = 0x40;

export const FILE_TYPES: Record<number, string> = { 0x01: "mp3", 0x04: "m4a", 0x05: "flac", 0x0b: "wav", 0x0c: "aiff" };

/** Track-row string slots (exports.html table 4). */
export const TRACK_STRINGS = [
  "isrc",
  "lyricist",
  "unknown2",
  "unknown3",
  "unknown4",
  "message",
  "publishTrackInfo",
  "autoloadHotcues",
  "unknown5",
  "unknown6",
  "dateAdded",
  "releaseDate",
  "mixName",
  "unknown7",
  "analyzePath",
  "analyzeDate",
  "comment",
  "title",
  "unknown8",
  "filename",
  "filePath",
] as const;

export interface PdbTrack {
  id: number;
  title: string;
  artistId: number;
  albumId: number;
  genreId: number;
  keyId: number;
  colorId: number;
  labelId: number;
  remixerId: number;
  composerId: number;
  originalArtistId: number;
  artworkId: number;
  rating: number;
  tempo: number; // BPM
  duration: number; // seconds
  sampleRate: number;
  sampleDepth: number;
  bitrate: number;
  fileSize: number;
  fileType: string;
  trackNumber: number;
  discNumber: number;
  year: number;
  playCount: number;
  filePath: string;
  filename: string;
  analyzePath: string;
  comment: string;
  mixName: string;
  dateAdded: string;
}

export interface PdbPlaylistNode {
  id: number;
  parentId: number;
  name: string;
  isFolder: boolean;
  sortOrder: number;
}

export interface PdbPlaylistEntry {
  playlistId: number;
  trackId: number;
  index: number;
}

export interface PdbDatabase {
  pageSize: number;
  tracks: PdbTrack[];
  artists: Map<number, string>;
  albums: Map<number, { name: string; artistId: number }>;
  genres: Map<number, string>;
  labels: Map<number, string>;
  keys: Map<number, string>;
  colors: Map<number, string>;
  artwork: Map<number, string>;
  playlists: PdbPlaylistNode[];
  playlistEntries: PdbPlaylistEntry[];
  warnings: string[];
}

export class PdbError extends Error {}

export function readDeviceSqlString(buf: Buffer, at: number): string {
  if (at < 0 || at >= buf.length) throw new PdbError(`string offset ${at} outside file`);
  const lk = buf[at];
  if (lk & 0x01) {
    const len = (lk >> 1) - 1;
    if (len <= 0) return "";
    return buf.subarray(at + 1, Math.min(buf.length, at + 1 + len)).toString("latin1");
  }
  if (at + 4 > buf.length) throw new PdbError("truncated long string");
  const total = buf.readUInt16LE(at + 1);
  const n = Math.max(0, total - 4);
  const data = buf.subarray(at + 4, Math.min(buf.length, at + 4 + n));
  if (lk === 0x90 && data[0] === 0x03) {
    // ISRC: marked as UTF-16 but holds 03, ASCII, NUL.
    const end = data.indexOf(0, 1);
    return data.subarray(1, end === -1 ? data.length : end).toString("latin1");
  }
  if (lk & 0x40) return data.toString("latin1");
  if (lk & 0x20) return data.toString("utf8");
  if (lk & 0x10) {
    if (lk & 0x80) return stripNul(data.subarray(0, data.length & ~1).toString("utf16le"));
    const swapped = Buffer.from(data.subarray(0, data.length & ~1));
    swapped.swap16();
    return stripNul(swapped.toString("utf16le"));
  }
  return data.toString("latin1");
}

const stripNul = (s: string): string => s.replace(/\u0000+$/, "");

interface TablePointer {
  type: number;
  firstPage: number;
  lastPage: number;
}

export function* tableRows(buf: Buffer, pageSize: number, table: TablePointer, warnings: string[] = []): Generator<number> {
  const seen = new Set<number>();
  let index = table.firstPage;
  for (;;) {
    if (seen.has(index)) {
      warnings.push(`page loop at ${index} in table ${table.type}`);
      return;
    }
    seen.add(index);
    const start = index * pageSize;
    if (start + pageSize > buf.length) {
      warnings.push(`page ${index} of table ${table.type} beyond end of file`);
      return;
    }
    const pageIndex = buf.readUInt32LE(start + 0x04);
    const type = buf.readUInt32LE(start + 0x08);
    const next = buf.readUInt32LE(start + 0x0c);
    const flags = buf[start + 0x1b];
    if (pageIndex === index && type === table.type && (flags & PAGE_FLAG_INDEX) === 0) {
      const packed = buf[start + 0x18] | (buf[start + 0x19] << 8) | (buf[start + 0x1a] << 16);
      const numOffsets = packed & 0x1fff;
      const groups = Math.ceil(numOffsets / 16);
      for (let g = 0; g < groups; g++) {
        const base = start + pageSize - g * ROW_GROUP;
        const presence = buf.readUInt16LE(base - 4);
        for (let i = 0; i < 16; i++) {
          if (g * 16 + i >= numOffsets) break;
          if (!(presence & (1 << i))) continue;
          const ofs = buf.readUInt16LE(base - 6 - 2 * i);
          const row = start + PAGE_HEADER + ofs;
          if (row >= start + pageSize) {
            warnings.push(`row offset ${ofs} outside page ${index}`);
            continue;
          }
          yield row;
        }
      }
    }
    if (index === table.lastPage) return;
    if (!next || next === index) return;
    index = next;
  }
}

const u32 = (b: Buffer, at: number): number => b.readUInt32LE(at);
const u16 = (b: Buffer, at: number): number => b.readUInt16LE(at);

export function parsePdb(input: Uint8Array): PdbDatabase {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < 0x1c) throw new PdbError("file too short for a PDB header");
  const pageSize = u32(buf, 0x04);
  const numTables = u32(buf, 0x08);
  if (pageSize < 0x100 || pageSize > 0x10000 || (pageSize & (pageSize - 1)) !== 0) throw new PdbError(`implausible page size ${pageSize}`);
  if (numTables > 64 || 0x1c + numTables * 16 > pageSize) throw new PdbError(`implausible table count ${numTables}`);
  const tables = new Map<number, TablePointer>();
  for (let i = 0; i < numTables; i++) {
    const at = 0x1c + i * 16;
    tables.set(u32(buf, at), { type: u32(buf, at), firstPage: u32(buf, at + 8), lastPage: u32(buf, at + 12) });
  }
  const warnings: string[] = [];
  const rows = function* (type: number): Generator<number> {
    const t = tables.get(type);
    if (t) yield* tableRows(buf, pageSize, t, warnings);
  };
  const str = (at: number): string => {
    try {
      return readDeviceSqlString(buf, at);
    } catch (error) {
      warnings.push((error as Error).message);
      return "";
    }
  };
  const simple = (type: number, idAt: number, nameAt: number): Map<number, string> => {
    const m = new Map<number, string>();
    for (const r of rows(type)) m.set(u32(buf, r + idAt), str(r + nameAt));
    return m;
  };

  const artists = new Map<number, string>();
  for (const r of rows(TABLE.artists)) {
    const subtype = u16(buf, r);
    const id = u32(buf, r + 4);
    const ofs = subtype & 0x04 ? u16(buf, r + 0x0a) : buf[r + 0x09];
    artists.set(id, str(r + ofs));
  }
  const albums = new Map<number, { name: string; artistId: number }>();
  for (const r of rows(TABLE.albums)) {
    const subtype = u16(buf, r);
    const ofs = subtype & 0x04 ? u16(buf, r + 0x16) : buf[r + 0x15];
    albums.set(u32(buf, r + 0x0c), { name: str(r + ofs), artistId: u32(buf, r + 0x08) });
  }
  const genres = simple(TABLE.genres, 0, 4);
  const labels = simple(TABLE.labels, 0, 4);
  const keys = simple(TABLE.keys, 0, 8);
  const artwork = simple(TABLE.artwork, 0, 4);
  const colors = new Map<number, string>();
  for (const r of rows(TABLE.colors)) colors.set(u16(buf, r + 5), str(r + 8));

  const tracks: PdbTrack[] = [];
  for (const r of rows(TABLE.tracks)) {
    const s: Record<string, string> = {};
    TRACK_STRINGS.forEach((name, i) => {
      s[name] = str(r + u16(buf, r + 0x5e + 2 * i));
    });
    tracks.push({
      id: u32(buf, r + 0x48),
      title: s.title,
      artistId: u32(buf, r + 0x44),
      albumId: u32(buf, r + 0x40),
      genreId: u32(buf, r + 0x3c),
      keyId: u32(buf, r + 0x20),
      colorId: buf[r + 0x58],
      labelId: u32(buf, r + 0x28),
      remixerId: u32(buf, r + 0x2c),
      composerId: u32(buf, r + 0x0c),
      originalArtistId: u32(buf, r + 0x24),
      artworkId: u32(buf, r + 0x1c),
      rating: buf[r + 0x59],
      tempo: u32(buf, r + 0x38) / 100,
      duration: u16(buf, r + 0x54),
      sampleRate: u32(buf, r + 0x08),
      sampleDepth: u16(buf, r + 0x52),
      bitrate: u32(buf, r + 0x30),
      fileSize: u32(buf, r + 0x10),
      fileType: FILE_TYPES[u16(buf, r + 0x5a)] ?? "",
      trackNumber: u32(buf, r + 0x34),
      discNumber: u16(buf, r + 0x4c),
      year: u16(buf, r + 0x50),
      playCount: u16(buf, r + 0x4e),
      filePath: s.filePath,
      filename: s.filename,
      analyzePath: s.analyzePath,
      comment: s.comment,
      mixName: s.mixName,
      dateAdded: s.dateAdded,
    });
  }

  const playlists: PdbPlaylistNode[] = [];
  for (const r of rows(TABLE.playlistTree)) {
    playlists.push({
      parentId: u32(buf, r),
      sortOrder: u32(buf, r + 0x08),
      id: u32(buf, r + 0x0c),
      isFolder: u32(buf, r + 0x10) !== 0,
      name: str(r + 0x14),
    });
  }
  const playlistEntries: PdbPlaylistEntry[] = [];
  for (const r of rows(TABLE.playlistEntries)) {
    playlistEntries.push({ index: u32(buf, r), trackId: u32(buf, r + 4), playlistId: u32(buf, r + 8) });
  }

  return { pageSize, tracks, artists, albums, genres, labels, keys, colors, artwork, playlists, playlistEntries, warnings };
}

/** Flatten the playlist tree into "Folder / Sub / Playlist" paths with ordered track ids. */
export function playlistPaths(db: PdbDatabase): { id: number; path: string[]; trackIds: number[] }[] {
  const byId = new Map(db.playlists.map((p) => [p.id, p]));
  const pathOf = (p: PdbPlaylistNode): string[] => {
    const out: string[] = [];
    let cur: PdbPlaylistNode | undefined = p;
    const guard = new Set<number>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      out.unshift(cur.name || `Playlist ${cur.id}`);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return out;
  };
  const entries = new Map<number, PdbPlaylistEntry[]>();
  for (const e of db.playlistEntries) {
    const list = entries.get(e.playlistId) ?? [];
    list.push(e);
    entries.set(e.playlistId, list);
  }
  return db.playlists
    .filter((p) => !p.isFolder)
    .sort((a, b) => a.parentId - b.parentId || a.sortOrder - b.sortOrder || a.id - b.id)
    .map((p) => ({
      id: p.id,
      path: pathOf(p),
      trackIds: (entries.get(p.id) ?? []).sort((a, b) => a.index - b.index).map((e) => e.trackId),
    }));
}

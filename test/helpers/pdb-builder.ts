// Test-only writer for synthetic export.pdb / ANLZ files, following the same
// format description the parser was written from (exports.html, anlz.html).
import { PAGE_HEADER, ROW_GROUP, TABLE } from "../../src/main/prolink/pdb.ts";

export function deviceSqlString(s: string): Buffer {
  const ascii = /^[\x20-\x7e]*$/.test(s);
  if (ascii && s.length <= 126) {
    const b = Buffer.alloc(1 + s.length);
    b[0] = (((s.length + 1) << 1) | 1) & 0xff;
    b.write(s, 1, "latin1");
    return b;
  }
  const data = Buffer.from(s, "utf16le");
  const b = Buffer.alloc(4 + data.length);
  b[0] = 0x90;
  b.writeUInt16LE(4 + data.length, 1);
  data.copy(b, 4);
  return b;
}

export interface TrackFields {
  id: number;
  title: string;
  filePath: string;
  artistId?: number;
  albumId?: number;
  genreId?: number;
  keyId?: number;
  colorId?: number;
  rating?: number;
  bpm?: number;
  duration?: number;
  fileSize?: number;
  fileType?: number;
  analyzePath?: string;
  comment?: string;
}

export function trackRow(t: TrackFields): Buffer {
  const fixed = Buffer.alloc(0x5e + 21 * 2);
  fixed.writeUInt16LE(0x24, 0);
  fixed.writeUInt32LE(44100, 0x08);
  fixed.writeUInt32LE(t.fileSize ?? 0, 0x10);
  fixed.writeUInt32LE(t.keyId ?? 0, 0x20);
  fixed.writeUInt32LE(320, 0x30);
  fixed.writeUInt32LE(Math.round((t.bpm ?? 0) * 100), 0x38);
  fixed.writeUInt32LE(t.genreId ?? 0, 0x3c);
  fixed.writeUInt32LE(t.albumId ?? 0, 0x40);
  fixed.writeUInt32LE(t.artistId ?? 0, 0x44);
  fixed.writeUInt32LE(t.id, 0x48);
  fixed.writeUInt16LE(24, 0x52);
  fixed.writeUInt16LE(t.duration ?? 0, 0x54);
  fixed.writeUInt16LE(29, 0x56);
  fixed[0x58] = t.colorId ?? 0;
  fixed[0x59] = t.rating ?? 0;
  fixed.writeUInt16LE(t.fileType ?? 1, 0x5a);
  fixed.writeUInt16LE(3, 0x5c);
  const strings: string[] = new Array(21).fill("");
  strings[14] = t.analyzePath ?? "";
  strings[16] = t.comment ?? "";
  strings[17] = t.title;
  strings[19] = t.filePath.split("/").pop() ?? "";
  strings[20] = t.filePath;
  const parts: Buffer[] = [fixed];
  let at = fixed.length;
  strings.forEach((s, i) => {
    const enc = deviceSqlString(s);
    fixed.writeUInt16LE(at, 0x5e + 2 * i);
    parts.push(enc);
    at += enc.length;
  });
  return Buffer.concat(parts);
}

export function artistRow(id: number, name: string, far = false): Buffer {
  const s = deviceSqlString(name);
  if (far) {
    const h = Buffer.alloc(0x0c);
    h.writeUInt16LE(0x64, 0);
    h.writeUInt32LE(id, 4);
    h.writeUInt16LE(3, 8);
    h.writeUInt16LE(0x0c, 0x0a);
    return Buffer.concat([h, s]);
  }
  const h = Buffer.alloc(0x0a);
  h.writeUInt16LE(0x60, 0);
  h.writeUInt32LE(id, 4);
  h[8] = 3;
  h[9] = 0x0a;
  return Buffer.concat([h, s]);
}

export function albumRow(id: number, name: string, artistId: number): Buffer {
  const h = Buffer.alloc(0x16);
  h.writeUInt16LE(0x80, 0);
  h.writeUInt32LE(artistId, 0x08);
  h.writeUInt32LE(id, 0x0c);
  h[0x14] = 3;
  h[0x15] = 0x16;
  return Buffer.concat([h, deviceSqlString(name)]);
}

export function idNameRow(id: number, name: string): Buffer {
  const h = Buffer.alloc(4);
  h.writeUInt32LE(id, 0);
  return Buffer.concat([h, deviceSqlString(name)]);
}

export function keyRow(id: number, name: string): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(id, 0);
  h.writeUInt32LE(id, 4);
  return Buffer.concat([h, deviceSqlString(name)]);
}

export function colorRow(id: number, name: string): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt16LE(id, 5);
  return Buffer.concat([h, deviceSqlString(name)]);
}

export function playlistTreeRow(p: { id: number; parentId: number; name: string; isFolder: boolean; sortOrder?: number }): Buffer {
  const h = Buffer.alloc(0x14);
  h.writeUInt32LE(p.parentId, 0);
  h.writeUInt32LE(p.sortOrder ?? 0, 8);
  h.writeUInt32LE(p.id, 0x0c);
  h.writeUInt32LE(p.isFolder ? 1 : 0, 0x10);
  return Buffer.concat([h, deviceSqlString(p.name)]);
}

export function playlistEntryRow(index: number, trackId: number, playlistId: number): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(index, 0);
  b.writeUInt32LE(trackId, 4);
  b.writeUInt32LE(playlistId, 8);
  return b;
}

export interface BuildTable {
  type: number;
  /** A row with present:false is written but flagged deleted. */
  rows: { data: Buffer; present?: boolean }[];
}

/** Lay rows out into pages: page 0 header, then per table an index page and data pages. */
export function buildPdb(tables: BuildTable[], pageSize = 4096): Buffer {
  const pages: Buffer[] = [Buffer.alloc(pageSize)];
  const pointers: { type: number; first: number; last: number }[] = [];
  for (const table of tables) {
    const tablePages: Buffer[] = [];
    const index = Buffer.alloc(pageSize);
    index[0x1b] = 0x64;
    tablePages.push(index);
    let page: Buffer | null = null;
    let heap = 0;
    let offsets: { ofs: number; present: boolean }[] = [];
    const flush = (): void => {
      if (!page) return;
      const n = offsets.length;
      const groups = Math.ceil(n / 16);
      for (let g = 0; g < groups; g++) {
        const base = pageSize - g * ROW_GROUP;
        let presence = 0;
        for (let i = 0; i < 16 && g * 16 + i < n; i++) {
          const o = offsets[g * 16 + i];
          page.writeUInt16LE(o.ofs, base - 6 - 2 * i);
          if (o.present) presence |= 1 << i;
        }
        page.writeUInt16LE(presence, base - 4);
      }
      const presentCount = offsets.filter((o) => o.present).length;
      const packed = (n & 0x1fff) | ((presentCount & 0x7ff) << 13);
      page[0x18] = packed & 0xff;
      page[0x19] = (packed >> 8) & 0xff;
      page[0x1a] = (packed >> 16) & 0xff;
      page[0x1b] = offsets.some((o) => !o.present) ? 0x34 : 0x24;
      page.writeUInt16LE(heap, 0x1e);
      tablePages.push(page);
      page = null;
    };
    for (const row of table.rows) {
      const len = (row.data.length + 3) & ~3;
      const fits = (p: number, h: number): boolean => PAGE_HEADER + h + len <= pageSize - Math.ceil((p + 1) / 16) * ROW_GROUP;
      if (page && !fits(offsets.length, heap)) flush();
      if (!page) {
        page = Buffer.alloc(pageSize);
        heap = 0;
        offsets = [];
        if (!fits(0, 0)) throw new Error("row larger than a page");
      }
      row.data.copy(page, PAGE_HEADER + heap);
      offsets.push({ ofs: heap, present: row.present !== false });
      heap += len;
    }
    flush();
    const first = pages.length;
    tablePages.forEach((p, i) => {
      const idx = first + i;
      p.writeUInt32LE(idx, 0x04);
      p.writeUInt32LE(table.type, 0x08);
      p.writeUInt32LE(i === tablePages.length - 1 ? 0 : idx + 1, 0x0c);
      if (i === 0) {
        p.writeUInt32LE(idx, 0x28 + 8);
        p.writeUInt32LE(i === tablePages.length - 1 ? 0x03ffffff : idx + 1, 0x28 + 12);
      }
      pages.push(p);
    });
    pointers.push({ type: table.type, first, last: pages.length - 1 });
  }
  const header = pages[0];
  header.writeUInt32LE(pageSize, 0x04);
  header.writeUInt32LE(pointers.length, 0x08);
  header.writeUInt32LE(pages.length, 0x0c);
  pointers.forEach((p, i) => {
    const at = 0x1c + i * 16;
    header.writeUInt32LE(p.type, at);
    header.writeUInt32LE(0, at + 4);
    header.writeUInt32LE(p.first, at + 8);
    header.writeUInt32LE(p.last, at + 12);
  });
  return Buffer.concat(pages);
}

export interface FixtureTrack extends TrackFields {
  artist?: string;
}

/** A small but complete rekordbox database used by several tests. */
export function sampleDatabase(pageSize = 4096): Buffer {
  return buildPdb(
    [
      {
        type: TABLE.tracks,
        rows: [
          { data: trackRow({ id: 1, title: "Opening Track", filePath: "/Contents/Artist One/Opening Track.mp3", artistId: 10, albumId: 20, genreId: 30, keyId: 40, colorId: 5, rating: 4, bpm: 124.5, duration: 301, fileSize: 9, analyzePath: "/PIONEER/USBANLZ/P001/00000001/ANLZ0000.DAT" }) },
          { data: trackRow({ id: 2, title: "Ünïcödé Dub ☂", filePath: "/Contents/Artist Two/Ünïcödé Dub.flac", artistId: 11, genreId: 30, keyId: 41, bpm: 128, duration: 420, fileSize: 12, fileType: 5 }) },
          { data: trackRow({ id: 99, title: "Deleted", filePath: "/Contents/gone.mp3" }), present: false },
          { data: trackRow({ id: 3, title: "Closer", filePath: "/Contents/Artist One/Closer.wav", artistId: 10, bpm: 90, duration: 200, fileSize: 7, fileType: 0x0b }) },
        ],
      },
      { type: TABLE.genres, rows: [{ data: idNameRow(30, "House") }] },
      { type: TABLE.artists, rows: [{ data: artistRow(10, "Artist One") }, { data: artistRow(11, "Artist Two", true) }] },
      { type: TABLE.albums, rows: [{ data: albumRow(20, "First Album", 10) }] },
      { type: TABLE.keys, rows: [{ data: keyRow(40, "Am") }, { data: keyRow(41, "F#") }] },
      { type: TABLE.colors, rows: [{ data: colorRow(5, "Green") }] },
      {
        type: TABLE.playlistTree,
        rows: [
          { data: playlistTreeRow({ id: 1, parentId: 0, name: "Gigs", isFolder: true }) },
          { data: playlistTreeRow({ id: 2, parentId: 1, name: "Friday", isFolder: false, sortOrder: 1 }) },
          { data: playlistTreeRow({ id: 3, parentId: 0, name: "Warmup", isFolder: false, sortOrder: 2 }) },
        ],
      },
      {
        type: TABLE.playlistEntries,
        rows: [
          { data: playlistEntryRow(2, 1, 2) },
          { data: playlistEntryRow(1, 3, 2) },
          { data: playlistEntryRow(1, 2, 3) },
        ],
      },
    ],
    pageSize,
  );
}

/** Minimal ANLZ .EXT with one PCO2 hot-cue section (big-endian). */
export function anlzWithHotCues(cues: { hotCue: number; timeMs: number; loopEndMs?: number; rgb?: [number, number, number]; comment?: string }[]): Buffer {
  const entries = cues.map((c) => {
    const comment = c.comment ? Buffer.concat([Buffer.from(c.comment, "utf16le").swap16(), Buffer.alloc(2)]) : Buffer.alloc(0);
    const len = 0x2c + comment.length + 4 + 4;
    const e = Buffer.alloc(len);
    e.write("PCP2", 0, "latin1");
    e.writeUInt32BE(0x10, 4);
    e.writeUInt32BE(len, 8);
    e.writeUInt32BE(c.hotCue, 0x0c);
    e[0x10] = c.loopEndMs ? 2 : 1;
    e.writeUInt32BE(c.timeMs, 0x14);
    e.writeUInt32BE(c.loopEndMs ?? 0xffffffff, 0x18);
    e.writeUInt32BE(comment.length, 0x28);
    comment.copy(e, 0x2c);
    if (c.rgb) {
      const at = 0x2c + comment.length;
      e[at] = 1;
      e[at + 1] = c.rgb[0];
      e[at + 2] = c.rgb[1];
      e[at + 3] = c.rgb[2];
    }
    return e;
  });
  const body = Buffer.concat(entries);
  const tag = Buffer.alloc(0x14);
  tag.write("PCO2", 0, "latin1");
  tag.writeUInt32BE(0x14, 4);
  tag.writeUInt32BE(0x14 + body.length, 8);
  tag.writeUInt32BE(1, 0x0c);
  tag.writeUInt16BE(cues.length, 0x10);
  const header = Buffer.alloc(0x1c);
  header.write("PMAI", 0, "latin1");
  header.writeUInt32BE(0x1c, 4);
  const file = Buffer.concat([header, tag, body]);
  file.writeUInt32BE(file.length, 8);
  return file;
}

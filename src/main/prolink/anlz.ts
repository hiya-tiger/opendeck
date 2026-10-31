// rekordbox ANLZ (.DAT / .EXT) cue-point reader, written from the prose and
// byte diagrams in Deep Symmetry's "Rekordbox Export Structure Analysis"
// (anlz.html). Only cue lists are read: PCO2 (extended, preferred) and PCOB.
// ANLZ files are big-endian, unlike export.pdb.

export interface AnlzCue {
  /** 0 for a memory point, otherwise hot cue number (A = 1). */
  hotCue: number;
  timeMs: number;
  /** Set for loops. */
  loopEndMs?: number;
  /** Hot cue RGB (#rrggbb) when present. */
  color?: string;
  comment?: string;
}

const fourcc = (b: Buffer, at: number): string => b.toString("latin1", at, at + 4);

const utf16be = (b: Buffer): string => {
  const c = Buffer.from(b.subarray(0, b.length & ~1));
  c.swap16();
  return c.toString("utf16le").replace(/\u0000+$/, "");
};

function* sections(buf: Buffer): Generator<{ tag: string; at: number; len: number }> {
  if (buf.length < 12 || fourcc(buf, 0) !== "PMAI") return;
  let at = buf.readUInt32BE(4);
  const end = Math.min(buf.length, buf.readUInt32BE(8) || buf.length);
  while (at + 12 <= end) {
    const len = buf.readUInt32BE(at + 8);
    if (len < 12 || at + len > end) return;
    yield { tag: fourcc(buf, at), at, len };
    at += len;
  }
}

const hex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();

/** Returns cues from PCO2 sections if any exist, otherwise from PCOB. */
export function parseAnlzCues(input: Uint8Array): AnlzCue[] {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const extended: AnlzCue[] = [];
  const legacy: AnlzCue[] = [];
  for (const s of sections(buf)) {
    if (s.tag === "PCO2") {
      const count = buf.readUInt16BE(s.at + 0x10);
      let e = s.at + 0x14;
      for (let i = 0; i < count && e + 0x1c <= s.at + s.len; i++) {
        if (fourcc(buf, e) !== "PCP2") break;
        const lenEntry = buf.readUInt32BE(e + 8);
        if (lenEntry < 0x1c || e + lenEntry > s.at + s.len) break;
        const cue: AnlzCue = { hotCue: buf.readUInt32BE(e + 0x0c), timeMs: buf.readUInt32BE(e + 0x14) };
        if (buf[e + 0x10] === 2) cue.loopEndMs = buf.readUInt32BE(e + 0x18);
        if (lenEntry >= 0x2c) {
          const lenComment = buf.readUInt32BE(e + 0x28);
          if (lenComment > 0 && 0x2c + lenComment <= lenEntry) {
            const text = utf16be(buf.subarray(e + 0x2c, e + 0x2c + lenComment));
            if (text) cue.comment = text;
          }
          const c = e + 0x2c + lenComment;
          if (cue.hotCue && c + 4 <= e + lenEntry && (buf[c] || buf[c + 1] || buf[c + 2] || buf[c + 3])) {
            cue.color = hex(buf[c + 1], buf[c + 2], buf[c + 3]);
          }
        }
        extended.push(cue);
        e += lenEntry;
      }
    } else if (s.tag === "PCOB") {
      const count = buf.readUInt16BE(s.at + 0x12);
      let e = s.at + 0x18;
      for (let i = 0; i < count && e + 0x28 <= s.at + s.len; i++) {
        if (fourcc(buf, e) !== "PCPT") break;
        const lenEntry = buf.readUInt32BE(e + 8) || 0x38;
        const cue: AnlzCue = { hotCue: buf.readUInt32BE(e + 0x0c), timeMs: buf.readUInt32BE(e + 0x20) };
        if (buf[e + 0x1c] === 2) cue.loopEndMs = buf.readUInt32BE(e + 0x24);
        legacy.push(cue);
        e += lenEntry;
      }
    }
  }
  const cues = extended.length ? extended : legacy;
  return cues.filter((c) => c.timeMs !== 0xffffffff).sort((a, b) => a.hotCue - b.hotCue || a.timeMs - b.timeMs);
}

/** "/PIONEER/USBANLZ/.../ANLZ0000.DAT" -> [".EXT", ".DAT"] candidates. */
export function anlzCandidates(analyzePath: string): string[] {
  if (!analyzePath) return [];
  const base = analyzePath.replace(/\.(DAT|EXT|2EX)$/i, "");
  return [`${base}.EXT`, `${base}.DAT`];
}

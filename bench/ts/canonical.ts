// Canonical text form of every scan/import result. bench/rs/src/canonical.rs
// writes the same text; equal SHA-256 digests mean equal parser output.
import type { PdbDatabase } from "../../src/main/prolink/pdb.ts";
import type { AnlzCue } from "../../src/main/prolink/anlz.ts";
import type { BeatGridMarker, SeratoMarkers } from "../../src/renderer/media/serato-tags.ts";
import type { SeratoColumn } from "../../src/renderer/media/serato-codec.ts";

export interface ScanResult {
  database: { version: string; tracks: Array<Record<string, string | number | boolean>> };
  crates: Array<{ name: string; version: string; columns: SeratoColumn[]; paths: string[] }>;
  markers: SeratoMarkers[];
  grids: BeatGridMarker[][];
  pdb: PdbDatabase;
  playlists: { id: number; path: string[]; trackIds: number[] }[];
  anlz: AnlzCue[][];
}

const US = "\x1f";
const val = (v: string | number | boolean): string => (typeof v === "boolean" ? (v ? "1" : "0") : String(v));
const byId = <T>(m: Map<number, T>): Array<[number, T]> => [...m.entries()].sort((a, b) => a[0] - b[0]);

export function canonicalScan(r: ScanResult): string {
  const out: string[] = [`db|${r.database.version}`];
  for (const t of r.database.tracks) out.push(`t|${Object.keys(t).sort().map((k) => `${k}=${val(t[k])}`).join(US)}`);
  for (const c of r.crates) out.push(`c|${c.name}|${c.version}|${c.columns.map((x) => `${x.name}:${x.width}`).join(",")}|${c.paths.join(US)}`);
  for (const m of r.markers) {
    out.push(`m|${m.trackColor}|${m.bpmLocked ? 1 : 0}|${m.cues.map((c) => [c.index, c.positionMs, c.color, c.name].join(",")).join(";")}|${m.loops.map((l) => [l.index, l.startMs, l.endMs, l.color, l.locked ? 1 : 0, l.name].join(",")).join(";")}`);
  }
  for (const g of r.grids) out.push(`g|${g.map((m) => `${m.position},${m.bpm !== undefined ? `b${m.bpm}` : `n${m.beatsTillNext}`}`).join(";")}`);
  const p = r.pdb;
  out.push(`p|${p.pageSize}|${p.warnings.length}`);
  for (const t of p.tracks) {
    out.push(`pt|${[t.id, t.title, t.artistId, t.albumId, t.genreId, t.keyId, t.colorId, t.labelId, t.remixerId, t.composerId, t.originalArtistId, t.artworkId, t.rating, t.tempo, t.duration, t.sampleRate, t.sampleDepth, t.bitrate, t.fileSize, t.fileType, t.trackNumber, t.discNumber, t.year, t.playCount, t.filePath, t.filename, t.analyzePath, t.comment, t.mixName, t.dateAdded].join(US)}`);
  }
  for (const [id, n] of byId(p.artists)) out.push(`pa|${id}|${n}`);
  for (const [id, a] of byId(p.albums)) out.push(`pb|${id}|${a.name}|${a.artistId}`);
  for (const [tag, m] of [["pg", p.genres], ["pl", p.labels], ["pk", p.keys], ["pc", p.colors], ["pw", p.artwork]] as const) {
    for (const [id, n] of byId(m)) out.push(`${tag}|${id}|${n}`);
  }
  for (const pl of r.playlists) out.push(`pp|${pl.id}|${pl.path.join("/")}|${pl.trackIds.join(",")}`);
  for (const cues of r.anlz) out.push(`a|${cues.map((c) => [c.hotCue, c.timeMs, c.loopEndMs ?? "", c.color ?? "", c.comment ?? ""].join(",")).join(";")}`);
  return out.join("\n");
}

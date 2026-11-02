// Deterministic benchmark fixtures for the MyGo + Rust experiment.
//
//   node bench/fixtures/gen.ts <outDir> [--seconds 120] [--tracks 6]
//
// Everything is synthetic and seeded, so every runner (and both the TS and the
// Rust side) works on byte-identical inputs. Writes:
//   audio/trackNN.f32       "ODF1" + u32 sr + u32 channels + u32 frames, then planar f32le
//   serato/database V2      Serato database (encodeDatabase), 20 000 tracks
//   serato/Subcrates/*.crate 100 crates x 200 paths (encodeCrate)
//   serato/tags/NNNN.m2 / .bg  2 000 Markers2 + BeatGrid blobs (encodeMarkers2 / encodeBeatGrid)
//   rekordbox/export.pdb    20 000 tracks, 2 000 artists, 200 playlists (test pdb-builder)
//   rekordbox/anlz/NNNN.EXT 2 000 ANLZ files with PCO2 hot cues
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { encodeCrate, encodeDatabase, type SeratoDbTrack } from "../../src/renderer/media/serato-codec.ts";
import { encodeBeatGrid, encodeMarkers2 } from "../../src/renderer/media/serato-tags.ts";
import { TABLE } from "../../src/main/prolink/pdb.ts";
import {
  albumRow, anlzWithHotCues, artistRow, buildPdb, colorRow, idNameRow, keyRow, playlistEntryRow, playlistTreeRow, trackRow,
} from "../../test/helpers/pdb-builder.ts";

const args = process.argv.slice(2);
const out = path.resolve(args[0] ?? "bench-fixtures");
const opt = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const SECONDS = opt("seconds", 120);
const TRACKS = opt("tracks", 6);
const LIB_TRACKS = opt("library", 20000);
const SR = 44100;

let seed = 0x9e3779b9;
const rand = (): number => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};

const mk = (...p: string[]): string => { const d = path.join(out, ...p); mkdirSync(d, { recursive: true }); return d; };

// ---- audio ---------------------------------------------------------------
const BPMS = [120, 128, 140, 174, 95, 100, 124, 132];
const ROOTS = [57, 60, 62, 64, 65, 67, 69, 71]; // midi roots: A3, C4, D4, ...
const audioDir = mk("audio");
for (let t = 0; t < TRACKS; t += 1) {
  const bpm = BPMS[t % BPMS.length];
  const root = ROOTS[t % ROOTS.length];
  const minor = t % 2 === 1;
  const frames = SECONDS * SR;
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const beat = (60 / bpm) * SR;
  const hz = (m: number): number => 440 * 2 ** ((m - 69) / 12);
  const third = minor ? 3 : 4;
  const chord = [hz(root), hz(root + third), hz(root + 7)];
  const bassHz = hz(root - 24);
  for (let i = 0; i < frames; i += 1) {
    const inBeat = i % beat;
    const ts = i / SR;
    const kick = Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-inBeat / 800)) * (inBeat / SR)) * Math.exp(-inBeat / 4000);
    const hatPhase = (i + beat / 2) % beat;
    const hat = (rand() * 2 - 1) * 0.08 * Math.exp(-hatPhase / 300);
    const bass = 0.25 * Math.sin(2 * Math.PI * bassHz * ts);
    const pad = 0.07 * (Math.sin(2 * Math.PI * chord[0] * ts) + Math.sin(2 * Math.PI * chord[1] * ts) + Math.sin(2 * Math.PI * chord[2] * ts));
    const s = 0.6 * kick + hat + bass + pad;
    L[i] = s * 0.9;
    R[i] = s * 0.9 + 0.02 * Math.sin(2 * Math.PI * chord[1] * 2 * ts);
  }
  const header = Buffer.alloc(16);
  header.write("ODF1", 0, "latin1");
  header.writeUInt32LE(SR, 4);
  header.writeUInt32LE(2, 8);
  header.writeUInt32LE(frames, 12);
  writeFileSync(path.join(audioDir, `track${String(t).padStart(2, "0")}.f32`), Buffer.concat([
    header, Buffer.from(L.buffer), Buffer.from(R.buffer),
  ]));
}

// ---- Serato ----------------------------------------------------------------
const WORDS = ["Deep", "Night", "Ünïcödé", "Bass", "Groove", "Sun", "Rise", "Dub", "Café", "Echo", "Drive", "Lights", "☂", "Kick", "Soul"];
const word = (): string => WORDS[Math.floor(rand() * WORDS.length)];
const KEYS = ["Am", "C", "F#m", "Bb", "Ebm", "G", "Dm", "E"];
const libPaths: string[] = [];
const dbTracks: SeratoDbTrack[] = [];
for (let i = 0; i < LIB_TRACKS; i += 1) {
  const artist = `${word()} ${word()}`;
  const title = `${word()} ${word()} ${i}`;
  const p = `Users/dj/Music/${artist}/${title}.mp3`;
  libPaths.push(p);
  dbTracks.push({
    path: p, type: "mp3", title, artist, album: `${word()} LP`, genre: word(), comment: `c${i}`,
    length: `0${3 + (i % 5)}:${String(i % 60).padStart(2, "0")}.00`, size: `${(8 + (i % 7)).toFixed(1)}MB`, bitrate: "320.0kbps",
    sampleRate: "44.1k", bpm: String(90 + (i % 60)), year: String(1990 + (i % 35)), key: KEYS[i % KEYS.length],
    uadd: 1600000000 + i, utme: 1600000000 + i, playCount: i % 17, played: i % 3 === 0,
  });
}
const seratoDir = mk("serato");
writeFileSync(path.join(seratoDir, "database V2"), encodeDatabase(dbTracks));
const crateDir = mk("serato", "Subcrates");
for (let c = 0; c < 100; c += 1) {
  const paths = Array.from({ length: 200 }, () => libPaths[Math.floor(rand() * libPaths.length)]);
  writeFileSync(path.join(crateDir, `Crate ${String(c).padStart(3, "0")}.crate`), encodeCrate(paths));
}
const tagDir = mk("serato", "tags");
const PALETTE = ["#CC0000", "#CC8800", "#00CC00", "#0000CC", "#CC00CC", "#00CCCC", "#CCCC00", "#27AAE1"];
for (let n = 0; n < 2000; n += 1) {
  const cues = Array.from({ length: 1 + (n % 8) }, (_, i) => ({
    index: i, positionMs: Math.floor(rand() * 300000), color: PALETTE[(n + i) % PALETTE.length], name: i % 2 ? `${word()} ${i}` : "",
  }));
  const loops = Array.from({ length: n % 3 }, (_, i) => ({
    index: i, startMs: 1000 * i, endMs: 1000 * i + 4000, color: "#27AAE1", name: `Loop ${i}`, locked: i === 1,
  }));
  writeFileSync(path.join(tagDir, `${String(n).padStart(4, "0")}.m2`), encodeMarkers2({ cues, loops, trackColor: "#FF99FF", bpmLocked: n % 2 === 0 }));
  const bpm = 90 + (n % 60) + 0.5;
  const grid = Array.from({ length: 1 + (n % 4) }, (_, i) => ({ position: 0.05 + i * 30, beatsTillNext: 64, bpm }));
  writeFileSync(path.join(tagDir, `${String(n).padStart(4, "0")}.bg`), encodeBeatGrid(grid));
}

// ---- rekordbox -------------------------------------------------------------
const rbDir = mk("rekordbox");
const trackRows = [];
for (let i = 1; i <= LIB_TRACKS; i += 1) {
  trackRows.push({
    data: trackRow({
      id: i, title: i % 9 === 0 ? `Ünïcödé ${word()} ${i}` : `${word()} ${word()} ${i}`, filePath: `/Contents/${word()}/${word()} ${i}.mp3`,
      artistId: 1 + (i % 2000), albumId: 1 + (i % 500), genreId: 1 + (i % 15), keyId: 1 + (i % 8), colorId: i % 8, rating: i % 6,
      bpm: 90 + (i % 60) + 0.25, duration: 180 + (i % 300), fileSize: 5000000 + i, fileType: [1, 4, 5, 0x0b][i % 4],
      analyzePath: `/PIONEER/USBANLZ/P${String(i % 1000).padStart(3, "0")}/${String(i).padStart(8, "0")}/ANLZ0000.DAT`, comment: i % 5 ? "" : `note ${i}`,
    }),
    present: i % 97 !== 0,
  });
}
const artists = Array.from({ length: 2000 }, (_, i) => ({ data: artistRow(i + 1, `${word()} ${word()}`, i % 10 === 0) }));
const albums = Array.from({ length: 500 }, (_, i) => ({ data: albumRow(i + 1, `${word()} Album`, 1 + (i % 2000)) }));
const genres = Array.from({ length: 15 }, (_, i) => ({ data: idNameRow(i + 1, WORDS[i]) }));
const keys = KEYS.map((k, i) => ({ data: keyRow(i + 1, k) }));
const colors = ["Pink", "Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple"].map((c, i) => ({ data: colorRow(i + 1, c) }));
const tree = [];
for (let f = 1; f <= 20; f += 1) tree.push({ data: playlistTreeRow({ id: f, parentId: 0, name: `Folder ${f}`, isFolder: true, sortOrder: f }) });
for (let p = 21; p <= 220; p += 1) tree.push({ data: playlistTreeRow({ id: p, parentId: 1 + (p % 20), name: `${word()} Set ${p}`, isFolder: false, sortOrder: p }) });
const entries = [];
for (let p = 21; p <= 220; p += 1) for (let k = 0; k < 100; k += 1) entries.push({ data: playlistEntryRow(k + 1, 1 + Math.floor(rand() * LIB_TRACKS), p) });
writeFileSync(path.join(rbDir, "export.pdb"), buildPdb([
  { type: TABLE.tracks, rows: trackRows },
  { type: TABLE.genres, rows: genres },
  { type: TABLE.artists, rows: artists },
  { type: TABLE.albums, rows: albums },
  { type: TABLE.keys, rows: keys },
  { type: TABLE.colors, rows: colors },
  { type: TABLE.playlistTree, rows: tree },
  { type: TABLE.playlistEntries, rows: entries },
], 4096));
const anlzDir = mk("rekordbox", "anlz");
for (let n = 0; n < 2000; n += 1) {
  const cues = Array.from({ length: 1 + (n % 8) }, (_, i) => ({
    hotCue: i % 3 === 0 ? 0 : i, timeMs: Math.floor(rand() * 300000), loopEndMs: i === 2 ? 400000 : undefined,
    rgb: i % 2 ? ([200, (n * 7) % 255, 40] as [number, number, number]) : undefined, comment: i % 4 === 1 ? `${word()} cue` : undefined,
  }));
  writeFileSync(path.join(anlzDir, `${String(n).padStart(4, "0")}.EXT`), anlzWithHotCues(cues));
}

writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ seconds: SECONDS, tracks: TRACKS, library: LIB_TRACKS, sampleRate: SR }, null, 2));
console.log(`fixtures written to ${out}`);

// "Today" side of the MyGo + Rust benchmark: the current TypeScript code paths,
// run in Electron's own V8 (ELECTRON_RUN_AS_NODE=1), on the fixtures from
// bench/fixtures/gen.ts.
//
//   node bench/ts/build.mjs && ELECTRON_RUN_AS_NODE=1 electron bench/out/ts-bench.cjs <fixtures> --runs 5 --out ts.json [--dump ts-dump.json]
//
// Workloads (same as the Rust side, bench/rs):
//   analysis  analyzeBuffer() on every track, through a pool of
//             defaultPoolSize(cpus) workers, as the app's AnalysisScheduler does
//   scan      read + parse the whole library: Serato database V2, crates,
//             Markers2 + BeatGrid tags, export.pdb (+ playlistPaths), ANLZ cues
//   hash      SHA-256 of every audio file, streamed (sha256File in separation.ts)
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { defaultPoolSize } from "../../src/renderer/engine/analysis-pool.ts";
import { decodeCrate, decodeDatabase } from "../../src/renderer/media/serato-codec.ts";
import { decodeBeatGrid, decodeMarkers2 } from "../../src/renderer/media/serato-tags.ts";
import { parsePdb, playlistPaths } from "../../src/main/prolink/pdb.ts";
import { parseAnlzCues } from "../../src/main/prolink/anlz.ts";
import { canonicalScan, type ScanResult } from "./canonical.ts";

const args = process.argv.slice(2);
const fixtures = path.resolve(args[0] ?? "bench-fixtures");
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const RUNS = Number(opt("runs", "5"));
const outFile = opt("out", "ts.json");
const dumpFile = opt("dump", "");
const only = opt("only", "analysis,scan,hash").split(",");

interface Track { name: string; sampleRate: number; channels: Float32Array[]; }

function loadTrack(file: string): Track {
  const buf = readFileSync(file);
  if (buf.toString("latin1", 0, 4) !== "ODF1") throw new Error(`bad fixture ${file}`);
  const sampleRate = buf.readUInt32LE(4);
  const nch = buf.readUInt32LE(8);
  const frames = buf.readUInt32LE(12);
  const channels: Float32Array[] = [];
  for (let c = 0; c < nch; c += 1) {
    const ab = new ArrayBuffer(frames * 4);
    buf.copy(Buffer.from(ab), 0, 16 + c * frames * 4, 16 + (c + 1) * frames * 4);
    channels.push(new Float32Array(ab));
  }
  return { name: path.basename(file), sampleRate, channels };
}

const audioFiles = readdirSync(path.join(fixtures, "audio")).filter((f) => f.endsWith(".f32")).sort().map((f) => path.join(fixtures, "audio", f));
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function analysisRun(tracks: Track[], size: number): Promise<{ ms: number; results: unknown[] }> {
  const workers = Array.from({ length: size }, () => new Worker(path.join(__dirname, "ts-worker.cjs")));
  // Warm the workers' module load out of the timing, as the app keeps its pool alive.
  await Promise.all(workers.map((w) => new Promise((r) => { w.once("message", r); w.postMessage({ ping: true }); })));
  const results: unknown[] = new Array(tracks.length);
  let next = 0;
  const t0 = performance.now();
  await Promise.all(workers.map(async (w) => {
    for (;;) {
      const i = next++;
      if (i >= tracks.length) return;
      const t = tracks[i];
      // Copy like channelsOf() in the app (getChannelData().slice() then transfer).
      const channels = t.channels.map((c) => c.slice());
      results[i] = await new Promise((resolve) => {
        w.once("message", resolve);
        w.postMessage({ sampleRate: t.sampleRate, length: channels[0].length, channels }, channels.map((c) => c.buffer));
      });
    }
  }));
  const ms = performance.now() - t0;
  await Promise.all(workers.map((w) => w.terminate()));
  return { ms, results };
}

function scanOnce(): ScanResult {
  const s = path.join(fixtures, "serato");
  const database = decodeDatabase(readFileSync(path.join(s, "database V2")));
  const crates = readdirSync(path.join(s, "Subcrates")).filter((f) => f.endsWith(".crate")).sort()
    .map((f) => ({ name: f, ...decodeCrate(readFileSync(path.join(s, "Subcrates", f))) }));
  const tagNames = readdirSync(path.join(s, "tags")).sort();
  const markers = tagNames.filter((f) => f.endsWith(".m2")).map((f) => decodeMarkers2(readFileSync(path.join(s, "tags", f))));
  const grids = tagNames.filter((f) => f.endsWith(".bg")).map((f) => decodeBeatGrid(new Uint8Array(readFileSync(path.join(s, "tags", f)))));
  const r = path.join(fixtures, "rekordbox");
  const pdb = parsePdb(readFileSync(path.join(r, "export.pdb")));
  const playlists = playlistPaths(pdb);
  const anlz = readdirSync(path.join(r, "anlz")).sort().map((f) => parseAnlzCues(readFileSync(path.join(r, "anlz", f))));
  return { database, crates, markers, grids, pdb, playlists, anlz };
}

const sha256File = (file: string): Promise<string> => new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(file).on("data", (d) => hash.update(d)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
});

async function main(): Promise<void> {
  const cpus = os.cpus().length;
  const report: Record<string, unknown> = { side: "ts", runtime: `electron-node ${process.versions.electron ?? "-"} / v8 ${process.versions.v8}`, platform: process.platform, arch: process.arch, cpus, runs: RUNS };
  const dump: Record<string, unknown> = {};
  if (only.includes("analysis")) {
    const tracks = audioFiles.map(loadTrack);
    const size = defaultPoolSize(cpus);
    const times: number[] = [];
    let last: unknown[] = [];
    for (let i = 0; i < RUNS + 1; i += 1) {
      const { ms, results } = await analysisRun(tracks, size);
      if (i > 0) times.push(ms); // run 0 is a warm-up (JIT), not counted
      last = results;
    }
    report.analysis = { poolSize: size, tracks: tracks.length, times, median: median(times) };
    dump.analysis = last;
  }
  if (only.includes("scan")) {
    const times: number[] = [];
    let digest = "";
    for (let i = 0; i < RUNS + 1; i += 1) {
      const t0 = performance.now();
      const res = scanOnce();
      const ms = performance.now() - t0;
      if (i > 0) times.push(ms);
      digest = createHash("sha256").update(canonicalScan(res)).digest("hex");
      if (i === 0 && dumpFile) dump.scanCanonical = canonicalScan(res);
    }
    report.scan = { times, median: median(times), digest };
  }
  if (only.includes("hash")) {
    const times: number[] = [];
    let digests: string[] = [];
    for (let i = 0; i < RUNS + 1; i += 1) {
      const t0 = performance.now();
      digests = [];
      for (const f of audioFiles) digests.push(await sha256File(f));
      const ms = performance.now() - t0;
      if (i > 0) times.push(ms);
    }
    report.hash = { files: audioFiles.length, times, median: median(times), digests };
  }
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  if (dumpFile) writeFileSync(dumpFile, JSON.stringify(dump));
  console.log(JSON.stringify(report));
}

void main().catch((e) => { console.error(e); process.exit(1); });

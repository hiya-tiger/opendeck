// End-to-end benchmark of the progressive separation worker (dist/separation-worker.cjs),
// driven over worker_threads exactly as the app drives it over a utilityProcess.
//
//   node scripts/build.mjs && node scripts/bench-stems-pipeline.mjs [--seconds 180] [--rate 48000] [--focus 90]
//        [--stop-after <regions>] [--overlap <frames>] [--out /tmp/stems-cache] [--json file]
//
// Reports session creation, time to the first playable region, time to the
// whole track, and the longest stall of this (the "main") thread's event loop
// while the worker computes.
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const seconds = Number(opt("seconds", "180"));
const rate = Number(opt("rate", "48000"));
const focus = Number(opt("focus", "0"));
const stopAfter = Number(opt("stop-after", "0"));
const out = opt("out", "/tmp/stems-bench-cache");
const modelPath = opt("model", process.env.OPENDECK_STEM_MODEL || "/tmp/htdemucs_fp16weights.onnx");

const frames = Math.round(seconds * rate);
const left = new Float32Array(frames);
const right = new Float32Array(frames);
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
for (let i = 0; i < frames; i += 1) {
  const t = i / rate;
  const beat = (t * 2) % 1;
  const kick = Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-beat * 40)) * beat * 0.5) * Math.exp(-beat * 9);
  const bass = 0.3 * Math.sin(2 * Math.PI * [55, 55, 73.4, 65.4][Math.floor(t / 2) % 4] * t);
  const pad = 0.08 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t));
  const hat = beat % 0.5 < 0.03 ? 0.06 * rand() : 0;
  const vox = 0.15 * Math.sin(2 * Math.PI * (330 + 30 * Math.sin(2 * Math.PI * 5 * t)) * t);
  left[i] = 0.5 * kick + bass + pad + hat + vox * 0.8;
  right[i] = 0.5 * kick + bass + pad * 0.9 + hat * 0.7 + vox;
}

let maxStall = 0;
let last = performance.now();
const heartbeat = setInterval(() => {
  const now = performance.now();
  maxStall = Math.max(maxStall, now - last - 10);
  last = now;
}, 10);

const t0 = performance.now();
const worker = new Worker(path.join(root, "dist", "separation-worker.cjs"));
const result = { seconds, rate, focusSeconds: focus, sessionMs: 0, provider: "", firstRegionMs: 0, firstRegionStartSec: 0, regions: 0, totalMs: 0, chunks: 0 };
const overlap = Number(opt("overlap", "0"));
worker.postMessage({ type: "init", modelPath, statePath: "/tmp/stems-bench-providers.json", force: opt("force", null), overlap: overlap || undefined });
worker.postMessage({ type: "job", id: "bench", hash: "bench", sampleRate: rate, left, right, focusFrame: Math.round(focus * rate), cacheDir: out }, [left.buffer, right.buffer]);

const finish = (code = 0) => {
  clearInterval(heartbeat);
  result.maxMainThreadStallMs = Math.round(maxStall);
  console.log(JSON.stringify(result, null, 2));
  const json = opt("json", "");
  if (json) fs.appendFileSync(json, `${JSON.stringify(result)}\n`);
  // Exit without terminate(): tearing a worker down mid session.run aborts.
  process.exit(code);
};

worker.on("message", (message) => {
  if (message.type === "ready") {
    result.sessionMs = Math.round(message.createMs);
    result.provider = message.provider;
  } else if (message.type === "region") {
    result.regions += 1;
    result.chunks = message.chunksTotal;
    if (result.regions === 1) {
      result.firstRegionMs = Math.round(performance.now() - t0);
      result.firstRegionStartSec = Number((message.start / message.sampleRate).toFixed(2));
    }
    process.stderr.write(`region ${message.chunksDone}/${message.chunksTotal} @${(message.start / message.sampleRate).toFixed(1)}s t=${((performance.now() - t0) / 1000).toFixed(1)}s\n`);
    if (stopAfter && result.regions >= stopAfter) {
      result.projectedTotalMs = Math.round(result.firstRegionMs + ((performance.now() - t0 - result.firstRegionMs) / (result.regions - 1 || 1)) * (message.chunksTotal - 1));
      finish();
    }
  } else if (message.type === "done") {
    result.totalMs = Math.round(performance.now() - t0);
    result.cache = message.manifest.dir;
    finish();
  } else if (message.type === "error") {
    console.error("worker error", message.message);
    finish(1);
  }
});

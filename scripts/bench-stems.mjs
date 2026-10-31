// Stem separation benchmark (plain Node, no Electron).
//
//   node scripts/bench-stems.mjs --model /tmp/htdemucs_fp16weights.onnx [options]
//
// Options:
//   --model <path>        htdemucs ONNX model (default $OPENDECK_STEM_MODEL or /tmp/htdemucs_fp16weights.onnx)
//   --seconds <n>         length of the synthetic stereo test signal (default 180)
//   --chunks <n>          how many chunks to actually infer (default: all); the
//                         rest of the track is extrapolated from the mean
//   --threads <n>         intraOpNumThreads (0 = let onnxruntime decide)
//   --baseline            use the pre-optimisation session options
//                         (intra = min(8, cpus - 1), nothing else set)
//   --ep <list>           comma separated execution providers (default cpu)
//   --overlap <fraction>  chunk overlap as a fraction of the chunk (default 0.25)
//   --arena / --no-mempattern / --opt <level>
//                         defaults match what the app ships (src/main/stems/core.ts
//                         cpuSessionOptions): arena off, graph optimisation "disabled"
//   --json <file>         append the result as one JSON line
//
// Prints session creation time, per-chunk inference time, the time until the
// first chunk's stems exist (session + chunk 0) and the projected full-track
// time.
import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const FRAME_COUNT = 343980;
const SAMPLE_RATE = 44100;
const modelPath = opt("model", process.env.OPENDECK_STEM_MODEL || "/tmp/htdemucs_fp16weights.onnx");
const seconds = Number(opt("seconds", "180"));
const overlapFraction = Number(opt("overlap", "0.25"));
const overlap = Math.floor(FRAME_COUNT * overlapFraction);
const stride = FRAME_COUNT - overlap;

const physicalCores = () => {
  try {
    if (process.platform === "linux") {
      const seen = new Set();
      for (const cpu of fs.readdirSync("/sys/devices/system/cpu").filter((d) => /^cpu\d+$/.test(d))) {
        const base = `/sys/devices/system/cpu/${cpu}/topology`;
        const core = fs.readFileSync(`${base}/core_id`, "utf8").trim();
        const pkg = fs.readFileSync(`${base}/physical_package_id`, "utf8").trim();
        seen.add(`${pkg}:${core}`);
      }
      if (seen.size) return seen.size;
    }
  } catch {
    // fall through
  }
  return os.availableParallelism?.() ?? os.cpus().length;
};

const sessionOptions = () => {
  if (flag("baseline")) {
    return {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      intraOpNumThreads: Math.max(1, Math.min(8, os.cpus().length - 1)),
    };
  }
  const threads = Number(opt("threads", String(physicalCores())));
  const options = {
    executionProviders: opt("ep", "cpu").split(",").filter(Boolean),
    graphOptimizationLevel: opt("opt", "disabled"),
    executionMode: "sequential",
    enableCpuMemArena: flag("arena"),
    enableMemPattern: !flag("no-mempattern"),
  };
  if (threads > 0) options.intraOpNumThreads = threads;
  return options;
};

// Synthetic "music": kick, bass line, chord pad, hats and a vocal-ish formant
// sweep, so every stem has something to find. Deterministic.
const makeSignal = (frames) => {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  const beat = SAMPLE_RATE / 2; // 120 bpm
  for (let i = 0; i < frames; i += 1) {
    const t = i / SAMPLE_RATE;
    const inBeat = i % beat;
    const kick = Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-inBeat / 800)) * (inBeat / SAMPLE_RATE)) * Math.exp(-inBeat / 4000);
    const bassNote = [55, 55, 73.4, 65.4][Math.floor(t / 2) % 4];
    const bass = 0.3 * Math.sin(2 * Math.PI * bassNote * t);
    const pad = 0.08 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t));
    const hatPhase = i % (beat / 2);
    const hat = hatPhase < 1500 ? 0.08 * rand() * Math.exp(-hatPhase / 300) : 0;
    const vowel = 0.15 * Math.sin(2 * Math.PI * (330 + 30 * Math.sin(2 * Math.PI * 5 * t)) * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.25 * t));
    left[i] = 0.5 * kick + bass + pad + hat + vowel * 0.8;
    right[i] = 0.5 * kick + bass + pad * 0.9 + hat * 0.7 + vowel;
  }
  return { left, right };
};

const frames = Math.round(seconds * SAMPLE_RATE);
const totalChunks = Math.ceil(frames / stride);
const runChunks = Math.min(totalChunks, Number(opt("chunks", String(totalChunks))));
const { left, right } = makeSignal(frames);

const options = sessionOptions();
const t0 = performance.now();
const session = await ort.InferenceSession.create(modelPath, options);
const sessionMs = performance.now() - t0;
const inputName = session.inputNames.includes("mix") ? "mix" : session.inputNames[0];
const outputName = session.outputNames.includes("stems") ? "stems" : session.outputNames[0];

const chunk = new Float32Array(2 * FRAME_COUNT);
const chunkMs = [];
for (let index = 0; index < runChunks; index += 1) {
  const start = index * stride;
  const length = Math.min(FRAME_COUNT, frames - start);
  chunk.fill(0);
  chunk.set(left.subarray(start, start + length), 0);
  chunk.set(right.subarray(start, start + length), FRAME_COUNT);
  const t = performance.now();
  const result = await session.run({ [inputName]: new ort.Tensor("float32", chunk, [1, 2, FRAME_COUNT]) });
  chunkMs.push(performance.now() - t);
  void result[outputName];
}

const mean = chunkMs.reduce((a, b) => a + b, 0) / chunkMs.length;
// The first run pays one-off allocation; project from the steady state when we have it.
const steady = chunkMs.length > 1 ? chunkMs.slice(1).reduce((a, b) => a + b, 0) / (chunkMs.length - 1) : mean;
const result = {
  label: opt("label", flag("baseline") ? "baseline" : "tuned"),
  platform: `${process.platform}-${process.arch}`,
  cpus: os.cpus().length,
  physicalCores: physicalCores(),
  options,
  overlap: overlapFraction,
  seconds,
  totalChunks,
  sessionMs: Math.round(sessionMs),
  chunkMs: chunkMs.map((v) => Math.round(v)),
  firstChunkMs: Math.round(chunkMs[0]),
  steadyChunkMs: Math.round(steady),
  timeToFirstStemsMs: Math.round(sessionMs + chunkMs[0]),
  projectedFullTrackMs: Math.round(sessionMs + chunkMs[0] + steady * (totalChunks - 1)),
  maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
  realtimeFactor: Number(((stride / SAMPLE_RATE) * 1000 / steady).toFixed(3)),
};
console.log(JSON.stringify(result, null, 2));
const out = opt("json", "");
if (out) fs.appendFileSync(out, `${JSON.stringify(result)}\n`);

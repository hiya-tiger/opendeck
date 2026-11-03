// Today's stem path for the benchmark: onnxruntime-node 1.20.1 with the app's
// own session plans (providerPlans / cpuSessionOptions from src/main/stems/core.ts),
// run in Electron's node (ELECTRON_RUN_AS_NODE=1) like the app's utility process.
//
//   ELECTRON_RUN_AS_NODE=1 electron bench/out/ts-stems.cjs --model m.onnx --fixtures fx --ep cpu|auto --chunks 5 --out ts-stems-cpu.json [--dump out.f32]
//
// Chunk 0 is timed on its own (it includes first-run graph setup, the app's
// time to first stems); the next --chunks chunks give the steady-state median.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { physicalCores } from "../../src/main/stems/cores.ts";
import { providerPlans, planChunksWith, DEFAULT_OVERLAP, MODEL_FRAME_COUNT } from "../../src/main/stems/core.ts";

const req = createRequire(__filename);
const ort = req("onnxruntime-node");
const args = process.argv.slice(2);
const opt = (n: string, d: string): string => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const modelPath = opt("model", "htdemucs_fp16weights.onnx");
const fixtures = opt("fixtures", "bench-fixtures");
const ep = opt("ep", "cpu");
const CHUNKS = Number(opt("chunks", "5"));
const outFile = opt("out", "ts-stems.json");
const dumpFile = opt("dump", "");


const audioDir = path.join(fixtures, "audio");
const first = readdirSync(audioDir).filter((f) => f.endsWith(".f32")).sort()[0];
const buf = readFileSync(path.join(audioDir, first));
const frames = buf.readUInt32LE(12);
const L = new Float32Array(buf.buffer.slice(buf.byteOffset + 16, buf.byteOffset + 16 + frames * 4));
const R = new Float32Array(buf.buffer.slice(buf.byteOffset + 16 + frames * 4, buf.byteOffset + 16 + frames * 8));
const plan = planChunksWith(frames, MODEL_FRAME_COUNT, DEFAULT_OVERLAP);
const chunkInput = (i: number): Float32Array => {
  const c = plan[i % plan.length];
  const input = new Float32Array(2 * MODEL_FRAME_COUNT);
  input.set(L.subarray(c.start, c.start + Math.min(c.length, MODEL_FRAME_COUNT)), 0);
  input.set(R.subarray(c.start, c.start + Math.min(c.length, MODEL_FRAME_COUNT)), MODEL_FRAME_COUNT);
  return input;
};
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function main(): Promise<void> {
  const supported = (ort.listSupportedBackends?.() ?? [{ name: "cpu" }]).map((b: { name: string }) => b.name);
  const threads = physicalCores();
  const plans = providerPlans({ platform: process.platform, arch: process.arch, supported, state: { disabled: {} } as never, threads, force: ep === "cpu" ? "cpu" : null });
  const chosen = plans[0];
  const t0 = performance.now();
  const session = await ort.InferenceSession.create(modelPath, chosen.options);
  const createMs = performance.now() - t0;
  const inName = session.inputNames.includes("mix") ? "mix" : session.inputNames[0];
  const outName = session.outputNames.includes("stems") ? "stems" : session.outputNames[0];
  const run = async (i: number): Promise<{ ms: number; data: Float32Array }> => {
    const input = chunkInput(i);
    const s = performance.now();
    const r = await session.run({ [inName]: new ort.Tensor("float32", input, [1, 2, MODEL_FRAME_COUNT]) });
    return { ms: performance.now() - s, data: r[outName].data as Float32Array };
  };
  const firstChunk = await run(0);
  const times: number[] = [];
  let dumpData: Float32Array | null = null;
  for (let i = 1; i <= CHUNKS; i += 1) {
    const r = await run(i);
    times.push(r.ms);
    if (i === 1) dumpData = r.data;
  }
  const med = median(times);
  const report = {
    side: "ts", engine: `onnxruntime-node ${req("onnxruntime-node/package.json").version}`, provider: chosen.name, threads, supported,
    createMs, firstChunkMs: firstChunk.ms, chunkTimes: times, chunkMedianMs: med, trackChunks: plan.length,
    trackSeconds: frames / 44100, fullTrackMs: createMs + firstChunk.ms + (plan.length - 1) * med,
    peakRssMb: process.resourceUsage().maxRSS / 1024,
  };
  if (dumpFile && dumpData) writeFileSync(dumpFile, Buffer.from(dumpData.buffer, dumpData.byteOffset, dumpData.byteLength));
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await session.release?.();
}
void main().catch((e) => { console.error(e); process.exit(1); });

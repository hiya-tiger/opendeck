// Electron end-to-end check of progressive stem separation: the real
// StemHost spawns dist/separation-worker.cjs as a utilityProcess, separates a
// short synthetic track, and we measure how long the Electron main process's
// event loop ever stalled while onnxruntime ran.
//
//   node scripts/build.mjs && xvfb-run -a node scripts/smoke-stems.mjs [--model /tmp/htdemucs_fp16weights.onnx] [--seconds 20]
//
// Needs the model; skips (exit 0) without it.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const model = opt("model", process.env.OPENDECK_STEM_MODEL || "/tmp/htdemucs_fp16weights.onnx");
const seconds = Number(opt("seconds", "20"));
if (!existsSync(model)) {
  console.log(`STEMS_SKIP no model at ${model}`);
  process.exit(0);
}
if (!existsSync(path.join(root, "dist", "separation-worker.cjs"))) {
  console.error("run node scripts/build.mjs first");
  process.exit(1);
}
const outDir = path.join(root, "dist", "stems-smoke");
await mkdir(outDir, { recursive: true });
await build({
  entryPoints: [path.join(root, "src", "main", "stems", "host.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  outfile: path.join(outDir, "host.cjs"),
  logLevel: "error",
});

const main = `const { app } = require("electron");
const path = require("node:path");
const { StemHost, defaultSpawner } = require("./host.cjs");
app.whenReady().then(async () => {
  const rate = 48000, frames = ${seconds} * rate;
  const left = new Float32Array(frames), right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { const t = i / rate; left[i] = 0.3 * Math.sin(2 * Math.PI * 110 * t) + 0.2 * Math.sin(2 * Math.PI * 440 * t) * ((t * 2) % 1 < 0.1 ? 1 : 0.2); right[i] = left[i] * 0.9; }
  const host = new StemHost(defaultSpawner(path.join(${JSON.stringify(path.join(root, "dist"))}, "separation-worker.cjs")), { modelPath: () => ${JSON.stringify(model)}, statePath: path.join(app.getPath("temp"), "od-stems-smoke-providers.json") });
  let maxStall = 0, last = Date.now();
  const beat = setInterval(() => { const now = Date.now(); maxStall = Math.max(maxStall, now - last - 10); last = now; }, 10);
  const t0 = Date.now();
  let first = 0, regions = 0, covered = 0;
  try {
    const manifest = await host.run({ hash: "smoke", sampleRate: rate, left, right, focusFrame: Math.round(frames / 2), cacheDir: path.join(app.getPath("temp"), "od-stems-smoke") }, {
      deck: "A",
      onRegion: (r) => { regions++; if (!first) first = Date.now() - t0; covered += r.parts.drums[0].length; },
      onProgress: () => undefined,
    });
    clearInterval(beat);
    const result = { ok: regions > 0 && manifest.frames > 0 && maxStall < 250, provider: host.activeProvider, regions, firstRegionMs: first, totalMs: Date.now() - t0, maxMainStallMs: maxStall, cacheFrames: manifest.frames, coveredFrames: covered };
    console.log("STEMS_RESULT " + JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.log("STEMS_RESULT " + JSON.stringify({ ok: false, error: String(error) }));
    process.exitCode = 1;
  }
  host.dispose();
  app.exit(process.exitCode ?? 0);
});
`;
const mainPath = path.join(outDir, "main.cjs");
await writeFile(mainPath, main);
const require = createRequire(import.meta.url);
const electron = require("electron");
const env = { ...process.env, NODE_PATH: path.join(root, "node_modules") };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [mainPath, "--no-sandbox"], { stdio: "inherit", env });
const timer = setTimeout(() => {
  console.error("STEMS_TIMEOUT");
  child.kill();
  process.exitCode = 1;
}, 115_000);
child.on("exit", (code) => {
  clearTimeout(timer);
  process.exit(code ?? 1);
});

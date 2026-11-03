// Electron end-to-end check of resumable stem separation (D45) with the real
// model and the real utilityProcess worker:
//   1. separate a synthetic track, switch the worker to background mode
//      (1 thread, low priority) after the first chunk, pause/resume it, and
//      quit (kill the worker) after a few chunks, like "Quit now";
//   2. a fresh host + worker (the next launch) separates the same track into
//      the same cache entry and must resume: the finished chunks come back
//      from partial/ and only the rest run through the model.
//
//   node scripts/build.mjs && xvfb-run -a node scripts/smoke-stems-resume.mjs [--model /path/htdemucs_fp16weights.onnx] [--seconds 30]
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
const seconds = Number(opt("seconds", "30"));
if (!existsSync(model)) {
  console.log(`STEMS_RESUME_SKIP no model at ${model}`);
  process.exit(0);
}
if (!existsSync(path.join(root, "dist", "separation-worker.cjs"))) {
  console.error("run node scripts/build.mjs first");
  process.exit(1);
}
const outDir = path.join(root, "dist", "stems-resume-smoke");
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
const fs = require("node:fs");
const path = require("node:path");
const { StemHost, defaultSpawner } = require("./host.cjs");
app.whenReady().then(async () => {
  const rate = 48000, frames = ${seconds} * rate;
  const left = new Float32Array(frames), right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { const t = i / rate; left[i] = 0.3 * Math.sin(2 * Math.PI * 110 * t) + 0.2 * Math.sin(2 * Math.PI * 440 * t) * ((t * 2) % 1 < 0.1 ? 1 : 0.2); right[i] = left[i] * 0.9; }
  const cacheDir = path.join(app.getPath("temp"), "od-stems-resume-smoke", "entry");
  fs.rmSync(path.dirname(cacheDir), { recursive: true, force: true });
  const spawnWorker = defaultSpawner(path.join(${JSON.stringify(path.join(root, "dist"))}, "separation-worker.cjs"));
  const config = { modelPath: () => ${JSON.stringify(model)}, statePath: path.join(app.getPath("temp"), "od-stems-resume-providers.json") };
  const result = { ok: false };
  try {
    // Run 1: background mode after the first chunk, a pause, then "Quit now" after 3 chunks.
    const host1 = new StemHost(spawnWorker, config);
    let computed1 = 0, pausedAt = 0, pauseHeldMs = 0;
    const stop = new Promise((resolve) => {
      host1.run({ hash: "resume-smoke", sampleRate: rate, left, right, focusFrame: 0, cacheDir, title: "Resume smoke" }, {
        deck: "A",
        onRegion: () => undefined,
        onProgress: (p) => {
          if (p.stage !== "separate" || !/^Chunk/.test(p.detail)) return;
          computed1++;
          if (computed1 === 1) {
            host1.setBackground(true, 1);
            host1.setPaused(true);
            pausedAt = Date.now();
            setTimeout(() => { pauseHeldMs = Date.now() - pausedAt; host1.setPaused(false); }, 1500);
          }
          if (computed1 === 3) resolve();
        },
      }).catch(() => resolve());
    });
    await stop;
    // give the last chunk's partial write a moment, then kill the worker like a quit
    await new Promise((r) => setTimeout(r, 1500));
    host1.dispose();
    await new Promise((r) => setTimeout(r, 500));
    const progress = JSON.parse(fs.readFileSync(path.join(cacheDir, "partial", "progress.json"), "utf8"));
    result.run1 = { computed: computed1, onDisk: progress.done.length, chunks: progress.chunks, pauseHeldMs };

    // Run 2: the next launch.
    const host2 = new StemHost(spawnWorker, config);
    let computed2 = 0, regions2 = 0, resumedDetail = null;
    const manifest = await host2.run({ hash: "resume-smoke", sampleRate: rate, left, right, focusFrame: 0, cacheDir, title: "Resume smoke" }, {
      deck: "A",
      onRegion: () => { regions2++; },
      onProgress: (p) => {
        if (p.stage === "separate" && /^Resumed/.test(p.detail)) resumedDetail = p.detail;
        if (p.stage === "separate" && /^Chunk/.test(p.detail)) computed2++;
      },
    });
    host2.dispose();
    result.run2 = { computed: computed2, regions: regions2, resumedDetail, cacheFrames: manifest.frames, partialLeft: fs.existsSync(path.join(cacheDir, "partial")) };
    result.ok = result.run1.onDisk >= 3 && result.run1.pauseHeldMs >= 1000 && computed2 === progress.chunks - result.run1.onDisk && regions2 === progress.chunks && Boolean(resumedDetail) && manifest.frames > 0 && !result.run2.partialLeft;
  } catch (error) {
    result.error = String(error && error.stack || error);
  }
  console.log("STEMS_RESUME_RESULT " + JSON.stringify(result));
  app.exit(result.ok ? 0 : 1);
});
`;
const mainPath = path.join(outDir, "main.cjs");
await writeFile(mainPath, main);
const require = createRequire(import.meta.url);
const electron = require("electron");
const env = { ...process.env, NODE_PATH: path.join(root, "node_modules"), OPENDECK_STEM_DEBUG: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [mainPath, "--no-sandbox"], { stdio: "inherit", env });
const timer = setTimeout(() => {
  console.error("STEMS_RESUME_TIMEOUT");
  child.kill();
  process.exitCode = 1;
}, 400_000);
child.on("exit", (code) => {
  clearTimeout(timer);
  process.exit(code ?? 1);
});

// Batch track-analysis benchmark (BPM / key / waveform) in a real Electron
// renderer: the old one-at-a-time pipeline against the worker pool.
//
//   node scripts/build.mjs && xvfb-run -a node scripts/bench-analysis.mjs --dir /tmp/abench
//
// --dir holds the audio files to analyse (e.g. 20 synthetic MP3s made with ffmpeg).
import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dirIndex = args.indexOf("--dir");
const dir = dirIndex >= 0 ? args[dirIndex + 1] : "/tmp/abench";
const files = (await readdir(dir)).filter((f) => /\.(mp3|wav|flac|m4a|ogg)$/i.test(f)).sort().map((f) => path.join(dir, f));
if (!files.length) {
  console.error(`no audio files in ${dir}`);
  process.exit(1);
}
const outDir = path.join(root, "dist", "analysis-bench");
await mkdir(outDir, { recursive: true });
await build({
  entryPoints: [path.join(root, "scripts", "analysis-bench-entry.ts")],
  bundle: true,
  format: "iife",
  target: "chrome120",
  outfile: path.join(outDir, "bench.js"),
  logLevel: "error",
});
await copyFile(path.join(root, "renderer", "analysis-worker.js"), path.join(outDir, "analysis-worker.js"));
await writeFile(path.join(outDir, "bench.html"), '<!doctype html><meta charset="utf-8"><script src="./bench.js"></script>');
const main = `const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, offscreen: true } });
  win.webContents.on("console-message", (e) => { if (e.level === "error") console.log("RENDERER", e.message); });
  const files = ${JSON.stringify(files)};
  await win.loadFile(path.join(__dirname, "bench.html"));
  const payload = files.map((f) => ({ name: path.basename(f), bytes: fs.readFileSync(f) }));
  await win.webContents.executeJavaScript("void 0");
  win.webContents.executeJavaScript("window.__benchFiles = null");
  // Hand the bytes over, then start.
  for (const [i, f] of payload.entries()) {
    await win.webContents.executeJavaScript("(window.__benchFiles = window.__benchFiles || []).push({ name: " + JSON.stringify(f.name) + ", bytes: Uint8Array.from(atob('" + f.bytes.toString("base64") + "'), c => c.charCodeAt(0)) }); void 0");
  }
  const result = await win.webContents.executeJavaScript("window.__startBench()", true);
  console.log("BENCH_RESULT " + JSON.stringify(result));
  app.exit(0);
});
`;
await writeFile(path.join(outDir, "main.cjs"), main);
const require = createRequire(import.meta.url);
const electron = require("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(outDir, "main.cjs")], { stdio: "inherit", env });
const timer = setTimeout(() => {
  console.error("BENCH_TIMEOUT");
  child.kill();
  process.exitCode = 1;
}, 115_000);
child.on("exit", (code) => {
  clearTimeout(timer);
  process.exit(code ?? 1);
});

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist", "audio-smoke");
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "scripts", "audio-smoke-entry.ts")],
  bundle: true,
  format: "iife",
  target: "chrome120",
  outfile: path.join(outDir, "audio-smoke.js"),
});

await writeFile(
  path.join(outDir, "smoke.html"),
  '<!doctype html><meta charset="utf-8"><script src="./audio-smoke.js"></script>',
);

const main = `const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { backgroundThrottling: false, offscreen: true },
  });
  win.webContents.on("console-message", (event) => {
    console.log("RENDERER " + event.level + " " + event.message + " @" + event.lineNumber + " " + event.sourceId);
  });
  try {
    await win.loadFile(path.join(__dirname, "smoke.html"));
    const result = await win.webContents.executeJavaScript("window.__smoke", true);
    console.log("SMOKE_RESULT " + JSON.stringify(result));
    process.exitCode = result && result.ok ? 0 : 1;
  } catch (error) {
    console.error("SMOKE_ERROR", error);
    process.exitCode = 1;
  }
  // app.quit() can leave the offscreen window (and the process) alive, which
  // made the wrapper report a timeout and exit 1 even after a clean result.
  app.exit(process.exitCode ?? 0);
});
`;
const mainPath = path.join(outDir, "main.cjs");
await writeFile(mainPath, main);

const require = createRequire(import.meta.url);
const electron = require("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [mainPath], { stdio: "inherit", env });
const timer = setTimeout(() => {
  console.error("SMOKE_TIMEOUT");
  child.kill();
  process.exitCode = 1;
}, 30_000);
child.on("exit", (code) => {
  clearTimeout(timer);
  process.exit(code ?? 1);
});

// Same deck mock page as ui-tauri (../ui-tauri/dist/index.html) hosted in today's Electron 44,
// so the toolkit table has an Electron row with identical content. Shim: window.__TAURI__.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const t0 = Date.now();
const at = process.argv.findIndex((a) => a.endsWith("main.cjs"));
const args = process.argv.slice(at + 1).filter((a) => !a.startsWith("--"));
ipcMain.handle("inv", (_e, cmd, a) => {
  if (cmd === "args") return args;
  if (cmd === "first_frame") { process.stdout.write(`FIRST_FRAME ${Date.now() - t0}\n`); return null; }
  if (cmd === "report") { process.stdout.write(`RESULT ${a.json.replace('"tauri"', '"electron"')}\n`); setTimeout(() => app.exit(0), 10); return null; }
});
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 1920, height: 1080, show: true, webPreferences: { preload: path.join(__dirname, "preload.cjs"), backgroundThrottling: false, contextIsolation: true } });
  w.loadFile(path.join(__dirname, "..", "ui-tauri", "dist", "index.html"));
});

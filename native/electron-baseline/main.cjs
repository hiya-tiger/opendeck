// Electron entry for the baseline: one visible window (rAF is throttled when hidden),
// forwards RESULT lines from the renderer console to stdout, then quits.
// usage: electron main.cjs <fixtures dir> [which] [tracks]
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const at = process.argv.findIndex((a) => a.endsWith("main.cjs"));
const args = process.argv.slice(at + 1).filter((a) => !a.startsWith("--"));
const fx = path.resolve(args[0] || "fixtures/audio");
const which = args[1] || "decode,stretch,library,render";
const tracks = args[2] || "100000";
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.whenReady().then(async () => {
  const t0 = Date.now();
  const win = new BrowserWindow({ width: 1920, height: 1080, show: true, webPreferences: { backgroundThrottling: false, webSecurity: false } });
  win.webContents.on("console-message", (_e, _level, message) => {
    if (message.startsWith("RESULT ")) process.stdout.write(message + "\n");
    else if (message === "BENCH_DONE") { process.stdout.write(`RESULT {"kind":"electron_total","wall_s":${(Date.now()-t0)/1000}}\n`); app.quit(); }
    else process.stderr.write("[renderer] " + message + "\n");
  });
  win.webContents.on("render-process-gone", (_e, d) => { process.stdout.write(`RESULT {"kind":"electron_error","error":"renderer gone ${d.reason}"}\n`); app.exit(1); });
  const files = fs.readdirSync(fx).filter((f) => !f.endsWith(".json") && !f.endsWith(".tmp")).sort().join("|");
  const q = new URLSearchParams({ fx: pathToFileURL(fx).href, files, which, tracks });
  await win.loadURL(pathToFileURL(path.join(__dirname, "out", "bench.html")).href + "?" + q.toString());
});

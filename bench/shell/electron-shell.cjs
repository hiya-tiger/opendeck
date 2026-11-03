// Electron side of the shell benchmark (same jobs as main.go).
//   electron bench/shell/electron-shell.cjs playback <dir> <seconds>
// Cold start uses the real app (electron . with dist/main.cjs) instead; see run_shell.py.
const { app, BrowserWindow } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const [mode, dir, seconds] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.whenReady().then(() => {
  if (mode !== "playback") { console.error("only playback"); app.exit(2); return; }
  const server = http.createServer((req, res) => {
    if (req.url === "/result") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => { process.stdout.write(`PLAYBACK ${body}\n`); res.writeHead(204); res.end(); setTimeout(() => app.exit(0), 200); });
      return;
    }
    const file = path.join(dir, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html");
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : "text/html" });
      res.end(data);
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const win = new BrowserWindow({ width: 800, height: 600, webPreferences: { backgroundThrottling: false } });
    win.loadURL(`http://127.0.0.1:${server.address().port}/index.html?seconds=${seconds || 300}&host=electron`);
  });
});

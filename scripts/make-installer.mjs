// Builds the Windows installer: release/OpenDecks-Setup-<version>.exe
//
//   npm run installer:win
//
// Works on Windows or Linux/macOS. Needs NSIS (makensis on PATH; on Windows
// the default C:\Program Files (x86)\NSIS is found too). The Windows Electron
// runtime comes from node_modules/electron/dist when that is the Windows
// build, otherwise from ELECTRON_WIN_ZIP (a local electron-vX-win32-x64.zip),
// otherwise it is downloaded from GitHub releases.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const electronVersion = pkg.devDependencies.electron.replace(/^[^\d]*/, "");
const release = path.join(root, "release");
const stage = path.join(release, "OpenDecks-win32-x64");
const outFile = path.join(release, `OpenDecks-Setup-${version}.exe`);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

console.log("[installer] Building bundles...");
run(process.execPath, [path.join(root, "scripts", "build.mjs")]);

// 1. Windows Electron runtime
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const localDist = path.join(root, "node_modules", "electron", "dist");
if (fs.existsSync(path.join(localDist, "electron.exe"))) {
  console.log("[installer] Using node_modules/electron/dist");
  fs.cpSync(localDist, stage, { recursive: true });
} else {
  let zip = process.env.ELECTRON_WIN_ZIP;
  if (!zip) {
    zip = path.join(os.tmpdir(), `electron-v${electronVersion}-win32-x64.zip`);
    if (!fs.existsSync(zip)) {
      const url = `https://github.com/electron/electron/releases/download/v${electronVersion}/electron-v${electronVersion}-win32-x64.zip`;
      console.log(`[installer] Downloading ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    }
  }
  console.log(`[installer] Extracting ${zip}`);
  if (process.platform === "win32") {
    run("powershell", ["-NoProfile", "-Command", `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${stage}'`]);
  } else {
    run("unzip", ["-q", "-o", zip, "-d", stage]);
  }
}
fs.renameSync(path.join(stage, "electron.exe"), path.join(stage, "OpenDecks.exe"));
fs.rmSync(path.join(stage, "resources", "default_app.asar"), { force: true });

// 2. App code
const appDir = path.join(stage, "resources", "app");
fs.mkdirSync(appDir, { recursive: true });
for (const item of ["package.json", "dist", "renderer", "LICENSE", "NOTICE", "README.md"]) {
  const src = path.join(root, item);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(appDir, item), { recursive: true });
}

// 3. Runtime modules main.cjs loads with require() (esbuild externals).
// onnxruntime-node ships binaries for every OS; keep only win32/x64.
const nm = path.join(appDir, "node_modules");
for (const mod of ["onnxruntime-node", "onnxruntime-common"]) {
  const src = path.join(root, "node_modules", mod);
  if (!fs.existsSync(src)) throw new Error(`missing node_modules/${mod}; run npm install first`);
  fs.cpSync(src, path.join(nm, mod), {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(src, p).split(path.sep).join("/");
      if (!rel.startsWith("bin/napi-v3/")) return true;
      const plat = rel.slice("bin/napi-v3/".length);
      return plat === "win32" || plat.startsWith("win32/x64") || plat === "win32/x64";
    },
  });
}

// 4. NSIS
const candidates = ["makensis", "C:\\Program Files (x86)\\NSIS\\makensis.exe", "C:\\Program Files\\NSIS\\makensis.exe"];
const makensis = candidates.find((c) => {
  try { execFileSync(c, ["-VERSION"], { stdio: "ignore" }); return true; } catch { return false; }
});
if (!makensis) throw new Error("NSIS not found. Install it from https://nsis.sourceforge.io/Download (or `winget install NSIS.NSIS`).");

const icon = path.join(root, "rust", "crates", "opendeck-app", "icons", "icon.ico");
const define = process.platform === "win32" ? "/D" : "-D";
const args = [
  `${define}STAGE_DIR=${stage}`,
  `${define}OUT_FILE=${outFile}`,
  `${define}APP_VERSION=${version}`,
  ...(fs.existsSync(icon) ? [`${define}APP_ICON=${icon}`] : []),
  path.join(root, "packaging", "windows", "opendecks.nsi"),
];
console.log("[installer] Running makensis...");
run(makensis, args);
console.log(`[installer] Built ${outFile}`);

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
console.log("[package:win] Building TypeScript & renderer bundles...");
execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs")], { stdio: "inherit" });

// 1. Create self-contained Electron Windows bundle at release/OpenDeck-win32-x64/OpenDeck.exe
const electronDist = path.join(root, "node_modules", "electron", "dist");
const outDir = path.join(root, "release", "OpenDeck-win32-x64");
if (fs.existsSync(electronDist)) {
  console.log("[package:win] Staging standalone Electron bundle at release/OpenDeck-win32-x64...");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(electronDist, outDir, { recursive: true });
  const srcExe = path.join(outDir, "electron.exe");
  const dstExe = path.join(outDir, "OpenDeck.exe");
  if (fs.existsSync(srcExe)) {
    fs.renameSync(srcExe, dstExe);
  }
  const appDir = path.join(outDir, "resources", "app");
  fs.rmSync(path.join(outDir, "resources", "default_app.asar"), { force: true });
  fs.mkdirSync(appDir, { recursive: true });
  for (const item of ["package.json", "dist", "renderer", "LICENSE", "NOTICE", "README.md"]) {
    const srcItem = path.join(root, item);
    if (fs.existsSync(srcItem)) {
      fs.cpSync(srcItem, path.join(appDir, item), { recursive: true });
    }
  }
  console.log("[package:win] Built standalone Electron app:", dstExe);
}

// 2. Compile root OpenDeck.exe Windows GUI launcher via rustc
const launcherSrc = path.join(root, "scripts", "win-launcher.rs");
fs.writeFileSync(launcherSrc, `#![windows_subsystem = "windows"]
use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    let exe_path = env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let root = exe_path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let args: Vec<String> = env::args().skip(1).collect();

    let packaged = root.join("release").join("OpenDeck-win32-x64").join("OpenDeck.exe");
    if packaged.exists() {
        let _ = Command::new(&packaged).args(&args).current_dir(root).spawn();
        return;
    }

    let dev_electron = root.join("node_modules").join("electron").join("dist").join("electron.exe");
    if dev_electron.exists() {
        let _ = Command::new(&dev_electron).arg(root).args(&args).current_dir(root).spawn();
        return;
    }

    let rust_app = root.join("bin").join("opendeck-app.exe");
    if rust_app.exists() {
        let _ = Command::new(&rust_app).args(&args).current_dir(root).spawn();
        return;
    }
}
`);

try {
  console.log("[package:win] Compiling root OpenDeck.exe launcher via rustc...");
  execFileSync("rustc", ["-C", "opt-level=z", "-C", "strip=symbols", launcherSrc, "-o", path.join(root, "OpenDeck.exe")], { stdio: "inherit" });
  fs.rmSync(launcherSrc, { force: true });
  console.log("[package:win] Built root launcher:", path.join(root, "OpenDeck.exe"));
} catch (err) {
  console.warn("[package:win] rustc launcher build skipped:", err.message);
}

// Builds macOS apps: release/OpenDecks-<version>-mac-<arch>.zip (arm64 and x64)
//
//   npm run package:mac            # both architectures
//   npm run package:mac -- arm64   # one
//
// Runs on macOS or Linux. Electron's darwin runtime is downloaded from GitHub
// releases (or read from ELECTRON_MAC_ZIP_<ARCH>). The app is ad-hoc signed,
// which Apple Silicon requires to launch: codesign on macOS, rcodesign
// (https://github.com/indygreg/apple-platform-rs) elsewhere. It is not
// notarized, so first launch needs right-click > Open.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const electronVersion = pkg.devDependencies.electron.replace(/^[^\d]*/, "");
const arches = process.argv.slice(2).length ? process.argv.slice(2) : ["arm64", "x64"];
const release = path.join(root, "release");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

console.log("[mac] Building bundles...");
run(process.execPath, [path.join(root, "scripts", "build.mjs")]);

// Icon: .icns built from the 256px PNG with Python Pillow when there's no prebuilt one.
const icnsOut = path.join(release, "opendecks.icns");
fs.mkdirSync(release, { recursive: true });
const pngIcon = path.join(root, "rust", "crates", "opendeck-app", "icons", "icon.png");
let haveIcon = false;
try {
  run(process.platform === "win32" ? "python" : "python3", ["-c",
    "import sys;from PIL import Image;Image.open(sys.argv[1]).convert('RGBA').resize((512,512)).save(sys.argv[2])",
    pngIcon, icnsOut]);
  haveIcon = true;
} catch { console.warn("[mac] Pillow not available; keeping Electron's icon"); }

const setPlist = (xml, key, value) => {
  const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
  if (re.test(xml)) return xml.replace(re, `$1${value}$2`);
  return xml.replace(/<dict>/, `<dict>\n\t<key>${key}</key>\n\t<string>${value}</string>`);
};

for (const arch of arches) {
  const work = path.join(release, `mac-${arch}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  let zip = process.env[`ELECTRON_MAC_ZIP_${arch.toUpperCase()}`];
  if (!zip) {
    zip = path.join(os.tmpdir(), `electron-v${electronVersion}-darwin-${arch}.zip`);
    if (!fs.existsSync(zip)) {
      const url = `https://github.com/electron/electron/releases/download/v${electronVersion}/electron-v${electronVersion}-darwin-${arch}.zip`;
      console.log(`[mac] Downloading ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    }
  }
  // unzip/ditto keep the framework symlinks; a JS unzip would break them.
  if (process.platform === "darwin") run("ditto", ["-x", "-k", zip, work]);
  else run("unzip", ["-q", zip, "-d", work]);

  const appPath = path.join(work, "OpenDecks.app");
  fs.renameSync(path.join(work, "Electron.app"), appPath);
  const contents = path.join(appPath, "Contents");
  const res = path.join(contents, "Resources");
  fs.rmSync(path.join(res, "default_app.asar"), { force: true });

  const plistPath = path.join(contents, "Info.plist");
  let plist = fs.readFileSync(plistPath, "utf8");
  plist = setPlist(plist, "CFBundleName", "OpenDecks");
  plist = setPlist(plist, "CFBundleDisplayName", "OpenDecks");
  plist = setPlist(plist, "CFBundleIdentifier", "io.opendeck.OpenDecks");
  plist = setPlist(plist, "CFBundleShortVersionString", version);
  plist = setPlist(plist, "CFBundleVersion", version);
  plist = setPlist(plist, "NSMicrophoneUsageDescription", "OpenDecks reads timecode vinyl and line inputs from your audio interface.");
  plist = setPlist(plist, "NSCameraUsageDescription", "OpenDecks can use a camera as a video source.");
  if (haveIcon) {
    fs.copyFileSync(icnsOut, path.join(res, "opendecks.icns"));
    plist = setPlist(plist, "CFBundleIconFile", "opendecks.icns");
  }
  fs.writeFileSync(plistPath, plist);

  const appDir = path.join(res, "app");
  fs.mkdirSync(appDir, { recursive: true });
  for (const item of ["package.json", "dist", "renderer", "LICENSE", "NOTICE", "README.md"]) {
    const src = path.join(root, item);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(appDir, item), { recursive: true });
  }
  // Runtime modules main.cjs require()s; keep only this arch's onnxruntime binaries.
  for (const mod of ["onnxruntime-node", "onnxruntime-common"]) {
    const src = path.join(root, "node_modules", mod);
    if (!fs.existsSync(src)) throw new Error(`missing node_modules/${mod}; run npm install first`);
    fs.cpSync(src, path.join(appDir, "node_modules", mod), {
      recursive: true,
      filter: (p) => {
        const rel = path.relative(src, p).split(path.sep).join("/");
        if (!rel.startsWith("bin/napi-v3/")) return true;
        const plat = rel.slice("bin/napi-v3/".length);
        return plat === "darwin" || plat === `darwin/${arch}` || plat.startsWith(`darwin/${arch}/`);
      },
    });
  }

  console.log(`[mac] Ad-hoc signing ${arch}...`);
  if (process.platform === "darwin") {
    run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
  } else {
    run(process.env.RCODESIGN || "rcodesign", ["sign", appPath]);
  }

  const out = path.join(release, `OpenDecks-${version}-mac-${arch}.zip`);
  fs.rmSync(out, { force: true });
  if (process.platform === "darwin") run("ditto", ["-c", "-k", "--keepParent", appPath, out]);
  else run("zip", ["-qry", out, "OpenDecks.app"], { cwd: work });
  console.log(`[mac] Built ${out}`);
}

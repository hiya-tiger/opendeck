import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destDir = path.join(root, "vendor", "ffmpeg", "win32-x64");
const dest = path.join(destDir, "ffmpeg.exe");

const ARCHIVE_URL =
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-20-13-08/ffmpeg-N-127790-g56dbd4cd37-win64-lgpl.zip";
const EXPECTED_SHA256 = "8e591d65c30c6844efcec55aa70678039c1f6925c5e87c4880f9cbf018e2133b";
const EXPECTED_SIZE = 138361856;

const sha256 = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

const isCurrent = async () => {
  try {
    const info = await stat(dest);
    if (info.size !== EXPECTED_SIZE) return false;
    return (await sha256(dest)) === EXPECTED_SHA256;
  } catch {
    return false;
  }
};

const findBinary = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findBinary(full);
      if (nested) return nested;
    } else if (entry.name === "ffmpeg.exe") {
      return full;
    }
  }
  return null;
};

if (await isCurrent()) {
  console.log("ffmpeg: bundled binary already present");
  process.exit(0);
}

if (process.platform !== "win32") {
  console.log("ffmpeg: only the Windows x64 binary is bundled; using ffmpeg on PATH");
  process.exit(0);
}

const work = await mkdtemp(path.join(tmpdir(), "opendeck-ffmpeg-"));
try {
  const archive = path.join(work, "ffmpeg.zip");
  console.log("ffmpeg: downloading LGPL build (about 178 MB)");
  const response = await fetch(ARCHIVE_URL, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));

  const extractDir = path.join(work, "extract");
  await mkdir(extractDir, { recursive: true });
  const extract = spawnSync("tar", ["-xf", archive, "-C", extractDir], { stdio: "inherit" });
  if (extract.status !== 0) {
    throw new Error("could not extract the archive with tar");
  }

  const extracted = await findBinary(extractDir);
  if (!extracted) {
    throw new Error("ffmpeg.exe was not found in the archive");
  }
  const digest = await sha256(extracted);
  if (digest !== EXPECTED_SHA256) {
    throw new Error(`checksum mismatch: expected ${EXPECTED_SHA256}, got ${digest}`);
  }

  await mkdir(destDir, { recursive: true });
  await copyFile(extracted, dest);
  console.log(`ffmpeg: installed ${dest}`);
} finally {
  await rm(work, { recursive: true, force: true });
}

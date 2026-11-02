/**
 * `npm run smoke:link` — headless integration smoke test for the
 * opendeck-link/1 session transport (docs/mobile/ADR-D34.md, ADR-D35.md).
 *
 * No Electron, no audio device, no network peer required. Bundles
 * scripts/link-smoke-entry.ts with esbuild (already a devDependency) and runs it
 * in Node, printing the same `SMOKE_RESULT <json>` line shape as
 * scripts/audio-smoke.mjs.
 *
 * Since D43 it also runs scripts/link-ableton-smoke-entry.ts (Ableton Link
 * backend). Set LINKHUT_BIN to a built reference LinkHutSilent to include the
 * real-peer interop checks.
 *
 * Exit codes: 0 pass, 1 fail, 2 skipped (multicast unavailable on this host).
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist", "link-smoke");
await mkdir(outDir, { recursive: true });

const outfile = path.join(outDir, "link-smoke.mjs");
await build({
  entryPoints: [path.join(root, "scripts", "link-smoke-entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
});

const ablOut = path.join(outDir, "link-ableton-smoke.mjs");
await build({
  entryPoints: [path.join(root, "scripts", "link-ableton-smoke-entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: ablOut,
});

// 1. opendeck-link/1 (fallback backend, D34).
const mod = await import(pathToFileURL(outfile).href);
const result = await mod.runLinkSmoke();
console.log(`SMOKE_RESULT ${JSON.stringify(result)}`);

// 2. Ableton Link backend (D43): self-consistency always; interop with a real
//    reference peer only when LINKHUT_BIN is set (never claimed otherwise).
const abl = await import(pathToFileURL(ablOut).href);
const ableton = await abl.runAbletonSmoke(root);
console.log(`SMOKE_RESULT_ABLETON ${JSON.stringify(ableton)}`);
for (const check of ableton.checks) console.log(`  ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
console.log(
  ableton.interop.ran
    ? `ABLETON_INTEROP ${ableton.interop.verified ? "VERIFIED" : "FAILED"} against ${ableton.interop.peer}`
    : `ABLETON_INTEROP NOT_RUN (${ableton.reason})`,
);

if (result.skipped) {
  console.log(`SMOKE_SKIPPED ${result.reason}`);
  process.exit(result.skipCode || 2);
}
const ablOk = ableton.skipped || ableton.checks.every((check) => check.ok);
process.exit(result.ok && ablOk ? 0 : 1);

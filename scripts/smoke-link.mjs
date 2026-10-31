/**
 * `npm run smoke:link` — headless integration smoke test for the
 * opendeck-link/1 session transport (docs/mobile/ADR-D34.md, ADR-D35.md).
 *
 * No Electron, no audio device, no network peer required. Bundles
 * scripts/link-smoke-entry.ts with esbuild (already a devDependency) and runs it
 * in Node, printing the same `SMOKE_RESULT <json>` line shape as
 * scripts/audio-smoke.mjs.
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

const mod = await import(pathToFileURL(outfile).href);
const result = await mod.runLinkSmoke();

console.log(`SMOKE_RESULT ${JSON.stringify(result)}`);
if (result.skipped) {
  console.log(`SMOKE_SKIPPED ${result.reason}`);
  process.exit(result.skipCode || 2);
}
process.exit(result.ok ? 0 : 1);

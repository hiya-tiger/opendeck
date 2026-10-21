import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = `${root}dist`;

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [`${root}src/main/main.ts`],
  outfile: `${out}/main.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
});

await build({
  entryPoints: [`${root}src/preload/preload.ts`],
  outfile: `${out}/preload.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
});

await build({
  entryPoints: [`${root}src/renderer/app.ts`],
  outfile: `${root}renderer/app.js`,
  bundle: true,
  format: "iife",
  target: "chrome120",
  loader: { ".ts": "ts" },
});

await build({
  entryPoints: [`${root}src/renderer/dvs-panel.ts`],
  outfile: `${root}renderer/dvs.js`,
  bundle: true,
  format: "iife",
  target: "chrome120",
});

console.log("built dist/main.cjs, dist/preload.cjs, renderer/app.js, renderer/dvs.js");



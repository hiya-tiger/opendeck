// Bundles bench.ts (and the app modules it imports) with the repo's own esbuild.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
await build({ entryPoints: [path.join(here, "bench.ts")], bundle: true, format: "iife", platform: "browser", target: "chrome130",
  outfile: path.join(here, "out", "bench.js"), logLevel: "warning" });
await (await import("node:fs/promises")).copyFile(path.join(here, "bench.html"), path.join(here, "out", "bench.html"));
console.log("built", path.join(here, "out"));

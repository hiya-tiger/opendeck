// Bundles the TS side of the benchmark for Electron's node (ELECTRON_RUN_AS_NODE=1).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
for (const [entry, out] of [["bench/ts/bench.ts", "bench/out/ts-bench.cjs"], ["bench/ts/worker.ts", "bench/out/ts-worker.cjs"], ["bench/ts/stems.ts", "bench/out/ts-stems.cjs"]]) {
  await build({ entryPoints: [root + entry], outfile: root + out, bundle: true, platform: "node", format: "cjs", target: "node20", logLevel: "error", external: ["onnxruntime-node", "electron"] });
}
await build({ entryPoints: [root + "bench/ts/playback.ts"], outfile: root + "bench/out/playback/playback.js", bundle: true, format: "iife", target: "es2020", logLevel: "error" });
const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync(root + "bench/out/playback", { recursive: true });
writeFileSync(root + "bench/out/playback/index.html", '<!doctype html><meta charset="utf-8"><title>playback</title><body>loading</body><script src="playback.js"></script>');
console.log("bench/out built");

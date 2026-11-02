// Bundles the TS side of the benchmark for Electron's node (ELECTRON_RUN_AS_NODE=1).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
for (const [entry, out] of [["bench/ts/bench.ts", "bench/out/ts-bench.cjs"], ["bench/ts/worker.ts", "bench/out/ts-worker.cjs"]]) {
  await build({ entryPoints: [root + entry], outfile: root + out, bundle: true, platform: "node", format: "cjs", target: "node20", logLevel: "error" });
}
console.log("bench/out built");

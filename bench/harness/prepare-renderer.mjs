// CI only: injects bench/shell/bench-ff.js as the first script in <head> of
// the given renderer directory, so the real Electron app and the MyGo shell
// load the very same files and report first frame the same way.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const dir = process.argv[2] ?? "renderer";
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
copyFileSync(path.join(here, "..", "shell", "bench-ff.js"), path.join(dir, "bench-ff.js"));
const index = path.join(dir, "index.html");
const html = readFileSync(index, "utf8");
if (!html.includes("bench-ff.js")) writeFileSync(index, html.replace(/<head>/i, '<head><script src="bench-ff.js"></script>'));
console.log("injected bench-ff.js into", index);

// Provenance audit of today's MIDI profiles (src/renderer/midi/profiles.ts): which bindings
// are device-specific, which are a shared generic template, and whether any binds a jog.
// Usage: node native/tools/midi_audit.mjs  (bundles profiles.ts with the repo's esbuild)
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const r = await build({ entryPoints: [path.join(root, "src/renderer/midi/profiles.ts")], bundle: true, format: "esm", platform: "node", write: false });
const mod = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
const { HARDWARE_CATALOGUE, DEVICE_PROFILES, SUPPORTED_HARDWARE_RAW } = mod;
const sig = (b) => JSON.stringify(Object.entries(b).sort());
const groups = new Map();
for (const p of DEVICE_PROFILES) {
  const s = sig(p.bindings);
  if (!groups.has(s)) groups.set(s, []);
  groups.get(s).push(p.label);
}
const jogTargets = DEVICE_PROFILES.filter((p) => Object.keys(p.bindings).some((k) => /jog|scratch|wheel|platter|nudge|bend/i.test(k)));
const rows = DEVICE_PROFILES.map((p) => {
  const g = groups.get(sig(p.bindings));
  const source = p.driver === "slab" ? "dedicated driver from AlphaTheta official SLAB MIDI message list (PDF)"
    : /T10/.test(p.label) ? "values from DJUCED's bundled DJControl_T10.djm (Hercules software file; licence not recorded)"
    : /Party Mix III/.test(p.label) ? "per docs/hardware.md: 'follows the community Mixxx mapping' (GPL project) - needs clean-room re-capture"
    : g.length > 1 ? `generic template shared by ${g.length} profiles (not from any manufacturer document)` : "unique bindings (origin unrecorded)";
  return { label: p.label, category: p.category, decks: p.decks, bindings: Object.keys(p.bindings).length, jog: false, source };
});
console.log(JSON.stringify({ raw_entries: SUPPORTED_HARDWARE_RAW.length, catalogue: HARDWARE_CATALOGUE.length, profiles: DEVICE_PROFILES.length,
  distinct_binding_sets: groups.size, group_sizes: [...groups.values()].map((g) => g.length).sort((a, b) => b - a),
  profiles_with_jog_bindings: jogTargets.length }, null, 1));
console.log("| Controller | Category | Decks | Bindings | Jog bound | Binding provenance |\n|---|---|---|---|---|---|");
for (const x of rows) console.log(`| ${x.label} | ${x.category} | ${x.decks} | ${x.bindings} | no | ${x.source} |`);

// Separation-quality null test: SDR of the prototype's stems against today's
// stems for the same chunk (raw f32le dumps of the [1,4,2,343980] output).
//   node bench/sdr.mjs today.f32 candidate.f32  -> {"sdrDb": .., "maxAbs": ..}
// Tolerance used in docs/benchmarks/mygo-rust.md: SDR >= 60 dB counts as the
// same separation (numerical noise only); GPU EPs are reported, not gated.
import { readFileSync } from "node:fs";
const [a, b] = process.argv.slice(2).map((f) => { const x = readFileSync(f); return new Float32Array(x.buffer, x.byteOffset, x.byteLength / 4); });
if (a.length !== b.length) { console.log(JSON.stringify({ error: `length ${a.length} vs ${b.length}` })); process.exit(1); }
let s = 0, e = 0, m = 0;
for (let i = 0; i < a.length; i += 1) { const d = a[i] - b[i]; s += a[i] * a[i]; e += d * d; if (Math.abs(d) > m) m = Math.abs(d); }
console.log(JSON.stringify({ sdrDb: e === 0 ? "inf" : 10 * Math.log10(s / e), maxAbs: m }));

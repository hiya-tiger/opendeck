// Output-equivalence check between bench/ts (today) and bench/rs (prototype).
//   node bench/equivalence.mjs ts-dump.json rs-dump.json ts.json rs.json
// Exits 1 on any mismatch beyond the stated tolerance.
//   bpm, key, camelot: exact. beatPhase: |d| <= 1e-9 s.
//   confidence, keyConfidence: |d| <= 1e-6. peaks / bands: max |d| <= 1e-6.
//   scan: SHA-256 of the canonical text must be identical. hash: identical digests.
import { readFileSync } from "node:fs";
const [tsDump, rsDump, tsRep, rsRep] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, "utf8")));
const fails = [];
const report = { analysis: [], scan: null, hash: null };
if (tsDump.analysis && rsDump.analysis) {
  tsDump.analysis.forEach((a, i) => {
    const b = rsDump.analysis[i];
    const maxd = (k) => a[k].reduce((m, v, j) => Math.max(m, Math.abs(v - b[k][j])), 0);
    const row = {
      track: i, tsBpm: a.bpm, rsBpm: b.bpm, tsKey: a.key, rsKey: b.key,
      dPhase: Math.abs(a.beatPhase - b.beatPhase), dConf: Math.abs(a.confidence - b.confidence), dKeyConf: Math.abs(a.keyConfidence - b.keyConfidence),
      dPeaks: maxd("peaks"), dLow: maxd("low"), dMid: maxd("mid"), dHigh: maxd("high"),
    };
    report.analysis.push(row);
    if (a.bpm !== b.bpm) fails.push(`track ${i} bpm ${a.bpm} vs ${b.bpm}`);
    if (a.key !== b.key || a.camelot !== b.camelot) fails.push(`track ${i} key ${a.key} vs ${b.key}`);
    if (row.dPhase > 1e-9) fails.push(`track ${i} beatPhase d=${row.dPhase}`);
    if (row.dConf > 1e-6 || row.dKeyConf > 1e-6) fails.push(`track ${i} confidence d=${row.dConf}/${row.dKeyConf}`);
    for (const k of ["dPeaks", "dLow", "dMid", "dHigh"]) if (row[k] > 1e-6) fails.push(`track ${i} ${k}=${row[k]}`);
  });
}
if (tsRep.scan && rsRep.scan) {
  report.scan = { ts: tsRep.scan.digest, rs: rsRep.scan.digest, equal: tsRep.scan.digest === rsRep.scan.digest };
  if (!report.scan.equal) {
    fails.push("scan digest differs");
    if (tsDump.scanCanonical && rsDump.scanCanonical) {
      const A = tsDump.scanCanonical.split("\n"), B = rsDump.scanCanonical.split("\n");
      const at = A.findIndex((l, i) => l !== B[i]);
      fails.push(`first differing line ${at}:\n  ts: ${String(A[at]).slice(0, 300)}\n  rs: ${String(B[at]).slice(0, 300)}`);
    }
  }
}
if (tsRep.hash && rsRep.hash) {
  report.hash = { equal: JSON.stringify(tsRep.hash.digests) === JSON.stringify(rsRep.hash.digests) };
  if (!report.hash.equal) fails.push("hash digests differ");
}
console.log(JSON.stringify({ ok: fails.length === 0, fails, report }, null, 2));
process.exit(fails.length ? 1 : 0);

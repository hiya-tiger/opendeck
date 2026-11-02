"""Aggregates results/<platform>/*.json into the per-platform table, the stem
engine comparison and the verdict (rule in Hark-decisions.md). Prints
Markdown; writes results/verdict.json.

Verdict rule, per platform, all three must pass:
 (i)   geomean speedup of analysis, scan/import, hashing, cold start >= 1.5
       and none of the four < 1.0
 (ii)  best prototype stem path fullTrackMs <= 1.05 x today's (today = the
       app's own default plan on that runner), quality SDR >= 60 dB vs today
 (iii) MyGo playback: appUnderruns + contextStalls <= Electron's, and the test ran
 (iv)  every smoke passed: npm test, tsc, smoke:ui, smoke:audio, smoke:link,
       cargo test, output equivalence, and the renderer under MyGo with no
       script errors (the smoke:ui criterion)
Missing data never passes.
"""
import json, math, os, sys

root = sys.argv[1]
def load(plat, name):
    p = os.path.join(root, plat, name)
    if not os.path.exists(p):
        p = os.path.join(root, f"results-{plat}", name)
    try:
        return json.load(open(p))
    except Exception:
        return None

plats = ["windows", "macos", "linux-flatpak"]
out, verdict = [], {}
def f(x, d=2):
    return "n/a" if x is None else f"{x:.{d}f}"

out.append("| Platform | Workload | Today (ms) | Prototype (ms) | Speedup |")
out.append("|---|---|---:|---:|---:|")
for plat in plats:
    ts, rs = load(plat, "ts.json") or {}, load(plat, "rs.json") or {}
    ce, cm = load(plat, "cold-electron.json") or {}, load(plat, "cold-mygo.json") or {}
    rows = {}
    for w in ["analysis", "scan", "hash"]:
        a = (ts.get(w) or {}).get("median"); b = (rs.get(w) or {}).get("median")
        rows[w] = (a, b)
    rows["coldstart"] = (ce.get("coldStartMedianMs"), cm.get("coldStartMedianMs"))
    sp = {}
    for w, (a, b) in rows.items():
        s = a / b if a and b else None
        sp[w] = s
        out.append(f"| {plat} | {w} | {f(a,0)} | {f(b,0)} | {f(s)}x |")
    vals = [v for v in sp.values() if v]
    geo = math.exp(sum(math.log(v) for v in vals) / len(vals)) if len(vals) == 4 else None
    out.append(f"| {plat} | **geomean** | | | **{f(geo)}x** |")
    i_ok = geo is not None and geo >= 1.5 and all(v >= 1.0 for v in vals)

    # stems
    today = load(plat, "stems-ts-auto.json") or load(plat, "stems-ts-cpu.json") or {}
    today_cpu = load(plat, "stems-ts-cpu.json") or {}
    if today.get("failed"):
        today = today_cpu
    best = None
    cands = []
    for name in ["cpu", "cpu-logical", "cpu-opt-all", "cpu-2sessions", "auto"]:
        r = load(plat, f"stems-rs-{name}.json")
        if not r or r.get("failed"):
            continue
        sdr = (load(plat, f"sdr-{name}.json") or {}).get("sdrDb")
        sdr_v = math.inf if sdr == "inf" else sdr
        ok_q = sdr_v is not None and sdr_v >= 60
        cands.append((name, r, sdr, ok_q))
        if ok_q and (best is None or r["fullTrackMs"] < best[1]["fullTrackMs"]):
            best = (name, r)
    t_full = today.get("fullTrackMs")
    ii_ok = best is not None and t_full is not None and best[1]["fullTrackMs"] <= 1.05 * t_full
    verdict[plat] = {"speedups": sp, "geomean": geo, "i": i_ok,
                     "stemsToday": {"provider": today.get("provider"), "fullTrackMs": t_full, "chunkMedianMs": today.get("chunkMedianMs"), "peakRssMb": today.get("peakRssMb")},
                     "stemsCandidates": [{"name": n, "provider": r.get("provider"), "fullTrackMs": r.get("fullTrackMs"), "effectiveChunkMs": r.get("effectiveChunkMs"), "peakRssMb": r.get("peakRssMb"), "sdrDb": s, "qualityOk": q} for n, r, s, q in cands],
                     "stemsBest": best[0] if best else None,
                     "stemsBestRatio": (best[1]["fullTrackMs"] / t_full) if best and t_full else None, "ii": ii_ok}
    pe, pm = load(plat, "play-electron.json") or {}, load(plat, "play-mygo.json") or {}
    def glitches(p):
        if not p or p.get("error") or "appUnderruns" not in p:
            return None
        return sum(p["appUnderruns"]) + p.get("contextStalls", 0)
    ge, gm = glitches(pe), glitches(pm)
    iii_ok = ge is not None and gm is not None and gm <= ge
    verdict[plat].update({"glitchesElectron": ge, "glitchesMygo": gm, "iii": iii_ok,
                          "playErrors": {"electron": pe.get("error"), "mygo": pm.get("error")}})
    sm = load(plat, "smokes.json") or {}
    eq = load(plat, "equivalence.json") or {}
    smokes = {k: (v == 0) for k, v in sm.items()}
    smokes["equivalence"] = bool(eq.get("ok"))
    smokes["renderer_under_mygo"] = bool(cm.get("smokeUi"))
    smokes["renderer_under_electron"] = bool(ce.get("smokeUi"))
    iv_ok = bool(sm) and all(smokes.values())
    sizes = {n: (load(plat, f"size-{n}.json") or {}).get("installedMb") for n in ["electron", "mygo"]}
    verdict[plat].update({"smokes": smokes, "iv": iv_ok, "mygoPageErrors": cm.get("pageErrors"),
                          "idleRamMb": {"electron": ce.get("idleRamMedianMb"), "mygo": cm.get("idleRamMedianMb")}, "installedMb": sizes,
                          "pass": i_ok and ii_ok and iii_ok and iv_ok})

overall = all(verdict[p]["pass"] for p in plats)
verdict["overall"] = "PASS" if overall else "FAIL"
out.append("")
out.append("| Platform | (i) geomean | (ii) stems best/today | (iii) glitches E/M | (iv) smokes | Idle RAM E/M MB | Size E/M MB | Pass |")
out.append("|---|---|---|---|---|---|---|---|")
for p in plats:
    v = verdict[p]
    failed = [k for k, ok in v["smokes"].items() if not ok]
    out.append(f"| {p} | {f(v['geomean'])}x | {v['stemsBest'] or 'n/a'} {f(v['stemsBestRatio'])} | {v['glitchesElectron']}/{v['glitchesMygo']} | {'ok' if v['iv'] else 'FAIL: ' + ','.join(failed)} | {f(v['idleRamMb']['electron'],0)}/{f(v['idleRamMb']['mygo'],0)} | {f(v['installedMb']['electron'],0)}/{f(v['installedMb']['mygo'],0)} | {'PASS' if v['pass'] else 'FAIL'} |")
out.append("")
out.append("Stem candidates (fullTrackMs, SDR vs today's CPU output):")
for p in plats:
    v = verdict[p]
    out.append(f"- {p}: today {v['stemsToday']['provider']} {f(v['stemsToday']['fullTrackMs'],0)} ms; " + "; ".join(f"{c['name']}({c['provider']}) {f(c['fullTrackMs'],0)} ms SDR {c['sdrDb']}" for c in v["stemsCandidates"]))
out.append("")
out.append(f"**Verdict: {verdict['overall']}**")
json.dump(verdict, open(os.path.join(root, "verdict.json"), "w"), indent=2)
print("\n".join(out))

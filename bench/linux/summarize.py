"""Builds the egui+Rust vs Electron table from bench/linux/run.sh results.
  python bench/linux/summarize.py results  > summary.md"""
import json, os, sys

root = sys.argv[1]
def load(env, name):
    try: return json.load(open(os.path.join(root, env, name)))
    except Exception: return None
def g(d, *path):
    for p in path:
        if d is None: return None
        d = d.get(p) if isinstance(d, dict) else None
    return d
def fmt(v, unit="", nd=1):
    if v is None: return "not measured"
    if isinstance(v, bool): return str(v)
    if isinstance(v, (int, float)): return f"{v:.{nd}f}{unit}" if isinstance(v, float) else f"{v}{unit}"
    return str(v)
def ratio(a, b, lower_better=True):
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)) or a == 0 or b == 0: return ""
    r = b / a if lower_better else a / b
    return f"{r:.2f}x {'better' if r > 1 else 'worse'}" if abs(r - 1) > 0.005 else "same"

def rows(env):
    ts, rs = load(env, "ts.json"), load(env, "rs.json")
    ce, cg = load(env, "cold-electron.json"), load(env, "cold-egui.json")
    pe, pg = load(env, "play-electron.json"), load(env, "play-rs.json")
    se, sg = load(env, "scroll-electron.json"), load(env, "scroll-egui.json")
    ste, stg = load(env, "stems-ts.json"), load(env, "stems-rs-cpu.json")
    st2, stl = load(env, "stems-rs-2sessions.json"), load(env, "stems-rs-logical.json")
    lat = load(env, "latency-rs.json")
    sz_e, sz_g = load(env, "size-electron.json"), load(env, "size-egui.json")
    fsz = load(env, "flatpak-size-bytes.json")
    e_under = None
    if isinstance(pe, dict) and isinstance(pe.get("appUnderruns"), list):
        e_under = sum(pe["appUnderruns"]) + (pe.get("contextStalls") or 0)
    best_stem = min([x for x in [g(stg, "effectiveChunkMs"), g(st2, "effectiveChunkMs"), g(stl, "effectiveChunkMs")] if isinstance(x, (int, float))], default=None)
    best_full = min([x for x in [g(stg, "fullTrackMs"), g(st2, "fullTrackMs"), g(stl, "fullTrackMs")] if isinstance(x, (int, float))], default=None)
    R = [
        ("Cold start to first frame (ms, median of 5)", g(ce, "coldStartMedianMs"), g(cg, "coldStartMedianMs"), True),
        ("Idle RAM, process tree (MB)", g(ce, "idleRamMedianMb"), g(cg, "idleRamMedianMb"), True),
        ("RAM, 4 decks playing (MB, tree median)", g(se, "median", "treeRssMbMedian"), g(sg, "median", "treeRssMbMedian"), True),
        ("CPU %, 4 decks playing + FX + key-lock (tree, 1 core = 100)", g(pe, "treeCpuPercentMedian"), g(pg, "treeCpuPercentMedian"), True),
        ("Install size (MB)", g(sz_e, "installedMb"), g(sz_g, "installedMb"), True),
        ("Flatpak app size (MB, /app files)", (fsz or {}).get("electron", 0) / 1048576 if fsz else None, (fsz or {}).get("egui", 0) / 1048576 if fsz else None, True),
        ("Analysis, 6 tracks (ms, median of 5)", g(ts, "analysis", "median"), g(rs, "analysis", "median"), True),
        ("Library scan/import (ms)", g(ts, "scan", "median"), g(rs, "scan", "median"), True),
        ("Hashing (ms)", g(ts, "hash", "median"), g(rs, "hash", "median"), True),
        ("Stem chunk latency, first chunk (ms)", g(ste, "firstChunkMs"), g(stg, "firstChunkMs"), True),
        ("Stem chunk, steady state (ms, best variant)", g(ste, "chunkMedianMs"), best_stem, True),
        ("Stems, full 120 s track (ms, best variant)", g(ste, "fullTrackMs"), best_full, True),
        (f"Audio glitches over the playback run ({fmt(g(pg, 'seconds'), ' s', 0)})", e_under, g(pg, "glitches"), True),
        ("Output buffer latency at smallest stable buffer (ms)", (g(pe, "baseLatency") or 0) * 1000 if g(pe, "baseLatency") is not None else None, g(lat, "outputBufferLatencyMs"), True),
        ("UI frame time, 4 waveforms scrolling (ms, median)", g(se, "median", "frameMsMedian"), g(sg, "median", "frameMsMedian"), True),
        ("UI frame time p95 (ms)", g(se, "median", "frameMsP95"), g(sg, "median", "frameMsP95"), True),
        ("UI frames per second", g(se, "median", "fps"), g(sg, "median", "fps"), False),
    ]
    return R

for env in ["native", "flatpak", "local-xvfb"]:
    if not os.path.isdir(os.path.join(root, env)): continue
    print(f"\n### {env}\n")
    print("| Metric | Electron (today) | egui + Rust | egui vs Electron |")
    print("|---|---|---|---|")
    for name, e, r, lb in rows(env):
        nd = 2 if isinstance(e, float) and e < 10 or isinstance(r, float) and r < 10 else 1
        print(f"| {name} | {fmt(e, nd=nd)} | {fmt(r, nd=nd)} | {ratio(r, e, lb) if lb else ratio(r, e, False)} |")
    eq = load(env, "equivalence.json")
    if eq: print(f"\nOutput equivalence (TS vs Rust, same fixtures): `{json.dumps(eq)[:300]}`")

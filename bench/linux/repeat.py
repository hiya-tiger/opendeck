"""Runs sample.py N times and keeps every run plus the median of each numeric field.
  python bench/linux/repeat.py --runs 5 --marker SCROLL --out x.json -- <cmd...>"""
import json, statistics, subprocess, sys, os
a = sys.argv[1:]
def opt(n, d=None): return a[a.index(f"--{n}") + 1] if f"--{n}" in a else d
runs, marker, out = int(opt("runs", "5")), opt("marker"), opt("out")
cmd = a[a.index("--") + 1:]
here = os.path.dirname(os.path.abspath(__file__))
results = []
for i in range(runs):
    tmp = f"{out}.run{i}.json"
    subprocess.run([sys.executable, os.path.join(here, "sample.py"), "--marker", marker, "--warmup", opt("warmup", "4"), "--out", tmp, "--"] + cmd)
    try: results.append(json.load(open(tmp)))
    except Exception as e: results.append({"error": str(e)})
keys = sorted({k for r in results for k, v in r.items() if isinstance(v, (int, float)) and not isinstance(v, bool)})
med = {k: statistics.median([r[k] for r in results if isinstance(r.get(k), (int, float))]) for k in keys if any(isinstance(r.get(k), (int, float)) for r in results)}
json.dump({"runs": results, "median": med, "okRuns": sum(1 for r in results if "error" not in r)}, open(out, "w"), indent=2)
print(json.dumps(med)[:1500])

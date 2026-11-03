"""Runs a command, samples the process tree's CPU % and RSS once a second
(after a warm-up) until a marker line appears, and merges the marker's JSON
with the samples. Used for both Electron and egui so CPU/RAM are measured
the same way.
  python bench/linux/sample.py --marker PLAYBACK --warmup 5 --out x.json -- <cmd...>
"""
import json, statistics, subprocess, sys, threading, time, os
import psutil

a = sys.argv[1:]
def opt(n, d=None): return a[a.index(f"--{n}") + 1] if f"--{n}" in a else d
cmd = a[a.index("--") + 1:]
marker, out, warm, timeout = opt("marker"), opt("out"), float(opt("warmup", "5")), float(opt("timeout", "1500"))
t0 = time.perf_counter()
p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, errors="replace", env=dict(os.environ))
found, log = {}, []
def reader():
    for line in p.stdout:
        log.append(line.rstrip())
        if marker + " " in line and "line" not in found:
            found["line"] = line.strip()
threading.Thread(target=reader, daemon=True).start()
ps = psutil.Process(p.pid)
cpu, rss = [], []
procs = {}
while "line" not in found and p.poll() is None and time.perf_counter() - t0 < timeout:
    try:
        tree = [ps] + ps.children(recursive=True)
    except psutil.Error:
        break
    total_rss, total_cpu = 0, 0.0
    for q in tree:
        try:
            if q.pid not in procs:
                procs[q.pid] = q; q.cpu_percent(None)
            total_cpu += procs[q.pid].cpu_percent(None)
            total_rss += q.memory_info().rss
        except psutil.Error:
            pass
    if time.perf_counter() - t0 > warm:
        cpu.append(total_cpu); rss.append(total_rss / 1048576)
    time.sleep(1.0)
res = {"cmd": cmd, "cpuSamples": len(cpu), "treeCpuPercentMedian": statistics.median(cpu) if cpu else None, "treeRssMbMedian": statistics.median(rss) if rss else None, "treeRssMbMax": max(rss) if rss else None}
if "line" in found:
    try:
        res.update(json.loads(found["line"].split(marker + " ", 1)[1].split(" ", 0)[0] if False else found["line"].split(marker + " ", 1)[1]))
    except Exception as e:  # noqa
        res["parseError"] = str(e); res["line"] = found["line"][:400]
else:
    res["error"] = "no result"; res["log"] = log[-40:]
try:
    for q in [ps] + ps.children(recursive=True):
        q.kill()
except psutil.Error:
    pass
json.dump(res, open(out, "w"), indent=2)
print(json.dumps({k: v for k, v in res.items() if k != "log"})[:1500])

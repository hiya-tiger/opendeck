#!/usr/bin/env python3
"""UI toolkit measurements for one prototype binary (same CLI: `<bin> frames N` / `<bin> idle S`).
cold start: spawn -> FIRST_FRAME line on stdout (1 warm-up + 5 runs, median)
idle: RSS of the process tree (webview helpers included) 4 s after first frame, and CPU % over
      the next 6 s with no animation requested
frames: `frames 600` x5, median of each run's medians (the app measures its own intervals)
size: the executable (plus the Electron dist dir for Electron)
Usage: ui_measure.py <toolkit> <cmd...>   (cmd prefix, e.g. xvfb-run -a ./ui-egui)
"""
import json, os, statistics, subprocess, sys, time
import psutil

tk = sys.argv[1]
cmd = sys.argv[2:]
RUNS = 5

def tree(p):
    try:
        return [p] + p.children(recursive=True)
    except psutil.Error:
        return [p]

def helpers():
    # webview processes that are not children (macOS WebKit XPC services)
    out = []
    if sys.platform == "darwin" and tk == "tauri":
        for p in psutil.process_iter(["name"]):
            n = (p.info["name"] or "")
            if "WebContent" in n or "com.apple.WebKit" in n:
                out.append(p)
    return out

def first_frame(extra, timeout=60):
    t = time.perf_counter()
    p = subprocess.Popen(cmd + extra, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    ff = None
    lines = []
    for line in p.stdout:
        lines.append(line)
        if line.startswith("FIRST_FRAME") and ff is None:
            ff = (time.perf_counter() - t) * 1e3
            return p, ff, lines
        if time.perf_counter() - t > timeout:
            break
    return p, ff, lines

res = {"kind": "ui_measure", "toolkit": tk}
cs = []
for i in range(RUNS + 1):
    p, ff, _ = first_frame(["idle", "2"])
    try:
        p.wait(timeout=30)
    except subprocess.TimeoutExpired:
        p.kill()
    if i > 0 and ff is not None:
        cs.append(ff)
res["cold_start_runs"] = len(cs)
res["cold_start_median_ms"] = round(statistics.median(cs), 1) if cs else None
# idle
p, ff, _ = first_frame(["idle", "14"])
if ff is not None:
    pp = psutil.Process(p.pid)
    time.sleep(4)
    procs = tree(pp) + helpers()
    res["idle_rss_mb"] = round(sum(x.memory_info().rss for x in procs if x.is_running()) / 2**20, 1)
    c0 = sum(sum(x.cpu_times()[:2]) for x in procs if x.is_running())
    time.sleep(6)
    procs2 = [x for x in procs if x.is_running()]
    c1 = sum(sum(x.cpu_times()[:2]) for x in procs2)
    res["idle_cpu_pct_one_core"] = round((c1 - c0) / 6 * 100, 2)
    res["idle_processes"] = len(procs)
try:
    p.wait(timeout=30)
except subprocess.TimeoutExpired:
    p.kill()
# frames
runs = []
for i in range(RUNS):
    pr = subprocess.run(cmd + ["frames", "600"], capture_output=True, text=True, timeout=300)
    for line in pr.stdout.splitlines():
        if line.startswith("RESULT "):
            runs.append(json.loads(line[7:]))
if runs:
    for k in ("frame_interval_median_ms", "frame_interval_p99_ms", "ui_cpu_median_ms", "ui_cpu_p99_ms"):
        vals = [r[k] for r in runs if isinstance(r.get(k), (int, float))]
        if vals:
            res[k] = round(statistics.median(vals), 3)
    res["frame_runs"] = len(runs)
print("RESULT " + json.dumps(res), flush=True)

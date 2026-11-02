"""Shell benchmark harness: cold start to first frame, idle RAM, installed
size and the 5-minute 4-deck playback test, for Electron (today) and the MyGo
shell (prototype). Same harness, same renderer files, same runner.

  python bench/harness/shell.py coldstart --name electron --runs 5 --out x.json -- <cmd...>
  python bench/harness/shell.py playback  --name mygo --seconds 300 --out y.json -- <cmd...>
  python bench/harness/shell.py size --name electron --out z.json <path> [<path> ...]

Cold start = process spawn -> the line FIRST_FRAME (printed after the second
requestAnimationFrame once the renderer's scripts ran). Idle RAM = summed RSS
of the process tree 8 s after first frame (on macOS plus the WebKit XPC
processes started after spawn, which launchd owns, not the app).
"""
import json, os, statistics, subprocess, sys, threading, time
import psutil

def tree_rss(proc, since):
    total = 0
    seen = set()
    try:
        procs = [proc] + proc.children(recursive=True)
    except psutil.Error:
        procs = []
    if sys.platform == "darwin":
        for p in psutil.process_iter(["name", "create_time"]):
            n = p.info.get("name") or ""
            if n.startswith("com.apple.WebKit") and (p.info.get("create_time") or 0) >= since - 1:
                procs.append(p)
    for p in procs:
        if p.pid in seen:
            continue
        seen.add(p.pid)
        try:
            total += p.memory_info().rss
        except psutil.Error:
            pass
    return total / 1048576

def kill_tree(proc, since):
    try:
        kids = proc.children(recursive=True)
    except psutil.Error:
        kids = []
    if sys.platform == "darwin":
        for p in psutil.process_iter(["name", "create_time"]):
            if (p.info.get("name") or "").startswith("com.apple.WebKit") and (p.info.get("create_time") or 0) >= since - 1:
                kids.append(p)
    for p in kids + [proc]:
        try:
            p.kill()
        except psutil.Error:
            pass
    time.sleep(1.5)

def run_until(cmd, marker, timeout):
    env = dict(os.environ, ELECTRON_ENABLE_LOGGING="1")
    t0 = time.perf_counter()
    since = time.time()
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, bufsize=1, text=True, errors="replace")
    found = {}
    log = []
    def reader():
        for line in p.stdout:
            log.append(line.rstrip())
            if marker in line and "t" not in found:
                found["t"] = (time.perf_counter() - t0) * 1000
                found["line"] = line.strip()
    th = threading.Thread(target=reader, daemon=True)
    th.start()
    deadline = time.time() + timeout
    while "t" not in found and time.time() < deadline and p.poll() is None:
        time.sleep(0.005)
    return p, psutil.Process(p.pid), since, found, log

def coldstart(name, cmd, runs, out):
    times, rams, errors, page_errors = [], [], [], []
    for i in range(runs + 1):  # run 0 warms the OS file cache, not counted
        p, ps, since, found, log = run_until(cmd, "FIRST_FRAME", 90)
        if "t" not in found:
            errors.append("\n".join(log[-30:]))
            kill_tree(ps, since)
            continue
        time.sleep(8)
        ram = tree_rss(ps, since)
        kill_tree(ps, since)
        if i > 0:
            times.append(found["t"]); rams.append(ram)
            line = found["line"]
            try:
                page_errors.append(json.loads(line[line.index("["):]))
            except ValueError:
                page_errors.append(["unparsed: " + line[:200]])
    res = {"name": name, "cmd": cmd, "coldStartMs": times, "idleRamMb": rams,
           "coldStartMedianMs": statistics.median(times) if times else None,
           "idleRamMedianMb": statistics.median(rams) if rams else None, "errors": errors[:3],
           "pageErrors": page_errors[0] if page_errors else None,
           "smokeUi": bool(page_errors) and all(len(e) == 0 for e in page_errors)}
    json.dump(res, open(out, "w"), indent=2)
    print(json.dumps(res)[:2000])

def playback(name, cmd, seconds, out):
    p, ps, since, found, log = run_until(cmd, "PLAYBACK ", seconds + 180)
    res = {"name": name, "cmd": cmd}
    if "t" in found:
        try:
            res.update(json.loads(found["line"].split("PLAYBACK ", 1)[1]))
        except Exception as e:  # noqa
            res["error"] = f"bad result line: {e}: {found['line'][:300]}"
    else:
        res["error"] = "no result"
        res["log"] = log[-40:]
    kill_tree(ps, since)
    json.dump(res, open(out, "w"), indent=2)
    print(json.dumps(res)[:2000])

def du(path):
    if os.path.isfile(path):
        return os.path.getsize(path)
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            fp = os.path.join(root, f)
            if not os.path.islink(fp):
                total += os.path.getsize(fp)
    return total

def size(name, paths, out):
    parts = {p: du(p) / 1048576 for p in paths}
    res = {"name": name, "parts": parts, "installedMb": sum(parts.values())}
    json.dump(res, open(out, "w"), indent=2)
    print(json.dumps(res))

if __name__ == "__main__":
    a = sys.argv[1:]
    mode = a[0]
    def opt(n, d=None):
        return a[a.index(f"--{n}") + 1] if f"--{n}" in a else d
    cmd = a[a.index("--") + 1:] if "--" in a else []
    if mode == "coldstart":
        coldstart(opt("name"), cmd, int(opt("runs", "5")), opt("out"))
    elif mode == "playback":
        playback(opt("name"), cmd, int(opt("seconds", "300")), opt("out"))
    elif mode == "size":
        rest = [x for i, x in enumerate(a[1:]) if not x.startswith("--") and (i == 0 or not a[i].startswith("--"))]
        size(opt("name"), rest, opt("out"))

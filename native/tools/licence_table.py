#!/usr/bin/env python3
"""Every crate in a Cargo workspace's full graph (all targets/platforms) with its declared
licence, as Markdown. Usage: licence_table.py <workspace dir> [--features F]"""
import json, subprocess, sys
from collections import Counter

ws = sys.argv[1]
extra = sys.argv[2:]
meta = json.loads(subprocess.check_output(["cargo", "metadata", "--format-version", "1", *extra], cwd=ws))
resolved = {n["id"] for n in meta["resolve"]["nodes"]}
rows = []
for p in meta["packages"]:
    if p["id"] not in resolved or p.get("source") is None:
        continue
    rows.append((p["name"], p["version"], p.get("license") or ("file: " + str(p.get("license_file")))))
rows.sort()
c = Counter(r[2] for r in rows)
print(f"{len(rows)} third-party crates.\n")
print("| Licence expression | Crates |\n|---|---|")
for k, v in c.most_common():
    print(f"| {k} | {v} |")
print("\n| Crate | Version | Licence |\n|---|---|---|")
for n, v, l in rows:
    print(f"| {n} | {v} | {l} |")

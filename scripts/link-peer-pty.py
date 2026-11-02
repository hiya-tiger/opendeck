#!/usr/bin/env python3
"""Drive an external Link peer (the reference LinkHutSilent example) as a black box.

Used only by `npm run smoke:link` when LINKHUT_BIN points at a built LinkHutSilent.
Runs the binary in a pseudo-terminal, forwards keystrokes read from stdin
("key <c>" per line, "quit" to stop), and prints every status row the peer
draws as:

    ROW <CLOCK_MONOTONIC microseconds> <enabled> <peers> <quantum> <sync> <state> <tempo> <beats>

The timestamp is taken when the row arrives, on the same monotonic clock Node's
process.hrtime uses on Linux, so the smoke can evaluate OpenDecks' beat at the
very same instant. Only the binary's terminal output is parsed; no source code
of the peer is read. MIT, part of OpenDecks.
"""
import os
import pty
import re
import select
import signal
import sys
import time

ROW = re.compile(r"^(yes|no)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(yes|no)\s*\[(\w+)\]\s*\|\s*([\d.]+)\s*\|\s*(-?[\d.]+)")


def main() -> int:
    binary = sys.argv[1]
    pid, fd = pty.fork()
    if pid == 0:
        os.execv(binary, [binary])
    buf = b""
    try:
        while True:
            ready, _, _ = select.select([fd, sys.stdin], [], [], 0.5)
            if sys.stdin in ready:
                line = sys.stdin.readline()
                if not line or line.strip() == "quit":
                    break
                if line.startswith("key "):
                    os.write(fd, line[4:5].encode())
            if fd in ready:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                now_us = time.clock_gettime_ns(time.CLOCK_MONOTONIC) // 1000
                buf += chunk
                parts = re.split(rb"[\r\n]", buf)
                buf = parts.pop()
                for part in parts:
                    m = ROW.match(part.decode("utf8", "replace").strip())
                    if m:
                        print("ROW", now_us, *m.groups(), flush=True)
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
            time.sleep(0.2)
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env bash
# Every leg of the Linux egui+Rust vs Electron benchmark on one machine.
#   bench/linux/run.sh <results dir>
# Env: FX fixtures dir · BIN dir with opendecks, od-bench, od-stems-bench
#      ELECTRON electron binary · APP repo root (Electron app: dist/, renderer/)
#      RUNP command prefix to run inside the Flatpak (empty = native)
#      MODEL htdemucs onnx (optional) · ORTLIB onnxruntime 1.20.1 .so (optional)
#      PLAY_SECONDS (600) · RUNS (5) · X ("xvfb-run -a" when no display)
set -u
R="$1"; mkdir -p "$R"
RUNS="${RUNS:-5}"; PLAY="${PLAY_SECONDS:-600}"; X="${X:-}"
PY=python3; H="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$H/../.." && pwd)"
run() { if [ -n "${RUNP:-}" ]; then $RUNP "$@"; else "$@"; fi; }
g() { echo "::group::$*"; }; e() { echo "::endgroup::"; }

g "analysis / scan / hash (5 runs + warm-up each side)"
ELECTRON_RUN_AS_NODE=1 run "$ELECTRON" "$APP/bench/out/ts-bench.cjs" "$FX" --runs "$RUNS" --out "$R/ts.json" --dump "$R/ts-dump.json" || echo '{"failed":true}' > "$R/ts.json"
run "$BIN/od-bench" core "$FX" --runs "$RUNS" --out "$R/rs.json" --dump "$R/rs-dump.json" || echo '{"failed":true}' > "$R/rs.json"
node "$REPO/bench/equivalence.mjs" "$R/ts-dump.json" "$R/rs-dump.json" "$R/ts.json" "$R/rs.json" > "$R/equivalence.json"; echo "equivalence exit $?"; rm -f "$R"/*-dump.json
e

if [ -n "${MODEL:-}" ] && [ -f "${MODEL:-/nonexistent}" ]; then
g "stems: chunk latency + full-track time"
ELECTRON_RUN_AS_NODE=1 run "$ELECTRON" "$APP/bench/out/ts-stems.cjs" --model "$MODEL" --fixtures "$FX" --ep cpu --chunks "$RUNS" --out "$R/stems-ts.json" || echo '{"failed":true}' > "$R/stems-ts.json"
CORES=$(nproc)
run "$BIN/od-stems-bench" --ort-lib "$ORTLIB" --model "$MODEL" --fixtures "$FX" --ep cpu --chunks "$RUNS" --out "$R/stems-rs-cpu.json" || echo '{"failed":true}' > "$R/stems-rs-cpu.json"
run "$BIN/od-stems-bench" --ort-lib "$ORTLIB" --model "$MODEL" --fixtures "$FX" --ep cpu --threads "$CORES" --out "$R/stems-rs-logical.json" --chunks "$RUNS" || echo '{"failed":true}' > "$R/stems-rs-logical.json"
run "$BIN/od-stems-bench" --ort-lib "$ORTLIB" --model "$MODEL" --fixtures "$FX" --ep cpu --sessions 2 --threads "$CORES" --out "$R/stems-rs-2sessions.json" --chunks "$RUNS" || echo '{"failed":true}' > "$R/stems-rs-2sessions.json"
e
fi

g "4-deck playback with FX + key-lock, ${PLAY} s (underruns, CPU, RAM)"
$PY "$H/sample.py" --marker PLAYBACK --warmup 5 --timeout $((PLAY + 300)) --out "$R/play-rs.json" -- $(echo ${RUNP:-}) "$BIN/od-bench" playback "$FX" --seconds "$PLAY" --buffer 256 --out /tmp/play-rs-inner.json
OD_FX=1 $PY "$H/sample.py" --marker PLAYBACK --warmup 5 --timeout $((PLAY + 300)) --out "$R/play-electron.json" -- $X $(echo ${RUNP:-}) "$ELECTRON" "$APP/bench/shell/electron-shell.cjs" playback "$APP/bench/out/playback" "$PLAY" --no-sandbox
e

g "smallest stable buffer (Rust engine)"
run "$BIN/od-bench" latency "$FX" --seconds 20 --out "$R/latency-rs.json" || true
e

g "cold start to first frame + idle RAM ($RUNS runs + warm-up)"
$PY "$REPO/bench/harness/shell.py" coldstart --name egui --runs "$RUNS" --out "$R/cold-egui.json" -- $X $(echo ${RUNP:-}) "$BIN/opendecks" --null-audio
$PY "$REPO/bench/harness/shell.py" coldstart --name electron --runs "$RUNS" --out "$R/cold-electron.json" -- $X $(echo ${RUNP:-}) "$ELECTRON" "$APP" --no-sandbox --enable-logging=stderr
e

g "UI frame time, 4 waveforms scrolling over 4 playing decks ($RUNS runs x 20 s)"
$PY "$H/repeat.py" --runs "$RUNS" --marker SCROLL --out "$R/scroll-egui.json" -- $X $(echo ${RUNP:-}) "$BIN/opendecks" --null-audio --bench-scroll 20 --fixtures "$FX"
$PY "$H/repeat.py" --runs "$RUNS" --marker SCROLL --out "$R/scroll-electron.json" -- $X $(echo ${RUNP:-}) "$ELECTRON" "$APP/bench/shell/electron-shell.cjs" scroll "$APP/bench/out/scroll" 20 --no-sandbox
e
ls -la "$R"

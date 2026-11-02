#!/usr/bin/env bash
# Runs every benchmark leg on one runner. Called by .github/workflows/bench-mygo-rust.yml.
#   bench/harness/run.sh <results dir>
# Env: APP   directory holding the app (repo root, or /app/bench inside the Flatpak)
#      RUNP  command prefix (empty natively; "flatpak run ... --command=" on Linux)
#      EXE   ".exe" on Windows
#      FX    fixtures dir, MODEL htdemucs model, ORTLIB onnxruntime 1.20.1 library
#      ELECTRON  electron binary inside $APP, RUST_EP  ep for the GPU leg (auto|cpu)
set -u
R="$1"; mkdir -p "$R"
run() { if [ -n "${RUNP:-}" ]; then $RUNP "$@"; else "$@"; fi; }
note() { echo "::group::$*"; }
done_() { echo "::endgroup::"; }

note "analysis / scan / hash: TS (Electron node)"
ELECTRON_RUN_AS_NODE=1 run "$ELECTRON" "$APP/bench/out/ts-bench.cjs" "$FX" --runs 5 --out "$R/ts.json" --dump "$R/ts-dump.json" || echo '{"failed":true}' > "$R/ts.json"
done_
note "analysis / scan / hash: Rust"
run "$APP/od-bench$EXE" "$FX" --runs 5 --out "$R/rs.json" --dump "$R/rs-dump.json" || echo '{"failed":true}' > "$R/rs.json"
done_
node bench/equivalence.mjs "$R/ts-dump.json" "$R/rs-dump.json" "$R/ts.json" "$R/rs.json" > "$R/equivalence.json"; echo "equivalence exit $?"
cat "$R/equivalence.json" | head -c 3000; rm -f "$R/ts-dump.json" "$R/rs-dump.json"

note "stems: today (onnxruntime-node, app plans)"
ELECTRON_RUN_AS_NODE=1 run "$ELECTRON" "$APP/bench/out/ts-stems.cjs" --model "$MODEL" --fixtures "$FX" --ep cpu --chunks 5 --out "$R/stems-ts-cpu.json" --dump "$R/ref-cpu.f32" || echo '{"failed":true}' > "$R/stems-ts-cpu.json"
if [ "$RUST_EP" = auto ]; then
  ELECTRON_RUN_AS_NODE=1 run "$ELECTRON" "$APP/bench/out/ts-stems.cjs" --model "$MODEL" --fixtures "$FX" --ep auto --chunks 5 --out "$R/stems-ts-auto.json" --dump "$R/ref-auto.f32" || echo '{"failed":true}' > "$R/stems-ts-auto.json"
fi
done_
note "stems: prototype (ort crate) variants"
CORES=$(node -e "console.log(require('os').cpus().length)")
stem() { local name="$1"; shift; run "$APP/od-stems$EXE" --ort-lib "$ORTLIB" --model "$MODEL" --fixtures "$FX" --chunks 5 --out "$R/stems-rs-$name.json" --dump "$R/out-$name.f32" "$@" || echo '{"failed":true}' > "$R/stems-rs-$name.json"
  if [ -f "$R/out-$name.f32" ]; then node bench/sdr.mjs "$R/ref-cpu.f32" "$R/out-$name.f32" > "$R/sdr-$name.json"; rm -f "$R/out-$name.f32"; fi; }
stem cpu --ep cpu
stem cpu-logical --ep cpu --threads "$CORES"
stem cpu-opt-all --ep cpu --opt all
stem cpu-2sessions --ep cpu --sessions 2 --threads "$CORES"
[ "$RUST_EP" = auto ] && stem auto --ep auto
rm -f "$R"/*.f32
done_

note "cold start + idle RAM"
PY=$(command -v python3 || command -v python)
run_py() { "$PY" bench/harness/shell.py "$@"; }
if [ -n "${RUNP:-}" ]; then
  run_py coldstart --name electron --runs 5 --out "$R/cold-electron.json" -- $RUNP "$ELECTRON" "$APP" --no-sandbox --enable-logging=stderr
  run_py coldstart --name mygo --runs 5 --out "$R/cold-mygo.json" -- $RUNP "$APP/od-mygo" -mode coldstart -dir "$APP/renderer"
else
  run_py coldstart --name electron --runs 5 --out "$R/cold-electron.json" -- "$ELECTRON" "$APP" --enable-logging=stderr
  run_py coldstart --name mygo --runs 5 --out "$R/cold-mygo.json" -- "$APP/od-mygo$EXE" -mode coldstart -dir "$APP/renderer"
fi
done_
note "installed size"
"$PY" bench/harness/shell.py size --name electron --out "$R/size-electron.json" "$SIZE_ELECTRON_DIST" "$HOSTAPP/dist" "$HOSTAPP/renderer" "$HOSTAPP/node_modules/fflate" "$HOSTAPP/node_modules/signalsmith-stretch" "$HOSTAPP/node_modules/onnxruntime-node/dist" "$HOSTAPP/node_modules/onnxruntime-node/lib" "$SIZE_ORT_BIN"
"$PY" bench/harness/shell.py size --name mygo --out "$R/size-mygo.json" "$HOSTAPP/od-mygo$EXE" "$HOSTAPP/od-bench$EXE" "$HOSTAPP/od-stems$EXE" "$HOSTAPP/renderer" "$SIZE_ORT_BIN"
done_
note "playback glitch test (300 s, 4 decks)"
if [ -n "${RUNP:-}" ]; then
  run_py playback --name electron --seconds 300 --out "$R/play-electron.json" -- $RUNP "$ELECTRON" "$APP/bench/shell/electron-shell.cjs" playback "$APP/bench/out/playback" 300 --no-sandbox
  run_py playback --name mygo --seconds 300 --out "$R/play-mygo.json" -- $RUNP "$APP/od-mygo" -mode playback -dir "$APP/bench/out/playback" -seconds 300
else
  run_py playback --name electron --seconds 300 --out "$R/play-electron.json" -- "$ELECTRON" "$APP/bench/shell/electron-shell.cjs" playback "$APP/bench/out/playback" 300
  run_py playback --name mygo --seconds 300 --out "$R/play-mygo.json" -- "$APP/od-mygo$EXE" -mode playback -dir "$APP/bench/out/playback" -seconds 300
fi
done_
ls -la "$R"

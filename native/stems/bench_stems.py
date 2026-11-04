#!/usr/bin/env python3
"""Stem model benchmark: shipping fp16-weights model vs derived fp32 / int8 / fp16 variants.

Same ONNX Runtime for every variant (the version OpenDecks ships: 1.20.1). Measures:
  * session create time, chunk 0 latency (first run), median of the next N chunks
  * full-track time for a 120 s track = create + chunk0 + (chunks-1) * median (21 chunks,
    343 980-frame chunks, 1/4 overlap, as src/main/stems/core.ts plans them)
  * realtime factor = audio seconds per chunk stride / chunk seconds
  * intra-op threads 1 and all cores; two sessions in parallel (multi-session)
  * execution providers that are present (CPU always; DirectML / CoreML / CUDA if available)
  * SDR vs ground-truth stems on a reference set (MUSDB18 7 s excerpts) and vs the shipping
    model's own output (agreement).
Writes one JSON line per measurement to stdout (prefixed RESULT ) so CI logs carry them.
"""
import argparse, json, os, sys, time, threading
from pathlib import Path
import numpy as np
import onnxruntime as ort

N = 343980
STRIDE = N - N // 4
CHUNKS_120S = 21
SOURCES = ("drums", "bass", "other", "vocals")


def out(rec):
    print("RESULT " + json.dumps(rec), flush=True)


def session(path, ep, threads, opt_off):
    so = ort.SessionOptions()
    # Linux ORT 1.20.1 crashed after chunk 2 with graph optimisation on (inside Electron,
    # D40). Keep the app's CPU setting (disabled) by default; --opt-all overrides.
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL if opt_off else ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.enable_mem_pattern = True
    so.enable_cpu_mem_arena = False
    providers = {"cpu": ["CPUExecutionProvider"], "dml": ["DmlExecutionProvider", "CPUExecutionProvider"],
                 "coreml": ["CoreMLExecutionProvider", "CPUExecutionProvider"], "cuda": ["CUDAExecutionProvider", "CPUExecutionProvider"]}[ep]
    if ep == "dml":
        so.enable_mem_pattern = False
    t = time.perf_counter()
    s = ort.InferenceSession(str(path), sess_options=so, providers=providers)
    return s, time.perf_counter() - t


def synth_chunk(seed):
    rng = np.random.default_rng(seed)
    t = np.arange(N) / 44100
    x = 0.3 * np.sin(2 * np.pi * 110 * t) + 0.2 * np.sin(2 * np.pi * 220 * t * (1 + 0.01 * np.sin(t))) + 0.05 * rng.standard_normal(N)
    return np.stack([x, np.roll(x, 50)]).astype(np.float32)[None]


def sdr(ref, est):
    ref = ref.astype(np.float64); est = est.astype(np.float64)
    num = np.sum(ref ** 2) + 1e-12
    den = np.sum((ref - est) ** 2) + 1e-12
    return 10 * np.log10(num / den)


def speed(model, ep, threads, opt_off, n_chunks, label):
    s, create = session(model, ep, threads, opt_off)
    used = s.get_providers()[0]
    x = synth_chunk(1)
    t = time.perf_counter(); s.run(None, {"mix": x}); c0 = time.perf_counter() - t
    times = []
    for i in range(n_chunks):
        x = synth_chunk(i + 2)
        t = time.perf_counter(); s.run(None, {"mix": x}); times.append(time.perf_counter() - t)
    med = float(np.median(times))
    full = create + c0 + (CHUNKS_120S - 1) * med
    out({"kind": "stems_speed", "variant": label, "ep_requested": ep, "ep_used": used, "threads": threads, "opt_off": opt_off,
         "create_s": round(create, 3), "chunk0_s": round(c0, 3), "chunk_median_s": round(med, 3), "chunk_runs": len(times),
         "full_120s_track_s": round(full, 2), "realtime_factor": round((STRIDE / 44100) / med, 3)})
    return s


def multi(model, ep, opt_off, label, sessions=2, n=3):
    ss = [session(model, ep, max(1, (os.cpu_count() or 2) // sessions), opt_off)[0] for _ in range(sessions)]
    for s in ss:
        s.run(None, {"mix": synth_chunk(0)})
    def work(s, k):
        for i in range(n):
            s.run(None, {"mix": synth_chunk(100 + k * 10 + i)})
    t = time.perf_counter()
    th = [threading.Thread(target=work, args=(s, k)) for k, s in enumerate(ss)]
    [x.start() for x in th]; [x.join() for x in th]
    el = time.perf_counter() - t
    out({"kind": "stems_multi", "variant": label, "ep": ep, "sessions": sessions, "chunks_total": sessions * n,
         "wall_s": round(el, 2), "chunks_per_s": round(sessions * n / el, 3)})


def load_ref(ref_dir, limit):
    """Ref set: <ref_dir>/<track>/{mixture,drums,bass,other,vocals}.f32 (stereo, 44.1 kHz, raw)."""
    items = []
    for d in sorted(Path(ref_dir).iterdir())[:limit]:
        if not (d / "mixture.f32").exists():
            continue
        def rd(n):
            a = np.fromfile(d / f"{n}.f32", dtype=np.float32).reshape(-1, 2).T
            if a.shape[1] < N:
                a = np.pad(a, ((0, 0), (0, N - a.shape[1])))
            return a[:, :N]
        items.append((d.name, rd("mixture"), {s: rd(s) for s in SOURCES}))
    return items


def quality(models, ref_dir, limit, opt_off, ship_label):
    items = load_ref(ref_dir, limit)
    outputs = {}
    for label, path in models:
        s, _ = session(path, "cpu", os.cpu_count() or 2, opt_off)
        outputs[label] = {}
        for name, mix, stems in items:
            y = s.run(None, {"mix": mix[None]})[0][0]  # (4, 2, N)
            outputs[label][name] = y
        del s
    for label in outputs:
        per = {src: [] for src in SOURCES}
        agree = {src: [] for src in SOURCES}
        for name, mix, stems in items:
            y = outputs[label][name]
            for k, src in enumerate(SOURCES):
                per[src].append(sdr(stems[src], y[k]))
                if label != ship_label:
                    agree[src].append(sdr(outputs[ship_label][name][k], y[k]))
        rec = {"kind": "stems_sdr", "variant": label, "tracks": len(items),
               "sdr_vs_truth_median_db": {s: round(float(np.median(v)), 2) for s, v in per.items()},
               "sdr_vs_truth_mean_db": round(float(np.mean([np.median(v) for v in per.values()])), 2)}
        if label != ship_label:
            rec["sdr_vs_shipping_median_db"] = {s: round(float(np.median(v)), 2) for s, v in agree.items()}
        out(rec)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True, help="dir with htdemucs*.onnx")
    ap.add_argument("--variants", default="fp16weights,fp32,int8-dyn-matmul,int8-dyn,fp16,int8-static")
    ap.add_argument("--eps", default="cpu")
    ap.add_argument("--chunks", type=int, default=3)
    ap.add_argument("--ref", default="")
    ap.add_argument("--ref-limit", type=int, default=8)
    ap.add_argument("--opt-all", action="store_true")
    ap.add_argument("--no-speed", action="store_true")
    ap.add_argument("--multi", action="store_true")
    a = ap.parse_args()
    md = Path(a.models)
    names = {"fp16weights": "htdemucs_fp16weights.onnx", "fp32": "htdemucs.onnx"}
    models = []
    for v in a.variants.split(","):
        p = md / names.get(v, f"htdemucs_{v}.onnx")
        if p.exists():
            models.append((v, p))
        else:
            out({"kind": "stems_missing", "variant": v})
    out({"kind": "stems_env", "ort": ort.__version__, "available_eps": ort.get_available_providers(), "cpus": os.cpu_count()})
    opt_off = not a.opt_all
    if not a.no_speed:
        for label, p in models:
            for ep in a.eps.split(","):
                prov = {"cpu": "CPUExecutionProvider", "dml": "DmlExecutionProvider", "coreml": "CoreMLExecutionProvider", "cuda": "CUDAExecutionProvider"}[ep]
                if prov not in ort.get_available_providers():
                    out({"kind": "stems_ep_unavailable", "ep": ep}); continue
                thread_set = [1, os.cpu_count() or 2] if ep == "cpu" else [os.cpu_count() or 2]
                for th in thread_set:
                    try:
                        speed(p, ep, th, opt_off if ep == "cpu" else False, a.chunks, label)
                    except Exception as e:  # record, never hide
                        out({"kind": "stems_error", "variant": label, "ep": ep, "threads": th, "error": str(e)[:300]})
            if a.multi:
                try:
                    multi(p, "cpu", opt_off, label)
                except Exception as e:
                    out({"kind": "stems_error", "variant": label, "stage": "multi", "error": str(e)[:300]})
    if a.ref:
        quality(models, a.ref, a.ref_limit, opt_off, "fp16weights")


if __name__ == "__main__":
    main()

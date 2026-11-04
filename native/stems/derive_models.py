#!/usr/bin/env python3
"""Derive int8 (dynamic, static QDQ) and fp16 variants of the MIT fp32 HTDemucs ONNX
export (https://huggingface.co/StemSplitio/htdemucs-onnx, file htdemucs.onnx), with
ONNX Runtime's own quantization tools, so the weights' provenance stays the MIT export.

Usage: python derive_models.py <model_dir> [variant ...]
Variants: int8-dyn-matmul, int8-dyn, int8-static, fp16
Writes <model_dir>/htdemucs_<variant>.onnx and appends sha256 + the exact call to
<model_dir>/derive.log. Nothing here downloads or uses any third-party quantized file.
"""
import hashlib, json, sys, time, os
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort

N = 343980


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def log(d, rec):
    with open(d / "derive.log", "a") as f:
        f.write(json.dumps(rec) + "\n")
    print(json.dumps(rec), flush=True)


def calib_chunks(n=4, seed=7):
    """Deterministic synthetic music-like calibration chunks (chords + kick + hats + noise).
    Used only for static-quant activation ranges; no third-party audio."""
    rng = np.random.default_rng(seed)
    t = np.arange(N) / 44100.0
    out = []
    for k in range(n):
        f0 = 55.0 * 2 ** (rng.integers(0, 12) / 12)
        x = sum(0.15 * np.sin(2 * np.pi * f0 * m * t) for m in (1, 1.26, 1.5, 2, 4))
        bpm = 120 + 8 * k
        ph = (t * bpm / 60) % 1
        x += 0.6 * np.sin(2 * np.pi * 50 * t) * np.exp(-ph * 18)
        x += 0.05 * rng.standard_normal(N) * ((t * bpm / 30) % 1 < 0.1)
        x += 0.2 * np.sin(2 * np.pi * (440 + 30 * np.sin(2 * np.pi * 0.3 * t)) * t) * (np.sin(2 * np.pi * 0.5 * t) > 0)
        st = np.stack([x, np.roll(x, 37)]).astype(np.float32) * 0.5
        out.append(st[None])
    return out


def main():
    d = Path(sys.argv[1])
    variants = sys.argv[2:] or ["int8-dyn-matmul", "int8-dyn", "fp16", "int8-static"]
    src = d / "htdemucs.onnx"
    log(d, {"step": "source", "file": src.name, "sha256": sha(src), "ort": ort.__version__, "onnx": onnx.__version__})
    from onnxruntime.quantization import quantize_dynamic, quantize_static, QuantType, QuantFormat, CalibrationDataReader, CalibrationMethod
    for v in variants:
        dst = d / f"htdemucs_{v}.onnx"
        t0 = time.time()
        if v == "int8-dyn-matmul":
            call = "quantize_dynamic(src, dst, op_types_to_quantize=['MatMul'], weight_type=QuantType.QInt8, per_channel=False)"
            quantize_dynamic(str(src), str(dst), op_types_to_quantize=["MatMul"], weight_type=QuantType.QInt8, per_channel=False)
        elif v == "int8-dyn":
            call = "quantize_dynamic(src, dst, op_types_to_quantize=['MatMul','Conv'], weight_type=QuantType.QUInt8, per_channel=False)"
            quantize_dynamic(str(src), str(dst), op_types_to_quantize=["MatMul", "Conv"], weight_type=QuantType.QUInt8, per_channel=False)
        elif v == "fp16":
            from onnxconverter_common import float16
            import onnxconverter_common
            call = f"onnxconverter_common {onnxconverter_common.__version__} float16.convert_float_to_float16(model, keep_io_types=True, disable_shape_infer=True)"
            m = onnx.load(str(src))
            m16 = float16.convert_float_to_float16(m, keep_io_types=True, disable_shape_infer=True)
            onnx.save(m16, str(dst))
        elif v == "int8-static":
            class R(CalibrationDataReader):
                def __init__(self):
                    self.it = iter([{"mix": c} for c in calib_chunks()])
                def get_next(self):
                    return next(self.it, None)
            call = ("quantize_static(src, dst, R(4 synthetic chunks seed 7), quant_format=QuantFormat.QDQ, "
                    "op_types_to_quantize=['MatMul','Conv'], activation_type=QuantType.QInt8, weight_type=QuantType.QInt8, "
                    "per_channel=True, calibrate_method=CalibrationMethod.MinMax, extra_options={'CalibMovingAverage': True})")
            quantize_static(str(src), str(dst), R(), quant_format=QuantFormat.QDQ, op_types_to_quantize=["MatMul", "Conv"],
                            activation_type=QuantType.QInt8, weight_type=QuantType.QInt8, per_channel=True,
                            calibrate_method=CalibrationMethod.MinMax, extra_options={"CalibMovingAverage": True})
        else:
            raise SystemExit(f"unknown variant {v}")
        log(d, {"step": "derive", "variant": v, "file": dst.name, "bytes": os.path.getsize(dst), "sha256": sha(dst),
                "seconds": round(time.time() - t0, 1), "call": call})


if __name__ == "__main__":
    main()

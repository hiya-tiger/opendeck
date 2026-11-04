#!/usr/bin/env python3
"""Generate the decode-benchmark fixtures once (seeded synthetic music, no third-party audio)
and encode them into every format OpenDecks accepts today (src/renderer/media/library.ts
AUDIO_RE: mp3 wav ogg flac m4a aac aif aiff opus webm; plus ALAC-in-m4a and 24-bit/float PCM).

The encoded files are committed under native/fixtures/audio/ so every CI runner decodes
byte-identical inputs. The ffmpeg CLI is used here only as an offline encoding tool on the
developer machine; nothing links or ships ffmpeg.
"""
import hashlib, json, subprocess, sys, wave
from pathlib import Path
import numpy as np

SR = 44100
SECONDS = 20
OUT = Path(__file__).resolve().parent / "audio"


def synth(seed=2026):
    rng = np.random.default_rng(seed)
    n = SR * SECONDS
    t = np.arange(n) / SR
    bpm = 126.0
    beat = (t * bpm / 60.0)
    ph = beat % 1.0
    kick = np.sin(2 * np.pi * (45 + 90 * np.exp(-ph * 30)) * t) * np.exp(-ph * 9)
    hat = rng.standard_normal(n) * np.exp(-((beat * 2) % 1.0) * 40) * 0.25
    roots = [57, 53, 60, 55]
    chord = np.zeros(n)
    bar = (beat // 4).astype(int) % 4
    for i, r in enumerate(roots):
        m = bar == i
        for semi in (0, 3, 7, 12):
            f = 440 * 2 ** ((r + semi - 69) / 12)
            chord[m] += np.sin(2 * np.pi * f * t[m]) * 0.08
    bass = np.sign(np.sin(2 * np.pi * 440 * 2 ** ((np.array(roots)[bar] - 24 - 69) / 12) * t)) * 0.12 * (ph < 0.6)
    lead = np.sin(2 * np.pi * 880 * 2 ** (rng.integers(0, 8, n // (SR // 4) + 1)[(t * 4).astype(int)] / 12) * t) * 0.07
    left = kick * 0.7 + hat * 0.6 + chord + bass + lead
    right = kick * 0.7 + hat * 0.4 + np.roll(chord, 113) + bass + lead * 0.8
    st = np.stack([left, right], 1)
    st /= np.max(np.abs(st)) * 1.12
    return st.astype(np.float32)


def write_wav16(path, x):
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())


ENCODES = [
    # name, ffmpeg args (input is master.wav, 16-bit), container note
    ("wav16.wav", ["-c:a", "pcm_s16le"]),
    ("wav24.wav", ["-c:a", "pcm_s24le"]),
    ("wavf32.wav", ["-c:a", "pcm_f32le"]),
    ("aiff16.aiff", ["-c:a", "pcm_s16be"]),
    ("aiff24.aif", ["-c:a", "pcm_s24be"]),
    ("flac16.flac", ["-c:a", "flac", "-compression_level", "8"]),
    ("flac24.flac", ["-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24"]),
    ("alac.m4a", ["-c:a", "alac"]),
    ("mp3-cbr320.mp3", ["-c:a", "libmp3lame", "-b:a", "320k"]),
    ("mp3-vbr0.mp3", ["-c:a", "libmp3lame", "-q:a", "0"]),
    ("aac-lc256.m4a", ["-c:a", "aac", "-b:a", "256k"]),
    ("aac-lc192.aac", ["-c:a", "aac", "-b:a", "192k", "-f", "adts"]),
    ("vorbis-q6.ogg", ["-c:a", "libvorbis", "-q:a", "6"]),
    ("opus160.opus", ["-c:a", "libopus", "-b:a", "160k"]),
    ("opus160.webm", ["-c:a", "libopus", "-b:a", "160k"]),
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    x = synth()
    master = OUT.parent / "master-16.wav.tmp"
    write_wav16(master, x)
    manifest = []
    for name, args in ENCODES:
        dst = OUT / name
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(master), *args, "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", str(dst)]
        subprocess.run(cmd, check=True)
        manifest.append({"file": name, "bytes": dst.stat().st_size, "sha256": hashlib.sha256(dst.read_bytes()).hexdigest(),
                         "encoder_args": " ".join(args)})
    master.unlink()
    ver = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.splitlines()[0]
    (OUT / "MANIFEST.json").write_text(json.dumps({"seconds": SECONDS, "rate": SR, "channels": 2, "seed": 2026,
                                                   "encoded_with": ver, "files": manifest}, indent=1))
    print(json.dumps(manifest, indent=1))


if __name__ == "__main__":
    main()

//! Real-time engine runs without a sound card: the engine is driven by a
//! thread paced to the buffer period (the same pacing the app's null driver
//! uses). A callback that takes longer than its period is "late"; a period
//! the pacer could not keep is an underrun. On a machine with a device the
//! app uses cpal instead and counts ALSA xruns.
use od_audio::{decode, Command, Engine};
use od_core::fx::FxType;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn opt(a: &[String], n: &str, d: &str) -> String { a.iter().position(|x| x == &format!("--{n}")).and_then(|i| a.get(i + 1).cloned()).unwrap_or_else(|| d.into()) }

fn cpu_seconds() -> f64 {
    let s = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    let f: Vec<&str> = s.rsplit(')').next().unwrap_or("").split_whitespace().collect();
    (f.get(11).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) + f.get(12).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0)) / 100.0
}
fn rss_mb() -> f64 { std::fs::read_to_string("/proc/self/status").unwrap_or_default().lines().find(|l| l.starts_with("VmRSS:")).and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) / 1024.0 }

fn setup(fx: &str, sr: u32) -> (Engine, od_audio::Controller) {
    let (mut e, mut c) = Engine::new(sr, false);
    let mut files: Vec<PathBuf> = std::fs::read_dir(PathBuf::from(fx).join("audio")).unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().map(|x| x == "f32").unwrap_or(false)).collect();
    files.sort();
    for (d, f) in files.iter().take(4).enumerate() {
        let pcm = Arc::new(decode::to_engine_rate(decode::decode_file(f).unwrap(), sr));
        c.send(Command::Load { deck: d, pcm, bpm: 124.0 });
        // Same scenario as bench/ts/playback.ts: 4 decks looping, C and D key-locked at +3 %; plus FX on A and B.
        c.send(Command::Loop { deck: d, start: 0.0, end: 110.0, on: true });
        if d >= 2 { c.send(Command::Keylock { deck: d, on: true }); c.send(Command::Rate { deck: d, rate: 1.03 }); }
        c.send(Command::Play { deck: d, on: true });
    }
    c.send(Command::Fx { deck: 0, kind: FxType::Echo, division: "1/4", amount: 0.4, wet: 0.55 });
    c.send(Command::Fx { deck: 1, kind: FxType::Reverb, division: "1/4", amount: 0.5, wet: 0.4 });
    let mut warm = vec![0f32; 512 * 2];
    e.process(&mut warm, 2, None);
    (e, c)
}

/// Returns (late callbacks, underruns, callbacks, worst callback ms, cpu %).
fn run(e: &mut Engine, frames: usize, sr: u32, secs: f64) -> (u64, u64, u64, f64, f64, f64) {
    let mut buf = vec![0f32; frames * 2];
    let period = Duration::from_secs_f64(frames as f64 / sr as f64);
    let (mut late, mut under, mut n, mut worst) = (0u64, 0u64, 0u64, 0f64);
    let mut per_cb = vec![];
    let c0 = cpu_seconds();
    let t0 = Instant::now();
    let mut next = t0 + period;
    while t0.elapsed().as_secs_f64() < secs {
        let s = Instant::now();
        e.process(&mut buf, 2, None);
        let ms = s.elapsed().as_secs_f64() * 1000.0;
        per_cb.push(ms);
        worst = worst.max(ms);
        n += 1;
        if s.elapsed() > period { late += 1; }
        let now = Instant::now();
        if now > next + period { under += 1; next = now + period; continue; }
        std::thread::sleep(next.saturating_duration_since(now));
        next += period;
    }
    per_cb.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let med = per_cb.get(per_cb.len() / 2).copied().unwrap_or(0.0);
    (late, under, n, worst, (cpu_seconds() - c0) / t0.elapsed().as_secs_f64() * 100.0, med)
}

pub fn playback_main(a: Vec<String>) {
    let fx = a.get(1).cloned().unwrap_or_default();
    let secs: f64 = opt(&a, "seconds", "600").parse().unwrap();
    let frames: usize = opt(&a, "buffer", "256").parse().unwrap();
    let out = opt(&a, "out", "play-rs.json");
    let sr = 48000;
    let (mut e, _c) = setup(&fx, sr);
    let idle = rss_mb();
    let (late, under, n, worst, cpu, med) = run(&mut e, frames, sr, secs);
    let r = json!({"name": "egui-rust", "seconds": secs, "bufferFrames": frames, "sampleRate": sr, "callbacks": n, "lateCallbacks": late, "underruns": under, "glitches": late + under, "worstCallbackMs": worst, "medianCallbackMs": med, "cpuPercent": cpu, "rssMb": rss_mb(), "rssBeforePlayMb": idle, "driver": "paced null driver (no sound card)"});
    std::fs::write(&out, serde_json::to_string_pretty(&r).unwrap()).unwrap();
    println!("PLAYBACK {r}");
}

/// Smallest buffer with zero late callbacks and zero underruns over `seconds`.
pub fn latency_main(a: Vec<String>) {
    let fx = a.get(1).cloned().unwrap_or_default();
    let secs: f64 = opt(&a, "seconds", "20").parse().unwrap();
    let out = opt(&a, "out", "lat-rs.json");
    let sr = 48000;
    let mut tried = vec![];
    let mut smallest = None;
    for frames in [32usize, 64, 128, 256, 512, 1024] {
        let (mut e, _c) = setup(&fx, sr);
        let (late, under, n, worst, cpu, _) = run(&mut e, frames, sr, secs);
        tried.push(json!({"bufferFrames": frames, "late": late, "underruns": under, "callbacks": n, "worstMs": worst, "cpuPercent": cpu}));
        if late == 0 && under == 0 && smallest.is_none() { smallest = Some(frames); }
    }
    let ms = smallest.map(|f| f as f64 / sr as f64 * 1000.0);
    let r = json!({"name": "egui-rust", "sampleRate": sr, "smallestStableBuffer": smallest, "outputBufferLatencyMs": ms, "note": "one output buffer at the smallest stable size, engine-side only; device/driver latency and the input path are not included (no sound card on CI)", "tried": tried});
    std::fs::write(&out, serde_json::to_string_pretty(&r).unwrap()).unwrap();
    println!("LATENCY {r}");
}

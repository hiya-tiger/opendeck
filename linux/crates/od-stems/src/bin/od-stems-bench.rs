//! Prototype stem path: the same htdemucs ONNX model, the same chunk plan
//! (343 980 frames, 1/4 overlap) and the same session options as the app's
//! src/main/stems/core.ts, through the `ort` crate.
//!
//!   od-stems --model m.onnx --fixtures fx --ep cpu|auto [--threads N] [--sessions K] [--opt disable|all] [--chunks 5] --out rs.json [--dump out.f32]
//!
//! --sessions K runs K sessions in parallel (each with threads/K intra-op
//! threads) on alternate chunks: the multi-core variant from the stems fallback.
use ort::execution_providers::CPUExecutionProvider;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

const FRAMES: usize = 343_980;
const OVERLAP: usize = FRAMES / 4;

fn plan(total: usize) -> Vec<(usize, usize)> {
    // planChunksWith(totalFrames, FRAMES, OVERLAP): starts every stride while start < total.
    let stride = FRAMES - OVERLAP;
    (0..total).step_by(stride).map(|start| (start, FRAMES.min(total - start))).collect()
}

fn median(xs: &[f64]) -> f64 {
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let m = s.len() / 2;
    if s.len() % 2 == 1 { s[m] } else { (s[m - 1] + s[m]) / 2.0 }
}

fn build(model: &str, ep: &str, threads: usize, opt: &str) -> ort::Result<(Session, String)> {
    let level = if opt == "all" { GraphOptimizationLevel::Level3 } else { GraphOptimizationLevel::Disable };
    let mut b = Session::builder()?
        .with_optimization_level(level)?
        .with_parallel_execution(false)?
        .with_memory_pattern(true)?;
    if threads > 0 { b = b.with_intra_threads(threads)?; }
    // CPU EP appended with use_arena = 0 (the default here) = the app's enableCpuMemArena: false.
    let cpu = CPUExecutionProvider::default().build();
    #[allow(unused_mut)]
    let mut provider = "cpu".to_string();
    #[allow(unused_mut)]
    let mut eps = vec![];
    if ep == "auto" {
        #[cfg(all(windows, feature = "directml"))]
        { eps.push(ort::execution_providers::DirectMLExecutionProvider::default().with_device_id(0).build().error_on_failure()); provider = "dml".into(); b = b.with_memory_pattern(false)?; }
        #[cfg(all(target_os = "macos", feature = "coreml"))]
        { eps.push(ort::execution_providers::CoreMLExecutionProvider::default().build().error_on_failure()); provider = "coreml".into(); }
    }
    if ep == "xnnpack" {
        #[cfg(feature = "xnnpack")]
        { eps.push(ort::execution_providers::XNNPACKExecutionProvider::default().build().error_on_failure()); provider = "xnnpack".into(); }
    }
    eps.push(cpu);
    let s = b.with_execution_providers(eps)?.commit_from_file(model)?;
    Ok((s, provider))
}

fn main() -> ort::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let opt = |n: &str, d: &str| -> String { args.iter().position(|a| a == &format!("--{}", n)).and_then(|i| args.get(i + 1).cloned()).unwrap_or_else(|| d.into()) };
    let model = opt("model", "htdemucs_fp16weights.onnx");
    let fixtures = PathBuf::from(opt("fixtures", "bench-fixtures"));
    let ep = opt("ep", "cpu");
    let chunks: usize = opt("chunks", "5").parse().unwrap();
    let sessions: usize = opt("sessions", "1").parse().unwrap();
    let level = opt("opt", "auto");
    let phys = num_cpus::get_physical();
    let threads: usize = opt("threads", &phys.to_string()).parse().unwrap();
    let out = opt("out", "rs-stems.json");
    let dump = opt("dump", "");
    // Same rule as providerPlans(): CPU keeps graph optimisation disabled, GPU EPs use "all".
    let level = if level == "auto" { if ep == "cpu" { "disable".to_string() } else { "all".to_string() } } else { level };

    let mut audio: Vec<PathBuf> = std::fs::read_dir(fixtures.join("audio")).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().map(|e| e == "f32").unwrap_or(false)).collect();
    audio.sort();
    let (_sr, ch) = od_core::load_track(&audio[0]).unwrap();
    let total = ch[0].len();
    let p = plan(total);
    let input_for = |i: usize| -> Vec<f32> {
        let (start, len) = p[i % p.len()];
        let mut v = vec![0f32; 2 * FRAMES];
        let n = len.min(FRAMES);
        v[..n].copy_from_slice(&ch[0][start..start + n]);
        v[FRAMES..FRAMES + n].copy_from_slice(&ch[1][start..start + n]);
        v
    };

    let lib = opt("ort-lib", &std::env::var("ORT_DYLIB_PATH").unwrap_or_default());
    ort::init_from(lib).commit()?;
    let per = (threads / sessions).max(1);
    let t0 = Instant::now();
    let mut pool = vec![];
    let mut provider = String::new();
    for _ in 0..sessions {
        let (s, pr) = build(&model, &ep, per, &level)?;
        provider = pr;
        pool.push(Arc::new(s));
    }
    let create_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let in_name = pool[0].inputs.iter().find(|i| i.name == "mix").map(|i| i.name.clone()).unwrap_or_else(|| pool[0].inputs[0].name.clone());
    let out_name = pool[0].outputs.iter().find(|o| o.name == "stems").map(|o| o.name.clone()).unwrap_or_else(|| pool[0].outputs[0].name.clone());
    let run = |s: &Session, i: usize| -> ort::Result<(f64, Vec<f32>)> {
        let data = input_for(i);
        let t = Instant::now();
        let tensor = ort::value::Tensor::from_array(([1usize, 2, FRAMES], data.into_boxed_slice()))?;
        let outs = s.run(ort::inputs![in_name.as_str() => tensor]?)?;
        let (_, d) = outs[out_name.as_str()].try_extract_raw_tensor::<f32>()?;
        Ok((t.elapsed().as_secs_f64() * 1000.0, d.to_vec()))
    };
    // Chunk 0 on every session (first-run setup), timed like the TS side's chunk 0.
    let (first_ms, _) = run(&pool[0], 0)?;
    for s in pool.iter().skip(1) { run(s, 0)?; }

    let mut times = vec![];
    let mut dumped: Option<Vec<f32>> = None;
    let wall;
    if sessions == 1 {
        let w = Instant::now();
        for i in 1..=chunks {
            let (ms, d) = run(&pool[0], i)?;
            times.push(ms);
            if i == 1 { dumped = Some(d); }
        }
        wall = w.elapsed().as_secs_f64() * 1000.0;
    } else {
        // K sessions in parallel, each taking every K-th chunk. Throughput per chunk = wall / chunks.
        let w = Instant::now();
        let results: Vec<Vec<(usize, f64, Vec<f32>)>> = std::thread::scope(|sc| {
            let hs: Vec<_> = (0..sessions).map(|k| {
                let s = pool[k].clone();
                let run = &run;
                sc.spawn(move || {
                    let mut r = vec![];
                    let mut i = 1 + k;
                    while i <= chunks { let (ms, d) = run(&s, i).unwrap(); r.push((i, ms, if i == 1 { d } else { vec![] })); i += sessions; }
                    r
                })
            }).collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        wall = w.elapsed().as_secs_f64() * 1000.0;
        for r in results.into_iter().flatten() { times.push(r.1); if r.0 == 1 { dumped = Some(r.2); } }
    }
    // Effective time per chunk: latency for one session, wall/chunks for several.
    let eff = if sessions == 1 { median(&times) } else { wall / chunks as f64 };
    let full = create_ms + first_ms + (p.len() as f64 - 1.0) * eff;
    let peak = peak_rss_mb();
    let report = json!({
        "side": "rs", "engine": "ort 2.0.0-rc.9 (ONNX Runtime 1.20)", "provider": provider, "threads": threads, "sessions": sessions, "opt": level,
        "createMs": create_ms, "firstChunkMs": first_ms, "chunkTimes": times, "chunkMedianMs": median(&times), "effectiveChunkMs": eff,
        "trackChunks": p.len(), "trackSeconds": total as f64 / 44100.0, "fullTrackMs": full, "peakRssMb": peak,
    });
    if !dump.is_empty() { if let Some(d) = dumped { std::fs::write(&dump, d.iter().flat_map(|f| f.to_le_bytes()).collect::<Vec<u8>>()).unwrap(); } }
    std::fs::write(&out, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    println!("{}", report);
    Ok(())
}

#[cfg(unix)]
fn peak_rss_mb() -> f64 {
    let mut u: libc_rusage = unsafe { std::mem::zeroed() };
    unsafe { getrusage(0, &mut u) };
    // ru_maxrss: KiB on Linux, bytes on macOS.
    if cfg!(target_os = "macos") { u.ru_maxrss as f64 / 1048576.0 } else { u.ru_maxrss as f64 / 1024.0 }
}
#[cfg(not(unix))]
fn peak_rss_mb() -> f64 { -1.0 } // measured by the harness on Windows

#[cfg(unix)]
#[repr(C)]
struct libc_rusage { ru_utime: [i64; 2], ru_stime: [i64; 2], ru_maxrss: i64, _rest: [i64; 13] }
#[cfg(unix)]
extern "C" { fn getrusage(who: i32, usage: *mut libc_rusage) -> i32; }

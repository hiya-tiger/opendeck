//! `od-bench core`: Rust side of the analysis/scan/hash benchmark: same workloads, fixtures and run count as
//! bench/ts/bench.ts. Run 0 is a warm-up on both sides and is not counted.
use od_core::{analysis, default_pool_size, library as lib, load_track};
use rayon::prelude::*;
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn sorted(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).filter(|p| p.to_string_lossy().ends_with(ext)).collect();
    v.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    v
}

fn median(xs: &[f64]) -> f64 {
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let m = s.len() / 2;
    if s.len() % 2 == 1 { s[m] } else { (s[m - 1] + s[m]) / 2.0 }
}

fn scan_once(fx: &Path) -> lib::ScanResult {
    let s = fx.join("serato");
    // Read every file first (I/O on one thread, as the TS does), then parse on all cores.
    let db_bytes = fs::read(s.join("database V2")).unwrap();
    let crate_files: Vec<(String, Vec<u8>)> = sorted(&s.join("Subcrates"), ".crate").into_iter().map(|p| (p.file_name().unwrap().to_string_lossy().into_owned(), fs::read(&p).unwrap())).collect();
    let tag_dir = s.join("tags");
    let m2: Vec<Vec<u8>> = sorted(&tag_dir, ".m2").iter().map(|p| fs::read(p).unwrap()).collect();
    let bg: Vec<Vec<u8>> = sorted(&tag_dir, ".bg").iter().map(|p| fs::read(p).unwrap()).collect();
    let r = fx.join("rekordbox");
    let pdb_bytes = fs::read(r.join("export.pdb")).unwrap();
    let anlz_files: Vec<Vec<u8>> = sorted(&r.join("anlz"), "").iter().map(|p| fs::read(p).unwrap()).collect();

    let ((database, crates), ((markers, grids), ((pdb, playlists), anlz))) = rayon::join(
        || rayon::join(
            || lib::decode_database(&db_bytes).unwrap(),
            || crate_files.par_iter().map(|(n, b)| (n.clone(), lib::decode_crate(b).unwrap())).collect::<Vec<_>>(),
        ),
        || rayon::join(
            || rayon::join(
                || m2.par_iter().map(|b| lib::decode_markers2(b).unwrap()).collect::<Vec<_>>(),
                || bg.par_iter().map(|b| lib::decode_beat_grid(b).unwrap()).collect::<Vec<_>>(),
            ),
            || rayon::join(
                || { let p = lib::parse_pdb(&pdb_bytes).unwrap(); let pl = lib::playlist_paths(&p); (p, pl) },
                || anlz_files.par_iter().map(|b| lib::parse_anlz_cues(b)).collect::<Vec<_>>(),
            ),
        ),
    );
    lib::ScanResult { database, crates, markers, grids, pdb, playlists, anlz }
}

fn sha256_file(p: &Path) -> String {
    let mut f = fs::File::open(p).unwrap();
    // ring's SHA-256 is the same BoringSSL/OpenSSL assembly (SHA-NI / ARMv8
    // crypto extensions) that Node's crypto uses.
    let mut h = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).unwrap();
        if n == 0 { break; }
        h.update(&buf[..n]);
    }
    h.finish().as_ref().iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn core_main(args: Vec<String>) {
    let fx = PathBuf::from(args.get(1).cloned().unwrap_or_else(|| "bench-fixtures".into()));
    let opt = |name: &str, d: &str| -> String {
        args.iter().position(|a| a == &format!("--{}", name)).and_then(|i| args.get(i + 1).cloned()).unwrap_or_else(|| d.into())
    };
    let runs: usize = opt("runs", "5").parse().unwrap();
    let out = opt("out", "rs.json");
    let dump = opt("dump", "");
    let only = opt("only", "analysis,scan,hash");
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    let pool = default_pool_size(cpus);
    // Same worker count the app's analysis pool gets, for every workload.
    rayon::ThreadPoolBuilder::new().num_threads(pool).build_global().unwrap();

    let mut report = json!({ "side": "rs", "platform": std::env::consts::OS, "arch": std::env::consts::ARCH, "cpus": cpus, "runs": runs, "poolSize": pool });
    let mut dumpv = json!({});
    let audio = sorted(&fx.join("audio"), ".f32");

    if only.contains("analysis") {
        let tracks: Vec<(f64, Vec<Vec<f32>>)> = audio.iter().map(|p| load_track(p).unwrap()).collect();
        let mut times = vec![];
        let mut last = vec![];
        for i in 0..=runs {
            let t0 = Instant::now();
            let res: Vec<analysis::AnalysisResult> = tracks.par_iter().map(|(sr, ch)| {
                // channelsOf() copies the channels before analysis; do the same.
                let copy: Vec<Vec<f32>> = ch.clone();
                analysis::analyze(&analysis::Audio { sample_rate: *sr, length: copy[0].len(), channels: &copy }, 2000)
            }).collect();
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            if i > 0 { times.push(ms); }
            last = res;
        }
        report["analysis"] = json!({ "poolSize": pool, "tracks": tracks.len(), "times": times, "median": median(&times) });
        dumpv["analysis"] = Value::Array(last.iter().map(|r| json!({
            "bpm": r.bpm, "confidence": r.confidence, "beatPhase": r.beat_phase, "key": r.key.key, "camelot": r.key.camelot,
            "keyConfidence": r.key.confidence, "duration": r.duration, "peaks": r.peaks, "low": r.low, "mid": r.mid, "high": r.high,
        })).collect());
    }
    if only.contains("scan") {
        let mut times = vec![];
        let mut digest = String::new();
        for i in 0..=runs {
            let t0 = Instant::now();
            let res = scan_once(&fx);
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            if i > 0 { times.push(ms); }
            let c = lib::canonical(&res);
            digest = od_core::hash::sha256_bytes(c.as_bytes());
            if i == 0 && !dump.is_empty() { dumpv["scanCanonical"] = Value::String(c); }
        }
        report["scan"] = json!({ "times": times, "median": median(&times), "digest": digest });
    }
    if only.contains("hash") {
        let mut times = vec![];
        let mut digests = vec![];
        for i in 0..=runs {
            let t0 = Instant::now();
            digests = audio.par_iter().map(|p| sha256_file(p)).collect::<Vec<_>>();
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            if i > 0 { times.push(ms); }
        }
        report["hash"] = json!({ "files": audio.len(), "times": times, "median": median(&times), "digests": digests });
    }
    fs::write(&out, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    if !dump.is_empty() { fs::write(&dump, dumpv.to_string()).unwrap(); }
    println!("{}", report);
}

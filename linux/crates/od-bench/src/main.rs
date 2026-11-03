//! Benchmarks for the Linux build. Same fixtures (bench/fixtures/gen.ts) and
//! run counts as the TypeScript side (bench/ts).
//!   od-bench core <fixtures> --runs 5 --out rs.json [--dump d.json]
//!   od-bench playback <fixtures> --seconds 600 --buffer 256 --out play.json
//!   od-bench latency <fixtures> --seconds 20 --out lat.json
mod core;
mod play;

fn main() {
    let mut a: Vec<String> = std::env::args().collect();
    let cmd = a.get(1).cloned().unwrap_or_default();
    a.remove(1);
    match cmd.as_str() {
        "core" => core::core_main(a),
        "playback" => play::playback_main(a),
        "latency" => play::latency_main(a),
        _ => { eprintln!("usage: od-bench core|playback|latency <fixtures> ..."); std::process::exit(2); }
    }
}

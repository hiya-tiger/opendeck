//! od-bench: benchmark-only prototype for the MyGo + Rust experiment
//! (docs/benchmarks/mygo-rust.md). Not wired into the app.
pub mod analysis;
pub mod library;

use std::path::Path;

pub fn load_track(path: &Path) -> std::io::Result<(f64, Vec<Vec<f32>>)> {
    let buf = std::fs::read(path)?;
    assert_eq!(&buf[0..4], b"ODF1", "bad fixture {}", path.display());
    let rd = |o: usize| u32::from_le_bytes(buf[o..o + 4].try_into().unwrap()) as usize;
    let (sr, nch, frames) = (rd(4), rd(8), rd(12));
    let mut chans = Vec::with_capacity(nch);
    for c in 0..nch {
        let s = 16 + c * frames * 4;
        chans.push(buf[s..s + frames * 4].chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect());
    }
    Ok((sr as f64, chans))
}

/// The app's defaultPoolSize(): max(1, min(8, cpus - 1)).
pub fn default_pool_size(cpus: usize) -> usize {
    (cpus.max(2) - 1).clamp(1, 8)
}

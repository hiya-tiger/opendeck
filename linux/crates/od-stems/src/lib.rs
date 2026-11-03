//! od-stems: progressive stem separation from the playhead (D40), off the
//! audio thread, behind the `StemEngine` trait.
//!
//! * `core` is a port of src/main/stems/core.ts (chunk plan, focus order,
//!   overlap windows, coverage), checked against TS vectors.
//! * `Scheduler` runs N worker threads, each owning one engine session, and
//!   always picks the chunk with the earliest playback deadline across all
//!   decks (playing decks first, nearest to the playhead), so four decks
//!   share the cores instead of one job at a time.
//! * `ort_engine` (feature "ort"): htdemucs through the `ort` crate with the
//!   same session options as the app (load-dynamic onnxruntime 1.20.1, the
//!   library onnxruntime-node ships, MIT).
pub mod core;
pub mod scheduler;
#[cfg(feature = "ort")]
pub mod ort_engine;

/// Four stems for one chunk, planar: [part][channel][frame].
pub type StemChunk = [[Vec<f32>; 2]; 4];

pub trait StemEngine: Send {
    fn name(&self) -> String;
    /// Separates one model chunk (stereo, 44.1 kHz, `core::MODEL_FRAME_COUNT` frames, zero-padded).
    fn separate(&mut self, left: &[f32], right: &[f32]) -> Result<StemChunk, String>;
}

/// A trivial engine for tests and for machines without the model: splits by
/// crossover bands (drums=highs, bass=lows, other=mids, vocals=centre mids).
/// It is NOT separation; it lets the pipeline, UI and benchmarks run.
pub struct BandSplitEngine;
impl StemEngine for BandSplitEngine {
    fn name(&self) -> String { "band-split (placeholder, not ML)".into() }
    fn separate(&mut self, l: &[f32], r: &[f32]) -> Result<StemChunk, String> {
        let n = l.len();
        let mut out: StemChunk = Default::default();
        for p in out.iter_mut() { for c in p.iter_mut() { *c = vec![0.0; n]; } }
        let (mut lo, mut hi) = ([0f32; 2], [0f32; 2]);
        for i in 0..n {
            for (c, x) in [l[i], r[i]].into_iter().enumerate() {
                lo[c] += (x - lo[c]) * 0.02;
                hi[c] = x - lo[c];
                let mid = hi[c] * 0.5;
                out[1][c][i] = lo[c];
                out[0][c][i] = hi[c] - mid;
                out[2][c][i] = mid * 0.5;
                out[3][c][i] = mid * 0.5;
            }
        }
        Ok(out)
    }
}

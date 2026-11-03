//! htdemucs through `ort` (MIT/Apache) with `load-dynamic`: the same
//! onnxruntime 1.20.1 library and session options as src/main/stems/core.ts
//! (CPU: graph optimisation disabled, sequential, mem pattern on, no arena).
use crate::{core::MODEL_FRAME_COUNT, StemChunk, StemEngine};
use ort::session::{builder::GraphOptimizationLevel, Session};

pub struct OrtEngine { session: Session, threads: usize }

impl OrtEngine {
    pub fn init_runtime(lib: &str) -> Result<(), String> { ort::init_from(lib).commit().map(|_| ()).map_err(|e| e.to_string()) }
    pub fn new(model: &str, threads: usize, optimize: bool) -> Result<Self, String> {
        let level = if optimize { GraphOptimizationLevel::Level3 } else { GraphOptimizationLevel::Disable };
        let s = Session::builder().and_then(|b| b.with_optimization_level(level)).and_then(|b| b.with_parallel_execution(false)).and_then(|b| b.with_memory_pattern(true)).and_then(|b| b.with_intra_threads(threads.max(1))).and_then(|b| b.commit_from_file(model)).map_err(|e| e.to_string())?;
        Ok(OrtEngine { session: s, threads })
    }
}
impl StemEngine for OrtEngine {
    fn name(&self) -> String { format!("onnxruntime (ort) cpu, {} threads", self.threads) }
    fn separate(&mut self, l: &[f32], r: &[f32]) -> Result<StemChunk, String> {
        let n = MODEL_FRAME_COUNT;
        let mut input = Vec::with_capacity(2 * n);
        input.extend_from_slice(&l[..n]); input.extend_from_slice(&r[..n]);
        let arr = ort::value::Tensor::from_array(([1usize, 2, n], input)).map_err(|e| e.to_string())?;
        let outs = self.session.run(ort::inputs![arr].map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let (_shape, data) = outs[0].try_extract_raw_tensor::<f32>().map_err(|e| e.to_string())?;
        let mut st: StemChunk = Default::default();
        for p in 0..4 { for c in 0..2 { let o = (p * 2 + c) * n; st[p][c] = data[o..o + n].to_vec(); } }
        Ok(st)
    }
}

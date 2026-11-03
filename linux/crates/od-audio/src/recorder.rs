//! Mix recorder: drains the engine's record ring to a 32-bit float WAV on its
//! own thread (the Electron app records webm/opus via MediaRecorder; WAV
//! keeps this dependency-free and lossless).
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub struct Recorder { pub stop: Arc<AtomicBool>, pub handle: Option<std::thread::JoinHandle<Result<u64, String>>>, pub path: PathBuf }

pub fn start(mut rx: rtrb::Consumer<f32>, sample_rate: u32, path: PathBuf) -> Recorder {
    let stop = Arc::new(AtomicBool::new(false));
    let s2 = stop.clone();
    let p2 = path.clone();
    let handle = std::thread::Builder::new().name("od-recorder".into()).spawn(move || {
        let spec = hound::WavSpec { channels: 2, sample_rate, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
        let mut w = hound::WavWriter::create(&p2, spec).map_err(|e| e.to_string())?;
        let mut n = 0u64;
        loop {
            let mut got = false;
            while let Ok(v) = rx.pop() { w.write_sample(v).map_err(|e| e.to_string())?; n += 1; got = true; }
            if s2.load(Ordering::Relaxed) && !got { break; }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        w.finalize().map_err(|e| e.to_string())?;
        Ok(n / 2)
    }).expect("recorder thread");
    Recorder { stop, handle: Some(handle), path }
}
impl Recorder {
    pub fn finish(mut self) -> Result<u64, String> { self.stop.store(true, Ordering::Relaxed); self.handle.take().unwrap().join().map_err(|_| "recorder panicked".to_string())? }
}

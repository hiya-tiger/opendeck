//! Audio output: cpal (ALSA, which PipeWire and PulseAudio serve through
//! their ALSA plugins; JACK with the `jack` feature), plus a paced "null"
//! driver for machines with no sound card (CI, xvfb) that keeps the same
//! callback deadline so CPU, late callbacks and allocation checks still mean
//! something.
use crate::engine::Engine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub enum Output { Cpal { _stream: cpal::Stream, _cue: Option<cpal::Stream>, desc: String }, Null { stop: Arc<AtomicBool>, handle: Option<std::thread::JoinHandle<()>>, desc: String } }

impl Output {
    pub fn describe(&self) -> &str { match self { Output::Cpal { desc, .. } | Output::Null { desc, .. } => desc } }
}
impl Drop for Output {
    fn drop(&mut self) { if let Output::Null { stop, handle, .. } = self { stop.store(true, Ordering::Relaxed); if let Some(h) = handle.take() { let _ = h.join(); } } }
}

pub struct OutputConfig { pub buffer_frames: u32, pub device: Option<String>, pub cue_device: Option<String>, pub force_null: bool, pub sample_rate: u32 }
impl Default for OutputConfig { fn default() -> Self { OutputConfig { buffer_frames: 256, device: None, cue_device: None, force_null: false, sample_rate: 48000 } } }

pub fn list_devices() -> Vec<String> {
    let mut v = vec![];
    for hid in cpal::available_hosts() {
        if let Ok(h) = cpal::host_from_id(hid) { if let Ok(ds) = h.output_devices() { for d in ds { if let Ok(n) = d.name() { v.push(format!("{}: {n}", hid.name())); } } } }
    }
    v
}

/// Starts the engine on the chosen output; falls back to the null driver when no device opens.
pub fn start(mut engine: Engine, cfg: &OutputConfig) -> Output {
    if !cfg.force_null {
        match open_cpal(&cfg.device, cfg.buffer_frames, cfg.sample_rate) {
            Ok((dev, sc)) => {
                let status = engine_status(&engine);
                let channels = sc.channels as usize;
                let st2 = status.clone();
                let err = move |e: cpal::StreamError| { if matches!(e, cpal::StreamError::BackendSpecific { .. }) { st2.xruns.fetch_add(1, Ordering::Relaxed); } };
                let desc = format!("{} · {} ch · {} Hz · buffer {:?}", dev.name().unwrap_or_default(), channels, sc.sample_rate.0, sc.buffer_size);
                match dev.build_output_stream(&sc, move |data: &mut [f32], _| { assert_no_alloc::assert_no_alloc(|| engine.process(data, channels, None)) }, err, None) {
                    Ok(stream) => { if stream.play().is_ok() { return Output::Cpal { _stream: stream, _cue: None, desc }; } }
                    Err(e) => eprintln!("od-audio: cpal stream failed ({e}); using the null driver"),
                }
                return start_null(None, cfg);
            }
            Err(e) => eprintln!("od-audio: no output device ({e}); using the null driver"),
        }
    }
    start_null(Some(engine), cfg)
}

fn engine_status(e: &Engine) -> Arc<crate::EngineStatus> { e.status() }

fn open_cpal(name: &Option<String>, frames: u32, sr: u32) -> Result<(cpal::Device, cpal::StreamConfig), String> {
    let host = cpal::default_host();
    let dev = match name {
        Some(n) => host.output_devices().map_err(|e| e.to_string())?.find(|d| d.name().map(|x| &x == n || n.ends_with(&x)).unwrap_or(false)).ok_or("device not found")?,
        None => host.default_output_device().ok_or("no default output device")?,
    };
    let def = dev.default_output_config().map_err(|e| e.to_string())?;
    let sc = cpal::StreamConfig { channels: def.channels(), sample_rate: cpal::SampleRate(sr), buffer_size: cpal::BufferSize::Fixed(frames) };
    Ok((dev, sc))
}

fn start_null(engine: Option<Engine>, cfg: &OutputConfig) -> Output {
    let stop = Arc::new(AtomicBool::new(false));
    let s2 = stop.clone();
    let frames = cfg.buffer_frames as usize;
    let sr = cfg.sample_rate;
    let desc = format!("null driver (no sound card) · 2 ch · {sr} Hz · buffer {frames}");
    let handle = engine.map(|mut engine| std::thread::Builder::new().name("od-audio-null".into()).spawn(move || {
        let mut buf = vec![0f32; frames * 2];
        let period = Duration::from_secs_f64(frames as f64 / sr as f64);
        let mut next = Instant::now() + period;
        while !s2.load(Ordering::Relaxed) {
            assert_no_alloc::assert_no_alloc(|| engine.process(&mut buf, 2, None));
            let now = Instant::now();
            if now > next + period { engine.status().xruns.fetch_add(1, Ordering::Relaxed); next = now + period; continue; }
            std::thread::sleep(next.saturating_duration_since(now));
            next += period;
        }
    }).expect("null audio thread"));
    Output::Null { stop, handle, desc }
}

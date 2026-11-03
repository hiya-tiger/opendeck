use crate::deck::{DeckVoice, MAX_BLOCK};
use crate::dsp::Limiter;
use crate::Pcm;
use od_core::fx::FxType;
use od_core::mixer::{channel_fader_gain, crossfader_gains, ChannelFaderCurve, CrossfaderAssign, CrossfaderCurve};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

pub const DECKS: usize = 4;
pub const SAMPLER_SLOTS: usize = 8;

pub enum Command {
    Load { deck: usize, pcm: Arc<Pcm>, bpm: f64 },
    Eject { deck: usize },
    Play { deck: usize, on: bool },
    Seek { deck: usize, seconds: f64 },
    Rate { deck: usize, rate: f64 },
    Pitch { deck: usize, semitones: f64 },
    Keylock { deck: usize, on: bool },
    Reverse { deck: usize, on: bool },
    Scan { deck: usize, speed: f64 },
    Censor { deck: usize, on: bool },
    Loop { deck: usize, start: f64, end: f64, on: bool },
    Eq { deck: usize, band: usize, db: f64 },
    Kill { deck: usize, band: usize, on: bool },
    Trim { deck: usize, gain: f32 },
    Fader { deck: usize, value: f32 },
    Pfl { deck: usize, on: bool },
    Fx { deck: usize, kind: FxType, division: &'static str, amount: f32, wet: f32 },
    Bpm { deck: usize, bpm: f64 },
    Crossfader { value: f64 },
    CrossCurve(CrossfaderCurve),
    CrossReverse(bool),
    FaderCurve(ChannelFaderCurve),
    Assign { deck: usize, assign: CrossfaderAssign },
    Master(f32),
    CueMix(f32),
    CueLevel(f32),
    SampleLoad { slot: usize, pcm: Arc<Pcm> },
    SampleTrigger { slot: usize, on: bool },
    SampleGain(f32),
    Record(bool),
}

/// Lock-free status the UI reads every frame.
pub struct DeckStatus { pub pos_bits: AtomicU64, pub playing: AtomicBool, pub peak_bits: AtomicU32, pub loaded: AtomicBool }
pub struct EngineStatus {
    pub decks: [DeckStatus; DECKS],
    pub master_peak_bits: AtomicU32,
    pub limiter_db_bits: AtomicU32,
    pub callbacks: AtomicU64,
    pub late_callbacks: AtomicU64,
    pub xruns: AtomicU64,
    pub dropped_record_frames: AtomicU64,
    pub max_callback_ns: AtomicU64,
    pub sample_rate: AtomicU32,
}
impl EngineStatus {
    fn new(sr: u32) -> Self {
        let d = || DeckStatus { pos_bits: AtomicU64::new(0), playing: AtomicBool::new(false), peak_bits: AtomicU32::new(0), loaded: AtomicBool::new(false) };
        EngineStatus { decks: [d(), d(), d(), d()], master_peak_bits: AtomicU32::new(0), limiter_db_bits: AtomicU32::new(0), callbacks: AtomicU64::new(0), late_callbacks: AtomicU64::new(0), xruns: AtomicU64::new(0), dropped_record_frames: AtomicU64::new(0), max_callback_ns: AtomicU64::new(0), sample_rate: AtomicU32::new(sr) }
    }
    pub fn position(&self, d: usize) -> f64 { f64::from_bits(self.decks[d].pos_bits.load(Ordering::Relaxed)) }
    pub fn playing(&self, d: usize) -> bool { self.decks[d].playing.load(Ordering::Relaxed) }
    pub fn peak(&self, d: usize) -> f32 { f32::from_bits(self.decks[d].peak_bits.load(Ordering::Relaxed)) }
    pub fn master_peak(&self) -> f32 { f32::from_bits(self.master_peak_bits.load(Ordering::Relaxed)) }
    pub fn limiter_db(&self) -> f32 { f32::from_bits(self.limiter_db_bits.load(Ordering::Relaxed)) }
}

struct SamplerVoice { pcm: Option<Arc<Pcm>>, pos: usize, playing: bool }

/// Audio-thread side. Owns every DSP object; created on the UI thread, then moved into the callback.
pub struct Engine {
    sr: f64,
    pub decks: [DeckVoice; DECKS],
    sampler: [SamplerVoice; SAMPLER_SLOTS],
    sampler_gain: f32,
    cmd: rtrb::Consumer<Command>,
    trash: rtrb::Producer<Arc<Pcm>>,
    rec: Option<rtrb::Producer<f32>>,
    recording: bool,
    status: Arc<EngineStatus>,
    master_buf: Vec<f32>,
    cue_buf: Vec<f32>,
    limiter: Limiter,
    cross: f64,
    curve: CrossfaderCurve,
    reversed: bool,
    fader_curve: ChannelFaderCurve,
    fader_raw: [f32; DECKS],
    assign: [CrossfaderAssign; DECKS],
    master_gain: f32,
    cue_mix: f32,
    cue_level: f32,
    meter_hold: u32,
}

/// UI-thread side.
pub struct Controller { tx: rtrb::Producer<Command>, trash: rtrb::Consumer<Arc<Pcm>>, pub status: Arc<EngineStatus>, pub rec: Option<rtrb::Consumer<f32>> }
impl Controller {
    pub fn send(&mut self, c: Command) -> bool { self.collect(); self.tx.push(c).is_ok() }
    /// Frees the buffers the audio thread released (call from the UI loop).
    pub fn collect(&mut self) { while let Ok(p) = self.trash.pop() { drop(p); } }
}

impl Engine {
    pub fn new(sample_rate: u32, with_recorder: bool) -> (Engine, Controller) {
        let sr = sample_rate as f64;
        let (tx, cmd) = rtrb::RingBuffer::new(1024);
        let (trash_tx, trash_rx) = rtrb::RingBuffer::new(256);
        let (rec_tx, rec_rx) = if with_recorder { let (a, b) = rtrb::RingBuffer::new(sample_rate as usize * 2 * 4); (Some(a), Some(b)) } else { (None, None) };
        let status = Arc::new(EngineStatus::new(sample_rate));
        let sv = || SamplerVoice { pcm: None, pos: 0, playing: false };
        let e = Engine {
            sr, decks: [DeckVoice::new(sr), DeckVoice::new(sr), DeckVoice::new(sr), DeckVoice::new(sr)],
            sampler: [sv(), sv(), sv(), sv(), sv(), sv(), sv(), sv()], sampler_gain: 0.8,
            cmd, trash: trash_tx, rec: rec_tx, recording: false, status: status.clone(),
            master_buf: vec![0.0; MAX_BLOCK * 2], cue_buf: vec![0.0; MAX_BLOCK * 2], limiter: Limiter::new(sr),
            cross: 0.5, curve: CrossfaderCurve::Smooth, reversed: false, fader_curve: ChannelFaderCurve::Linear, fader_raw: [0.85; DECKS],
            assign: [CrossfaderAssign::A, CrossfaderAssign::B, CrossfaderAssign::A, CrossfaderAssign::B],
            master_gain: 0.8, cue_mix: 0.5, cue_level: 0.8, meter_hold: 0,
        };
        let mut e = e;
        e.apply_cross();
        (e, Controller { tx, trash: trash_rx, status, rec: rec_rx })
    }
    pub fn sample_rate(&self) -> f64 { self.sr }
    pub fn status(&self) -> Arc<EngineStatus> { self.status.clone() }
    fn release(&mut self, p: Option<Arc<Pcm>>) { if let Some(p) = p { if let Err(rtrb::PushError::Full(p)) = self.trash.push(p) { std::mem::forget(p); } } }
    fn apply_cross(&mut self) {
        let (l, r) = crossfader_gains(self.cross, self.curve, self.reversed);
        for i in 0..DECKS {
            let g = match self.assign[i] { CrossfaderAssign::Thru => 1.0, CrossfaderAssign::A => l, CrossfaderAssign::B => r };
            self.decks[i].cross.target = g as f32;
            self.decks[i].fader.target = channel_fader_gain(self.fader_raw[i] as f64, self.fader_curve) as f32;
        }
    }
    fn handle(&mut self, c: Command) {
        let sr = self.sr;
        match c {
            Command::Load { deck, pcm, bpm } => { let old = self.decks[deck].eject(); self.release(old); self.decks[deck].pcm = Some(pcm); self.decks[deck].bpm = bpm; }
            Command::Eject { deck } => { let old = self.decks[deck].eject(); self.release(old); }
            Command::Play { deck, on } => self.decks[deck].playing = on && self.decks[deck].pcm.is_some(),
            Command::Seek { deck, seconds } => self.decks[deck].seek(seconds),
            Command::Rate { deck, rate } => self.decks[deck].rate = rate.clamp(0.0, 4.0),
            Command::Pitch { deck, semitones } => self.decks[deck].pitch_semis = semitones,
            Command::Keylock { deck, on } => self.decks[deck].keylock = on,
            Command::Reverse { deck, on } => self.decks[deck].reverse = on,
            Command::Scan { deck, speed } => self.decks[deck].scan = speed,
            Command::Censor { deck, on } => {
                let d = &mut self.decks[deck];
                if on { d.censor_from = Some(d.pos); d.censor_frames = 0.0; }
                else if let Some(from) = d.censor_from.take() { d.pos = from + d.censor_frames; }
            }
            Command::Loop { deck, start, end, on } => { let d = &mut self.decks[deck]; d.loop_start = start * sr; d.loop_end = end * sr; d.loop_on = on; }
            Command::Eq { deck, band, db } => { self.decks[deck].eq_db[band.min(2)] = db; self.decks[deck].apply_eq(); }
            Command::Kill { deck, band, on } => { self.decks[deck].eq_kill[band.min(2)] = on; self.decks[deck].apply_eq(); }
            Command::Trim { deck, gain } => self.decks[deck].trim.target = gain,
            Command::Fader { deck, value } => { self.fader_raw[deck] = value; self.apply_cross(); }
            Command::Pfl { deck, on } => self.decks[deck].pfl = on,
            Command::Fx { deck, kind, division, amount, wet } => self.decks[deck].fx.set(kind, division, amount, wet),
            Command::Bpm { deck, bpm } => self.decks[deck].bpm = bpm,
            Command::Crossfader { value } => { self.cross = value; self.apply_cross(); }
            Command::CrossCurve(c) => { self.curve = c; self.apply_cross(); }
            Command::CrossReverse(r) => { self.reversed = r; self.apply_cross(); }
            Command::FaderCurve(c) => { self.fader_curve = c; self.apply_cross(); }
            Command::Assign { deck, assign } => { self.assign[deck] = assign; self.apply_cross(); }
            Command::Master(g) => self.master_gain = g,
            Command::CueMix(m) => self.cue_mix = m.clamp(0.0, 1.0),
            Command::CueLevel(l) => self.cue_level = l,
            Command::SampleLoad { slot, pcm } => { let old = self.sampler[slot].pcm.replace(pcm); self.sampler[slot].playing = false; self.release(old); }
            Command::SampleTrigger { slot, on } => { let s = &mut self.sampler[slot]; s.playing = on && s.pcm.is_some(); s.pos = 0; }
            Command::SampleGain(g) => self.sampler_gain = g,
            Command::Record(on) => self.recording = on && self.rec.is_some(),
        }
    }

    /// Renders interleaved output. `channels` >= 4 puts the cue mix on 3-4
    /// (headphones on the same card); `cue_out` receives the cue mix for a
    /// second device. Real-time safe.
    pub fn process(&mut self, out: &mut [f32], channels: usize, mut cue_out: Option<&mut [f32]>) {
        let t0 = std::time::Instant::now();
        while let Ok(c) = self.cmd.pop() { self.handle(c); }
        let frames = out.len() / channels.max(1);
        let mut done = 0;
        while done < frames {
            let n = (frames - done).min(MAX_BLOCK);
            let (m, q) = (&mut self.master_buf[..n * 2], &mut self.cue_buf[..n * 2]);
            m.fill(0.0); q.fill(0.0);
            for d in self.decks.iter_mut() { d.render(m, q, n); }
            for s in self.sampler.iter_mut() {
                if !s.playing { continue; }
                let Some(p) = s.pcm.as_ref() else { continue };
                let (l, r) = p.chan();
                for k in 0..n { if s.pos >= l.len() { s.playing = false; break; } m[2 * k] += l[s.pos] * self.sampler_gain; m[2 * k + 1] += r[s.pos] * self.sampler_gain; s.pos += 1; }
            }
            let mut peak = 0f32;
            for k in 0..n {
                let s = self.limiter.tick([m[2 * k] * self.master_gain, m[2 * k + 1] * self.master_gain]);
                m[2 * k] = s[0]; m[2 * k + 1] = s[1];
                peak = peak.max(s[0].abs()).max(s[1].abs());
                // Headphone mix: cue_mix 0 = cue only, 1 = master only.
                q[2 * k] = (q[2 * k] * (1.0 - self.cue_mix) + s[0] * self.cue_mix) * self.cue_level;
                q[2 * k + 1] = (q[2 * k + 1] * (1.0 - self.cue_mix) + s[1] * self.cue_mix) * self.cue_level;
            }
            for k in 0..n {
                let o = &mut out[(done + k) * channels..(done + k + 1) * channels];
                o[0] = m[2 * k];
                if channels > 1 { o[1] = m[2 * k + 1]; }
                if channels >= 4 { o[2] = q[2 * k]; o[3] = q[2 * k + 1]; for x in o[4..].iter_mut() { *x = 0.0; } }
                else if channels > 2 { for x in o[2..].iter_mut() { *x = 0.0; } }
            }
            if let Some(c) = cue_out.as_deref_mut() { let len = (n * 2).min(c.len().saturating_sub(done * 2)); c[done * 2..done * 2 + len].copy_from_slice(&q[..len]); }
            if self.recording {
                if let Some(r) = self.rec.as_mut() {
                    if r.slots() >= n * 2 { for v in m.iter() { let _ = r.push(*v); } } else { self.status.dropped_record_frames.fetch_add(n as u64, Ordering::Relaxed); }
                }
            }
            let prev = f32::from_bits(self.status.master_peak_bits.load(Ordering::Relaxed));
            self.status.master_peak_bits.store((prev * 0.85).max(peak).to_bits(), Ordering::Relaxed);
            done += n;
        }
        self.limiter.update_meter();
        self.status.limiter_db_bits.store(self.limiter.reduction_db.to_bits(), Ordering::Relaxed);
        for (i, d) in self.decks.iter().enumerate() {
            let s = &self.status.decks[i];
            s.pos_bits.store((d.pos / self.sr).to_bits(), Ordering::Relaxed);
            s.playing.store(d.playing, Ordering::Relaxed);
            s.peak_bits.store(d.peak.to_bits(), Ordering::Relaxed);
            s.loaded.store(d.pcm.is_some(), Ordering::Relaxed);
        }
        let ns = t0.elapsed().as_nanos() as u64;
        self.status.callbacks.fetch_add(1, Ordering::Relaxed);
        self.status.max_callback_ns.fetch_max(ns, Ordering::Relaxed);
        let budget = (frames as f64 / self.sr * 1e9) as u64;
        if ns > budget { self.status.late_callbacks.fetch_add(1, Ordering::Relaxed); }
        let _ = self.meter_hold;
    }
}

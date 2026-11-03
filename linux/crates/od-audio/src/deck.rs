//! One deck's real-time voice: transport (rate, reverse, loops, scan,
//! censor), varispeed or key-locked playback (Signalsmith Stretch, the same
//! library and block/interval settings as pcm-source.ts STRETCH_CONFIG:
//! 120 ms blocks, 30 ms interval), trim, 3-band EQ (180 Hz low shelf, 1.2 kHz
//! peak Q 0.9, 6 kHz high shelf, kill = -60 dB as deck.ts), FX, fader.
use crate::dsp::{db_to_gain, Biquad, BiquadKind, Smooth};
use crate::fx::FxUnit;
use crate::Pcm;
use signalsmith_stretch::Stretch;
use std::sync::Arc;

pub const MAX_BLOCK: usize = 4096;

pub struct DeckVoice {
    sr: f64,
    pub pcm: Option<Arc<Pcm>>,
    pub pos: f64,
    pub playing: bool,
    pub rate: f64,
    pub pitch_semis: f64,
    pub keylock: bool,
    pub reverse: bool,
    pub scan: f64,
    pub loop_on: bool,
    pub loop_start: f64,
    pub loop_end: f64,
    pub censor_from: Option<f64>,
    pub censor_frames: f64,
    pub bpm: f64,
    pub trim: Smooth,
    pub fader: Smooth,
    pub cross: Smooth,
    pub eq_db: [f64; 3],
    pub eq_kill: [bool; 3],
    eq: [Biquad; 3],
    pub fx: FxUnit,
    pub pfl: bool,
    stretch: Stretch,
    st_in: Vec<f32>,
    st_out: Vec<f32>,
    pub peak: f32,
    stretch_primed: bool,
}

impl DeckVoice {
    pub fn new(sr: f64) -> Self {
        let block = (sr * 0.120) as usize;
        let interval = (sr * 0.030) as usize;
        let mut d = DeckVoice {
            sr, pcm: None, pos: 0.0, playing: false, rate: 1.0, pitch_semis: 0.0, keylock: true, reverse: false, scan: 0.0,
            loop_on: false, loop_start: 0.0, loop_end: 0.0, censor_from: None, censor_frames: 0.0, bpm: 0.0,
            trim: Smooth::new(1.0, sr, 10.0), fader: Smooth::new(0.85, sr, 10.0), cross: Smooth::new(std::f32::consts::FRAC_1_SQRT_2, sr, 10.0),
            eq_db: [0.0; 3], eq_kill: [false; 3], eq: [Biquad::default(); 3], fx: FxUnit::new(sr), pfl: false,
            stretch: Stretch::new(2, block, interval),
            st_in: vec![0.0; MAX_BLOCK * 2 * 4 + 16], st_out: vec![0.0; MAX_BLOCK * 2], peak: 0.0, stretch_primed: false,
        };
        d.apply_eq();
        d
    }
    pub fn apply_eq(&mut self) {
        let g = |i: usize, s: &Self| if s.eq_kill[i] { -60.0 } else { s.eq_db[i] };
        let (l, m, h) = (g(0, self), g(1, self), g(2, self));
        self.eq[0].set(BiquadKind::LowShelf, self.sr, 180.0, 0.0, l);
        self.eq[1].set(BiquadKind::Peaking, self.sr, 1200.0, 0.9, m);
        self.eq[2].set(BiquadKind::HighShelf, self.sr, 6000.0, 0.0, h);
    }
    pub fn duration(&self) -> f64 { self.pcm.as_ref().map(|p| p.frames() as f64 / self.sr).unwrap_or(0.0) }
    /// Full reset on eject (the Nov 1 "full eject reset" behaviour).
    pub fn eject(&mut self) -> Option<Arc<Pcm>> {
        self.playing = false; self.pos = 0.0; self.loop_on = false; self.reverse = false; self.scan = 0.0; self.censor_from = None; self.bpm = 0.0;
        self.fx.reset(); for e in self.eq.iter_mut() { e.reset(); } self.stretch.reset(); self.stretch_primed = false;
        self.pcm.take()
    }
    pub fn seek(&mut self, seconds: f64) { self.pos = (seconds * self.sr).clamp(0.0, self.pcm.as_ref().map(|p| p.frames() as f64).unwrap_or(0.0)); self.stretch_primed = false; }

    #[inline]
    fn sample(pcm: &Pcm, frame: f64) -> [f32; 2] {
        let n = pcm.frames();
        if frame < 0.0 || frame >= (n - 1) as f64 || n < 2 { return [0.0; 2]; }
        let i = frame as usize;
        let fr = (frame - i as f64) as f32;
        let (l, r) = pcm.chan();
        [l[i] + (l[i + 1] - l[i]) * fr, r[i] + (r[i + 1] - r[i]) * fr]
    }

    /// Effective transport speed in source frames per output frame.
    pub fn speed(&self) -> f64 {
        let base = if self.scan != 0.0 { self.scan } else { self.rate * self.fx.transport_rate() };
        if self.reverse || self.censor_from.is_some() { -base } else { base }
    }

    /// Renders `n` frames, ADDING into master and cue (when PFL). Allocation-free.
    pub fn render(&mut self, master: &mut [f32], cue: &mut [f32], n: usize) {
        let Some(pcm) = self.pcm.clone() else { return };
        // ^ Arc clone is a refcount increment, not an allocation.
        let total = pcm.frames() as f64;
        self.fx.bpm = if self.bpm > 0.0 { self.bpm * self.rate } else { 120.0 };
        let speed = if self.playing { self.speed() } else { 0.0 };
        let use_stretch = self.playing && self.keylock && self.scan == 0.0 && speed > 0.0 && (speed - 1.0).abs() > 1e-4 || (self.playing && self.pitch_semis != 0.0 && speed > 0.0);
        let n = n.min(MAX_BLOCK);
        if use_stretch {
            let in_frames = ((n as f64) * speed).round().max(1.0) as usize;
            let in_frames = in_frames.min(MAX_BLOCK * 4);
            for k in 0..in_frames {
                let mut f = self.pos + k as f64;
                if self.loop_on && self.loop_end > self.loop_start && f >= self.loop_end { f = self.loop_start + (f - self.loop_start) % (self.loop_end - self.loop_start); }
                let s = Self::sample(&pcm, f);
                self.st_in[2 * k] = s[0]; self.st_in[2 * k + 1] = s[1];
            }
            let ratio = if self.keylock { 1.0 } else { speed };
            self.stretch.set_transpose_factor((ratio * 2f64.powf(self.pitch_semis / 12.0)) as f32, None);
            self.stretch.process(&self.st_in[..in_frames * 2], &mut self.st_out[..n * 2]);
            self.stretch_primed = true;
            self.pos += in_frames as f64;
        } else {
            for k in 0..n {
                let s = if self.playing { Self::sample(&pcm, self.pos) } else { [0.0; 2] };
                self.st_out[2 * k] = s[0]; self.st_out[2 * k + 1] = s[1];
                self.pos += speed;
                if self.loop_on && self.loop_end > self.loop_start && speed > 0.0 && self.pos >= self.loop_end { self.pos = self.loop_start + (self.pos - self.loop_end); }
            }
        }
        if self.loop_on && self.loop_end > self.loop_start && self.pos >= self.loop_end { self.pos = self.loop_start + (self.pos - self.loop_end) % (self.loop_end - self.loop_start); }
        if self.censor_from.is_some() { self.censor_frames += n as f64 * self.rate; }
        if self.pos >= total { self.pos = total; self.playing = false; }
        if self.pos < 0.0 { self.pos = 0.0; if self.reverse { self.playing = false; } }
        let mut peak = 0f32;
        for k in 0..n {
            let t = self.trim.next();
            let mut s = [self.st_out[2 * k] * t, self.st_out[2 * k + 1] * t];
            for e in self.eq.iter_mut() { s = [e.tick(0, s[0]), e.tick(1, s[1])]; }
            s = self.fx.tick(s);
            let f = self.fader.next();
            let c = self.cross.next();
            peak = peak.max(s[0].abs()).max(s[1].abs());
            if self.pfl { cue[2 * k] += s[0] * f; cue[2 * k + 1] += s[1] * f; }
            master[2 * k] += s[0] * f * c;
            master[2 * k + 1] += s[1] * f * c;
        }
        self.peak = self.peak * 0.9 + peak * 0.1;
    }
}

pub fn trim_gain(trim_linear: f64, track_gain_db: f64) -> f64 { trim_linear * db_to_gain(track_gain_db.clamp(-24.0, 24.0)) }

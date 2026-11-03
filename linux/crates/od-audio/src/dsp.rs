//! Small real-time DSP blocks. Nothing here allocates after construction.
use std::f64::consts::PI;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BiquadKind { LowPass, HighPass, LowShelf, HighShelf, Peaking, AllPass }

/// RBJ cookbook biquad, the same formulas Web Audio's BiquadFilterNode uses
/// (shelves with S = 1, peaking/LP/HP with Q), per channel state for stereo.
#[derive(Clone, Copy, Debug)]
pub struct Biquad { b0: f64, b1: f64, b2: f64, a1: f64, a2: f64, z: [[f64; 2]; 2] }

impl Default for Biquad { fn default() -> Self { Biquad { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, z: [[0.0; 2]; 2] } } }

impl Biquad {
    pub fn set(&mut self, kind: BiquadKind, sr: f64, freq: f64, q: f64, gain_db: f64) {
        let f = freq.clamp(10.0, sr * 0.49);
        let w0 = 2.0 * PI * f / sr;
        let (cw, sw) = (w0.cos(), w0.sin());
        let a = 10f64.powf(gain_db / 40.0);
        let (b0, b1, b2, a0, a1, a2);
        match kind {
            BiquadKind::LowPass | BiquadKind::HighPass | BiquadKind::AllPass | BiquadKind::Peaking => {
                // Web Audio's lowpass/highpass Q is in dB; peaking/allpass Q is linear.
                let qq = match kind { BiquadKind::LowPass | BiquadKind::HighPass => 10f64.powf(q / 20.0), _ => q.max(1e-4) };
                let alpha = sw / (2.0 * qq);
                match kind {
                    BiquadKind::LowPass => { b0 = (1.0 - cw) / 2.0; b1 = 1.0 - cw; b2 = b0; a0 = 1.0 + alpha; a1 = -2.0 * cw; a2 = 1.0 - alpha; }
                    BiquadKind::HighPass => { b0 = (1.0 + cw) / 2.0; b1 = -(1.0 + cw); b2 = b0; a0 = 1.0 + alpha; a1 = -2.0 * cw; a2 = 1.0 - alpha; }
                    BiquadKind::AllPass => { b0 = 1.0 - alpha; b1 = -2.0 * cw; b2 = 1.0 + alpha; a0 = 1.0 + alpha; a1 = -2.0 * cw; a2 = 1.0 - alpha; }
                    _ => { b0 = 1.0 + alpha * a; b1 = -2.0 * cw; b2 = 1.0 - alpha * a; a0 = 1.0 + alpha / a; a1 = -2.0 * cw; a2 = 1.0 - alpha / a; }
                }
            }
            BiquadKind::LowShelf | BiquadKind::HighShelf => {
                let alpha = sw / 2.0 * 2f64.sqrt();
                let sa = 2.0 * a.sqrt() * alpha;
                if kind == BiquadKind::LowShelf {
                    b0 = a * ((a + 1.0) - (a - 1.0) * cw + sa); b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cw); b2 = a * ((a + 1.0) - (a - 1.0) * cw - sa);
                    a0 = (a + 1.0) + (a - 1.0) * cw + sa; a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cw); a2 = (a + 1.0) + (a - 1.0) * cw - sa;
                } else {
                    b0 = a * ((a + 1.0) + (a - 1.0) * cw + sa); b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cw); b2 = a * ((a + 1.0) + (a - 1.0) * cw - sa);
                    a0 = (a + 1.0) - (a - 1.0) * cw + sa; a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cw); a2 = (a + 1.0) - (a - 1.0) * cw - sa;
                }
            }
        }
        self.b0 = b0 / a0; self.b1 = b1 / a0; self.b2 = b2 / a0; self.a1 = a1 / a0; self.a2 = a2 / a0;
    }
    #[inline]
    pub fn tick(&mut self, ch: usize, x: f32) -> f32 {
        let x = x as f64;
        let z = &mut self.z[ch];
        let y = self.b0 * x + z[0];
        z[0] = self.b1 * x - self.a1 * y + z[1];
        z[1] = self.b2 * x - self.a2 * y;
        y as f32
    }
    pub fn reset(&mut self) { self.z = [[0.0; 2]; 2]; }
}

/// Stereo delay line with a fixed maximum length (allocated once).
pub struct DelayLine { buf: Vec<[f32; 2]>, w: usize }
impl DelayLine {
    pub fn new(max: usize) -> Self { DelayLine { buf: vec![[0.0; 2]; max.max(4)], w: 0 } }
    #[inline]
    pub fn read(&self, delay: f64) -> [f32; 2] {
        let n = self.buf.len();
        let d = delay.clamp(1.0, (n - 2) as f64);
        let i = d.floor() as usize;
        let fr = (d - i as f64) as f32;
        let a = self.buf[(self.w + n - i) % n];
        let b = self.buf[(self.w + n - i - 1) % n];
        [a[0] + (b[0] - a[0]) * fr, a[1] + (b[1] - a[1]) * fr]
    }
    #[inline]
    pub fn write(&mut self, v: [f32; 2]) { self.w = (self.w + 1) % self.buf.len(); self.buf[self.w] = v; }
    pub fn clear(&mut self) { for v in self.buf.iter_mut() { *v = [0.0; 2]; } }
}

/// One-pole smoother for click-free parameter changes.
#[derive(Clone, Copy, Debug)]
pub struct Smooth { pub v: f32, pub target: f32, k: f32 }
impl Smooth {
    pub fn new(v: f32, sr: f64, ms: f64) -> Self { Smooth { v, target: v, k: (1.0 - (-1.0 / (sr * ms / 1000.0)).exp()) as f32 } }
    #[inline] pub fn next(&mut self) -> f32 { self.v += (self.target - self.v) * self.k; self.v }
}

pub fn db_to_gain(db: f64) -> f64 { 10f64.powf(db / 20.0) }

/// Peak limiter standing in for the DynamicsCompressor the Electron master
/// uses (threshold -3 dB, attack 3 ms, release 250 ms). Reports gain reduction.
pub struct Limiter { env: f32, att: f32, rel: f32, thr: f32, pub reduction_db: f32 }
impl Limiter {
    pub fn new(sr: f64) -> Self { Limiter { env: 1.0, att: (1.0 - (-1.0 / (sr * 0.003)).exp()) as f32, rel: (1.0 - (-1.0 / (sr * 0.25)).exp()) as f32, thr: db_to_gain(-3.0) as f32, reduction_db: 0.0 } }
    #[inline]
    pub fn tick(&mut self, s: [f32; 2]) -> [f32; 2] {
        let peak = s[0].abs().max(s[1].abs());
        let want = if peak > self.thr { self.thr / peak } else { 1.0 };
        let k = if want < self.env { self.att } else { self.rel };
        self.env += (want - self.env) * k;
        [s[0] * self.env, s[1] * self.env]
    }
    pub fn update_meter(&mut self) { self.reduction_db = 20.0 * self.env.max(1e-6).log10(); }
}

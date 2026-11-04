//! One deck: PCM transport with tempo/key-lock through Signalsmith Stretch, jog wheel
//! (scratch / nudge / touch top / outer ring / vinyl mode), back-spin, vinyl brake.
//!
//! Two scratch routes are implemented so they can be measured side by side:
//! * `Route::Stretch` (the requested path): every block reads `|rate| * n` input frames in the
//!   direction of travel and hands them to Signalsmith Stretch with a transpose of `|rate|`
//!   while scratching (vinyl pitch) or 1.0 under key lock.
//! * `Route::Varispeed` (reference): a direct cubic-interpolated read head, zero added latency.
//!
//! The real-time path allocates nothing after `Deck::new` (buffers are sized for
//! `MAX_BLOCK` frames at `MAX_RATE`).

use std::f64::consts::TAU;
use std::sync::Arc;

use signalsmith_stretch::Stretch;

pub const MAX_BLOCK: usize = 4096;
pub const MAX_RATE: f64 = 8.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Stretch,
    Varispeed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JogZone {
    /// Touch-sensitive platter top.
    Top,
    /// Outer ring (never scratches; nudges / pitch-bends while playing, searches while paused).
    Ring,
}

#[derive(Clone, Copy, Debug)]
pub struct JogSettings {
    /// Vinyl mode on: touching the top holds the record and moving it scratches.
    /// Off: the top behaves like the ring (nudge only), as on CDJs with vinyl mode off.
    pub vinyl_mode: bool,
    /// One platter revolution = this many seconds of audio at 1x (33 1/3 rpm = 1.8 s).
    pub seconds_per_rev: f64,
    /// User sensitivity multiplier applied to every jog movement.
    pub sensitivity: f64,
    /// Pitch bend per (revolution / second) of ring speed.
    pub nudge_gain: f64,
    /// Largest bend (fraction of rate), e.g. 0.5 = +-50 %.
    pub nudge_max: f64,
    /// Scratch follower time constant (ms): position lag behind the hand.
    pub follow_ms: f64,
    /// Slip-mat time constant (ms) for the platter to return to motor speed after release.
    pub release_ms: f64,
    /// Motor start / brake (vinyl stop) times in ms.
    pub start_ms: f64,
    pub brake_ms: f64,
}

impl Default for JogSettings {
    fn default() -> Self {
        Self {
            vinyl_mode: true,
            seconds_per_rev: 1.8,
            sensitivity: 1.0,
            nudge_gain: 0.25,
            nudge_max: 0.5,
            follow_ms: 8.0,
            release_ms: 150.0,
            start_ms: 0.0,
            brake_ms: 600.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct BlockStats {
    pub rate_start: f64,
    pub rate_end: f64,
    pub input_frames: usize,
}

pub struct Deck {
    pcm: Arc<Vec<f32>>,
    frames: usize,
    sr: f64,
    pub pos: f64,
    pub playing: bool,
    pub tempo: f64,
    pub keylock: bool,
    pub route: Route,
    pub jog: JogSettings,
    motor: f64,
    touched: bool,
    scratching: bool,
    target: f64,
    target_s: f64,
    ring_pending: f64,
    bend: f64,
    rate: f64,
    released: bool,
    stretch: Stretch,
    inbuf: Vec<f32>,
    frac: f64,
    transpose: f32,
}

impl Deck {
    pub fn new(pcm: Arc<Vec<f32>>, sample_rate: u32, route: Route, cheaper: bool) -> Self {
        let frames = pcm.len() / 2;
        let stretch = if cheaper {
            Stretch::preset_cheaper(2, sample_rate)
        } else {
            Stretch::preset_default(2, sample_rate)
        };
        Self {
            pcm,
            frames,
            sr: sample_rate as f64,
            pos: 0.0,
            playing: false,
            tempo: 1.0,
            keylock: true,
            route,
            jog: JogSettings::default(),
            motor: 0.0,
            touched: false,
            scratching: false,
            target: 0.0,
            target_s: 0.0,
            ring_pending: 0.0,
            bend: 0.0,
            rate: 0.0,
            released: false,
            stretch,
            inbuf: vec![0.0; (MAX_BLOCK as f64 * MAX_RATE) as usize * 2 + 64],
            frac: 0.0,
            transpose: 1.0,
        }
    }

    pub fn frames(&self) -> usize {
        self.frames
    }
    pub fn rate(&self) -> f64 {
        self.rate
    }
    pub fn is_scratching(&self) -> bool {
        self.scratching
    }
    /// Added algorithmic latency of the stretch route in frames (input + output latency).
    pub fn stretch_latency(&self) -> usize {
        self.stretch.input_latency() + self.stretch.output_latency()
    }
    fn frames_per_rad(&self) -> f64 {
        self.sr * self.jog.seconds_per_rev / TAU
    }

    pub fn play(&mut self) {
        self.playing = true;
    }
    /// Motor off: with `brake_ms` > 0 this is the vinyl stop (rate ramps to 0).
    pub fn stop(&mut self) {
        self.playing = false;
    }
    pub fn seek(&mut self, frame: f64) {
        self.pos = frame.clamp(0.0, self.frames as f64);
        self.target = self.pos;
        self.target_s = self.pos;
        self.stretch.reset();
        self.frac = 0.0;
    }

    pub fn jog_touch(&mut self, down: bool) {
        self.touched = down;
        if down && self.jog.vinyl_mode {
            self.scratching = true;
            self.released = false;
            self.target = self.pos;
            self.target_s = self.pos;
        } else if !down && self.scratching {
            self.scratching = false;
            self.released = true;
        }
    }

    /// `radians` of platter movement (positive = forward). Mouse drag and MIDI both land here.
    pub fn jog_move(&mut self, zone: JogZone, radians: f64) {
        let r = radians * self.jog.sensitivity;
        let top_scratches = zone == JogZone::Top && self.jog.vinyl_mode && self.touched;
        if top_scratches || (!self.playing && self.motor.abs() < 1e-6) {
            if !self.scratching {
                // Paused search with the ring (or vinyl off): follow like a scratch but release at once.
                self.target = self.pos;
                self.target_s = self.pos;
                self.scratching = true;
                self.released = false;
                if !top_scratches {
                    self.touched = false;
                }
            }
            self.target += r * self.frames_per_rad();
        } else {
            self.ring_pending += r;
        }
    }

    /// Back-spin helper for tests: platter flung at `rate` and let go.
    pub fn fling(&mut self, rate: f64) {
        self.scratching = false;
        self.released = true;
        self.rate = rate.clamp(-MAX_RATE, MAX_RATE);
    }

    #[inline]
    fn step_rate(&mut self, a_target: f64, a_rate: f64, rate_target: f64) -> f64 {
        if self.scratching {
            self.target_s += (self.target - self.target_s) * a_target;
            let f = (self.jog.follow_ms * 1e-3 * self.sr).max(1.0);
            let want = ((self.target_s - self.pos) / f).clamp(-MAX_RATE, MAX_RATE);
            self.rate += (want - self.rate) * a_target;
        } else {
            self.rate += (rate_target - self.rate) * a_rate;
        }
        self.rate
    }

    /// Render `out.len() / 2` stereo frames.
    pub fn process(&mut self, out: &mut [f32]) -> BlockStats {
        let n = out.len() / 2;
        debug_assert!(n <= MAX_BLOCK);
        let dt = n as f64 / self.sr;
        // Motor (start ramp / vinyl brake ramp), per block.
        let motor_target = if self.playing { self.tempo } else { 0.0 };
        let ramp_ms = if self.playing { self.jog.start_ms } else { self.jog.brake_ms };
        if ramp_ms <= 0.0 {
            self.motor = motor_target;
        } else {
            let step = dt * 1000.0 / ramp_ms * self.tempo.max(1.0);
            self.motor += (motor_target - self.motor).clamp(-step, step);
        }
        // Ring nudge -> pitch bend (decays when the ring stops).
        let ring_rps = self.ring_pending / TAU / dt;
        self.ring_pending = 0.0;
        let bend_inst = (ring_rps * self.jog.nudge_gain).clamp(-self.jog.nudge_max, self.jog.nudge_max);
        let a_bend = 1.0 - (-dt / 0.03).exp();
        self.bend += (bend_inst - self.bend) * a_bend;
        let rate_target = self.motor * (1.0 + self.bend);
        // Per-sample smoothing coefficients.
        let a_target = 1.0 - (-1.0 / (self.jog.follow_ms * 1e-3 * self.sr * 0.5).max(1.0)).exp();
        let tau_rate = if self.released { self.jog.release_ms } else { 3.0 };
        let a_rate = 1.0 - (-1.0 / (tau_rate * 1e-3 * self.sr).max(1.0)).exp();
        if self.released && (self.rate - rate_target).abs() < 1e-3 {
            self.released = false;
        }
        if self.scratching && !self.touched && (self.target - self.pos).abs() < 0.5 && self.rate.abs() < 1e-3 {
            self.scratching = false; // paused search finished
        }
        let rate_start = self.rate;
        let mut input_frames = 0usize;
        match self.route {
            Route::Varispeed => {
                for i in 0..n {
                    let r = self.step_rate(a_target, a_rate, rate_target);
                    self.pos = (self.pos + r).clamp(0.0, self.frames as f64);
                    let (l, rr) = cubic(&self.pcm, self.frames, self.pos);
                    out[2 * i] = l;
                    out[2 * i + 1] = rr;
                }
            }
            Route::Stretch => {
                let p0 = self.pos;
                let mut sum = 0.0;
                for _ in 0..n {
                    sum += self.step_rate(a_target, a_rate, rate_target);
                }
                let mean = sum / n as f64;
                let want = sum.abs() + self.frac;
                let m = (want.floor() as usize).min(self.inbuf.len() / 2 - 1);
                self.frac = want - m as f64;
                let dir = if sum >= 0.0 { 1.0 } else { -1.0 };
                // Read m frames from p0 in the direction of travel (integer read head; the
                // fractional remainder carries to the next block).
                let base = p0.floor() as isize;
                for k in 0..m {
                    let idx = if dir > 0.0 { base + k as isize } else { base - 1 - k as isize };
                    let (l, r) = if idx >= 0 && (idx as usize) < self.frames {
                        let j = idx as usize * 2;
                        (self.pcm[j], self.pcm[j + 1])
                    } else {
                        (0.0, 0.0)
                    };
                    self.inbuf[2 * k] = l;
                    self.inbuf[2 * k + 1] = r;
                }
                let t = if self.scratching || self.released || !self.keylock {
                    mean.abs().clamp(0.0625, MAX_RATE) as f32
                } else {
                    1.0
                };
                if (t / self.transpose - 1.0).abs() > 0.001 {
                    self.stretch.set_transpose_factor(t, None);
                    self.transpose = t;
                }
                self.stretch.process(&self.inbuf[..m * 2], &mut out[..n * 2]);
                self.pos = (p0 + dir * m as f64).clamp(0.0, self.frames as f64);
                input_frames = m;
            }
        }
        BlockStats { rate_start, rate_end: self.rate, input_frames }
    }
}

#[inline]
fn at(pcm: &[f32], frames: usize, i: isize, c: usize) -> f32 {
    if i < 0 || i as usize >= frames {
        0.0
    } else {
        pcm[i as usize * 2 + c]
    }
}

/// Catmull-Rom cubic read of a stereo interleaved buffer at fractional frame `p`.
#[inline]
pub fn cubic(pcm: &[f32], frames: usize, p: f64) -> (f32, f32) {
    let i = p.floor() as isize;
    let t = (p - i as f64) as f32;
    let mut o = [0f32; 2];
    for (c, v) in o.iter_mut().enumerate() {
        let y0 = at(pcm, frames, i - 1, c);
        let y1 = at(pcm, frames, i, c);
        let y2 = at(pcm, frames, i + 1, c);
        let y3 = at(pcm, frames, i + 2, c);
        let a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
        let b = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
        let cc = -0.5 * y0 + 0.5 * y2;
        *v = ((a * t + b) * t + cc) * t + y1;
    }
    (o[0], o[1])
}

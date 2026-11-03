//! Per-deck FX unit: every effect in od_core::fx::FX_DEFS (fx.ts), as plain
//! DSP instead of Web Audio node graphs. Parameters follow the TS maths
//! (delaySeconds, filterFrequency, tremoloRateHz, tapeStopRate, crushCurve).
use crate::dsp::{Biquad, BiquadKind, DelayLine};
use od_core::fx::{self, FxType};

pub struct FxUnit {
    sr: f64,
    pub kind: FxType,
    pub division: &'static str,
    pub amount: f32,
    pub wet: f32,
    pub bpm: f64,
    delay: DelayLine,
    rev: [DelayLine; 4],
    filt: Biquad,
    tone: Biquad,
    stages: [Biquad; 4],
    phase: f64,
    hold: [f32; 2],
    hold_n: u32,
    tape: f64,
    fb: [f32; 2],
}

const REV_LENS: [f64; 4] = [0.0297, 0.0371, 0.0411, 0.0437];

impl FxUnit {
    pub fn new(sr: f64) -> Self {
        let max = (sr * 8.5) as usize;
        let rev = REV_LENS.map(|l| DelayLine::new((sr * l * 2.5) as usize + 8));
        FxUnit { sr, kind: FxType::Off, division: "1/4", amount: 0.0, wet: 0.0, bpm: 120.0, delay: DelayLine::new(max), rev, filt: Biquad::default(), tone: Biquad::default(), stages: [Biquad::default(); 4], phase: 0.0, hold: [0.0; 2], hold_n: 0, tape: 1.0, fb: [0.0; 2] }
    }
    pub fn set(&mut self, kind: FxType, division: &'static str, amount: f32, wet: f32) {
        if kind != self.kind { self.delay.clear(); for r in self.rev.iter_mut() { r.clear(); } self.filt.reset(); self.tape = 1.0; self.phase = 0.0; }
        self.kind = kind; self.division = division; self.amount = amount; self.wet = fx::wet_gain(wet as f64) as f32;
        let sr = self.sr;
        match kind {
            FxType::Filter => {
                let a = (amount as f64) * 2.0 - 1.0; // knob 0..1 -> bipolar
                self.filt.set(if fx::filter_is_lowpass(-a) { BiquadKind::LowPass } else { BiquadKind::HighPass }, sr, fx::filter_frequency(-a), 0.9, 0.0);
            }
            FxType::ComboFilterEcho => { self.filt.set(BiquadKind::LowPass, sr, 8000.0 * (0.2 + amount as f64), 2.2, 0.0); self.tone.set(BiquadKind::LowPass, sr, 3800.0, 0.0, 0.0); }
            FxType::Echo | FxType::Delay => self.tone.set(BiquadKind::LowPass, sr, 4200.0, 0.0, 0.0),
            FxType::Reverb => self.tone.set(BiquadKind::LowPass, sr, 9000.0, 0.0, 0.0),
            _ => {}
        }
    }
    pub fn reset(&mut self) { self.delay.clear(); for r in self.rev.iter_mut() { r.clear(); } self.filt.reset(); self.tape = 1.0; }
    /// Rate multiplier the deck applies for tape-stop / brake (1 = normal).
    pub fn transport_rate(&self) -> f64 { match self.kind { FxType::TapeStop | FxType::TapeStopQuick | FxType::Brake if self.wet > 0.0 => self.tape, _ => 1.0 } }

    #[inline]
    pub fn tick(&mut self, x: [f32; 2]) -> [f32; 2] {
        let sr = self.sr;
        let wet = self.wet;
        let amt = self.amount;
        let beat = fx::delay_seconds(self.division, self.bpm);
        let mix = |d: [f32; 2], w: [f32; 2]| [d[0] * (1.0 - wet) + w[0] * wet, d[1] * (1.0 - wet) + w[1] * wet];
        match self.kind {
            FxType::Off => x,
            FxType::Echo | FxType::ComboFilterEcho => {
                let src = if self.kind == FxType::ComboFilterEcho { [self.filt.tick(0, x[0]), self.filt.tick(1, x[1])] } else { x };
                let d = self.delay.read(beat * sr);
                let fbk = 0.25 + 0.6 * amt;
                let t = [self.tone.tick(0, d[0]), self.tone.tick(1, d[1])];
                self.delay.write([src[0] + t[0] * fbk, src[1] + t[1] * fbk]);
                [x[0] + d[0] * wet, x[1] + d[1] * wet]
            }
            FxType::Delay => {
                let d = self.delay.read(beat * sr);
                let fbk = 0.2 + 0.6 * amt;
                let t = [self.tone.tick(0, d[1]), self.tone.tick(1, d[0])]; // ping-pong: cross the channels
                self.delay.write([x[0] + t[0] * fbk, (x[1] * 0.0) + t[1] * fbk]);
                [x[0] + d[0] * wet, x[1] + d[1] * wet]
            }
            FxType::Reverb => {
                let size = 0.5 + amt as f64;
                let mut acc = [0.0f32; 2];
                let input = (x[0] + x[1]) * 0.5;
                for (i, r) in self.rev.iter_mut().enumerate() {
                    let o = r.read(REV_LENS[i] * size * sr);
                    let g = 0.72 + 0.2 * amt;
                    r.write([input + o[1] * g, input + o[0] * g]);
                    acc[0] += o[0]; acc[1] += o[1];
                }
                let w = [self.tone.tick(0, acc[0] * 0.25), self.tone.tick(1, acc[1] * 0.25)];
                [x[0] + w[0] * wet, x[1] + w[1] * wet]
            }
            FxType::Filter => { let w = [self.filt.tick(0, x[0]), self.filt.tick(1, x[1])]; mix(x, w) }
            FxType::Flanger => {
                self.phase = (self.phase + 1.0 / (beat * 4.0 * sr).max(1.0)) % 1.0;
                let lfo = (self.phase * std::f64::consts::TAU).sin() * 0.5 + 0.5;
                let d = self.delay.read((0.001 + 0.004 * lfo) * sr);
                self.delay.write([x[0] + d[0] * 0.5 * amt, x[1] + d[1] * 0.5 * amt]);
                mix(x, [(x[0] + d[0]) * 0.7, (x[1] + d[1]) * 0.7])
            }
            FxType::Phaser => {
                self.phase = (self.phase + 0.16 / sr) % 1.0;
                if self.hold_n == 0 {
                    let lfo = (self.phase * std::f64::consts::TAU).sin();
                    for (i, s) in self.stages.iter_mut().enumerate() { s.set(BiquadKind::AllPass, sr, (320.0 + i as f64 * 420.0 + lfo * 700.0 * amt as f64).max(40.0), 0.5, 0.0); }
                    self.hold_n = 64;
                }
                self.hold_n -= 1;
                let mut y = [x[0] + self.fb[0] * 0.35, x[1] + self.fb[1] * 0.35];
                for s in self.stages.iter_mut() { y = [s.tick(0, y[0]), s.tick(1, y[1])]; }
                self.fb = y;
                mix(x, y)
            }
            FxType::Crush => {
                let steps = 2f32.max((256.0 - amt * 248.0).round());
                let hold = 1 + (amt * 15.0) as u32;
                if self.hold_n == 0 { self.hold = [(x[0] * steps).round() / steps, (x[1] * steps).round() / steps]; self.hold_n = hold; }
                self.hold_n -= 1;
                mix(x, self.hold)
            }
            FxType::Autopan | FxType::Tremolo | FxType::Gate => {
                let hz = fx::tremolo_rate_hz(self.division, self.bpm);
                self.phase = (self.phase + hz / sr) % 1.0;
                let s = (self.phase * std::f64::consts::TAU).sin() as f32;
                match self.kind {
                    FxType::Autopan => { let p = s * amt; mix(x, [x[0] * (1.0 - p).min(1.0), x[1] * (1.0 + p).min(1.0)]) }
                    FxType::Tremolo => { let g = 1.0 - amt * 0.5 * (1.0 - s); mix(x, [x[0] * g, x[1] * g]) }
                    _ => { let open = self.phase < (1.0 - amt as f64 * 0.8).max(0.15); let g = if open { 1.0 } else { 0.0 }; mix(x, [x[0] * g, x[1] * g]) }
                }
            }
            FxType::TapeStop | FxType::TapeStopQuick | FxType::Brake => {
                // Slows the deck's transport (transport_rate) toward the TS tapeStopRate floor.
                let secs = match self.kind { FxType::TapeStopQuick => 0.35, FxType::Brake => beat, _ => 0.4 + 1.6 * amt as f64 };
                let floor = if self.kind == FxType::Brake { 0.0 } else { fx::tape_stop_rate(amt as f64) * 0.0 };
                if wet > 0.0 { self.tape = (self.tape - 1.0 / (secs * sr)).max(floor); }
                x
            }
        }
    }
}

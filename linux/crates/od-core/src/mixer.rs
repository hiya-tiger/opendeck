//! Port of the pure maths in src/renderer/engine/mixer.ts.
use std::f64::consts::PI;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CrossfaderCurve { #[default] Smooth, Fast, Cut }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ChannelFaderCurve { #[default] Linear, Log, Sharp }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrossfaderAssign { A, B, Thru }

impl CrossfaderCurve {
    pub fn parse(s: &str) -> Self { match s { "fast" => Self::Fast, "cut" => Self::Cut, _ => Self::Smooth } }
    pub fn name(self) -> &'static str { match self { Self::Smooth => "smooth", Self::Fast => "fast", Self::Cut => "cut" } }
}
impl ChannelFaderCurve {
    pub fn parse(s: &str) -> Self { match s { "log" | "logarithmic" => Self::Log, "sharp" => Self::Sharp, _ => Self::Linear } }
    pub fn name(self) -> &'static str { match self { Self::Linear => "linear", Self::Log => "log", Self::Sharp => "sharp" } }
}

/// Returns (left, right); decks C/D take the same gains as A/B.
pub fn crossfader_gains(value: f64, curve: CrossfaderCurve, reversed: bool) -> (f64, f64) {
    let raw = value.clamp(0.0, 1.0);
    let x = if reversed { 1.0 - raw } else { raw };
    let (mut left, mut right);
    match curve {
        CrossfaderCurve::Cut => {
            left = if x <= 0.92 { 1.0 } else { 0.0 };
            right = if x >= 0.08 { 1.0 } else { 0.0 };
            if value < 0.5 && !reversed { right = 0.0; }
            else if value >= 0.5 && !reversed { left = 0.0; }
            else if reversed {
                left = if x < 0.5 { 1.0 } else { 0.0 };
                right = if x < 0.5 { 0.0 } else { 1.0 };
            }
        }
        CrossfaderCurve::Fast => { left = (1.0 - x).powi(2); right = x.powi(2); }
        CrossfaderCurve::Smooth => { left = (x * PI / 2.0).cos(); right = (x * PI / 2.0).sin(); }
    }
    (left, right)
}

pub fn channel_fader_gain(value: f64, curve: ChannelFaderCurve) -> f64 {
    let x = value.clamp(0.0, 1.0);
    match curve {
        ChannelFaderCurve::Log => x.powf(2.2),
        ChannelFaderCurve::Sharp => if x > 0.05 { x.powf(0.55) } else { (x / 0.05) * 0.05f64.powf(0.55) },
        ChannelFaderCurve::Linear => x,
    }
}

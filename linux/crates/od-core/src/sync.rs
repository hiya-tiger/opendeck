//! Port of src/renderer/engine/sync.ts.
use crate::beatgrid::{beat_seconds, wrap_beat_phase};

#[derive(Debug, Clone, Copy, Default)]
pub struct SyncInput {
    pub master_bpm: f64,
    pub target_bpm: f64,
    pub master_position: f64,
    pub target_position: f64,
    pub target_phase: f64,
    pub master_phase: f64,
    pub max_tempo_percent: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SyncResult {
    pub rate: f64,
    pub tempo_percent: f64,
    pub phase_error_seconds: f64,
    pub seek_to: f64,
    pub clamped: bool,
}

pub fn sync_rate(master_bpm: f64, target_bpm: f64, max_tempo_percent: f64) -> f64 {
    if master_bpm <= 0.0 || target_bpm <= 0.0 { return 1.0; }
    let rate = master_bpm / target_bpm;
    let limit = 1.0 + max_tempo_percent / 100.0;
    (1.0 / limit).max(limit.min(rate))
}

pub fn sync_deck(i: SyncInput) -> SyncResult {
    let max = i.max_tempo_percent.unwrap_or(50.0);
    let rate = sync_rate(i.master_bpm, i.target_bpm, max);
    let _beats = beat_seconds(i.master_bpm);
    let phase_error = wrap_beat_phase(i.target_position - i.master_position + i.target_phase - i.master_phase, i.master_bpm);
    SyncResult {
        rate,
        tempo_percent: (rate - 1.0) * 100.0,
        phase_error_seconds: phase_error,
        seek_to: i.target_position - phase_error,
        clamped: (rate - i.master_bpm / i.target_bpm.max(1e-6)).abs() > 1e-6,
    }
}

pub fn nudge_toward_phase(master_bpm: f64, master_position: f64, target_position: f64, max_nudge: f64) -> f64 {
    let error = wrap_beat_phase(target_position - master_position, master_bpm);
    (-max_nudge).max(max_nudge.min(-error * 0.25))
}

pub fn tempo_percent_label(percent: f64, digits: usize) -> String {
    format!("{}{}%", if percent >= 0.0 { "+" } else { "" }, js_to_fixed(percent, digits))
}

/// Number.prototype.toFixed: rounds the exact binary value half away from zero.
pub fn js_to_fixed(x: f64, digits: usize) -> String {
    let neg = x < 0.0;
    let exact = format!("{:.*}", digits + 40, x.abs());
    let (int, frac) = exact.split_once('.').unwrap();
    let mut keep: Vec<u8> = format!("{int}{}", &frac[..digits]).into_bytes();
    if frac.as_bytes()[digits] >= b'5' {
        let mut i = keep.len();
        loop {
            if i == 0 { keep.insert(0, b'1'); break; }
            i -= 1;
            if keep[i] == b'9' { keep[i] = b'0'; } else { keep[i] += 1; break; }
        }
    }
    let s = String::from_utf8(keep).unwrap();
    let (a, b) = s.split_at(s.len() - digits);
    let body = if digits == 0 { a.to_string() } else { format!("{a}.{b}") };
    let zero = body.bytes().all(|c| c == b'0' || c == b'.');
    if neg && !zero { format!("-{body}") } else { body }
}

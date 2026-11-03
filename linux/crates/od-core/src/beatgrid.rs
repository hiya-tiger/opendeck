//! Port of src/renderer/engine/beatgrid.ts (timing helpers).
pub const BEATS_PER_BAR: f64 = 4.0;
pub const LOOP_BEATS: [f64; 9] = [0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0];

pub fn beat_seconds(bpm: f64) -> f64 {
    if bpm > 0.0 { 60.0 / bpm } else { 0.5 }
}
pub fn bar_seconds(bpm: f64) -> f64 {
    beat_seconds(bpm) * BEATS_PER_BAR
}
pub fn loop_seconds(bpm: f64, beats: f64) -> f64 {
    if bpm > 0.0 { beat_seconds(bpm) * beats } else { 0.5 * beats }
}
pub fn beat_index_at(time: f64, bpm: f64) -> f64 {
    if bpm <= 0.0 { time / 0.5 } else { time / beat_seconds(bpm) }
}
/// JS Math.round (ties toward +inf).
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}
pub fn snap_to_beat(time: f64, bpm: f64) -> f64 {
    if bpm <= 0.0 { return time; }
    let beat = beat_seconds(bpm);
    js_round(time / beat) * beat
}
pub fn beat_jump_target(time: f64, bpm: f64, beats: f64, duration: f64) -> f64 {
    let next = time + beat_seconds(bpm) * beats;
    let hi = if duration > 0.0 { duration - 0.01 } else { 0.0 };
    0f64.max(hi.min(next))
}
/// JS `%` is fmod (sign of the dividend), which Rust's `%` on f64 also is.
pub fn wrap_beat_phase(delta_seconds: f64, bpm: f64) -> f64 {
    let beat = beat_seconds(bpm);
    if beat <= 0.0 { return delta_seconds; }
    let mut d = delta_seconds % beat;
    if d > beat / 2.0 { d -= beat; }
    if d < -beat / 2.0 { d += beat; }
    d
}
pub fn nearest_beat(time: f64, bpm: f64, phase: f64) -> f64 {
    let beat = beat_seconds(bpm);
    if beat <= 0.0 { return time; }
    js_round((time - phase) / beat) * beat + phase
}
pub fn format_beat_position(time: f64, bpm: f64, phase: f64) -> String {
    if bpm <= 0.0 { return "--".into(); }
    let beat = beat_seconds(bpm);
    let index = 0f64.max((time - phase) / beat);
    let bar = (index / BEATS_PER_BAR).floor() + 1.0;
    let in_bar = (index % BEATS_PER_BAR).floor() + 1.0;
    let fraction = ((index % 1.0) * 4.0).floor() + 1.0;
    format!("{}.{}.{}", bar as i64, in_bar as i64, fraction as i64)
}

//! Port of src/renderer/engine/pad-modes.ts.
pub struct PadModeDef { pub id: &'static str, pub label: &'static str, pub hint: &'static str }
pub const PAD_MODE_DEFS: [PadModeDef; 10] = [
    PadModeDef { id: "hot-cue", label: "Hot Cue", hint: "Jump or set eight cues." },
    PadModeDef { id: "cue-loop", label: "Cue Loop", hint: "Cue plus a four-beat loop." },
    PadModeDef { id: "loop-roll", label: "Loop Roll", hint: "Hold a pad for a rolling loop." },
    PadModeDef { id: "slicer", label: "Slicer", hint: "Hold to loop one slice of the track." },
    PadModeDef { id: "beat-jump", label: "Beat Jump", hint: "Jump by musical lengths." },
    PadModeDef { id: "transport", label: "Transport", hint: "Play, cue, sync, loop and reverse." },
    PadModeDef { id: "pitch-play", label: "Pitch Play", hint: "Hold a cue at a new pitch." },
    PadModeDef { id: "scratch", label: "Scratch", hint: "Load a track into a pad and scratch it." },
    PadModeDef { id: "sequence", label: "Sequence", hint: "Record and loop pad actions." },
    PadModeDef { id: "part-fx", label: "Part FX", hint: "Filter or mute drums, bass, other or vocals." },
];
pub const LOOP_ROLL_BEATS: [f64; 8] = [0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0];
pub const BEAT_JUMP_STEPS: [f64; 8] = [-16.0, -8.0, -4.0, -1.0, 1.0, 4.0, 8.0, 16.0];
pub const PITCH_PLAY_SEMITONES: [f64; 8] = [-7.0, -5.0, -3.0, -2.0, 2.0, 3.0, 5.0, 7.0];
pub const PART_FX_PADS: [&str; 8] = ["filter-drums", "filter-bass", "filter-other", "filter-vocals", "mute-drums", "mute-bass", "mute-other", "mute-vocals"];

fn slot(index: f64) -> usize { index.floor().clamp(0.0, 7.0) as usize }
pub fn is_pad_mode(v: &str) -> bool { PAD_MODE_DEFS.iter().any(|m| m.id == v) }
pub fn loop_roll_beats(index: f64) -> f64 { LOOP_ROLL_BEATS[slot(index)] }
pub fn beat_jump_step(index: f64) -> f64 { BEAT_JUMP_STEPS[slot(index)] }
pub fn pitch_play_semitones(index: f64) -> f64 { PITCH_PLAY_SEMITONES[slot(index)] }
pub fn pitch_play_rate(index: f64) -> f64 { 2f64.powf(pitch_play_semitones(index) / 12.0) }
pub fn slice_range(index: f64, duration: f64) -> (f64, f64) {
    let d = if duration.is_finite() { duration.max(0.0) } else { 0.0 };
    let s = index.floor().clamp(0.0, 7.0);
    (d * (s / 8.0), d * ((s + 1.0) / 8.0))
}
pub fn rolling_release_position(start_position: f64, started_at_ms: f64, released_at_ms: f64, rate: f64, duration: f64) -> f64 {
    let elapsed = (released_at_ms - started_at_ms).max(0.0) / 1000.0;
    let target = start_position + elapsed * rate;
    let limit = if duration > 0.0 { duration - 0.02 } else { 0.0 };
    0f64.max(limit.min(target))
}

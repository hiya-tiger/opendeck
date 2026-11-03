//! Port of src/renderer/engine/fx.ts (FX catalogue and parameter maths).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum FxType {
    #[default]
    Off, Echo, Delay, Reverb, Filter, Flanger, Phaser, Crush, Autopan, Tremolo, Gate, TapeStop, TapeStopQuick, Brake, ComboFilterEcho,
}

pub struct FxDef { pub id: FxType, pub key: &'static str, pub label: &'static str, pub beat_synced: bool, pub hint: &'static str }

pub const FX_DEFS: &[FxDef] = &[
    FxDef { id: FxType::Off, key: "off", label: "Off", beat_synced: false, hint: "dry signal" },
    FxDef { id: FxType::Echo, key: "echo", label: "Echo", beat_synced: true, hint: "beat-synced feedback delay" },
    FxDef { id: FxType::Delay, key: "delay", label: "Delay", beat_synced: true, hint: "ping-pong delay" },
    FxDef { id: FxType::Reverb, key: "reverb", label: "Reverb", beat_synced: false, hint: "generated room impulse" },
    FxDef { id: FxType::Filter, key: "filter", label: "Filter", beat_synced: false, hint: "bipolar sweep, LP to HP" },
    FxDef { id: FxType::Flanger, key: "flanger", label: "Flanger", beat_synced: true, hint: "modulated comb" },
    FxDef { id: FxType::Phaser, key: "phaser", label: "Phaser", beat_synced: false, hint: "all-pass sweep" },
    FxDef { id: FxType::Crush, key: "crush", label: "Crush", beat_synced: false, hint: "bit and rate reduction" },
    FxDef { id: FxType::Autopan, key: "autopan", label: "Auto Pan", beat_synced: true, hint: "beat-synced stereo panner" },
    FxDef { id: FxType::Tremolo, key: "tremolo", label: "Tremolo", beat_synced: true, hint: "beat-synced amplitude LFO" },
    FxDef { id: FxType::Gate, key: "gate", label: "Trance Gate", beat_synced: true, hint: "rhythmic chopper gate" },
    FxDef { id: FxType::TapeStop, key: "tape-stop", label: "Tape Stop", beat_synced: false, hint: "turntable power-down sweep" },
    FxDef { id: FxType::TapeStopQuick, key: "tapestop", label: "Tape Stop (Quick)", beat_synced: false, hint: "turntable power-down sweep" },
    FxDef { id: FxType::Brake, key: "brake", label: "Vinyl Brake", beat_synced: true, hint: "timed platter brake" },
    FxDef { id: FxType::ComboFilterEcho, key: "combo-filter-echo", label: "Filter Echo", beat_synced: true, hint: "resonant filter into dub echo" },
];

impl FxType {
    pub fn def(self) -> &'static FxDef { FX_DEFS.iter().find(|d| d.id == self).unwrap() }
    pub fn key(self) -> &'static str { self.def().key }
    pub fn label(self) -> &'static str { self.def().label }
    pub fn parse(s: &str) -> Option<Self> { FX_DEFS.iter().find(|d| d.key == s).map(|d| d.id) }
}

pub const DIVISIONS: [&str; 8] = ["1/16", "1/8", "1/4", "3/8", "1/2", "1", "2", "4"];
const DIVISION_BEATS: [f64; 8] = [0.25, 0.5, 1.0, 1.5, 2.0, 4.0, 8.0, 16.0];

pub fn division_beats(division: &str) -> f64 {
    DIVISIONS.iter().position(|d| *d == division).map(|i| DIVISION_BEATS[i]).unwrap_or(1.0)
}
pub fn delay_seconds(division: &str, bpm: f64) -> f64 { (60.0 / bpm.max(1.0)) * division_beats(division) }
pub fn filter_frequency(amount: f64) -> f64 {
    let c = amount.clamp(-1.0, 1.0);
    let hz = 180.0 * (20000.0f64 / 180.0).powf((c + 1.0) / 2.0);
    hz.clamp(60.0, 19000.0)
}
/// true = lowpass, false = highpass (filterType()).
pub fn filter_is_lowpass(amount: f64) -> bool { amount >= 0.0 }
/// crushCurve(): the 1024-point WaveShaper curve.
pub fn crush_curve(amount: f64) -> Vec<f32> {
    let steps = 2f64.max(crate::beatgrid::js_round(256.0 - amount * 248.0));
    (0..1024).map(|i| { let x = (i as f64 / 1023.0) * 2.0 - 1.0; (crate::beatgrid::js_round(x * steps) / steps) as f32 }).collect()
}
pub fn wet_gain(amount: f64) -> f64 { amount.clamp(0.0, 1.0) }
pub fn tremolo_rate_hz(division: &str, bpm: f64) -> f64 {
    let sec = delay_seconds(division, bpm);
    if sec > 0.0 { (1.0 / sec).clamp(0.25, 32.0) } else { 4.0 }
}
pub fn tape_stop_rate(amount: f64) -> f64 {
    let c = amount.clamp(0.0, 1.0);
    0.05f64.max(1.0 - c.powf(1.5) * 0.95)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FxParams { pub division: &'static str, pub amount: f64, pub wet: f64 }

pub fn fx_default(t: FxType) -> FxParams {
    let p = |division, amount, wet| FxParams { division, amount, wet };
    match t {
        FxType::Echo => p("1/4", 0.4, 0.55),
        FxType::Delay => p("1/8", 0.35, 0.5),
        FxType::Reverb => p("1/4", 0.5, 0.4),
        FxType::Filter => p("1/4", 0.6, 1.0),
        FxType::Flanger => p("1/8", 0.4, 0.6),
        FxType::Phaser => p("1/4", 0.5, 0.6),
        FxType::Crush => p("1/16", 0.35, 0.25),
        FxType::Tremolo => p("1/8", 0.65, 0.8),
        FxType::Gate => p("1/16", 0.75, 0.9),
        FxType::Autopan => p("1/4", 0.6, 0.8),
        FxType::TapeStop | FxType::TapeStopQuick => p("1/2", 0.5, 1.0),
        FxType::Brake => p("1", 0.6, 1.0),
        FxType::ComboFilterEcho => p("1/4", 0.55, 0.75),
        FxType::Off => p("1/4", 0.0, 0.0),
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CustomFxSlot { pub fx: FxType, pub division: &'static str, pub amount: f64, pub wet: f64, pub enabled: bool }
#[derive(Debug, Clone, PartialEq)]
pub struct CustomFxPreset { pub id: String, pub name: String, pub slots: Vec<CustomFxSlot> }

pub fn default_custom_presets() -> Vec<CustomFxPreset> {
    let s = |fx, division, amount, wet| CustomFxSlot { fx, division, amount, wet, enabled: true };
    vec![
        CustomFxPreset { id: "dub-riser".into(), name: "Dub Filter Echo".into(), slots: vec![s(FxType::Filter, "1/4", 0.65, 0.85), s(FxType::Echo, "3/8", 0.5, 0.6), s(FxType::Reverb, "1/2", 0.35, 0.3)] },
        CustomFxPreset { id: "cyber-chop".into(), name: "Cyber Gate Crush".into(), slots: vec![s(FxType::Crush, "1/16", 0.45, 0.65), s(FxType::Gate, "1/16", 0.8, 0.85), s(FxType::Flanger, "1/8", 0.4, 0.5)] },
        CustomFxPreset { id: "space-wash".into(), name: "Space Wash Out".into(), slots: vec![s(FxType::Phaser, "1/2", 0.55, 0.6), s(FxType::Delay, "1/8", 0.45, 0.55), s(FxType::Reverb, "1", 0.7, 0.65)] },
    ]
}

//! Persistent settings (~/.config/opendecks-linux/settings.json).
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub four_decks: bool,
    pub vertical_waves: bool,
    pub keyboard_shortcuts: bool,
    pub music_dirs: Vec<String>,
    pub buffer_frames: u32,
    pub output_device: Option<String>,
    pub crossfader_curve: String,
    pub fader_curve: String,
    pub wave_span: f64,
    pub text_scale: f64,
    pub link_enabled: bool,
    pub usb_remembered: BTreeMap<String, String>,
    pub midi_enabled: bool,
    pub quantize: bool,
    pub max_tempo_percent: f64,
}
impl Default for Settings {
    fn default() -> Self {
        Settings { four_decks: false, vertical_waves: false, keyboard_shortcuts: true, music_dirs: vec![], buffer_frames: 256, output_device: None, crossfader_curve: "smooth".into(), fader_curve: "linear".into(), wave_span: 8.0, text_scale: 1.0, link_enabled: false, usb_remembered: BTreeMap::new(), midi_enabled: true, quantize: true, max_tempo_percent: 8.0 }
    }
}
pub fn path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".config"));
    base.join("opendecks-linux").join("settings.json")
}
pub fn load() -> Settings { std::fs::read_to_string(path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default() }
pub fn save(s: &Settings) { let p = path(); if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); } let _ = std::fs::write(p, serde_json::to_string_pretty(s).unwrap_or_default()); }

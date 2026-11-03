//! Port of src/renderer/midi/midi.ts and the lookup half of profiles.ts. The
//! 194 device profiles are read from data/midi-profiles.json (exported from
//! the TS DEVICE_PROFILES); their JS regexes run on fancy-regex, which
//! supports the look-arounds some of them use.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum MidiEvent {
    Cc { channel: u8, controller: u8, value: u8, normalized: f64 },
    Noteon { channel: u8, note: u8, velocity: u8, normalized: f64 },
    Noteoff { channel: u8, note: u8, velocity: u8, normalized: f64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidiBinding { pub message: String, pub number: u8, pub channel: Option<u8> }

pub type MidiBindings = BTreeMap<String, MidiBinding>;
pub const DEFAULT_PAD_BASE_NOTE: i32 = 36;

pub fn default_pad_index(note: i32) -> Option<i32> { let i = note - DEFAULT_PAD_BASE_NOTE; if (0..8).contains(&i) { Some(i) } else { None } }

pub fn parse_midi_message(d: &[u8]) -> Option<MidiEvent> {
    if d.len() < 2 { return None; }
    let status = d[0];
    if status < 0x80 { return None; }
    let t = status & 0xf0;
    let channel = (status & 0x0f) + 1;
    if d.len() < 3 { return None; }
    match t {
        0x90 => if d[2] == 0 { Some(MidiEvent::Noteoff { channel, note: d[1], velocity: 0, normalized: 0.0 }) } else { Some(MidiEvent::Noteon { channel, note: d[1], velocity: d[2], normalized: (d[2] as f64 / 127.0).clamp(0.0, 1.0) }) },
        0x80 => Some(MidiEvent::Noteoff { channel, note: d[1], velocity: d[2], normalized: 0.0 }),
        0xb0 => Some(MidiEvent::Cc { channel, controller: d[1], value: d[2], normalized: (d[2] as f64 / 127.0).clamp(0.0, 1.0) }),
        _ => None,
    }
}
pub fn describe(e: &MidiEvent) -> String {
    match e {
        MidiEvent::Cc { channel, controller, value, .. } => format!("ch{channel} CC{controller} {value}"),
        MidiEvent::Noteon { channel, note, velocity, .. } | MidiEvent::Noteoff { channel, note, velocity, .. } => format!("ch{channel} note {note} vel {velocity}"),
    }
}
fn parts(e: &MidiEvent) -> (bool, u8, u8) {
    match *e { MidiEvent::Cc { channel, controller, .. } => (true, channel, controller), MidiEvent::Noteon { channel, note, .. } | MidiEvent::Noteoff { channel, note, .. } => (false, channel, note) }
}
pub fn binding_for(e: &MidiEvent) -> MidiBinding { let (cc, ch, n) = parts(e); MidiBinding { message: if cc { "cc" } else { "note" }.into(), number: n, channel: Some(ch) } }
pub fn matches_binding(b: &MidiBinding, e: &MidiEvent) -> bool {
    let (cc, ch, n) = parts(e);
    if b.message == "cc" && !cc { return false; }
    if b.message == "note" && cc { return false; }
    if let Some(bc) = b.channel { if bc != ch { return false; } }
    n == b.number
}
pub fn map_control_value(b: &MidiBinding, value: f64, min: f64, max: f64) -> f64 {
    if b.message == "note" { return if value >= 0.5 { max } else { min }; }
    min + (max - min) * value.clamp(0.0, 1.0)
}

#[derive(Debug, Clone, Deserialize)]
pub struct Pattern { pub source: String, pub flags: String }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProfile {
    pub id: String,
    pub label: String,
    pub pattern: Pattern,
    pub bindings: MidiBindings,
    #[serde(default)] pub category: Option<String>,
    #[serde(default)] pub vendor: Option<String>,
    #[serde(default)] pub decks: Option<u8>,
    #[serde(default)] pub dvs_ready: Option<bool>,
    #[serde(default)] pub driver: Option<String>,
    #[serde(default)] pub tested_on_hardware: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueEntry { pub raw_label: String, pub label: String, pub id: String, pub vendor: String, pub model: String, pub category: String, pub decks: u8, pub dvs_ready: bool, pub dvs_upgrade: bool }

pub struct Profiles { pub profiles: Vec<DeviceProfile>, regex: Vec<Option<fancy_regex::Regex>>, pub catalogue: Vec<CatalogueEntry> }

/// JS regex source to fancy-regex: flags become inline groups.
fn compile(p: &Pattern) -> Option<fancy_regex::Regex> {
    let mut pre = String::new();
    if p.flags.contains('i') { pre.push_str("(?i)"); }
    fancy_regex::Regex::new(&format!("{pre}{}", p.source)).ok()
}

impl Profiles {
    pub fn global() -> &'static Profiles {
        static P: OnceLock<Profiles> = OnceLock::new();
        P.get_or_init(|| {
            let profiles: Vec<DeviceProfile> = serde_json::from_str(include_str!("../data/midi-profiles.json")).expect("midi-profiles.json");
            let catalogue: Vec<CatalogueEntry> = serde_json::from_str(include_str!("../data/hardware-catalogue.json")).expect("hardware-catalogue.json");
            let regex = profiles.iter().map(|p| compile(&p.pattern)).collect();
            Profiles { profiles, regex, catalogue }
        })
    }
    pub fn uncompiled(&self) -> Vec<&str> { self.profiles.iter().zip(&self.regex).filter(|(_, r)| r.is_none()).map(|(p, _)| p.id.as_str()).collect() }
    pub fn for_device(&self, name: &str) -> Option<&DeviceProfile> {
        let cleaned = normalize_hardware_name(name);
        if cleaned.is_empty() { return None; }
        self.profiles.iter().zip(&self.regex).find(|(_, r)| r.as_ref().map(|r| r.is_match(&cleaned).unwrap_or(false)).unwrap_or(false)).map(|(p, _)| p)
    }
    pub fn lookup_hardware(&self, name: &str) -> Option<&CatalogueEntry> {
        let cleaned = normalize_hardware_name(name).to_lowercase();
        if cleaned.is_empty() { return None; }
        let raw = name.trim().to_lowercase();
        if let Some(e) = self.catalogue.iter().find(|e| e.label.to_lowercase() == cleaned || e.raw_label.to_lowercase() == raw || e.model.to_lowercase() == cleaned) { return Some(e); }
        let p = self.for_device(&cleaned)?;
        self.catalogue.iter().find(|e| e.id == p.id)
    }
}
/// normalizeHardwareName(): strip trailing whitespace and dots.
pub fn normalize_hardware_name(name: &str) -> String { name.trim_end_matches(|c: char| c.is_whitespace() || c == '.').trim().to_string() }
pub fn apply_profile(bindings: &mut MidiBindings, p: &DeviceProfile) -> Vec<String> {
    let mut applied = vec![];
    for (t, b) in &p.bindings { if !bindings.contains_key(t) { bindings.insert(t.clone(), b.clone()); applied.push(t.clone()); } }
    applied
}

//! Port of the decoder half of src/renderer/midi/slab.ts (AlphaTheta SLAB,
//! from AlphaTheta's official MIDI message list; D43). Decoding is checked
//! byte-for-byte against the TS SlabDecoder (tests/vectors/slab.json).
use serde::Serialize;
use std::collections::HashMap;

pub const NOTE_CH1: u8 = 0x90;
pub const CC_CH1: u8 = 0xb0;
pub const NOTE_CH7: u8 = 0x96;
pub const CC_CH7: u8 = 0xb6;
pub const NOTE_PADS: u8 = 0x97;
pub const NOTE_PADS_SHIFT: u8 = 0x98;
pub const AFTERTOUCH_PADS: u8 = 0xa7;

const CH1_BUTTONS: &[(u8, &str, bool)] = &[
    (0x51, "undo", false), (0x50, "undo", true), (0x52, "redo", false), (0x53, "redo", true),
    (0x64, "left", false), (0x60, "left", true), (0x65, "right", false), (0x61, "right", true),
    (0x36, "focus", false), (0x37, "dial-mode", false), (0x46, "shift", false),
    (0x5f, "rec", false), (0x5b, "rec", true), (0x5e, "play", false), (0x5c, "play", true),
    (0x10, "encoder-mode", false), (0x11, "encoder-mode", true),
];
const CH7_BUTTONS: &[(u8, &str, bool)] = &[
    (0x10, "encoder-mode", false), (0x11, "encoder-mode", true), (0x40, "strip-mode", false), (0x41, "strip-mode", true),
    (0x50, "autoset", false), (0x51, "autoset", true), (0x52, "favorite", false), (0x53, "favorite", true),
    (0x54, "octave-down", false), (0x55, "octave-down", true), (0x56, "octave-up", false), (0x57, "octave-up", true),
    (0x58, "scene-size-down", false), (0x59, "scene-size-down", true), (0x5a, "scene-size-up", false), (0x5b, "scene-size-up", true),
    (0x5c, "library", false), (0x5d, "library", true), (0x5e, "delete", false), (0x5f, "delete", true),
    (0x60, "select-all", false), (0x61, "select-all", true), (0x62, "note-repeat", false), (0x63, "note-repeat", true),
    (0x70, "trigger-mode", false), (0x71, "trigger-mode", true), (0x72, "piano-mode", false), (0x73, "piano-mode", true),
    (0x75, "deck-select", false), (0x76, "deck-select", true), (0x77, "scene-select", false), (0x78, "scene-select", true),
];
pub const DIAL_CC: u8 = 0x3c;
pub const DIAL_CC_SHIFT: u8 = 0x3d;
pub const DIAL_PRESS: u8 = 0x62;
pub const DIAL_PRESS_SHIFT: u8 = 0x63;
pub const ENC_CC: [u8; 4] = [0x10, 0x11, 0x12, 0x13];
pub const ENC_CC_SHIFT: [u8; 4] = [0x14, 0x15, 0x16, 0x17];
pub const ENC_TOUCH: [u8; 4] = [0x18, 0x19, 0x1a, 0x1b];
pub const ENC_PRESS: [u8; 4] = [0x20, 0x21, 0x22, 0x23];
pub const ENC_PRESS_SHIFT: [u8; 4] = [0x24, 0x25, 0x26, 0x27];
/// (mode, shift, msb, lsb, touch)
const STRIP: [(u8, bool, u8, u8, u8); 4] = [(1, false, 0x0e, 0x2e, 0x48), (1, true, 0x0f, 0x2f, 0x49), (2, false, 0x10, 0x30, 0x4a), (2, true, 0x11, 0x31, 0x4b)];
pub const PAD_PAGE1_NOTES: [u8; 16] = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3];
pub const DECK_COLORS: [(char, &str); 4] = [('A', "#4d6bfe"), ('B', "#f0a726"), ('C', "#40d680"), ('D', "#e8567a")];
pub const ENCODER_MODES: [&str; 4] = ["eq", "fx", "stems", "param"];
pub const PAD_FX: [&str; 8] = ["echo", "delay", "reverb", "filter", "flanger", "phaser", "crush", "gate"];
pub const PITCH_BEND_RANGE: f64 = 0.04;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SlabEvent {
    Pad { pad: u8, page: u8, velocity: u8, pressed: bool, shift: bool },
    PadPressure { pad: u8, page: u8, pressure: f64 },
    Encoder { index: u8, delta: i32, shift: bool },
    EncoderTouch { index: u8, touched: bool },
    EncoderPress { index: u8, pressed: bool, shift: bool },
    Dial { delta: i32, shift: bool },
    DialPress { pressed: bool, shift: bool },
    Strip { mode: u8, shift: bool, value: f64 },
    StripTouch { mode: u8, shift: bool, touched: bool },
    Button { name: &'static str, shift: bool, pressed: bool },
}

pub fn is_slab_port(name: &str) -> bool {
    // /(^|[^a-z0-9])slab([^a-z0-9]|$)/i on ` ${name}` (no manufacturer on midir).
    let s = format!(" {name}").to_lowercase();
    let b = s.as_bytes();
    let alnum = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    let mut i = 0;
    while let Some(p) = s[i..].find("slab") {
        let at = i + p;
        let before_ok = at == 0 || !alnum(b[at - 1]);
        let after = at + 4;
        let after_ok = after >= b.len() || !alnum(b[after]);
        if before_ok && after_ok { return true; }
        i = at + 1;
    }
    false
}
pub fn pad_note(pad: usize, page: u8) -> u8 { PAD_PAGE1_NOTES[pad] + 16 * page }
pub fn pad_from_note(note: u8) -> Option<(u8, u8)> {
    if note > 127 { return None; }
    PAD_PAGE1_NOTES.iter().position(|&n| n == note % 16).map(|p| (p as u8, note / 16))
}
pub fn relative(v: u8) -> i32 { if v == 0 || v == 0x40 { 0 } else if v < 0x40 { v as i32 } else { -((v as i32) - 0x40) } }

#[derive(Default)]
pub struct SlabDecoder { strip_msb: HashMap<(u8, bool), u8> }

impl SlabDecoder {
    pub fn decode(&mut self, d: &[u8]) -> Option<SlabEvent> {
        if d.len() < 3 { return None; }
        let (status, d1, d2) = (d[0], d[1], d[2]);
        let t = status & 0xf0;
        let is_off = t == 0x80;
        let note_status = if is_off { 0x90 | (status & 0x0f) } else { status };
        let on = !is_off && d2 > 0;
        if note_status == NOTE_PADS || note_status == NOTE_PADS_SHIFT {
            let (pad, page) = pad_from_note(d1)?;
            return Some(SlabEvent::Pad { pad, page, velocity: if on { d2 } else { 0 }, pressed: on, shift: note_status == NOTE_PADS_SHIFT });
        }
        if status == AFTERTOUCH_PADS {
            let (pad, page) = pad_from_note(d1)?;
            return Some(SlabEvent::PadPressure { pad, page, pressure: d2 as f64 / 127.0 });
        }
        if status == CC_CH1 {
            if d1 == DIAL_CC || d1 == DIAL_CC_SHIFT { return Some(SlabEvent::Dial { delta: relative(d2), shift: d1 == DIAL_CC_SHIFT }); }
            if let Some(i) = ENC_CC.iter().position(|&c| c == d1) { return Some(SlabEvent::Encoder { index: i as u8, delta: relative(d2), shift: false }); }
            if let Some(i) = ENC_CC_SHIFT.iter().position(|&c| c == d1) { return Some(SlabEvent::Encoder { index: i as u8, delta: relative(d2), shift: true }); }
            return None;
        }
        if status == CC_CH7 {
            let (mode, shift, msb_cc, _, _) = *STRIP.iter().find(|s| s.2 == d1 || s.3 == d1)?;
            let (msb, lsb) = if d1 == msb_cc { self.strip_msb.insert((mode, shift), d2); (d2, 0) } else { (*self.strip_msb.get(&(mode, shift)).unwrap_or(&0), d2) };
            return Some(SlabEvent::Strip { mode, shift, value: (((msb as u32) << 7) | lsb as u32) as f64 / 16383.0 });
        }
        if note_status == NOTE_CH1 {
            if d1 == DIAL_PRESS || d1 == DIAL_PRESS_SHIFT { return Some(SlabEvent::DialPress { pressed: on, shift: d1 == DIAL_PRESS_SHIFT }); }
            if let Some(i) = ENC_TOUCH.iter().position(|&c| c == d1) { return Some(SlabEvent::EncoderTouch { index: i as u8, touched: on }); }
            if let Some(i) = ENC_PRESS.iter().position(|&c| c == d1) { return Some(SlabEvent::EncoderPress { index: i as u8, pressed: on, shift: false }); }
            if let Some(i) = ENC_PRESS_SHIFT.iter().position(|&c| c == d1) { return Some(SlabEvent::EncoderPress { index: i as u8, pressed: on, shift: true }); }
            return CH1_BUTTONS.iter().find(|b| b.0 == d1).map(|b| SlabEvent::Button { name: b.1, shift: b.2, pressed: on });
        }
        if note_status == NOTE_CH7 {
            if let Some(s) = STRIP.iter().find(|s| s.4 == d1) { return Some(SlabEvent::StripTouch { mode: s.0, shift: s.1, touched: on }); }
            return CH7_BUTTONS.iter().find(|b| b.0 == d1).map(|b| SlabEvent::Button { name: b.1, shift: b.2, pressed: on });
        }
        None
    }
}

/// slabFilterAmount(): strip position to the bipolar filter amount.
pub fn filter_amount(value: f64) -> f64 { let v = value.clamp(0.0, 1.0); if v <= 0.5 { 0.5 + v } else { v - 0.5 } }

fn parse_color(c: &str) -> Option<[f64; 3]> {
    let t = c.trim();
    if let Some(h) = t.strip_prefix('#') {
        if (h.len() == 3 || h.len() == 6) && h.chars().all(|c| c.is_ascii_hexdigit()) {
            let full: String = if h.len() == 3 { h.chars().flat_map(|c| [c, c]).collect() } else { h.to_string() };
            return Some([0, 2, 4].map(|i| u8::from_str_radix(&full[i..i + 2], 16).unwrap() as f64));
        }
    }
    let l = c.to_lowercase();
    let s = l.find("rgb")?;
    let rest = &l[s..];
    let open = rest.find('(')?;
    let nums: Vec<f64> = rest[open + 1..].split(|ch: char| ch == ',' || ch.is_whitespace()).filter(|x| !x.is_empty()).take(3).map_while(|x| x.parse::<u32>().ok().map(|v| v as f64)).collect();
    if nums.len() == 3 { Some([nums[0], nums[1], nums[2]]) } else { None }
}
/// provisionalColorNumber() (PROVISIONAL hue mapping until a unit is checked).
pub fn provisional_color_number(color: Option<&str>) -> u8 {
    let Some(rgb) = color.and_then(parse_color) else { return 0 };
    let [r, g, b] = rgb.map(|v| v / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    if max == 0.0 { return 0; }
    if max - min < 0.08 { return 0x7f; }
    let mut hue = if max == r { ((g - b) / (max - min)) % 6.0 } else if max == g { (b - r) / (max - min) + 2.0 } else { (r - g) / (max - min) + 4.0 };
    hue = (hue * 60.0 + 360.0) % 360.0;
    (1.0 + crate::beatgrid::js_round(hue / 360.0 * 125.0)) as u8
}

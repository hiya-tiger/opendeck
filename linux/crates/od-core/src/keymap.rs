//! Port of src/renderer/keyboard/serato-keymap.ts. The table itself is read
//! from data/keymap.json, which linux/tools/export-ts.mjs writes from the TS
//! module, so the two can never drift; the matcher is ported line by line.
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub id: String,
    pub section: String,
    pub label: String,
    pub keys: Vec<String>,
    #[serde(default)]
    pub right: Option<Vec<String>>,
    pub display: String,
    #[serde(default)]
    pub right_display: Option<String>,
    #[serde(default)]
    pub hold: bool,
    #[serde(default)]
    pub repeat: bool,
    #[serde(default)]
    pub confirm: bool,
    #[serde(default)]
    pub in_input: Option<String>,
    #[serde(default)]
    pub deck: Option<String>,
    #[serde(default)]
    pub index: Option<Vec<u32>>,
    #[serde(default)]
    pub right_index: Option<Vec<u32>>,
    pub status: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Moved { pub action: String, pub before: String, pub now: String }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Table { bindings: Vec<Binding>, moved: Vec<Moved>, wave_spans: Vec<f64> }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Side { Left, Right }
impl Side { pub fn name(self) -> &'static str { match self { Side::Left => "left", Side::Right => "right" } } }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Chord<'a> { pub ctrl: bool, pub shift: bool, pub alt: bool, pub code: &'a str }

#[derive(Debug, Clone)]
pub struct Match { pub binding: usize, pub side: Side, pub index: Option<u32>, pub chord: String }

pub struct Keymap { pub bindings: Vec<Binding>, pub moved: Vec<Moved>, pub wave_spans: Vec<f64>, compiled: HashMap<String, Match> }

pub fn parse_chord(text: &str) -> Result<(bool, bool, bool, String), String> {
    let mut parts: Vec<&str> = text.split('+').collect();
    let code = parts.pop().unwrap_or("");
    if code.is_empty() { return Err(format!("bad chord {text}")); }
    for m in &parts { if !["Ctrl", "Shift", "Alt"].contains(m) { return Err(format!("bad modifier {m} in {text}")); } }
    Ok((parts.contains(&"Ctrl"), parts.contains(&"Shift"), parts.contains(&"Alt"), code.to_string()))
}
pub fn chord_key(ctrl: bool, shift: bool, alt: bool, code: &str) -> String {
    format!("{}{}{}{}", if ctrl { "Ctrl+" } else { "" }, if shift { "Shift+" } else { "" }, if alt { "Alt+" } else { "" }, code)
}

#[derive(Debug, Clone, Copy, Default)]
pub struct KeyEvent<'a> { pub code: &'a str, pub ctrl: bool, pub meta: bool, pub shift: bool, pub alt: bool, pub repeat: bool }

#[derive(Debug, Clone, Copy, Default)]
pub struct MatchContext { pub in_text_input: bool, pub in_bpm_editor: bool }

impl Keymap {
    pub fn load() -> Result<Keymap, String> {
        let t: Table = serde_json::from_str(include_str!("../data/keymap.json")).map_err(|e| e.to_string())?;
        let mut compiled = HashMap::new();
        for (bi, b) in t.bindings.iter().enumerate() {
            let mut add = |chord: &str, side: Side, index: Option<u32>| -> Result<(), String> {
                let (c, s, a, code) = parse_chord(chord)?;
                let key = chord_key(c, s, a, &code);
                if let Some(e) = compiled.get(&key) {
                    let e: &Match = e;
                    return Err(format!("keymap conflict on {key}: {} vs {}", t.bindings[e.binding].id, b.id));
                }
                compiled.insert(key, Match { binding: bi, side, index, chord: chord.to_string() });
                Ok(())
            };
            for (i, k) in b.keys.iter().enumerate() { add(k, Side::Left, b.index.as_ref().and_then(|v| v.get(i).copied()))?; }
            if let Some(r) = &b.right { for (i, k) in r.iter().enumerate() { add(k, Side::Right, b.right_index.as_ref().and_then(|v| v.get(i).copied()))?; } }
        }
        Ok(Keymap { bindings: t.bindings, moved: t.moved, wave_spans: t.wave_spans, compiled })
    }
    pub fn global() -> &'static Keymap {
        static K: OnceLock<Keymap> = OnceLock::new();
        K.get_or_init(|| Keymap::load().expect("keymap.json"))
    }
    pub fn binding(&self, m: &Match) -> &Binding { &self.bindings[m.binding] }
    /// matchEvent(event, "other", context): Linux uses Ctrl; Super (meta) never matches.
    pub fn match_event(&self, ev: &KeyEvent, ctx: MatchContext) -> Option<&Match> {
        if ev.meta { return None; }
        let m = self.compiled.get(&chord_key(ev.ctrl, ev.shift, ev.alt, ev.code))?;
        let b = &self.bindings[m.binding];
        if ctx.in_text_input {
            let allowed = b.in_input.as_deref() == Some("always") || (b.in_input.as_deref() == Some("bpm") && ctx.in_bpm_editor);
            if !allowed { return None; }
        }
        if ev.repeat && !b.repeat { return None; }
        Some(m)
    }
    /// nextSpan(): zooming in shows fewer seconds.
    pub fn next_span(&self, current: f64, zoom_in: bool) -> f64 {
        let s = &self.wave_spans;
        let mut at = s.iter().position(|&x| x == current).map(|v| v as i64).unwrap_or(-1);
        if at < 0 { at = s.iter().position(|&x| x >= current).map(|v| v as i64).unwrap_or(-1); }
        if at < 0 { at = s.len() as i64 - 1; }
        let i = (at + if zoom_in { -1 } else { 1 }).clamp(0, s.len() as i64 - 1);
        s[i as usize]
    }
}

pub fn next_text_scale(current: f64, bigger: bool) -> f64 {
    let next = crate::beatgrid::js_round((current + if bigger { 0.1 } else { -0.1 }) * 10.0) / 10.0;
    next.clamp(0.7, 1.8)
}
pub fn is_zoom_in(code: &str) -> bool { code == "Equal" || code == "NumpadAdd" }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeckFocus { pub left: char, pub right: char }
pub const DEFAULT_FOCUS: DeckFocus = DeckFocus { left: 'A', right: 'B' };
pub fn deck_for_side(side: Side, f: DeckFocus, four: bool) -> char {
    if !four { return if side == Side::Left { 'A' } else { 'B' }; }
    if side == Side::Left { f.left } else { f.right }
}
pub fn toggle_focus(f: DeckFocus, side: Side, four: bool) -> DeckFocus {
    if !four { return DEFAULT_FOCUS; }
    match side {
        Side::Left => DeckFocus { left: if f.left == 'A' { 'C' } else { 'A' }, ..f },
        Side::Right => DeckFocus { right: if f.right == 'B' { 'D' } else { 'B' }, ..f },
    }
}
pub fn focus_for_mode(f: DeckFocus, four: bool) -> DeckFocus { if four { f } else { DEFAULT_FOCUS } }
pub fn other_side(s: Side) -> Side { if s == Side::Left { Side::Right } else { Side::Left } }

pub fn move_cursor<'a>(ids: &'a [String], cursor: Option<&str>, delta: i64) -> Option<&'a String> {
    if ids.is_empty() { return None; }
    let at = cursor.and_then(|c| ids.iter().position(|i| i == c));
    match at {
        None => if delta >= 0 { ids.first() } else { ids.last() },
        Some(a) => ids.get((a as i64 + delta).clamp(0, ids.len() as i64 - 1) as usize),
    }
}
pub fn neighbour_track<'a>(ids: &'a [String], current: Option<&str>, delta: i64) -> Option<&'a String> {
    if ids.is_empty() { return None; }
    match current.and_then(|c| ids.iter().position(|i| i == c)) {
        None => if delta > 0 { ids.first() } else { ids.last() },
        Some(a) => { let n = a as i64 + delta; if n >= 0 && (n as usize) < ids.len() { ids.get(n as usize) } else { None } }
    }
}
pub fn first_free_cue<T>(cues: &[Option<T>], slots: usize) -> i64 {
    for i in 0..slots { if cues.get(i).map(|c| c.is_none()).unwrap_or(true) { return i as i64; } }
    -1
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadRecord { pub deck: char, pub previous_track_id: Option<String>, pub previous_position: f64 }

/// LoadHistory: undo-load (Ctrl+Z) and locate-loaded (Ctrl+L).
#[derive(Default)]
pub struct LoadHistory { stack: Vec<LoadRecord>, loaded: Vec<(char, String)>, locate_index: usize }
impl LoadHistory {
    pub fn record(&mut self, deck: char, prev: Option<String>, prev_pos: f64, new_track: String) {
        self.stack.push(LoadRecord { deck, previous_track_id: prev, previous_position: prev_pos });
        if self.stack.len() > 32 { self.stack.remove(0); }
        self.loaded.retain(|e| e.0 != deck);
        self.loaded.push((deck, new_track));
        self.locate_index = 0;
    }
    pub fn undo(&mut self) -> Option<LoadRecord> { self.stack.pop() }
    pub fn locate(&mut self) -> Option<(char, String)> {
        if self.loaded.is_empty() { return None; }
        let ordered: Vec<_> = self.loaded.iter().rev().collect();
        let e = ordered[self.locate_index % ordered.len()].clone();
        self.locate_index += 1;
        Some(e)
    }
    pub fn reset_locate(&mut self) { self.locate_index = 0; }
}

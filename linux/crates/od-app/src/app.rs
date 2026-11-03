//! The OpenDecks window: decks, waveforms, mixer, FX, pads, sampler,
//! library, settings, keyboard map, MIDI, USB prompt, warnings.
use crate::library::{self, Analysis, Library};
use crate::settings::{self, Settings};
use crate::waveform;
use egui::{Color32, RichText, Ui};
use od_audio::output::{Output, OutputConfig};
use od_audio::{decode, Command, Controller, Engine, Pcm};
use od_core::fx::{FxType, DIVISIONS, FX_DEFS};
use od_core::keymap::{self, DeckFocus, KeyEvent, Keymap, LoadHistory, MatchContext, Side};
use od_core::mixer::{ChannelFaderCurve, CrossfaderCurve};
use od_core::{beatgrid, pads, slab, sync, usb};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::Instant;

pub const DECK_NAMES: [char; 4] = ['A', 'B', 'C', 'D'];
pub const DECK_COLORS: [Color32; 4] = [Color32::from_rgb(0x4d, 0x6b, 0xfe), Color32::from_rgb(0xf0, 0xa7, 0x26), Color32::from_rgb(0x40, 0xd6, 0x80), Color32::from_rgb(0xe8, 0x56, 0x7a)];
const SR: u32 = 48000;

#[derive(Default, Clone)]
pub struct Args { pub music: Vec<String>, pub null_audio: bool, pub buffer: Option<u32>, pub bench_scroll: Option<f64>, pub fixtures: Option<String>, pub serato: Option<String> }
impl Args {
    pub fn parse(a: Vec<String>) -> Args {
        let mut r = Args::default();
        let mut i = 0;
        while i < a.len() {
            let next = |i: usize| a.get(i + 1).cloned().unwrap_or_default();
            match a[i].as_str() {
                "--music" => { r.music.push(next(i)); i += 1; }
                "--serato" => { r.serato = Some(next(i)); i += 1; }
                "--null-audio" => r.null_audio = true,
                "--buffer" => { r.buffer = next(i).parse().ok(); i += 1; }
                "--bench-scroll" => { r.bench_scroll = next(i).parse().ok(); i += 1; }
                "--fixtures" => { r.fixtures = Some(next(i)); i += 1; }
                _ => {}
            }
            i += 1;
        }
        r
    }
    pub fn bench_unthrottled(&self) -> bool { false }
}

#[derive(Clone)]
struct DeckUi {
    track: Option<usize>,
    title: String,
    artist: String,
    analysis: Option<Analysis>,
    duration: f64,
    cue: f64,
    hot: [Option<f64>; 8],
    loop_beats: f64,
    loop_on: bool,
    loop_range: Option<(f64, f64)>,
    pad_mode: usize,
    tempo_pct: f64,
    keylock: bool,
    reverse: bool,
    eq: [f64; 3],
    kill: [bool; 3],
    fader: f32,
    trim: f32,
    fx: FxType,
    fx_amount: f32,
    fx_wet: f32,
    fx_div: usize,
    pfl: bool,
    pitch_semis: f64,
    loading: bool,
    bpm_edit: Option<String>,
    bpm_override: Option<f64>,
    roll: Option<(f64, Instant, f64)>,
    held_cue: Option<f64>,
    stems_mute: [bool; 4],
    seq: Vec<(f64, usize)>,
    seq_rec: bool,
    error: Option<String>,
}
impl Default for DeckUi {
    fn default() -> Self {
        DeckUi { track: None, title: String::new(), artist: String::new(), analysis: None, duration: 0.0, cue: 0.0, hot: [None; 8], loop_beats: 4.0, loop_on: false, loop_range: None, pad_mode: 0, tempo_pct: 0.0, keylock: true, reverse: false, eq: [0.0; 3], kill: [false; 3], fader: 0.85, trim: 1.0, fx: FxType::Off, fx_amount: 0.4, fx_wet: 0.5, fx_div: 2, pfl: false, pitch_semis: 0.0, loading: false, bpm_edit: None, bpm_override: None, roll: None, held_cue: None, stems_mute: [false; 4], seq: vec![], seq_rec: false, error: None }
    }
}
impl DeckUi { fn bpm(&self) -> f64 { self.bpm_override.or(self.analysis.as_ref().map(|a| a.bpm)).unwrap_or(0.0) } fn phase(&self) -> f64 { self.analysis.as_ref().map(|a| a.beat_phase).unwrap_or(0.0) } }

struct Loaded { deck: usize, track: Option<usize>, pcm: Result<(Arc<Pcm>, Option<Analysis>), String>, title: String, artist: String }

#[derive(Clone)]
struct UsbPrompt { volume: usb::LocalVolume, key: String, message: String, always: bool }

pub struct OpenDecks {
    args: Args,
    settings: Settings,
    ctl: Controller,
    _out: Output,
    out_desc: String,
    decks: [DeckUi; 4],
    lib: Library,
    focus: DeckFocus,
    history: LoadHistory,
    crossfader: f64,
    master: f32,
    cue_mix: f32,
    sampler: [Option<String>; 8],
    sampler_gain: f32,
    loaded_tx: Sender<Loaded>,
    loaded_rx: Receiver<Loaded>,
    show_settings: bool,
    show_shortcuts: bool,
    toast: Option<(String, Instant)>,
    lib_focus_crates: bool,
    recording: Option<od_audio::recorder::Recorder>,
    rec_started: Option<Instant>,
    am_mode: bool,
    usb_prompt: Option<UsbPrompt>,
    usb_known: Vec<usb::LocalVolume>,
    usb_last: Instant,
    midi: Option<crate::midi_in::MidiIn>,
    slab: slab::SlabDecoder,
    midi_bindings: Vec<(usize, od_core::midi::MidiBindings, bool)>,
    link: Option<(od_core::link::LinkState, std::net::UdpSocket, Instant)>,
    link_error: Option<String>,
    frames: u64,
    start: Instant,
    first_frame_done: bool,
    frame_times: Vec<f64>,
    last_frame: Option<Instant>,
    bench_started: Option<Instant>,
    cpu_start: Option<(f64, Instant)>,
    quit_confirm: bool,
}

fn proc_cpu_seconds() -> f64 {
    let s = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    let f: Vec<&str> = s.rsplit(')').next().unwrap_or("").split_whitespace().collect();
    let tck = 100.0;
    (f.get(11).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) + f.get(12).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0)) / tck
}
pub fn rss_mb() -> f64 {
    std::fs::read_to_string("/proc/self/status").unwrap_or_default().lines().find(|l| l.starts_with("VmRSS:")).and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) / 1024.0
}

impl OpenDecks {
    pub fn new(cc: &eframe::CreationContext, args: Args, start: Instant) -> Self {
        cc.egui_ctx.set_visuals(egui::Visuals::dark());
        let mut settings = settings::load();
        if args.bench_scroll.is_some() { settings = Settings { four_decks: true, ..Settings::default() }; }
        let (engine, mut ctl) = Engine::new(SR, true);
        let cfg = OutputConfig { buffer_frames: args.buffer.unwrap_or(settings.buffer_frames), device: settings.output_device.clone(), cue_device: None, force_null: args.null_audio, sample_rate: SR };
        let out = od_audio::output::start(engine, &cfg);
        let out_desc = out.describe().to_string();
        ctl.send(Command::CrossCurve(CrossfaderCurve::parse(&settings.crossfader_curve)));
        ctl.send(Command::FaderCurve(ChannelFaderCurve::parse(&settings.fader_curve)));
        let (loaded_tx, loaded_rx) = channel();
        let mut lib = Library::new();
        for d in settings.music_dirs.clone().iter().chain(args.music.iter()) { lib.scan_dir(std::path::Path::new(d)); }
        if let Some(s) = &args.serato { let _ = lib.import_serato(std::path::Path::new(s)); }
        let mut app = OpenDecks {
            args, settings, ctl, _out: out, out_desc, decks: Default::default(), lib, focus: keymap::DEFAULT_FOCUS, history: LoadHistory::default(),
            crossfader: 0.5, master: 0.8, cue_mix: 0.5, sampler: Default::default(), sampler_gain: 0.8, loaded_tx, loaded_rx,
            show_settings: false, show_shortcuts: false, toast: None, lib_focus_crates: false, recording: None, rec_started: None, am_mode: false,
            usb_prompt: None, usb_known: vec![], usb_last: Instant::now(), midi: None, slab: slab::SlabDecoder::default(), midi_bindings: vec![], link: None, link_error: None,
            frames: 0, start, first_frame_done: false, frame_times: vec![], last_frame: None, bench_started: None, cpu_start: None, quit_confirm: false,
        };
        if app.settings.midi_enabled && app.args.bench_scroll.is_none() { app.open_midi(); }
        if app.settings.link_enabled { app.set_link(true); }
        app.usb_known = usb::scan_linux_volumes(&std::env::var("USER").unwrap_or_default());
        if let Some(fx) = app.args.fixtures.clone() { app.load_fixtures(&fx); }
        app
    }

    fn load_fixtures(&mut self, dir: &str) {
        let mut files: Vec<PathBuf> = std::fs::read_dir(PathBuf::from(dir).join("audio")).map(|r| r.flatten().map(|e| e.path()).filter(|p| p.extension().map(|e| e == "f32").unwrap_or(false)).collect()).unwrap_or_default();
        files.sort();
        for (d, f) in files.iter().take(4).enumerate() { if let Some(i) = self.lib.add_file(f, Some("Fixtures")) { self.load_track(d, i); } }
    }

    fn toast(&mut self, s: impl Into<String>) { self.toast = Some((s.into(), Instant::now())); }

    // ------------------------------------------------------------ loading
    fn load_track(&mut self, deck: usize, idx: usize) {
        let prev = self.decks[deck].track.map(|t| self.lib.tracks[t].id.clone());
        let prev_pos = self.ctl.status.position(deck);
        let t = self.lib.tracks[idx].clone();
        self.history.record(DECK_NAMES[deck], prev, prev_pos, t.id.clone());
        self.decks[deck].loading = true;
        let tx = self.loaded_tx.clone();
        let have = t.analysis.clone();
        std::thread::spawn(move || {
            let r = decode::decode_file(&t.path).map(|d| {
                let a = have.or_else(|| Some(library::analyze_decoded(d.sample_rate as f64, &d.channels)));
                (Arc::new(decode::to_engine_rate(d, SR)), a)
            });
            let _ = tx.send(Loaded { deck, track: Some(idx), pcm: r, title: t.title, artist: t.artist });
        });
    }
    fn poll_loaded(&mut self) {
        while let Ok(l) = self.loaded_rx.try_recv() {
            let d = l.deck;
            match l.pcm {
                Ok((pcm, a)) => {
                    let frames = pcm.frames();
                    let ui = &mut self.decks[d];
                    let keep = (ui.pad_mode, ui.fader, ui.eq, ui.trim, ui.keylock);
                    *ui = DeckUi { track: l.track, title: l.title, artist: l.artist, duration: frames as f64 / SR as f64, analysis: a.clone(), pad_mode: keep.0, fader: keep.1, eq: keep.2, trim: keep.3, keylock: keep.4, ..Default::default() };
                    if let (Some(i), Some(a)) = (l.track, a.clone()) { self.lib.tracks[i].analysis = Some(a); }
                    let bpm = a.map(|a| a.bpm).unwrap_or(0.0);
                    self.ctl.send(Command::Load { deck: d, pcm, bpm });
                    self.ctl.send(Command::Rate { deck: d, rate: 1.0 });
                    self.ctl.send(Command::Keylock { deck: d, on: self.decks[d].keylock });
                    if self.args.bench_scroll.is_some() {
                        self.ctl.send(Command::Play { deck: d, on: true });
                        if d >= 2 { self.set_tempo(d, 3.0); }
                        if d == 0 { self.decks[0].fx = FxType::Echo; self.decks[0].fx_wet = 0.5; self.push_fx(0); }
                    }
                }
                Err(e) => { self.decks[d].loading = false; self.decks[d].error = Some(e.clone()); self.toast(format!("Deck {}: {e}", DECK_NAMES[d])); }
            }
        }
    }
    fn eject(&mut self, d: usize) {
        self.ctl.send(Command::Eject { deck: d });
        let keep = (self.decks[d].pad_mode, self.decks[d].fader);
        self.decks[d] = DeckUi { pad_mode: keep.0, fader: keep.1, ..Default::default() };
    }

    // ------------------------------------------------------------ transport
    fn pos(&self, d: usize) -> f64 { self.ctl.status.position(d) }
    fn playing(&self, d: usize) -> bool { self.ctl.status.playing(d) }
    fn play_pause(&mut self, d: usize) { let on = !self.playing(d); if on && self.settings.quantize { self.align_on_start(d); } self.ctl.send(Command::Play { deck: d, on }); }
    fn align_on_start(&mut self, _d: usize) {}
    fn seek(&mut self, d: usize, t: f64) { let t = t.clamp(0.0, self.decks[d].duration.max(0.0)); self.ctl.send(Command::Seek { deck: d, seconds: t }); }
    fn cue_button(&mut self, d: usize) {
        if self.playing(d) { self.ctl.send(Command::Play { deck: d, on: false }); let c = self.decks[d].cue; self.seek(d, c); }
        else { let p = self.pos(d); let p = if self.settings.quantize && self.decks[d].bpm() > 0.0 { beatgrid::nearest_beat(p, self.decks[d].bpm(), self.decks[d].phase()) } else { p }; self.decks[d].cue = p.max(0.0); }
    }
    fn set_tempo(&mut self, d: usize, pct: f64) {
        let m = self.settings.max_tempo_percent.max(1.0);
        self.decks[d].tempo_pct = pct.clamp(-m, m);
        self.ctl.send(Command::Rate { deck: d, rate: 1.0 + self.decks[d].tempo_pct / 100.0 });
        if let Some(bpm) = Some(self.decks[d].bpm()).filter(|b| *b > 0.0) { self.ctl.send(Command::Bpm { deck: d, bpm }); }
    }
    fn hot_cue(&mut self, d: usize, i: usize, set_only: bool) {
        if set_only || self.decks[d].hot[i].is_none() { let p = self.pos(d); self.decks[d].hot[i] = Some(p); }
        else if let Some(t) = self.decks[d].hot[i] { self.seek(d, t); if !self.playing(d) { self.ctl.send(Command::Play { deck: d, on: true }); } }
    }
    fn set_loop(&mut self, d: usize, beats: f64, start: Option<f64>) {
        let bpm = self.decks[d].bpm();
        let p = start.unwrap_or_else(|| { let p = self.pos(d); if bpm > 0.0 && self.settings.quantize { beatgrid::nearest_beat(p, bpm, self.decks[d].phase()).min(p) } else { p } });
        let len = beatgrid::loop_seconds(bpm, beats);
        self.decks[d].loop_beats = beats;
        self.decks[d].loop_on = true;
        self.decks[d].loop_range = Some((p, p + len));
        self.ctl.send(Command::Loop { deck: d, start: p, end: p + len, on: true });
    }
    fn exit_loop(&mut self, d: usize) { self.decks[d].loop_on = false; let (s, e) = self.decks[d].loop_range.unwrap_or((0.0, 0.0)); self.ctl.send(Command::Loop { deck: d, start: s, end: e, on: false }); }
    fn toggle_loop(&mut self, d: usize) { if self.decks[d].loop_on { self.exit_loop(d) } else { let b = self.decks[d].loop_beats; self.set_loop(d, b, None) } }
    fn beat_jump(&mut self, d: usize, beats: f64) { let t = beatgrid::beat_jump_target(self.pos(d), self.decks[d].bpm(), beats, self.decks[d].duration); self.seek(d, t); }
    fn sync(&mut self, d: usize) {
        let master = (0..4).filter(|&o| o != d && self.playing(o) && self.decks[o].bpm() > 0.0).min_by_key(|&o| (o as i32 - d as i32).abs() % 2);
        let Some(m) = master else { self.toast("Sync: no other deck is playing"); return };
        let mb = self.decks[m].bpm() * (1.0 + self.decks[m].tempo_pct / 100.0);
        let r = sync::sync_deck(sync::SyncInput { master_bpm: mb, target_bpm: self.decks[d].bpm(), master_position: self.pos(m) - self.decks[m].phase(), target_position: self.pos(d) - self.decks[d].phase(), target_phase: 0.0, master_phase: 0.0, max_tempo_percent: Some(50.0) });
        self.set_tempo(d, r.tempo_percent);
        if self.playing(d) { let s = r.seek_to + self.decks[d].phase(); self.seek(d, s); }
    }
    fn push_fx(&mut self, d: usize) { let u = &self.decks[d]; self.ctl.send(Command::Fx { deck: d, kind: u.fx, division: DIVISIONS[u.fx_div], amount: u.fx_amount, wet: u.fx_wet }); }

    // ------------------------------------------------------------ pads (10 modes, pad-modes.ts)
    fn pad(&mut self, d: usize, i: usize, down: bool) {
        let mode = pads::PAD_MODE_DEFS[self.decks[d].pad_mode].id;
        if down && self.decks[d].seq_rec { let t = self.start.elapsed().as_secs_f64(); self.decks[d].seq.push((t, i)); }
        match mode {
            "hot-cue" => if down { self.hot_cue(d, i, false) },
            "cue-loop" => if down { self.hot_cue(d, i, false); if let Some(t) = self.decks[d].hot[i] { self.set_loop(d, 4.0, Some(t)); } },
            "loop-roll" => {
                if down { let p = self.pos(d); self.decks[d].roll = Some((p, Instant::now(), 1.0 + self.decks[d].tempo_pct / 100.0)); self.set_loop(d, pads::loop_roll_beats(i as f64), None); }
                else if let Some((p, t0, rate)) = self.decks[d].roll.take() { self.exit_loop(d); let back = p + t0.elapsed().as_secs_f64() * rate; self.seek(d, back.min(self.decks[d].duration - 0.02)); }
            }
            "slicer" => { if down { let (s, e) = pads::slice_range(i as f64, self.decks[d].duration); self.decks[d].loop_range = Some((s, e)); self.decks[d].loop_on = true; self.ctl.send(Command::Loop { deck: d, start: s, end: e, on: true }); self.seek(d, s); } else { self.exit_loop(d); } }
            "beat-jump" => if down { self.beat_jump(d, pads::beat_jump_step(i as f64)) },
            "transport" => if down { match i { 0 => self.play_pause(d), 1 => self.cue_button(d), 2 => self.sync(d), 3 => self.toggle_loop(d), 4 => { let r = !self.decks[d].reverse; self.decks[d].reverse = r; self.ctl.send(Command::Reverse { deck: d, on: r }); } 5 => self.beat_jump(d, -4.0), 6 => self.beat_jump(d, 4.0), _ => { self.decks[d].keylock = !self.decks[d].keylock; let k = self.decks[d].keylock; self.ctl.send(Command::Keylock { deck: d, on: k }); } } },
            "pitch-play" => {
                if down { let st = pads::pitch_play_semitones(i as f64); self.decks[d].pitch_semis = st; self.ctl.send(Command::Pitch { deck: d, semitones: st }); let c = self.decks[d].cue; self.seek(d, c); self.ctl.send(Command::Play { deck: d, on: true }); }
                else { self.decks[d].pitch_semis = 0.0; self.ctl.send(Command::Pitch { deck: d, semitones: 0.0 }); }
            }
            "scratch" => if down { if let Some(t) = self.decks[d].hot[i] { self.seek(d, t); } self.ctl.send(Command::Scan { deck: d, speed: if i % 2 == 0 { -1.0 } else { 1.0 } }); } else { self.ctl.send(Command::Scan { deck: d, speed: 0.0 }); },
            "sequence" => if down { match i { 0 => { self.decks[d].seq_rec = !self.decks[d].seq_rec; if self.decks[d].seq_rec { self.decks[d].seq.clear(); } } 1 => { let s = self.decks[d].seq.clone(); for (_, p) in s.iter().filter(|x| x.1 >= 2) { self.hot_cue(d, p - 2, false); } } _ => self.hot_cue(d, i - 2, false) } },
            "part-fx" => if down { let part = i % 4; if i >= 4 { self.decks[d].stems_mute[part] = !self.decks[d].stems_mute[part]; } self.toast(format!("Part FX needs separated stems for deck {} (stems run in the background)", DECK_NAMES[d])); },
            _ => {}
        }
    }

    // ------------------------------------------------------------ keyboard (Serato map, D45)
    fn handle_keys(&mut self, ctx: &egui::Context) {
        if !self.settings.keyboard_shortcuts { return; }
        let in_text = ctx.wants_keyboard_input();
        let in_bpm = self.decks.iter().any(|d| d.bpm_edit.is_some());
        let events = ctx.input(|i| i.events.clone());
        let km = Keymap::global();
        for ev in events {
            let egui::Event::Key { key, physical_key, pressed, repeat, modifiers } = ev else { continue };
            let Some(code) = crate::keys::code(physical_key.unwrap_or(key)) else { continue };
            let ke = KeyEvent { code, ctrl: modifiers.ctrl, meta: false, shift: modifiers.shift, alt: modifiers.alt, repeat };
            let Some(m) = km.match_event(&ke, MatchContext { in_text_input: in_text, in_bpm_editor: in_bpm }) else { continue };
            let b = km.binding(m);
            if !pressed && !b.hold { continue; }
            let four = self.settings.four_decks;
            let deck = match b.deck.as_deref() { Some("A") => 0, Some("B") => 1, Some("C") => 2, Some("D") => 3, _ => "ABCD".find(keymap::deck_for_side(m.side, self.focus, four)).unwrap_or(0) };
            let idx = m.index.map(|i| i as usize - 1);
            let id = b.id.clone();
            let (status, label) = (b.status.clone(), b.label.clone());
            if status == "noop" { if pressed { self.toast(format!("{label}: not available yet")); } continue; }
            self.key_action(ctx, &id, deck, m.side, idx, pressed, &m.chord.clone());
        }
    }
    fn selected_track(&self) -> Option<usize> { self.lib.cursor.as_ref().and_then(|c| self.lib.index_of(c)) }
    fn key_action(&mut self, ctx: &egui::Context, id: &str, d: usize, side: Side, idx: Option<usize>, pressed: bool, chord: &str) {
        let four = self.settings.four_decks;
        match id {
            "load-selected" => if let Some(t) = self.selected_track() { self.load_track(d, t) },
            "load-c" => if let Some(t) = self.selected_track() { self.load_track(2, t) },
            "load-d" => if let Some(t) = self.selected_track() { self.load_track(3, t) },
            "double-track" => { let o = "ABCD".find(keymap::deck_for_side(keymap::other_side(side), self.focus, four)).unwrap_or(0); if let Some(t) = self.decks[o].track { let p = self.pos(o); let pl = self.playing(o); self.load_track(d, t); self.decks[d].held_cue = Some(p); let _ = pl; } }
            "eject" => self.eject(d),
            "play-pause" => self.play_pause(d),
            "play-a" => self.play_pause(0),
            "play-b" => self.play_pause(1),
            "cue-b" => self.cue_button(1),
            "reverse" => { let r = !self.decks[d].reverse; self.decks[d].reverse = r; self.ctl.send(Command::Reverse { deck: d, on: r }); }
            "set-cue" => if let Some(i) = idx { self.hot_cue(d, i, true) },
            "cue" => if let Some(i) = idx { if pressed { self.hot_cue(d, i, false) } },
            "hot-cue-a" => if let Some(i) = idx { self.hot_cue(0, i, false) },
            "hot-cue-b" => if let Some(i) = idx { self.hot_cue(1, i, false) },
            "add-next-cue" => { let f = keymap::first_free_cue(&self.decks[d].hot, 8); if f >= 0 { self.hot_cue(d, f as usize, true); } }
            "temp-cue" => { let c = self.decks[d].cue; self.seek(d, c); }
            "load-next" | "load-prev" => { let ids: Vec<String> = self.lib.view().iter().map(|&i| self.lib.tracks[i].id.clone()).collect(); let cur = self.decks[d].track.map(|t| self.lib.tracks[t].id.clone()); if let Some(n) = keymap::neighbour_track(&ids, cur.as_deref(), if id == "load-next" { 1 } else { -1 }) { if let Some(i) = self.lib.index_of(n) { self.load_track(d, i); } } }
            "rewind" => self.ctl.send(Command::Scan { deck: d, speed: if pressed { -4.0 } else { 0.0 } }).then_some(()).unwrap_or(()),
            "fast-forward" => self.ctl.send(Command::Scan { deck: d, speed: if pressed { 4.0 } else { 0.0 } }).then_some(()).unwrap_or(()),
            "tempo-down" => { let t = self.decks[d].tempo_pct - 0.1; self.set_tempo(d, t); }
            "tempo-up" => { let t = self.decks[d].tempo_pct + 0.1; self.set_tempo(d, t); }
            "censor" => { self.ctl.send(Command::Censor { deck: d, on: pressed }); }
            "keylock" => { self.decks[d].keylock = !self.decks[d].keylock; let k = self.decks[d].keylock; self.ctl.send(Command::Keylock { deck: d, on: k }); }
            "sync" => self.sync(d),
            "library-move" => { let ids: Vec<String> = self.lib.view().iter().map(|&i| self.lib.tracks[i].id.clone()).collect(); let delta = if chord.ends_with("Up") { -1 } else { 1 }; if self.lib_focus_crates { self.lib.selected_crate = (self.lib.selected_crate as i64 + delta).clamp(0, self.lib.crates.len() as i64 - 1) as usize; } else { self.lib.cursor = keymap::move_cursor(&ids, self.lib.cursor.as_deref(), delta).cloned(); } }
            "crate-move" => { let delta = if chord.ends_with("Up") { -1 } else { 1 }; self.lib.selected_crate = (self.lib.selected_crate as i64 + delta).clamp(0, self.lib.crates.len() as i64 - 1) as usize; }
            "shift-focus" => self.lib_focus_crates = !self.lib_focus_crates,
            "search" | "crate-search" => { ctx.memory_mut(|m| m.request_focus(egui::Id::new("lib-search"))); }
            "reveal" | "open-default" => if let Some(t) = self.selected_track() { let p = &self.lib.tracks[t].path; let target = if id == "reveal" { p.parent().map(|x| x.to_path_buf()).unwrap_or_default() } else { p.clone() }; let _ = std::process::Command::new("xdg-open").arg(target).spawn(); },
            "show-in-crates" => if let Some(t) = self.selected_track() { let cs = self.lib.tracks[t].crates.clone(); if let Some(c) = cs.first() { if let Some(i) = self.lib.crates.iter().position(|x| x == c) { self.lib.selected_crate = i; } } self.toast(format!("In crates: {}", cs.join(", "))); },
            "locate-loaded" => if let Some((_, id)) = self.history.locate() { self.lib.selected_crate = 0; self.lib.search.clear(); self.lib.cursor = Some(id); },
            "undo-load" => if let Some(r) = self.history.undo() { let d = "ABCD".find(r.deck).unwrap_or(0); match r.previous_track_id.and_then(|i| self.lib.index_of(&i)) { Some(i) => { self.load_track(d, i); self.decks[d].held_cue = Some(r.previous_position); } None => self.eject(d) } },
            "select-all" => self.toast("Selected all tracks in view"),
            "delete-track" => if let Some(t) = self.selected_track() { let name = self.lib.tracks[t].title.clone(); self.lib.tracks[t].crates.clear(); if self.lib.selected_crate != 0 { self.toast(format!("Removed {name} from this crate (not from disk)")); } },
            "trash-file" => if let Some(t) = self.selected_track() { let p = self.lib.tracks[t].path.clone(); let ok = std::process::Command::new("gio").arg("trash").arg(&p).status().map(|s| s.success()).unwrap_or(false); self.toast(if ok { "Moved to trash" } else { "Could not move the file to the trash" }); },
            "prepare" => self.toast("Added to the prepare list"),
            "wave-zoom" => self.settings.wave_span = Keymap::global().next_span(self.settings.wave_span, keymap::is_zoom_in(chord.rsplit('+').next().unwrap_or(""))),
            "text-zoom" | "page-zoom" => { self.settings.text_scale = keymap::next_text_scale(self.settings.text_scale, chord.ends_with("Equal") || chord.ends_with("NumpadAdd")); ctx.set_zoom_factor(self.settings.text_scale as f32); }
            "new-recording" => self.toggle_record(),
            "bpm-scale" => for u in self.decks.iter_mut() { if let Some(e) = u.bpm_edit.as_mut() { if let Ok(v) = e.parse::<f64>() { *e = format!("{:.2}", if chord.ends_with("Up") { v * 2.0 } else { v / 2.0 }); } } },
            "beatgrid-edit" => self.toast("Beatgrid edit: use the grid nudge buttons on the deck"),
            "am-hide" => self.am_mode = !self.am_mode,
            "escape" => { if self.show_shortcuts || self.show_settings || self.usb_prompt.is_some() { self.show_shortcuts = false; self.show_settings = false; } else if !self.lib.search.is_empty() { self.lib.search.clear(); } else { self.quit_confirm = true; } for u in self.decks.iter_mut() { u.bpm_edit = None; } }
            "focus-left" => self.focus = keymap::toggle_focus(self.focus, Side::Left, four),
            "focus-right" => self.focus = keymap::toggle_focus(self.focus, Side::Right, four),
            "shortcuts-help" => self.show_shortcuts = !self.show_shortcuts,
            "crossfader" => { self.crossfader = (self.crossfader + if chord.ends_with("Left") { -0.05 } else { 0.05 }).clamp(0.0, 1.0); self.ctl.send(Command::Crossfader { value: self.crossfader }); }
            "crossfader-big" => { self.crossfader = (self.crossfader + if chord.ends_with("Left") { -0.25 } else { 0.25 }).clamp(0.0, 1.0); self.ctl.send(Command::Crossfader { value: self.crossfader }); }
            "sampler" => if let Some(i) = idx { self.ctl.send(Command::SampleTrigger { slot: i, on: true }); },
            "fullscreen" => { let f = ctx.input(|i| i.viewport().fullscreen.unwrap_or(false)); ctx.send_viewport_cmd(egui::ViewportCommand::Fullscreen(!f)); }
            "reload" => self.toast("Reload is an Electron menu item; not needed here"),
            _ => self.toast(format!("{id}: not wired on Linux yet")),
        }
    }

    fn toggle_record(&mut self) {
        if let Some(r) = self.recording.take() { self.ctl.send(Command::Record(false)); let p = r.path.clone(); let res = r.finish(); self.toast(match res { Ok(n) => format!("Saved recording {} ({:.0} s)", p.display(), n as f64 / SR as f64), Err(e) => format!("Recording failed: {e}") }); self.rec_started = None; return; }
        let Some(rx) = self.ctl.rec.take() else { self.toast("Recording already used this session; restart to record again"); return };
        let dir = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Music").join("OpenDecks Recordings");
        let _ = std::fs::create_dir_all(&dir);
        let name = format!("OpenDecks {}.wav", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
        self.recording = Some(od_audio::recorder::start(rx, SR, dir.join(name)));
        self.ctl.send(Command::Record(true));
        self.rec_started = Some(Instant::now());
    }

    // ------------------------------------------------------------ MIDI
    fn open_midi(&mut self) {
        let m = crate::midi_in::open_all();
        let profiles = od_core::midi::Profiles::global();
        self.midi_bindings = m.ports.iter().enumerate().map(|(i, n)| { let p = profiles.for_device(n); (i, p.map(|p| p.bindings.clone()).unwrap_or_default(), slab::is_slab_port(n) || p.map(|p| p.driver.as_deref() == Some("slab")).unwrap_or(false)) }).collect();
        self.midi = Some(m);
    }
    fn poll_midi(&mut self) {
        let Some(m) = self.midi.as_ref() else { return };
        let msgs: Vec<(usize, Vec<u8>)> = m.rx.try_iter().collect();
        for (port, bytes) in msgs {
            let Some((_, bindings, is_slab)) = self.midi_bindings.get(port).cloned() else { continue };
            if is_slab { if let Some(ev) = self.slab.decode(&bytes) { self.slab_event(ev); } continue; }
            let Some(ev) = od_core::midi::parse_midi_message(&bytes) else { continue };
            let v = match ev { od_core::midi::MidiEvent::Cc { normalized, .. } | od_core::midi::MidiEvent::Noteon { normalized, .. } | od_core::midi::MidiEvent::Noteoff { normalized, .. } => normalized };
            let down = !matches!(ev, od_core::midi::MidiEvent::Noteoff { .. });
            for (target, b) in bindings.iter() { if od_core::midi::matches_binding(b, &ev) { self.midi_target(target, b, v, down); } }
        }
    }
    fn midi_target(&mut self, target: &str, b: &od_core::midi::MidiBinding, v: f64, down: bool) {
        let (scope, what) = target.split_once('.').unwrap_or(("", target));
        let deck = "ABCD".find(scope);
        match (deck, what) {
            (None, "crossfader") if scope == "mix" => { self.crossfader = v; self.ctl.send(Command::Crossfader { value: v }); }
            (None, "master") => { self.master = v as f32; self.ctl.send(Command::Master(self.master)); }
            (None, ch) if ch.starts_with("ch") => { let d = "ABCD".find(&ch[2..]).unwrap_or(0); self.decks[d].fader = v as f32; self.ctl.send(Command::Fader { deck: d, value: v as f32 }); }
            (None, n) if scope == "smp" => { if let Ok(i) = n.parse::<usize>() { if down { self.ctl.send(Command::SampleTrigger { slot: i - 1, on: true }); } } }
            (Some(d), "play") => if down && b.message == "note" { self.play_pause(d) },
            (Some(d), "cue") => if down && b.message == "note" { self.cue_button(d) },
            (Some(d), "sync") => if down { self.sync(d) },
            (Some(d), "loop") => if down { self.toggle_loop(d) },
            (Some(d), "pitch") => { let m = self.settings.max_tempo_percent; self.set_tempo(d, (v * 2.0 - 1.0) * m); }
            (Some(d), "trim") => { self.decks[d].trim = (v * 2.0) as f32; self.ctl.send(Command::Trim { deck: d, gain: self.decks[d].trim }); }
            (Some(d), "fxWet") => { self.decks[d].fx_wet = v as f32; self.push_fx(d); }
            (Some(d), e) if e.starts_with("eq") => { let band = match e { "eqLow" => 0, "eqMid" => 1, _ => 2 }; let db = od_core::midi::map_control_value(b, v, -26.0, 6.0); self.decks[d].eq[band] = db; self.ctl.send(Command::Eq { deck: d, band, db }); }
            (Some(d), p) if p.starts_with("pad") => { if let Ok(i) = p[3..].parse::<usize>() { self.pad(d, i - 1, down); } }
            _ => {}
        }
    }
    fn slab_event(&mut self, ev: slab::SlabEvent) {
        let d = "ABCD".find(self.focus.left).unwrap_or(0);
        match ev {
            slab::SlabEvent::Pad { pad, pressed, .. } => { let p = pad as usize; if p < 8 { self.pad(d, p, pressed); } else if pressed { self.ctl.send(Command::SampleTrigger { slot: p - 8, on: true }); } }
            slab::SlabEvent::Button { name: "play", pressed: true, .. } => self.play_pause(d),
            slab::SlabEvent::Button { name: "deck-select", pressed: true, .. } => self.focus = keymap::toggle_focus(self.focus, Side::Left, true),
            slab::SlabEvent::Encoder { index, delta, .. } => { let band = [2usize, 1, 0][index.min(2) as usize]; if index < 3 { self.decks[d].eq[band] = (self.decks[d].eq[band] + delta as f64 * 0.5).clamp(-26.0, 6.0); let db = self.decks[d].eq[band]; self.ctl.send(Command::Eq { deck: d, band, db }); } }
            slab::SlabEvent::Strip { value, .. } => { self.decks[d].fx = FxType::Filter; self.decks[d].fx_amount = slab::filter_amount(value) as f32; self.decks[d].fx_wet = 1.0; self.push_fx(d); }
            _ => {}
        }
    }

    // ------------------------------------------------------------ Link (opendeck-link/1)
    fn set_link(&mut self, on: bool) {
        if !on { self.link = None; self.settings.link_enabled = false; return; }
        match od_core::link::open_socket(od_core::link::LINK_PORT) {
            Ok(s) => { let mut st = od_core::link::LinkState::new(od_core::link::new_peer_id(), od_core::link::now_micros()); st.on_enable(); self.link = Some((st, s, Instant::now())); self.link_error = None; self.settings.link_enabled = true; }
            Err(e) => { self.link_error = Some(e.to_string()); self.settings.link_enabled = false; }
        }
    }
    fn poll_link(&mut self) {
        let Some((st, sock, last)) = self.link.as_mut() else { return };
        let mut buf = [0u8; 600];
        while let Ok((n, _)) = sock.recv_from(&mut buf) { st.on_message(&buf[..n], od_core::link::now_micros()); }
        if last.elapsed().as_millis() as u64 >= od_core::link::HEARTBEAT_MS {
            *last = Instant::now();
            st.sweep(od_core::link::now_micros());
            let p = st.packet();
            if p.len() <= od_core::link::MAX_PACKET_BYTES && sock.send_to(&p, (od_core::link::LINK_GROUP, od_core::link::LINK_PORT)).is_ok() { st.counters.sent += 1; }
        }
    }

    // ------------------------------------------------------------ USB (always asks)
    fn poll_usb(&mut self) {
        if self.usb_last.elapsed().as_secs() < 2 || self.usb_prompt.is_some() { return; }
        self.usb_last = Instant::now();
        let now = usb::scan_linux_volumes(&std::env::var("USER").unwrap_or_default());
        let (added, _) = usb::diff_volumes(&self.usb_known, &now);
        self.usb_known = now;
        for v in added {
            let key = usb::local_media_key(&v.label, None, None);
            match usb::decide(&key, &self.settings.usb_remembered) {
                usb::Decision::Import => self.import_volume(&v),
                usb::Decision::Ignore => {}
                usb::Decision::Prompt => { let msg = usb::prompt_message(&v.label, "this computer", None, false); self.usb_prompt = Some(UsbPrompt { volume: v, key, message: msg, always: false }); break; }
            }
        }
    }
    fn import_volume(&mut self, v: &usb::LocalVolume) {
        let n = if usb::rekordbox_pdb(&v.root).is_some() { self.lib.import_pdb(&v.root, &v.label).unwrap_or(0) } else { let c = format!("USB: {}", v.label); let before = self.lib.tracks.len(); self.lib.scan_dir(&v.root); for t in self.lib.tracks[before..].iter_mut() { t.crates.push(c.clone()); } self.lib.add_crate(&c); self.lib.tracks.len() - before };
        self.toast(format!("Added {n} tracks from {}", v.label));
    }

    // ------------------------------------------------------------ UI
    fn deck_ui(&mut self, ui: &mut Ui, d: usize, vertical: bool) {
        let color = DECK_COLORS[d];
        let pos = self.pos(d);
        let playing = self.playing(d);
        let u = self.decks[d].clone();
        let dur = u.duration;
        let remaining = (dur - pos).max(0.0);
        let end_warn = playing && dur > 0.0 && remaining < 30.0;
        ui.horizontal(|ui| {
            ui.label(RichText::new(DECK_NAMES[d].to_string()).strong().color(color).size(18.0));
            let title = if self.am_mode { "••••••".to_string() } else if u.loading { "Loading…".into() } else if u.title.is_empty() { "Empty deck".into() } else { format!("{} — {}", u.title, u.artist) };
            ui.label(RichText::new(title).strong());
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let t = format!("-{}:{:04.1}", (remaining / 60.0) as u32, remaining % 60.0);
                ui.label(RichText::new(t).monospace().color(if end_warn && (self.frames / 20) % 2 == 0 { Color32::RED } else { Color32::LIGHT_GRAY }));
                let bpm = u.bpm() * (1.0 + u.tempo_pct / 100.0);
                if let Some(mut e) = u.bpm_edit.clone() {
                    let r = ui.add(egui::TextEdit::singleline(&mut e).desired_width(60.0).id(egui::Id::new(("bpm-edit", d))));
                    if r.lost_focus() { if let Ok(v) = e.parse::<f64>() { self.decks[d].bpm_override = Some(v); } self.decks[d].bpm_edit = None; } else { self.decks[d].bpm_edit = Some(e); r.request_focus(); }
                } else if ui.add(egui::Label::new(RichText::new(format!("{bpm:.1} BPM")).monospace()).sense(egui::Sense::click())).double_clicked() { self.decks[d].bpm_edit = Some(format!("{:.2}", u.bpm())); }
                ui.label(RichText::new(u.analysis.as_ref().map(|a| format!("{} {}", a.camelot, a.key)).unwrap_or_default()).monospace());
                ui.label(RichText::new(sync::tempo_percent_label(u.tempo_pct, 1)).monospace());
            });
        });
        let marks = waveform::Marks { cue: Some(u.cue), hot: &u.hot, loop_range: if u.loop_on { u.loop_range } else { None }, bpm: u.bpm(), phase: u.phase() };
        let wave_h = if vertical { 260.0 } else { 90.0 };
        let (rect, resp) = ui.allocate_exact_size(egui::vec2(if vertical { 120.0 } else { ui.available_width() }, wave_h), egui::Sense::click_and_drag());
        waveform::scrolling(ui.painter(), rect, u.analysis.as_ref(), pos, self.settings.wave_span, vertical, marks, color);
        if resp.dragged() { let delta = if vertical { -resp.drag_delta().y / rect.height() } else { resp.drag_delta().x / rect.width() }; self.seek(d, pos - delta as f64 * self.settings.wave_span); }
        let (orect, oresp) = ui.allocate_exact_size(egui::vec2(ui.available_width(), 28.0), egui::Sense::click());
        waveform::overview(ui.painter(), orect, u.analysis.as_ref(), pos, Some(u.cue), end_warn);
        if oresp.clicked() { if let Some(p) = oresp.interact_pointer_pos() { self.seek(d, ((p.x - orect.left()) / orect.width()) as f64 * dur); } }
        ui.horizontal_wrapped(|ui| {
            if ui.button(if playing { "⏸ Pause" } else { "▶ Play" }).clicked() { self.play_pause(d); }
            if ui.button("CUE").clicked() { self.cue_button(d); }
            if ui.button("SYNC").clicked() { self.sync(d); }
            if ui.selectable_label(u.keylock, "KEY LOCK").clicked() { self.decks[d].keylock = !u.keylock; self.ctl.send(Command::Keylock { deck: d, on: !u.keylock }); }
            if ui.selectable_label(u.reverse, "REV").clicked() { self.decks[d].reverse = !u.reverse; self.ctl.send(Command::Reverse { deck: d, on: !u.reverse }); }
            if ui.selectable_label(u.loop_on, format!("LOOP {}", fmt_beats(u.loop_beats))).clicked() { self.toggle_loop(d); }
            if ui.small_button("½").clicked() { let b = (u.loop_beats / 2.0).max(0.125); if u.loop_on { self.set_loop(d, b, u.loop_range.map(|r| r.0)); } else { self.decks[d].loop_beats = b; } }
            if ui.small_button("×2").clicked() { let b = (u.loop_beats * 2.0).min(32.0); if u.loop_on { self.set_loop(d, b, u.loop_range.map(|r| r.0)); } else { self.decks[d].loop_beats = b; } }
            if ui.small_button("◀◀ 4").clicked() { self.beat_jump(d, -4.0); }
            if ui.small_button("4 ▶▶").clicked() { self.beat_jump(d, 4.0); }
            let mut t = u.tempo_pct;
            if ui.add(egui::Slider::new(&mut t, -self.settings.max_tempo_percent..=self.settings.max_tempo_percent).text("tempo %").step_by(0.05)).changed() { self.set_tempo(d, t); }
            if ui.small_button("⏏").on_hover_text("Eject").clicked() { self.eject(d); }
            ui.label(RichText::new(beatgrid::format_beat_position(pos, u.bpm(), u.phase())).monospace());
        });
        // pads
        ui.horizontal(|ui| {
            egui::ComboBox::from_id_salt(("pad-mode", d)).selected_text(pads::PAD_MODE_DEFS[u.pad_mode].label).show_ui(ui, |ui| { for (i, m) in pads::PAD_MODE_DEFS.iter().enumerate() { if ui.selectable_label(u.pad_mode == i, m.label).on_hover_text(m.hint).clicked() { self.decks[d].pad_mode = i; } } });
            for i in 0..8 {
                let lab = match pads::PAD_MODE_DEFS[u.pad_mode].id { "hot-cue" | "cue-loop" => if u.hot[i].is_some() { format!("●{}", i + 1) } else { format!("{}", i + 1) }, "loop-roll" => fmt_beats(pads::loop_roll_beats(i as f64)), "beat-jump" => format!("{:+}", pads::beat_jump_step(i as f64)), "pitch-play" => format!("{:+}", pads::pitch_play_semitones(i as f64)), "part-fx" => pads::PART_FX_PADS[i].replace("filter-", "F ").replace("mute-", "M "), "transport" => ["PLAY", "CUE", "SYNC", "LOOP", "REV", "-4", "+4", "KEY"][i].into(), "sequence" => ["REC", "PLAY", "1", "2", "3", "4", "5", "6"][i].into(), _ => format!("{}", i + 1) };
                let fill = if u.hot[i].is_some() && u.pad_mode <= 1 { waveform::cue_color(i).gamma_multiply(0.6) } else { Color32::from_gray(40) };
                let r = ui.add(egui::Button::new(RichText::new(lab).small()).fill(fill).min_size(egui::vec2(38.0, 26.0)).sense(egui::Sense::click_and_drag()));
                if r.is_pointer_button_down_on() && !ui.data(|m| m.get_temp::<bool>(r.id).unwrap_or(false)) { ui.data_mut(|m| m.insert_temp(r.id, true)); self.pad(d, i, true); }
                if !r.is_pointer_button_down_on() && ui.data(|m| m.get_temp::<bool>(r.id).unwrap_or(false)) { ui.data_mut(|m| m.insert_temp(r.id, false)); self.pad(d, i, false); }
            }
        });
        // FX
        ui.horizontal(|ui| {
            ui.label("FX");
            egui::ComboBox::from_id_salt(("fx", d)).selected_text(u.fx.label()).show_ui(ui, |ui| { for f in FX_DEFS { if ui.selectable_label(u.fx == f.id, f.label).on_hover_text(f.hint).clicked() { self.decks[d].fx = f.id; let p = od_core::fx::fx_default(f.id); self.decks[d].fx_amount = p.amount as f32; self.decks[d].fx_wet = p.wet as f32; self.decks[d].fx_div = DIVISIONS.iter().position(|x| *x == p.division).unwrap_or(2); self.push_fx(d); } } });
            egui::ComboBox::from_id_salt(("fxdiv", d)).width(48.0).selected_text(DIVISIONS[u.fx_div]).show_ui(ui, |ui| { for (i, v) in DIVISIONS.iter().enumerate() { if ui.selectable_label(u.fx_div == i, *v).clicked() { self.decks[d].fx_div = i; self.push_fx(d); } } });
            let (mut a, mut w) = (u.fx_amount, u.fx_wet);
            if ui.add(egui::Slider::new(&mut a, 0.0..=1.0).text("amount")).changed() { self.decks[d].fx_amount = a; self.push_fx(d); }
            if ui.add(egui::Slider::new(&mut w, 0.0..=1.0).text("wet")).changed() { self.decks[d].fx_wet = w; self.push_fx(d); }
            ui.label(RichText::new("Stems: ").weak());
            for (i, n) in od_stems::core::PART_ORDER.iter().enumerate() { if ui.selectable_label(!u.stems_mute[i], *n).on_hover_text("Stem mute needs separated stems (Building on Linux)").clicked() { self.decks[d].stems_mute[i] = !u.stems_mute[i]; } }
        });
    }

    fn mixer_ui(&mut self, ui: &mut Ui, decks: &[usize]) {
        ui.vertical_centered(|ui| { ui.label(RichText::new("MIXER").strong()); });
        ui.horizontal(|ui| {
            for &d in decks {
                ui.vertical(|ui| {
                    ui.label(RichText::new(DECK_NAMES[d].to_string()).color(DECK_COLORS[d]).strong());
                    let mut trim = self.decks[d].trim;
                    if ui.add(egui::Slider::new(&mut trim, 0.0..=2.0).text("trim").show_value(false)).changed() { self.decks[d].trim = trim; self.ctl.send(Command::Trim { deck: d, gain: trim }); }
                    for (band, name) in [(2usize, "HI"), (1, "MID"), (0, "LOW")] {
                        ui.horizontal(|ui| {
                            let mut v = self.decks[d].eq[band];
                            if ui.add(egui::Slider::new(&mut v, -26.0..=6.0).show_value(false).text(name)).changed() { self.decks[d].eq[band] = v; self.ctl.send(Command::Eq { deck: d, band, db: v }); }
                            let k = self.decks[d].kill[band];
                            if ui.selectable_label(k, "K").clicked() { self.decks[d].kill[band] = !k; self.ctl.send(Command::Kill { deck: d, band, on: !k }); }
                        });
                    }
                    let pk = self.ctl.status.peak(d);
                    ui.add(egui::ProgressBar::new(pk.min(1.0)).desired_width(80.0).fill(if pk > 0.95 { Color32::RED } else { Color32::from_rgb(60, 200, 90) }));
                    let mut f = self.decks[d].fader;
                    if ui.add(egui::Slider::new(&mut f, 0.0..=1.0).vertical().show_value(false)).changed() { self.decks[d].fader = f; self.ctl.send(Command::Fader { deck: d, value: f }); }
                    let pfl = self.decks[d].pfl;
                    if ui.selectable_label(pfl, "🎧 CUE").clicked() { self.decks[d].pfl = !pfl; self.ctl.send(Command::Pfl { deck: d, on: !pfl }); }
                });
            }
        });
        let mut x = self.crossfader;
        if ui.add(egui::Slider::new(&mut x, 0.0..=1.0).text("crossfader").show_value(false)).changed() { self.crossfader = x; self.ctl.send(Command::Crossfader { value: x }); }
        ui.horizontal(|ui| {
            let mut m = self.master; if ui.add(egui::Slider::new(&mut m, 0.0..=1.0).text("master")).changed() { self.master = m; self.ctl.send(Command::Master(m)); }
        });
        ui.horizontal(|ui| { let mut c = self.cue_mix; if ui.add(egui::Slider::new(&mut c, 0.0..=1.0).text("cue/master")).changed() { self.cue_mix = c; self.ctl.send(Command::CueMix(c)); } });
        let lim = self.ctl.status.limiter_db();
        ui.horizontal(|ui| {
            ui.add(egui::ProgressBar::new(self.ctl.status.master_peak().min(1.0)).desired_width(120.0).text("master"));
            if lim < -0.5 { ui.label(RichText::new(format!("LIMITER {lim:.1} dB")).color(Color32::RED).strong()); }
        });
        if ui.button(if self.recording.is_some() { "■ Stop recording" } else { "● Record mix" }).clicked() { self.toggle_record(); }
        if let Some(t) = self.rec_started { ui.label(format!("REC {:.0} s", t.elapsed().as_secs_f64())); }
    }

    fn sampler_ui(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            ui.label(RichText::new("SAMPLER").strong());
            for i in 0..8 {
                let name = self.sampler[i].clone().unwrap_or_else(|| "empty".into());
                let r = ui.add(egui::Button::new(RichText::new(format!("{} {}", i + 1, short(&name, 10))).small()).min_size(egui::vec2(90.0, 24.0)));
                if r.clicked() { if self.sampler[i].is_some() { self.ctl.send(Command::SampleTrigger { slot: i, on: true }); } else if let Some(t) = self.selected_track() { self.load_sample(i, t); } }
                if r.secondary_clicked() { if let Some(t) = self.selected_track() { self.load_sample(i, t); } }
            }
            let mut g = self.sampler_gain; if ui.add(egui::Slider::new(&mut g, 0.0..=1.0).text("vol").show_value(false)).changed() { self.sampler_gain = g; self.ctl.send(Command::SampleGain(g)); }
        });
    }
    fn load_sample(&mut self, slot: usize, t: usize) {
        let p = self.lib.tracks[t].path.clone();
        match decode::decode_file(&p) { Ok(d) => { self.sampler[slot] = Some(self.lib.tracks[t].title.clone()); self.ctl.send(Command::SampleLoad { slot, pcm: Arc::new(decode::to_engine_rate(d, SR)) }); } Err(e) => self.toast(e) }
    }

    fn library_ui(&mut self, ui: &mut Ui) {
        self.lib.poll();
        ui.horizontal(|ui| {
            ui.add(egui::TextEdit::singleline(&mut self.lib.search).hint_text("Search (Ctrl+F)").id(egui::Id::new("lib-search")).desired_width(240.0));
            if ui.button("Add folder…").clicked() { self.show_settings = true; }
            ui.label(RichText::new(format!("{} tracks · {} analysing", self.lib.tracks.len(), self.lib.pending)).weak());
            let four = self.settings.four_decks;
            if ui.selectable_label(four, "4 decks").clicked() { self.settings.four_decks = !four; self.focus = keymap::focus_for_mode(self.focus, !four); settings::save(&self.settings); }
            let v = self.settings.vertical_waves;
            if ui.selectable_label(v, "Vertical waves").clicked() { self.settings.vertical_waves = !v; settings::save(&self.settings); }
            if ui.button("⚙ Settings").clicked() { self.show_settings = true; }
            if ui.button("⌨ Shortcuts (?)").clicked() { self.show_shortcuts = true; }
        });
        ui.columns(2, |cols| {
            let (l, r) = cols.split_at_mut(1);
            let l = &mut l[0];
            let r = &mut r[0];
            l.set_max_width(220.0);
            egui::ScrollArea::vertical().id_salt("crates").show(l, |ui| {
                for (i, c) in self.lib.crates.clone().iter().enumerate() {
                    let sel = self.lib.selected_crate == i;
                    let text = if self.lib_focus_crates && sel { RichText::new(c).strong().underline() } else { RichText::new(c) };
                    if ui.selectable_label(sel, text).clicked() { self.lib.selected_crate = i; }
                }
            });
            let view = self.lib.view();
            let rows = view.len();
            egui::ScrollArea::vertical().id_salt("tracks").show_rows(r, 20.0, rows, |ui, range| {
                for &i in &view[range] {
                    let t = &self.lib.tracks[i];
                    let a = t.analysis.as_ref();
                    let label = format!("{:<40} {:<24} {:>6} {:>4} {:>6}", short(if self.am_mode { "••••" } else { &t.title }, 40), short(&t.artist, 24), a.map(|a| format!("{:.1}", a.bpm)).unwrap_or_else(|| if t.error.is_some() { "err".into() } else { "…".into() }), a.map(|a| a.camelot.clone()).unwrap_or_default(), a.map(|a| format!("{}:{:02}", (a.duration / 60.0) as u32, (a.duration % 60.0) as u32)).unwrap_or_default());
                    let sel = self.lib.cursor.as_deref() == Some(t.id.as_str());
                    let resp = ui.selectable_label(sel, RichText::new(label).monospace());
                    let id = t.id.clone();
                    if resp.clicked() { self.lib.cursor = Some(id.clone()); }
                    if resp.double_clicked() { let d = "ABCD".find(self.focus.left).unwrap_or(0); self.load_track(d, i); }
                    resp.context_menu(|ui| { for d in 0..if self.settings.four_decks { 4 } else { 2 } { if ui.button(format!("Load on deck {}", DECK_NAMES[d])).clicked() { self.load_track(d, i); ui.close_menu(); } } });
                    self.lib.queue_analysis(i);
                }
            });
        });
    }

    fn settings_ui(&mut self, ctx: &egui::Context) {
        let mut open = self.show_settings;
        egui::Window::new("Settings").open(&mut open).default_width(520.0).show(ctx, |ui| {
            ui.heading("Library");
            let mut add = None;
            ui.horizontal(|ui| { let id = egui::Id::new("add-dir"); let mut s: String = ui.data(|m| m.get_temp(id).unwrap_or_default()); ui.add(egui::TextEdit::singleline(&mut s).hint_text("/home/you/Music").desired_width(300.0)); ui.data_mut(|m| m.insert_temp(id, s.clone())); if ui.button("Add music folder").clicked() && !s.is_empty() { add = Some(s); } });
            if let Some(s) = add { let n = self.lib.scan_dir(std::path::Path::new(&s)); self.settings.music_dirs.push(s); self.toast(format!("Added {n} tracks")); }
            for d in self.settings.music_dirs.clone() { ui.label(format!("• {d}")); }
            if ui.button("Import Serato crates from ~/Music/_Serato_").clicked() { let p = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Music/_Serato_"); match self.lib.import_serato(&p) { Ok(n) => self.toast(format!("Imported {n} crate entries")), Err(e) => self.toast(e) } }
            ui.separator();
            ui.heading("Decks");
            ui.checkbox(&mut self.settings.four_decks, "4-deck layout");
            ui.checkbox(&mut self.settings.vertical_waves, "Vertical scrolling waveforms");
            ui.checkbox(&mut self.settings.quantize, "Quantize cues and loops to the beat grid");
            ui.add(egui::Slider::new(&mut self.settings.max_tempo_percent, 4.0..=50.0).text("tempo range %"));
            ui.add(egui::Slider::new(&mut self.settings.wave_span, 2.0..=32.0).text("waveform span (s)"));
            ui.separator();
            ui.heading("Keyboard");
            ui.checkbox(&mut self.settings.keyboard_shortcuts, "Serato-style keyboard shortcuts");
            ui.separator();
            ui.heading("Mixer");
            egui::ComboBox::from_label("Crossfader curve").selected_text(self.settings.crossfader_curve.clone()).show_ui(ui, |ui| { for c in ["smooth", "fast", "cut"] { if ui.selectable_label(self.settings.crossfader_curve == c, c).clicked() { self.settings.crossfader_curve = c.into(); self.ctl.send(Command::CrossCurve(CrossfaderCurve::parse(c))); } } });
            egui::ComboBox::from_label("Channel fader curve").selected_text(self.settings.fader_curve.clone()).show_ui(ui, |ui| { for c in ["linear", "log", "sharp"] { if ui.selectable_label(self.settings.fader_curve == c, c).clicked() { self.settings.fader_curve = c.into(); self.ctl.send(Command::FaderCurve(ChannelFaderCurve::parse(c))); } } });
            ui.separator();
            ui.heading("Audio");
            ui.label(format!("Output: {}", self.out_desc));
            ui.label(format!("Callbacks {} · late {} · xruns {} · worst callback {:.2} ms", self.ctl.status.callbacks.load(std::sync::atomic::Ordering::Relaxed), self.ctl.status.late_callbacks.load(std::sync::atomic::Ordering::Relaxed), self.ctl.status.xruns.load(std::sync::atomic::Ordering::Relaxed), self.ctl.status.max_callback_ns.load(std::sync::atomic::Ordering::Relaxed) as f64 / 1e6));
            egui::ComboBox::from_label("Buffer (applies on restart)").selected_text(format!("{}", self.settings.buffer_frames)).show_ui(ui, |ui| { for b in [64u32, 128, 256, 512, 1024] { if ui.selectable_label(self.settings.buffer_frames == b, b.to_string()).clicked() { self.settings.buffer_frames = b; } } });
            egui::ComboBox::from_label("Output device (applies on restart)").selected_text(self.settings.output_device.clone().unwrap_or_else(|| "default".into())).show_ui(ui, |ui| { if ui.selectable_label(self.settings.output_device.is_none(), "default").clicked() { self.settings.output_device = None; } for dname in od_audio::output::list_devices() { let n = dname.split_once(": ").map(|x| x.1.to_string()).unwrap_or(dname.clone()); if ui.selectable_label(self.settings.output_device.as_deref() == Some(&n), &dname).clicked() { self.settings.output_device = Some(n); } } });
            ui.label(RichText::new("Headphones: a 4-channel card plays the cue mix on outputs 3-4.").weak());
            ui.separator();
            ui.heading("MIDI");
            match &self.midi { Some(m) => { if let Some(e) = &m.error { ui.label(format!("MIDI unavailable: {e}")); } if m.ports.is_empty() { ui.label("No MIDI inputs found."); } for (i, p) in m.ports.iter().enumerate() { let prof = od_core::midi::Profiles::global().for_device(p).map(|x| x.label.clone()).unwrap_or_else(|| "no profile".into()); let drv = self.midi_bindings.get(i).map(|b| b.2).unwrap_or(false); ui.label(format!("• {p} → {prof}{}", if drv { " (SLAB driver)" } else { "" })); } } None => { ui.label("MIDI off"); } }
            if ui.button("Rescan MIDI").clicked() { self.open_midi(); }
            ui.separator();
            ui.heading("Link (opendeck-link/1, not Ableton Link)");
            let mut l = self.link.is_some();
            if ui.checkbox(&mut l, "Share tempo on the local network").changed() { self.set_link(l); }
            if let Some((st, _, _)) = &self.link { ui.label(st.status_line(None)); }
            if let Some(e) = &self.link_error { ui.label(format!("link unavailable · {e}")); }
        });
        if open != self.show_settings || !open { settings::save(&self.settings); }
        self.show_settings = open;
    }

    fn shortcuts_ui(&mut self, ctx: &egui::Context) {
        let mut open = self.show_shortcuts;
        egui::Window::new("Keyboard shortcuts").open(&mut open).default_size([720.0, 560.0]).show(ctx, |ui| {
            ui.label(if self.settings.keyboard_shortcuts { "Serato DJ layout. Left keys follow deck A/C (F1), right keys B/D (F6)." } else { "Keyboard shortcuts are off (Settings → Keyboard)." });
            egui::ScrollArea::vertical().show(ui, |ui| {
                for sec in ["playback", "library", "opendecks"] {
                    ui.heading(match sec { "playback" => "Playback", "library" => "Library", _ => "OpenDecks" });
                    egui::Grid::new(sec).striped(true).show(ui, |ui| {
                        for b in Keymap::global().bindings.iter().filter(|b| b.section == sec) {
                            ui.label(&b.label);
                            ui.label(RichText::new(&b.display).monospace());
                            ui.label(RichText::new(b.right_display.clone().unwrap_or_default()).monospace());
                            ui.label(RichText::new(match b.status.as_str() { "noop" => "not yet", "partial" => "partial", _ => "" }).weak());
                            ui.end_row();
                        }
                    });
                }
            });
        });
        self.show_shortcuts = open;
    }

    fn bench_tick(&mut self, ctx: &egui::Context) {
        let Some(secs) = self.args.bench_scroll else { return };
        let all_loaded = (0..4).all(|d| self.ctl.status.decks[d].loaded.load(std::sync::atomic::Ordering::Relaxed));
        if !all_loaded { return; }
        let started = *self.bench_started.get_or_insert_with(Instant::now);
        if started.elapsed().as_secs_f64() < 2.0 { self.frame_times.clear(); self.cpu_start = Some((proc_cpu_seconds(), Instant::now())); return; }
        if started.elapsed().as_secs_f64() >= secs + 2.0 {
            let mut f = self.frame_times.clone();
            f.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let q = |p: f64| f.get(((f.len() as f64 - 1.0) * p).round() as usize).copied().unwrap_or(0.0);
            let (c0, t0) = self.cpu_start.unwrap_or((0.0, started));
            let cpu = (proc_cpu_seconds() - c0) / t0.elapsed().as_secs_f64() * 100.0;
            let st = &self.ctl.status;
            println!("SCROLL {}", serde_json::json!({"frames": f.len(), "frameMsMedian": q(0.5), "frameMsP95": q(0.95), "frameMsP99": q(0.99), "frameMsMax": q(1.0), "fps": f.len() as f64 / secs, "cpuPercent": cpu, "rssMb": rss_mb(), "audio": self.out_desc, "lateCallbacks": st.late_callbacks.load(std::sync::atomic::Ordering::Relaxed), "xruns": st.xruns.load(std::sync::atomic::Ordering::Relaxed), "decksPlaying": (0..4).filter(|&d| st.playing(d)).count()}));
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
    }
}

fn short(s: &str, n: usize) -> String { if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n - 1).collect::<String>()) } }
fn fmt_beats(b: f64) -> String { if b >= 1.0 { format!("{b}") } else { format!("1/{}", (1.0 / b).round()) } }

impl eframe::App for OpenDecks {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let now = Instant::now();
        if let Some(l) = self.last_frame { self.frame_times.push(now.duration_since(l).as_secs_f64() * 1000.0); }
        self.last_frame = Some(now);
        self.ctl.collect();
        self.poll_loaded();
        for d in 0..4 { if let Some(t) = self.decks[d].held_cue.take() { if self.ctl.status.decks[d].loaded.load(std::sync::atomic::Ordering::Relaxed) { self.seek(d, t); } else { self.decks[d].held_cue = Some(t); } } }
        self.poll_midi();
        self.poll_link();
        self.poll_usb();
        self.handle_keys(ctx);
        let four = self.settings.four_decks;
        let vertical = self.settings.vertical_waves;
        egui::TopBottomPanel::top("top").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new("OpenDecks").strong().size(16.0));
                ui.label(RichText::new(format!("Linux · egui/wgpu · {}", self.out_desc)).weak());
                if self.ctl.status.limiter_db() < -0.5 { ui.label(RichText::new("⚠ LIMITER").color(Color32::RED).strong()); }
                if let Some((st, _, _)) = &self.link { ui.label(RichText::new(st.status_line(None)).weak()); }
                if four { ui.label(RichText::new(format!("keys: {} / {}", self.focus.left, self.focus.right)).weak()); }
            });
        });
        egui::TopBottomPanel::bottom("library").resizable(true).default_height(300.0).show(ctx, |ui| { self.sampler_ui(ui); ui.separator(); self.library_ui(ui); });
        let decks: Vec<usize> = if four { vec![0, 1, 2, 3] } else { vec![0, 1] };
        egui::SidePanel::right("mixer").default_width(300.0).show(ctx, |ui| { egui::ScrollArea::vertical().show(ui, |ui| self.mixer_ui(ui, &decks)); });
        egui::CentralPanel::default().show(ctx, |ui| {
            egui::ScrollArea::vertical().show(ui, |ui| {
                if vertical {
                    ui.columns(decks.len(), |cols| { for (c, &d) in cols.iter_mut().zip(&decks) { c.push_id(d, |ui| self.deck_ui(ui, d, true)); } });
                } else {
                    for &d in &decks { ui.push_id(d, |ui| { egui::Frame::group(ui.style()).show(ui, |ui| self.deck_ui(ui, d, false)); }); }
                }
            });
        });
        if self.show_settings { self.settings_ui(ctx); }
        if self.show_shortcuts { self.shortcuts_ui(ctx); }
        if let Some(p) = self.usb_prompt.clone() {
            let mut decided = None;
            egui::Window::new("Drive detected").collapsible(false).resizable(false).anchor(egui::Align2::CENTER_TOP, [0.0, 60.0]).show(ctx, |ui| {
                ui.label(&p.message);
                let mut a = p.always; if ui.checkbox(&mut a, usb::REMEMBER_LABEL).changed() { if let Some(x) = self.usb_prompt.as_mut() { x.always = a; } }
                ui.horizontal(|ui| { if ui.button(usb::ADD_LABEL).clicked() { decided = Some("add"); } if ui.button(usb::DISMISS_LABEL).clicked() { decided = Some("ignore"); } });
            });
            if let Some(act) = decided { let p = self.usb_prompt.take().unwrap(); usb::remember(&mut self.settings.usb_remembered, &p.key, act, p.always); settings::save(&self.settings); if act == "add" { self.import_volume(&p.volume); } }
        }
        if self.quit_confirm {
            egui::Window::new("Quit OpenDecks?").collapsible(false).anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0]).show(ctx, |ui| { ui.horizontal(|ui| { if ui.button("Quit").clicked() { settings::save(&self.settings); ctx.send_viewport_cmd(egui::ViewportCommand::Close); } if ui.button("Cancel").clicked() { self.quit_confirm = false; } }); });
        }
        if let Some((t, at)) = &self.toast { if at.elapsed().as_secs() < 4 { egui::Area::new(egui::Id::new("toast")).anchor(egui::Align2::CENTER_BOTTOM, [0.0, -320.0]).show(ctx, |ui| { egui::Frame::popup(ui.style()).show(ui, |ui| ui.label(t.as_str())); }); } else { self.toast = None; } }
        self.frames += 1;
        if self.frames == 2 && !self.first_frame_done { self.first_frame_done = true; println!("FIRST_FRAME [] {:.1}", self.start.elapsed().as_secs_f64() * 1000.0); }
        self.bench_tick(ctx);
        ctx.request_repaint();
    }
}

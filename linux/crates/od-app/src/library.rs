//! Library: folder scan, Serato crates (~/Music/_Serato_), USB/rekordbox
//! drives, search, and background analysis (od_core::analysis, the port of
//! analyzeBuffer) with results cached by file hash.
use od_core::analysis::{analyze, Audio};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;

pub const AUDIO_EXT: [&str; 6] = ["wav", "flac", "mp3", "ogg", "oga", "f32"];

#[derive(Clone, Default)]
pub struct Analysis { pub bpm: f64, pub beat_phase: f64, pub key: String, pub camelot: String, pub duration: f64, pub peaks: Arc<Vec<f32>>, pub low: Arc<Vec<f32>>, pub mid: Arc<Vec<f32>>, pub high: Arc<Vec<f32>>, pub buckets_per_sec: f64 }

#[derive(Clone)]
pub struct Track { pub id: String, pub path: PathBuf, pub title: String, pub artist: String, pub crates: Vec<String>, pub analysis: Option<Analysis>, pub error: Option<String>, pub queued: bool }

pub struct Library {
    pub tracks: Vec<Track>,
    pub crates: Vec<String>,
    pub search: String,
    pub selected_crate: usize,
    pub cursor: Option<String>,
    by_path: HashMap<PathBuf, usize>,
    tx: Sender<(String, Result<Analysis, String>)>,
    pub rx: Receiver<(String, Result<Analysis, String>)>,
    pub pending: usize,
}

pub fn title_artist(p: &Path) -> (String, String) {
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    match stem.split_once(" - ") { Some((a, t)) => (t.trim().to_string(), a.trim().to_string()), None => (stem, String::new()) }
}

impl Library {
    pub fn new() -> Self {
        let (tx, rx) = channel();
        Library { tracks: vec![], crates: vec!["All tracks".into()], search: String::new(), selected_crate: 0, cursor: None, by_path: HashMap::new(), tx, rx, pending: 0 }
    }
    pub fn add_file(&mut self, p: &Path, crate_name: Option<&str>) -> Option<usize> {
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if !AUDIO_EXT.contains(&ext.as_str()) { return None; }
        let idx = if let Some(&i) = self.by_path.get(p) { i } else {
            let (title, artist) = title_artist(p);
            let i = self.tracks.len();
            self.tracks.push(Track { id: format!("t{i}"), path: p.to_path_buf(), title, artist, crates: vec![], analysis: None, error: None, queued: false });
            self.by_path.insert(p.to_path_buf(), i);
            i
        };
        if let Some(c) = crate_name { self.add_crate(c); if !self.tracks[idx].crates.iter().any(|x| x == c) { self.tracks[idx].crates.push(c.to_string()); } }
        Some(idx)
    }
    pub fn add_crate(&mut self, c: &str) { if !self.crates.iter().any(|x| x == c) { self.crates.push(c.to_string()); } }
    /// Recursive folder scan; each top folder becomes a crate.
    pub fn scan_dir(&mut self, dir: &Path) -> usize {
        let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| dir.display().to_string());
        let mut stack = vec![dir.to_path_buf()];
        let mut n = 0;
        while let Some(d) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            let mut ents: Vec<_> = rd.flatten().map(|e| e.path()).collect();
            ents.sort();
            for p in ents { if p.is_dir() { if !p.file_name().map(|f| f.to_string_lossy().starts_with('.')).unwrap_or(true) { stack.push(p); } } else if self.add_file(&p, Some(&name)).is_some() { n += 1; } }
        }
        n
    }
    /// Serato crates: _Serato_/Subcrates/*.crate (paths are relative to the drive root).
    pub fn import_serato(&mut self, serato_dir: &Path) -> Result<usize, String> {
        let sub = serato_dir.join("Subcrates");
        let rd = std::fs::read_dir(&sub).map_err(|e| format!("{}: {e}", sub.display()))?;
        let root = serato_dir.parent().and_then(|p| if p.ends_with("Music") { p.parent().and_then(|h| h.parent()).map(|_| PathBuf::from("/")) } else { Some(p.to_path_buf()) }).unwrap_or_else(|| PathBuf::from("/"));
        let mut n = 0;
        let mut files: Vec<_> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|e| e == "crate").unwrap_or(false)).collect();
        files.sort();
        for f in files {
            let bytes = std::fs::read(&f).map_err(|e| e.to_string())?;
            let c = od_core::library::decode_crate(&bytes)?;
            let name = f.file_stem().unwrap().to_string_lossy().replace("%%", " / ");
            self.add_crate(&name);
            for p in c.paths { let full = root.join(p.trim_start_matches('/')); if self.add_file(&full, Some(&name)).is_some() { n += 1; } }
        }
        Ok(n)
    }
    /// A rekordbox USB export: tracks and playlists from export.pdb.
    pub fn import_pdb(&mut self, root: &Path, label: &str) -> Result<usize, String> {
        let pdb = od_core::usb::rekordbox_pdb(root).ok_or("no PIONEER/rekordbox/export.pdb")?;
        let bytes = std::fs::read(&pdb).map_err(|e| e.to_string())?;
        let db = od_core::library::parse_pdb(&bytes)?;
        let base = format!("USB: {label}");
        let mut n = 0;
        let mut by_id = HashMap::new();
        for t in &db.tracks { if let Some(i) = self.add_file(&root.join(t.path.trim_start_matches('/')), Some(&base)) { by_id.insert(t.id, i); n += 1; } }
        for (_, path, ids) in od_core::library::playlist_paths(&db) {
            let c = format!("{base} / {}", path.join(" / "));
            self.add_crate(&c);
            for id in ids { if let Some(&i) = by_id.get(&id) { if !self.tracks[i].crates.contains(&c) { self.tracks[i].crates.push(c.clone()); } } }
        }
        Ok(n)
    }
    pub fn view(&self) -> Vec<usize> {
        let q = self.search.to_lowercase();
        let c = self.crates.get(self.selected_crate).cloned().unwrap_or_default();
        (0..self.tracks.len()).filter(|&i| {
            let t = &self.tracks[i];
            (self.selected_crate == 0 || t.crates.contains(&c)) && (q.is_empty() || t.title.to_lowercase().contains(&q) || t.artist.to_lowercase().contains(&q) || t.analysis.as_ref().map(|a| a.key.to_lowercase().contains(&q) || format!("{:.0}", a.bpm).contains(&q)).unwrap_or(false))
        }).collect()
    }
    pub fn queue_analysis(&mut self, idx: usize) {
        let t = &mut self.tracks[idx];
        if t.queued || t.analysis.is_some() { return; }
        t.queued = true;
        self.pending += 1;
        let (id, path, tx) = (t.id.clone(), t.path.clone(), self.tx.clone());
        rayon::spawn(move || { let _ = tx.send((id, analyze_file(&path))); });
    }
    pub fn poll(&mut self) -> bool {
        let mut any = false;
        while let Ok((id, r)) = self.rx.try_recv() {
            self.pending = self.pending.saturating_sub(1);
            if let Some(t) = self.tracks.iter_mut().find(|t| t.id == id) { match r { Ok(a) => t.analysis = Some(a), Err(e) => t.error = Some(e) } }
            any = true;
        }
        any
    }
    pub fn index_of(&self, id: &str) -> Option<usize> { self.tracks.iter().position(|t| t.id == id) }
}

pub const BUCKETS_PER_SEC: f64 = 150.0;

pub fn analyze_decoded(sr: f64, channels: &[Vec<f32>]) -> Analysis {
    let len = channels.first().map(|c| c.len()).unwrap_or(0);
    let audio = Audio { sample_rate: sr, length: len, channels };
    let dur = len as f64 / sr;
    let buckets = ((dur * BUCKETS_PER_SEC) as usize).max(64);
    let r = analyze(&audio, buckets);
    Analysis { bpm: r.bpm, beat_phase: r.beat_phase, key: r.key.key.clone(), camelot: r.key.camelot.clone(), duration: r.duration, peaks: Arc::new(r.peaks), low: Arc::new(r.low), mid: Arc::new(r.mid), high: Arc::new(r.high), buckets_per_sec: buckets as f64 / dur.max(1e-9) }
}
pub fn analyze_file(p: &Path) -> Result<Analysis, String> {
    let d = od_audio::decode::decode_file(p)?;
    Ok(analyze_decoded(d.sample_rate as f64, &d.channels))
}

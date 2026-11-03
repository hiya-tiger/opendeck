//! Port of src/main/prolink/prompt.ts and the Linux half of volumes.ts:
//! detected media is never imported silently; it asks (Add / Not now /
//! "Always do this for this drive"), unless that drive's mediaKey was
//! remembered.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision { Import, Ignore, Prompt }

pub type Remembered = BTreeMap<String, String>;

pub fn decide(media_key: &str, remembered: &Remembered) -> Decision {
    match remembered.get(media_key).map(|s| s.as_str()) { Some("add") => Decision::Import, Some("ignore") => Decision::Ignore, _ => Decision::Prompt }
}
pub fn remember(r: &mut Remembered, media_key: &str, action: &str, always: bool) { if always && !media_key.is_empty() { r.insert(media_key.to_string(), action.to_string()); } }
pub fn forget(r: &mut Remembered, media_key: &str) { r.remove(media_key); }
fn clean(s: &str) -> String { s.chars().filter(|c| (*c as u32) >= 0x20).collect::<String>().trim().to_string() }
pub fn cdj_media_key(name: &str, created: &str, total: u64, tracks: u64) -> String { format!("cdj:{}|{}|{}|{}", clean(name).to_lowercase(), clean(created), total, tracks) }
pub fn local_media_key(label: &str, serial: Option<&str>, total: Option<u64>) -> String {
    if let Some(s) = serial.filter(|s| !s.is_empty()) { return format!("local:serial:{}", clean(s).to_lowercase()); }
    format!("local:{}|{}", clean(label).to_lowercase(), total.unwrap_or(0))
}
pub fn prompt_message(media_name: &str, where_: &str, track_count: Option<u64>, sd: bool) -> String {
    let what = if sd { "SD card" } else { "USB drive" };
    let name = if media_name.is_empty() { "(unnamed)".to_string() } else { format!("'{media_name}'") };
    let count = match track_count { None => String::new(), Some(n) => format!(" ({n} track{})", if n == 1 { "" } else { "s" }) };
    format!("{what} {name} found on {where_}{count}. Add it to your library?")
}
pub const ADD_LABEL: &str = "Add";
pub const DISMISS_LABEL: &str = "Not now";
pub const REMEMBER_LABEL: &str = "Always do this for this drive";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalVolume { pub root: PathBuf, pub label: String }

/// Linux mount points: /media/$USER/*, /run/media/$USER/*, /media/<label>.
pub fn scan_linux_volumes(user: &str) -> Vec<LocalVolume> {
    let mut out = vec![];
    for base in [format!("/media/{user}"), format!("/run/media/{user}")] {
        if let Ok(rd) = std::fs::read_dir(&base) { for e in rd.flatten() { if e.path().is_dir() { out.push(LocalVolume { root: e.path(), label: e.file_name().to_string_lossy().into() }); } } }
    }
    if let Ok(rd) = std::fs::read_dir("/media") {
        for e in rd.flatten() { let p = e.path(); if p.is_dir() && e.file_name().to_string_lossy() != user && is_mount_point(&p) { out.push(LocalVolume { root: p, label: e.file_name().to_string_lossy().into() }); } }
    }
    out.sort_by(|a, b| a.root.cmp(&b.root));
    out
}
fn is_mount_point(p: &Path) -> bool {
    std::fs::read_to_string("/proc/self/mounts").map(|m| m.lines().any(|l| l.split(' ').nth(1).map(|mp| Path::new(mp) == p).unwrap_or(false))).unwrap_or(false)
}
/// rekordbox export on a stick: PIONEER/rekordbox/export.pdb
pub fn rekordbox_pdb(root: &Path) -> Option<PathBuf> {
    let p = root.join("PIONEER").join("rekordbox").join("export.pdb");
    p.exists().then_some(p)
}
pub fn diff_volumes(prev: &[LocalVolume], next: &[LocalVolume]) -> (Vec<LocalVolume>, Vec<LocalVolume>) {
    let added = next.iter().filter(|v| !prev.iter().any(|p| p.root == v.root)).cloned().collect();
    let removed = prev.iter().filter(|v| !next.iter().any(|n| n.root == v.root)).cloned().collect();
    (added, removed)
}

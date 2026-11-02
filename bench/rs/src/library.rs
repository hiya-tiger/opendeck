//! Ports of the library import parsers:
//!   serato-codec.ts  readChunks / decodeCrate / decodeDatabase
//!   serato-tags.ts   decodeMarkers2 / base64Decode / decodeBeatGrid
//!   prolink/pdb.ts   parsePdb / readDeviceSqlString / tableRows / playlistPaths
//!   prolink/anlz.ts  parseAnlzCues
//! plus canonical(), the same text bench/ts/canonical.ts writes.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write;

// ---------------------------------------------------------------- Serato chunks
pub struct Chunk<'a> {
    pub tag: [u8; 4],
    pub payload: &'a [u8],
}

pub fn read_chunks(bytes: &[u8]) -> Result<Vec<Chunk<'_>>, String> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off + 8 <= bytes.len() {
        let tag = [bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]];
        let len = u32::from_be_bytes(bytes[off + 4..off + 8].try_into().unwrap()) as usize;
        let start = off + 8;
        let end = start + len;
        if end > bytes.len() {
            return Err(format!("Truncated {} chunk", String::from_utf8_lossy(&tag)));
        }
        out.push(Chunk { tag, payload: &bytes[start..end] });
        off = end;
    }
    Ok(out)
}

fn utf16be_skip_nul(b: &[u8]) -> String {
    let units: Vec<u16> = b.chunks_exact(2).map(|p| u16::from_be_bytes([p[0], p[1]])).filter(|u| *u != 0).collect();
    String::from_utf16_lossy(&units)
}

fn tag_str(t: &[u8; 4]) -> String {
    t.iter().map(|b| *b as char).collect()
}

pub struct Crate {
    pub version: String,
    pub columns: Vec<(String, String)>,
    pub paths: Vec<String>,
}

pub fn decode_crate(input: &[u8]) -> Result<Crate, String> {
    let mut c = Crate { version: String::new(), columns: vec![], paths: vec![] };
    for ch in read_chunks(input)? {
        match &ch.tag {
            b"vrsn" => c.version = utf16be_skip_nul(ch.payload),
            b"ovct" => {
                let mut fields: HashMap<[u8; 4], String> = HashMap::new();
                for f in read_chunks(ch.payload)? {
                    fields.insert(f.tag, utf16be_skip_nul(f.payload));
                }
                if let Some(n) = fields.get(b"tvcn") {
                    c.columns.push((n.clone(), fields.get(b"tvcw").cloned().unwrap_or_else(|| "250".into())));
                }
            }
            b"otrk" => {
                for f in read_chunks(ch.payload)? {
                    if &f.tag == b"ptrk" || &f.tag == b"pfil" {
                        c.paths.push(utf16be_skip_nul(f.payload));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(c)
}

pub enum Val {
    S(String),
    U(u32),
    B(bool),
}

pub struct Database {
    pub version: String,
    pub tracks: Vec<BTreeMap<String, Val>>,
}

pub fn decode_database(input: &[u8]) -> Result<Database, String> {
    let mut db = Database { version: String::new(), tracks: vec![] };
    for ch in read_chunks(input)? {
        if &ch.tag == b"vrsn" {
            db.version = utf16be_skip_nul(ch.payload);
        } else if &ch.tag == b"otrk" {
            let mut t = BTreeMap::new();
            for f in read_chunks(ch.payload)? {
                let k = tag_str(&f.tag);
                // TEXT_TAGS, ttyp and pfil all start with t or p.
                if f.tag[0] == b't' || f.tag[0] == b'p' {
                    t.insert(k, Val::S(utf16be_skip_nul(f.payload)));
                } else if f.tag[0] == b'u' && f.payload.len() == 4 {
                    t.insert(k, Val::U(u32::from_be_bytes(f.payload.try_into().unwrap())));
                } else if f.tag[0] == b'b' && f.payload.len() == 1 {
                    t.insert(k, Val::B(f.payload[0] != 0));
                }
            }
            db.tracks.push(t);
        }
    }
    Ok(db)
}

// ---------------------------------------------------------------- Serato tags
pub struct Cue {
    pub index: u8,
    pub position_ms: u32,
    pub color: String,
    pub name: String,
}
pub struct Loop {
    pub index: u8,
    pub start_ms: u32,
    pub end_ms: u32,
    pub color: String,
    pub locked: bool,
    pub name: String,
}
pub struct Markers {
    pub cues: Vec<Cue>,
    pub loops: Vec<Loop>,
    pub track_color: String,
    pub bpm_locked: bool,
}

fn rgb_hex(r: u8, g: u8, b: u8) -> String {
    format!("#{:02X}{:02X}{:02X}", r, g, b)
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_index(c: Option<u8>) -> i32 {
    match c {
        Some(c) => B64.iter().position(|x| *x == c).map(|p| p as i32).unwrap_or(-1),
        None => -1,
    }
}

pub fn base64_decode(text: &[u8]) -> Result<Vec<u8>, String> {
    let clean: Vec<u8> = text.iter().copied().filter(|c| c.is_ascii_alphanumeric() || *c == b'+' || *c == b'/' || *c == b'=').collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    let at = |i: usize| clean.get(i).copied();
    let mut i = 0;
    while i < clean.len() {
        let a = b64_index(at(i));
        let b = b64_index(at(i + 1));
        let c2 = at(i + 2);
        let d2 = at(i + 3);
        let c = if c2 == Some(b'=') || c2.is_none() { 0 } else { b64_index(c2) };
        let d = if d2 == Some(b'=') || d2.is_none() { 0 } else { b64_index(d2) };
        if a < 0 || b < 0 || c < 0 || d < 0 {
            return Err("Invalid base64".into());
        }
        let triple = (a << 18) | (b << 12) | (c << 6) | d;
        out.push(((triple >> 16) & 0xff) as u8);
        if c2 != Some(b'=') && c2.is_some() {
            out.push(((triple >> 8) & 0xff) as u8);
        }
        if d2 != Some(b'=') && d2.is_some() {
            out.push((triple & 0xff) as u8);
        }
        i += 4;
    }
    Ok(out)
}

fn be32(b: &[u8], o: usize) -> u32 {
    u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

pub fn decode_markers2(raw: &[u8]) -> Result<Markers, String> {
    if raw.len() < 2 || raw[0] != 1 || raw[1] != 1 {
        return Err("Bad Serato Markers2 header".into());
    }
    let end = raw[2..].iter().position(|b| *b == 0).map(|p| p + 2).unwrap_or(raw.len());
    let mut text: Vec<u8> = raw[2..end].iter().copied().filter(|c| *c != b'\r' && *c != b'\n').collect();
    // String.fromCharCode on bytes >= 0x80 makes non-base64 chars that the
    // clean step drops; filtering bytes directly is equivalent.
    let rem = text.len() % 4;
    if rem == 1 {
        text.extend_from_slice(b"A==");
    } else if rem != 0 {
        text.extend(std::iter::repeat(b'=').take(4 - rem));
    }
    let inner = base64_decode(&text)?;
    if inner.len() < 2 || inner[0] != 1 || inner[1] != 1 {
        return Err("Bad Serato Markers2 payload".into());
    }
    let mut m = Markers { cues: vec![], loops: vec![], track_color: "#FFFFFF".into(), bpm_locked: false };
    let mut off = 2;
    while off < inner.len() {
        let mut ne = off;
        while ne < inner.len() && inner[ne] != 0 {
            ne += 1;
        }
        if ne == off {
            break;
        }
        let name = &inner[off..ne];
        off = ne + 1;
        if off + 4 > inner.len() {
            break;
        }
        let len = be32(&inner, off) as usize;
        off += 4;
        let dend = (off + len).min(inner.len());
        let data = &inner[off.min(inner.len())..dend];
        off += len;
        match name {
            b"COLOR" if data.len() >= 4 => m.track_color = rgb_hex(data[1], data[2], data[3]),
            b"BPMLOCK" if !data.is_empty() => m.bpm_locked = data[0] != 0,
            b"CUE" if data.len() >= 13 => {
                let mut e = 12;
                while e < data.len() && data[e] != 0 {
                    e += 1;
                }
                m.cues.push(Cue {
                    index: data[1],
                    position_ms: be32(data, 2),
                    color: rgb_hex(data[7], data[8], data[9]),
                    name: String::from_utf8_lossy(&data[12..e]).into_owned(),
                });
            }
            b"LOOP" if data.len() >= 20 => {
                let mut e = 20;
                while e < data.len() && data[e] != 0 {
                    e += 1;
                }
                m.loops.push(Loop {
                    index: data[1],
                    start_ms: be32(data, 2),
                    end_ms: be32(data, 6),
                    color: rgb_hex(data[15], data[16], data[17]),
                    locked: data[19] != 0,
                    name: String::from_utf8_lossy(&data[20..e]).into_owned(),
                });
            }
            _ => {}
        }
    }
    Ok(m)
}

pub enum GridMarker {
    Next(f32, u32),
    Last(f32, f32),
}

pub fn decode_beat_grid(raw: &[u8]) -> Result<Vec<GridMarker>, String> {
    if raw.len() < 6 {
        return Ok(vec![]);
    }
    if ((raw[0] as u16) << 8 | raw[1] as u16) != 0x0100 {
        return Err("Bad Serato BeatGrid version".into());
    }
    let count = be32(raw, 2) as usize;
    let mut out = Vec::new();
    for i in 0..count {
        let o = 6 + i * 8;
        if o + 8 > raw.len() {
            break;
        }
        let pos = f32::from_be_bytes(raw[o..o + 4].try_into().unwrap());
        if i == count - 1 {
            out.push(GridMarker::Last(pos, f32::from_be_bytes(raw[o + 4..o + 8].try_into().unwrap())));
        } else {
            out.push(GridMarker::Next(pos, be32(raw, o + 4)));
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- export.pdb
const PAGE_HEADER: usize = 0x28;
const ROW_GROUP: usize = 0x24;
const PAGE_FLAG_INDEX: u8 = 0x40;

fn u32le(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
fn u16le(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn latin1(b: &[u8]) -> String {
    b.iter().map(|c| *c as char).collect()
}
fn strip_nul(mut s: String) -> String {
    while s.ends_with('\u{0}') {
        s.pop();
    }
    s
}

pub fn read_device_sql_string(buf: &[u8], at: usize) -> Result<String, String> {
    if at >= buf.len() {
        return Err(format!("string offset {} outside file", at));
    }
    let lk = buf[at];
    if lk & 0x01 != 0 {
        let len = (lk >> 1) as i32 - 1;
        if len <= 0 {
            return Ok(String::new());
        }
        let e = buf.len().min(at + 1 + len as usize);
        return Ok(latin1(&buf[at + 1..e]));
    }
    if at + 4 > buf.len() {
        return Err("truncated long string".into());
    }
    let total = u16le(buf, at + 1) as usize;
    let n = total.saturating_sub(4);
    let data = &buf[at + 4..buf.len().min(at + 4 + n)];
    if lk == 0x90 && data.first() == Some(&0x03) {
        let end = data[1..].iter().position(|b| *b == 0).map(|p| p + 1).unwrap_or(data.len());
        return Ok(latin1(&data[1..end]));
    }
    if lk & 0x40 != 0 {
        return Ok(latin1(data));
    }
    if lk & 0x20 != 0 {
        return Ok(String::from_utf8_lossy(data).into_owned());
    }
    if lk & 0x10 != 0 {
        let even = &data[..data.len() & !1];
        let units: Vec<u16> = if lk & 0x80 != 0 {
            even.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect()
        } else {
            even.chunks_exact(2).map(|p| u16::from_be_bytes([p[0], p[1]])).collect()
        };
        return Ok(strip_nul(String::from_utf16_lossy(&units)));
    }
    Ok(latin1(data))
}

#[derive(Clone, Copy)]
struct TablePointer {
    ty: u32,
    first: u32,
    last: u32,
}

fn table_rows(buf: &[u8], page_size: usize, t: TablePointer, warnings: &mut Vec<String>) -> Vec<usize> {
    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    let mut index = t.first;
    loop {
        if !seen.insert(index) {
            warnings.push(format!("page loop at {} in table {}", index, t.ty));
            return rows;
        }
        let start = index as usize * page_size;
        if start + page_size > buf.len() {
            warnings.push(format!("page {} of table {} beyond end of file", index, t.ty));
            return rows;
        }
        let page_index = u32le(buf, start + 4);
        let ty = u32le(buf, start + 8);
        let next = u32le(buf, start + 0x0c);
        let flags = buf[start + 0x1b];
        if page_index == index && ty == t.ty && flags & PAGE_FLAG_INDEX == 0 {
            let packed = buf[start + 0x18] as u32 | (buf[start + 0x19] as u32) << 8 | (buf[start + 0x1a] as u32) << 16;
            let num = (packed & 0x1fff) as usize;
            let groups = num.div_ceil(16);
            for g in 0..groups {
                let base = start + page_size - g * ROW_GROUP;
                let presence = u16le(buf, base - 4);
                for i in 0..16 {
                    if g * 16 + i >= num {
                        break;
                    }
                    if presence & (1 << i) == 0 {
                        continue;
                    }
                    let ofs = u16le(buf, base - 6 - 2 * i) as usize;
                    let row = start + PAGE_HEADER + ofs;
                    if row >= start + page_size {
                        warnings.push(format!("row offset {} outside page {}", ofs, index));
                        continue;
                    }
                    rows.push(row);
                }
            }
        }
        if index == t.last || next == 0 || next == index {
            return rows;
        }
        index = next;
    }
}

pub struct PdbTrack {
    pub fields: Vec<String>, // canonical order, see canonical()
    pub id: u32,
}

pub struct PlaylistNode {
    pub id: u32,
    pub parent_id: u32,
    pub name: String,
    pub is_folder: bool,
    pub sort_order: u32,
}

pub struct Pdb {
    pub page_size: usize,
    pub tracks: Vec<PdbTrack>,
    pub artists: BTreeMap<u32, String>,
    pub albums: BTreeMap<u32, (String, u32)>,
    pub genres: BTreeMap<u32, String>,
    pub labels: BTreeMap<u32, String>,
    pub keys: BTreeMap<u32, String>,
    pub colors: BTreeMap<u32, String>,
    pub artwork: BTreeMap<u32, String>,
    pub playlists: Vec<PlaylistNode>,
    pub entries: Vec<(u32, u32, u32)>, // index, trackId, playlistId
    pub warnings: Vec<String>,
}

const TRACK_STRINGS: usize = 21;
// indices into TRACK_STRINGS
const S_DATE_ADDED: usize = 10;
const S_MIX_NAME: usize = 12;
const S_ANALYZE_PATH: usize = 14;
const S_COMMENT: usize = 16;
const S_TITLE: usize = 17;
const S_FILENAME: usize = 19;
const S_FILE_PATH: usize = 20;

fn file_type(v: u16) -> &'static str {
    match v {
        0x01 => "mp3",
        0x04 => "m4a",
        0x05 => "flac",
        0x0b => "wav",
        0x0c => "aiff",
        _ => "",
    }
}

/// JS number formatting of an integer divided by 100 (tempo).
fn js_num(x: f64) -> String {
    let mut s = String::new();
    write!(s, "{}", x).unwrap();
    s
}

pub fn parse_pdb(buf: &[u8]) -> Result<Pdb, String> {
    if buf.len() < 0x1c {
        return Err("file too short for a PDB header".into());
    }
    let page_size = u32le(buf, 4) as usize;
    let num_tables = u32le(buf, 8) as usize;
    if !(0x100..=0x10000).contains(&page_size) || page_size & (page_size - 1) != 0 {
        return Err(format!("implausible page size {}", page_size));
    }
    if num_tables > 64 || 0x1c + num_tables * 16 > page_size {
        return Err(format!("implausible table count {}", num_tables));
    }
    let mut tables: HashMap<u32, TablePointer> = HashMap::new();
    for i in 0..num_tables {
        let at = 0x1c + i * 16;
        tables.insert(u32le(buf, at), TablePointer { ty: u32le(buf, at), first: u32le(buf, at + 8), last: u32le(buf, at + 12) });
    }
    let mut warnings = Vec::new();
    let rows = |ty: u32, w: &mut Vec<String>| -> Vec<usize> {
        match tables.get(&ty) {
            Some(t) => table_rows(buf, page_size, *t, w),
            None => vec![],
        }
    };
    let str_at = |at: usize, w: &mut Vec<String>| -> String {
        match read_device_sql_string(buf, at) {
            Ok(s) => s,
            Err(e) => {
                w.push(e);
                String::new()
            }
        }
    };
    let mut artists = BTreeMap::new();
    for r in rows(0x02, &mut warnings) {
        let sub = u16le(buf, r);
        let id = u32le(buf, r + 4);
        let ofs = if sub & 0x04 != 0 { u16le(buf, r + 0x0a) as usize } else { buf[r + 0x09] as usize };
        artists.insert(id, str_at(r + ofs, &mut warnings));
    }
    let mut albums = BTreeMap::new();
    for r in rows(0x03, &mut warnings) {
        let sub = u16le(buf, r);
        let ofs = if sub & 0x04 != 0 { u16le(buf, r + 0x16) as usize } else { buf[r + 0x15] as usize };
        albums.insert(u32le(buf, r + 0x0c), (str_at(r + ofs, &mut warnings), u32le(buf, r + 0x08)));
    }
    let simple = |ty: u32, id_at: usize, name_at: usize, w: &mut Vec<String>| -> BTreeMap<u32, String> {
        let mut m = BTreeMap::new();
        for r in rows(ty, w) {
            let name = str_at(r + name_at, w);
            m.insert(u32le(buf, r + id_at), name);
        }
        m
    };
    let genres = simple(0x01, 0, 4, &mut warnings);
    let labels = simple(0x04, 0, 4, &mut warnings);
    let keys = simple(0x05, 0, 8, &mut warnings);
    let artwork = simple(0x0d, 0, 4, &mut warnings);
    let mut colors = BTreeMap::new();
    for r in rows(0x06, &mut warnings) {
        colors.insert(u16le(buf, r + 5) as u32, str_at(r + 8, &mut warnings));
    }
    let mut tracks = Vec::new();
    for r in rows(0x00, &mut warnings) {
        let s: Vec<String> = (0..TRACK_STRINGS).map(|i| str_at(r + u16le(buf, r + 0x5e + 2 * i) as usize, &mut warnings)).collect();
        let id = u32le(buf, r + 0x48);
        let u = |o: usize| u32le(buf, r + o).to_string();
        let h = |o: usize| u16le(buf, r + o).to_string();
        let fields = vec![
            id.to_string(),
            s[S_TITLE].clone(),
            u(0x44),
            u(0x40),
            u(0x3c),
            u(0x20),
            buf[r + 0x58].to_string(),
            u(0x28),
            u(0x2c),
            u(0x0c),
            u(0x24),
            u(0x1c),
            buf[r + 0x59].to_string(),
            js_num(u32le(buf, r + 0x38) as f64 / 100.0),
            h(0x54),
            u(0x08),
            h(0x52),
            u(0x30),
            u(0x10),
            file_type(u16le(buf, r + 0x5a)).to_string(),
            u(0x34),
            h(0x4c),
            h(0x50),
            h(0x4e),
            s[S_FILE_PATH].clone(),
            s[S_FILENAME].clone(),
            s[S_ANALYZE_PATH].clone(),
            s[S_COMMENT].clone(),
            s[S_MIX_NAME].clone(),
            s[S_DATE_ADDED].clone(),
        ];
        tracks.push(PdbTrack { fields, id });
    }
    let mut playlists = Vec::new();
    for r in rows(0x07, &mut warnings) {
        playlists.push(PlaylistNode {
            parent_id: u32le(buf, r),
            sort_order: u32le(buf, r + 8),
            id: u32le(buf, r + 0x0c),
            is_folder: u32le(buf, r + 0x10) != 0,
            name: str_at(r + 0x14, &mut warnings),
        });
    }
    let mut entries = Vec::new();
    for r in rows(0x08, &mut warnings) {
        entries.push((u32le(buf, r), u32le(buf, r + 4), u32le(buf, r + 8)));
    }
    Ok(Pdb { page_size, tracks, artists, albums, genres, labels, keys, colors, artwork, playlists, entries, warnings })
}

pub fn playlist_paths(db: &Pdb) -> Vec<(u32, Vec<String>, Vec<u32>)> {
    // Map iteration in JS keeps the last duplicate id; HashMap insert does too.
    let by_id: HashMap<u32, &PlaylistNode> = db.playlists.iter().map(|p| (p.id, p)).collect();
    let path_of = |p: &PlaylistNode| -> Vec<String> {
        let mut out = Vec::new();
        let mut guard = HashSet::new();
        let mut cur = Some(p);
        while let Some(c) = cur {
            if !guard.insert(c.id) {
                break;
            }
            out.insert(0, if c.name.is_empty() { format!("Playlist {}", c.id) } else { c.name.clone() });
            cur = if c.parent_id != 0 { by_id.get(&c.parent_id).copied() } else { None };
        }
        out
    };
    let mut entries: HashMap<u32, Vec<(u32, u32)>> = HashMap::new();
    for e in &db.entries {
        entries.entry(e.2).or_default().push((e.0, e.1));
    }
    let mut lists: Vec<&PlaylistNode> = db.playlists.iter().filter(|p| !p.is_folder).collect();
    lists.sort_by(|a, b| a.parent_id.cmp(&b.parent_id).then(a.sort_order.cmp(&b.sort_order)).then(a.id.cmp(&b.id)));
    lists
        .into_iter()
        .map(|p| {
            let mut es = entries.get(&p.id).cloned().unwrap_or_default();
            es.sort_by(|a, b| a.0.cmp(&b.0));
            (p.id, path_of(p), es.into_iter().map(|e| e.1).collect())
        })
        .collect()
}

// ---------------------------------------------------------------- ANLZ
pub struct AnlzCue {
    pub hot_cue: u32,
    pub time_ms: u32,
    pub loop_end_ms: Option<u32>,
    pub color: Option<String>,
    pub comment: Option<String>,
}

fn be32a(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
fn be16a(b: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([b[at], b[at + 1]])
}

pub fn parse_anlz_cues(buf: &[u8]) -> Vec<AnlzCue> {
    let mut ext = Vec::new();
    let mut leg = Vec::new();
    if buf.len() >= 12 && &buf[0..4] == b"PMAI" {
        let mut at = be32a(buf, 4) as usize;
        let hdr_end = be32a(buf, 8) as usize;
        let end = buf.len().min(if hdr_end == 0 { buf.len() } else { hdr_end });
        while at + 12 <= end {
            let len = be32a(buf, at + 8) as usize;
            if len < 12 || at + len > end {
                break;
            }
            let tag = &buf[at..at + 4];
            if tag == b"PCO2" {
                let count = be16a(buf, at + 0x10) as usize;
                let mut e = at + 0x14;
                let mut i = 0;
                while i < count && e + 0x1c <= at + len {
                    if &buf[e..e + 4] != b"PCP2" {
                        break;
                    }
                    let le = be32a(buf, e + 8) as usize;
                    if le < 0x1c || e + le > at + len {
                        break;
                    }
                    let mut cue = AnlzCue { hot_cue: be32a(buf, e + 0x0c), time_ms: be32a(buf, e + 0x14), loop_end_ms: None, color: None, comment: None };
                    if buf[e + 0x10] == 2 {
                        cue.loop_end_ms = Some(be32a(buf, e + 0x18));
                    }
                    if le >= 0x2c {
                        let lc = be32a(buf, e + 0x28) as usize;
                        if lc > 0 && 0x2c + lc <= le {
                            let raw = &buf[e + 0x2c..e + 0x2c + lc];
                            let units: Vec<u16> = raw[..raw.len() & !1].chunks_exact(2).map(|p| u16::from_be_bytes([p[0], p[1]])).collect();
                            let text = strip_nul(String::from_utf16_lossy(&units));
                            if !text.is_empty() {
                                cue.comment = Some(text);
                            }
                        }
                        let c = e + 0x2c + lc;
                        if cue.hot_cue != 0 && c + 4 <= e + le && (buf[c] | buf[c + 1] | buf[c + 2] | buf[c + 3]) != 0 {
                            cue.color = Some(rgb_hex(buf[c + 1], buf[c + 2], buf[c + 3]));
                        }
                    }
                    ext.push(cue);
                    e += le;
                    i += 1;
                }
            } else if tag == b"PCOB" {
                let count = be16a(buf, at + 0x12) as usize;
                let mut e = at + 0x18;
                let mut i = 0;
                while i < count && e + 0x28 <= at + len {
                    if &buf[e..e + 4] != b"PCPT" {
                        break;
                    }
                    let le = match be32a(buf, e + 8) { 0 => 0x38, v => v as usize };
                    let mut cue = AnlzCue { hot_cue: be32a(buf, e + 0x0c), time_ms: be32a(buf, e + 0x20), loop_end_ms: None, color: None, comment: None };
                    if buf[e + 0x1c] == 2 {
                        cue.loop_end_ms = Some(be32a(buf, e + 0x24));
                    }
                    leg.push(cue);
                    e += le;
                    i += 1;
                }
            }
            at += len;
        }
    }
    let mut cues: Vec<AnlzCue> = if !ext.is_empty() { ext } else { leg };
    cues.retain(|c| c.time_ms != 0xffff_ffff);
    cues.sort_by(|a, b| a.hot_cue.cmp(&b.hot_cue).then(a.time_ms.cmp(&b.time_ms)));
    cues
}

// ---------------------------------------------------------------- canonical
pub struct ScanResult {
    pub database: Database,
    pub crates: Vec<(String, Crate)>,
    pub markers: Vec<Markers>,
    pub grids: Vec<Vec<GridMarker>>,
    pub pdb: Pdb,
    pub playlists: Vec<(u32, Vec<String>, Vec<u32>)>,
    pub anlz: Vec<Vec<AnlzCue>>,
}

fn f32js(v: f32) -> String {
    js_num(v as f64)
}

fn join<T, F: Fn(&T) -> String>(xs: &[T], sep: &str, f: F) -> String {
    xs.iter().map(f).collect::<Vec<_>>().join(sep)
}

pub fn canonical(r: &ScanResult) -> String {
    const US: &str = "\x1f";
    let mut out: Vec<String> = vec![format!("db|{}", r.database.version)];
    for t in &r.database.tracks {
        // BTreeMap orders keys by UTF-8 bytes; tags are ASCII, so this is JS's sort().
        let s = t
            .iter()
            .map(|(k, v)| {
                let v = match v {
                    Val::S(s) => s.clone(),
                    Val::U(u) => u.to_string(),
                    Val::B(b) => (if *b { "1" } else { "0" }).to_string(),
                };
                format!("{}={}", k, v)
            })
            .collect::<Vec<_>>()
            .join(US);
        out.push(format!("t|{}", s));
    }
    for (name, c) in &r.crates {
        out.push(format!("c|{}|{}|{}|{}", name, c.version, join(&c.columns, ",", |x| format!("{}:{}", x.0, x.1)), c.paths.join(US)));
    }
    for m in &r.markers {
        out.push(format!(
            "m|{}|{}|{}|{}",
            m.track_color,
            if m.bpm_locked { 1 } else { 0 },
            join(&m.cues, ";", |c| format!("{},{},{},{}", c.index, c.position_ms, c.color, c.name)),
            join(&m.loops, ";", |l| format!("{},{},{},{},{},{}", l.index, l.start_ms, l.end_ms, l.color, if l.locked { 1 } else { 0 }, l.name))
        ));
    }
    for g in &r.grids {
        out.push(format!(
            "g|{}",
            join(g, ";", |m| match m {
                GridMarker::Last(p, b) => format!("{},b{}", f32js(*p), f32js(*b)),
                GridMarker::Next(p, n) => format!("{},n{}", f32js(*p), n),
            })
        ));
    }
    let p = &r.pdb;
    out.push(format!("p|{}|{}", p.page_size, p.warnings.len()));
    for t in &p.tracks {
        out.push(format!("pt|{}", t.fields.join(US)));
    }
    for (id, n) in &p.artists {
        out.push(format!("pa|{}|{}", id, n));
    }
    for (id, (n, a)) in &p.albums {
        out.push(format!("pb|{}|{}|{}", id, n, a));
    }
    for (tag, m) in [("pg", &p.genres), ("pl", &p.labels), ("pk", &p.keys), ("pc", &p.colors), ("pw", &p.artwork)] {
        for (id, n) in m {
            out.push(format!("{}|{}|{}", tag, id, n));
        }
    }
    for (id, path, ids) in &r.playlists {
        out.push(format!("pp|{}|{}|{}", id, path.join("/"), join(ids, ",", |x| x.to_string())));
    }
    for cues in &r.anlz {
        out.push(format!(
            "a|{}",
            join(cues, ";", |c| format!(
                "{},{},{},{},{}",
                c.hot_cue,
                c.time_ms,
                c.loop_end_ms.map(|v| v.to_string()).unwrap_or_default(),
                c.color.clone().unwrap_or_default(),
                c.comment.clone().unwrap_or_default()
            ))
        ));
    }
    out.join("\n")
}

//! Library DB: SQLite (public domain) through rusqlite (MIT) with the `bundled` feature.

use rusqlite::{params, Connection};

pub struct SynthTrack {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    pub bpm: f64,
    pub key: String,
    pub duration: f64,
    pub crate_name: String,
    pub color: String,
    pub play_count: i64,
}

const GENRES: [&str; 8] = ["House", "Techno", "Hip-Hop", "Drum & Bass", "Disco", "Pop", "Trance", "Afro"];
const KEYS: [&str; 24] = [
    "1A", "2A", "3A", "4A", "5A", "6A", "7A", "8A", "9A", "10A", "11A", "12A", "1B", "2B", "3B", "4B", "5B", "6B", "7B", "8B", "9B",
    "10B", "11B", "12B",
];
const WORDS: [&str; 32] = [
    "night", "drive", "sun", "blue", "fire", "deep", "rhythm", "love", "city", "dream", "echo", "gold", "wave", "storm", "velvet", "neon",
    "moon", "river", "heart", "shadow", "light", "tokyo", "lagos", "berlin", "toronto", "summer", "glass", "pulse", "orbit", "silk",
    "motion", "signal",
];

/// Deterministic synthetic library (xorshift, seed 1), identical to the TS baseline generator.
pub fn synth_tracks(n: usize) -> Vec<SynthTrack> {
    let mut s: u32 = 1;
    let mut rnd = move || {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        s
    };
    (0..n)
        .map(|i| {
            let a = WORDS[(rnd() % 32) as usize];
            let b = WORDS[(rnd() % 32) as usize];
            let c = WORDS[(rnd() % 32) as usize];
            let artist = format!("{} {}", WORDS[(rnd() % 32) as usize], WORDS[(rnd() % 32) as usize]);
            let genre = GENRES[(rnd() % 8) as usize];
            let bpm = 80.0 + (rnd() % 9000) as f64 / 100.0;
            let key = KEYS[(rnd() % 24) as usize];
            let duration = 120.0 + (rnd() % 360) as f64;
            let crate_name = format!("Crate {}", rnd() % 100);
            let title = format!("{a} {b} {c} {i}");
            SynthTrack {
                path: format!("/music/{}/{}/{} - {}.mp3", genre, crate_name, artist, title),
                title,
                artist,
                album: format!("{} {}", c, b),
                genre: genre.to_string(),
                bpm,
                key: key.to_string(),
                duration,
                crate_name,
                color: String::new(),
                play_count: (rnd() % 20) as i64,
            }
        })
        .collect()
}

pub fn open(path: &str) -> rusqlite::Result<Connection> {
    let c = Connection::open(path)?;
    c.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;
         CREATE TABLE IF NOT EXISTS tracks(
           id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT, artist TEXT, album TEXT, genre TEXT,
           bpm REAL, key TEXT, duration REAL, crate TEXT, color TEXT, play_count INTEGER DEFAULT 0, analyzed INTEGER DEFAULT 0);
         CREATE INDEX IF NOT EXISTS tracks_bpm ON tracks(bpm);
         CREATE INDEX IF NOT EXISTS tracks_crate ON tracks(crate);
         CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(title, artist, album, content='tracks', content_rowid='id');",
    )?;
    Ok(c)
}

pub fn import(c: &mut Connection, tracks: &[SynthTrack]) -> rusqlite::Result<()> {
    let tx = c.transaction()?;
    {
        let mut st = tx.prepare_cached(
            "INSERT INTO tracks(path,title,artist,album,genre,bpm,key,duration,crate,color,play_count) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(path) DO UPDATE SET title=excluded.title",
        )?;
        for t in tracks {
            st.execute(params![t.path, t.title, t.artist, t.album, t.genre, t.bpm, t.key, t.duration, t.crate_name, t.color, t.play_count])?;
        }
    }
    tx.execute_batch("INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild');")?;
    tx.commit()
}

/// Substring search like the app's filterTracks (title/artist/album/genre contains).
pub fn search_like(c: &Connection, term: &str) -> rusqlite::Result<usize> {
    let pat = format!("%{term}%");
    let mut st = c.prepare_cached(
        "SELECT id FROM tracks WHERE title LIKE ?1 OR artist LIKE ?1 OR album LIKE ?1 OR genre LIKE ?1 ORDER BY title",
    )?;
    let n = st.query_map([pat], |r| r.get::<_, i64>(0))?.count();
    Ok(n)
}

pub fn search_fts(c: &Connection, term: &str) -> rusqlite::Result<usize> {
    let mut st = c.prepare_cached("SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?1")?;
    let q = format!("{term}*");
    let n = st.query_map([q], |r| r.get::<_, i64>(0))?.count();
    Ok(n)
}

pub fn sort_page(c: &Connection) -> rusqlite::Result<usize> {
    let mut st = c.prepare_cached("SELECT id,title,artist,bpm,key,duration FROM tracks ORDER BY bpm DESC, title LIMIT 500")?;
    let n = st.query_map([], |r| r.get::<_, i64>(0))?.count();
    Ok(n)
}

/// Full sort of every row (what the app does when it re-sorts the whole list).
pub fn sort_all(c: &Connection) -> rusqlite::Result<usize> {
    let mut st = c.prepare_cached("SELECT id FROM tracks ORDER BY artist, title")?;
    let n = st.query_map([], |r| r.get::<_, i64>(0))?.count();
    Ok(n)
}

/// Live playlist: genre = House AND bpm between 120 and 128 AND play_count > 3.
pub fn live_playlist(c: &Connection) -> rusqlite::Result<usize> {
    let mut st = c.prepare_cached("SELECT id FROM tracks WHERE genre = 'House' AND bpm BETWEEN 120 AND 128 AND play_count > 3")?;
    let n = st.query_map([], |r| r.get::<_, i64>(0))?.count();
    Ok(n)
}

pub fn update_meta(c: &mut Connection, n: usize) -> rusqlite::Result<()> {
    let tx = c.transaction()?;
    {
        let mut st = tx.prepare_cached("UPDATE tracks SET color=?1, play_count=play_count+1 WHERE id=?2")?;
        for i in 0..n {
            st.execute(params!["#ff0000", (i * 37 % 50_000 + 1) as i64])?;
        }
    }
    tx.commit()
}

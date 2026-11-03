//! Multi-deck progressive stem scheduler (off the audio thread).
use crate::core::{order_chunks_from_focus, plan_chunks, transition_window_for, ChunkPlan, IntervalSet, DEFAULT_OVERLAP, MODEL_FRAME_COUNT};
use crate::{StemChunk, StemEngine};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

pub struct Job {
    pub deck: usize,
    pub left: Arc<Vec<f32>>,
    pub right: Arc<Vec<f32>>,
    pub plan: Vec<ChunkPlan>,
    pub state: Vec<u8>, // 0 todo, 1 running, 2 done
    pub focus: f64,
    pub playing: bool,
    pub stems: [[Vec<f32>; 2]; 4],
    pub weight: Vec<f32>,
    pub covered: IntervalSet,
    pub started: Instant,
    pub first_chunk_ms: Option<f64>,
    pub finished_ms: Option<f64>,
    pub generation: u64,
}

#[derive(Debug, Clone)]
pub struct ChunkDone { pub deck: usize, pub index: usize, pub ms: f64, pub since_load_ms: f64, pub worker: usize }

#[derive(Default)]
struct Shared { jobs: Vec<Option<Job>>, quit: bool, log: Vec<ChunkDone> }

pub struct Scheduler { shared: Arc<(Mutex<Shared>, Condvar)>, workers: Vec<std::thread::JoinHandle<()>> }

impl Scheduler {
    /// `engines`: one per worker (each owns its session and intra-op threads).
    pub fn new(engines: Vec<Box<dyn StemEngine>>, decks: usize) -> Scheduler {
        let shared = Arc::new((Mutex::new(Shared { jobs: (0..decks).map(|_| None).collect(), ..Default::default() }), Condvar::new()));
        let workers = engines.into_iter().enumerate().map(|(wi, mut eng)| {
            let sh = shared.clone();
            std::thread::Builder::new().name(format!("od-stems-{wi}")).spawn(move || worker(wi, &mut *eng, &sh)).expect("stem worker")
        }).collect();
        Scheduler { shared, workers }
    }
    pub fn load(&self, deck: usize, left: Vec<f32>, right: Vec<f32>, focus_frame: f64, playing: bool) {
        let n = left.len();
        let plan = plan_chunks(n);
        let z = || vec![0f32; n];
        let (m, cv) = &*self.shared;
        let mut g = m.lock().unwrap();
        let generation = g.jobs[deck].as_ref().map(|j| j.generation + 1).unwrap_or(0);
        g.jobs[deck] = Some(Job { deck, state: vec![0; plan.len()], plan, left: Arc::new(left), right: Arc::new(right), focus: focus_frame, playing, stems: [[z(), z()], [z(), z()], [z(), z()], [z(), z()]], weight: z(), covered: IntervalSet::default(), started: Instant::now(), first_chunk_ms: None, finished_ms: None, generation });
        cv.notify_all();
    }
    pub fn eject(&self, deck: usize) { self.shared.0.lock().unwrap().jobs[deck] = None; }
    pub fn focus(&self, deck: usize, frame: f64, playing: bool) { if let Some(j) = self.shared.0.lock().unwrap().jobs[deck].as_mut() { j.focus = frame; j.playing = playing; } }
    pub fn progress(&self, deck: usize) -> Option<(usize, usize, Option<f64>, Option<f64>)> {
        self.shared.0.lock().unwrap().jobs[deck].as_ref().map(|j| (j.state.iter().filter(|s| **s == 2).count(), j.plan.len(), j.first_chunk_ms, j.finished_ms))
    }
    pub fn coverage(&self, deck: usize, frame: usize) -> f64 {
        self.shared.0.lock().unwrap().jobs[deck].as_ref().map(|j| crate::core::coverage_at(&j.covered, frame, j.left.len(), crate::core::BOUNDARY_FADE)).unwrap_or(0.0)
    }
    pub fn take_log(&self) -> Vec<ChunkDone> { std::mem::take(&mut self.shared.0.lock().unwrap().log) }
    pub fn with_job<R>(&self, deck: usize, f: impl FnOnce(&Job) -> R) -> Option<R> { self.shared.0.lock().unwrap().jobs[deck].as_ref().map(f) }
    pub fn all_done(&self) -> bool { self.shared.0.lock().unwrap().jobs.iter().flatten().all(|j| j.state.iter().all(|s| *s == 2)) }
}
impl Drop for Scheduler {
    fn drop(&mut self) {
        { let (m, cv) = &*self.shared; m.lock().unwrap().quit = true; cv.notify_all(); }
        for w in self.workers.drain(..) { let _ = w.join(); }
    }
}

/// Earliest-deadline pick: playing decks first, then the chunk that comes
/// first in that deck's focus order (two ahead per one behind).
fn pick(g: &mut Shared) -> Option<(usize, ChunkPlan, u64, Arc<Vec<f32>>, Arc<Vec<f32>>)> {
    let mut best: Option<(f64, usize, ChunkPlan)> = None;
    for (d, j) in g.jobs.iter().enumerate() {
        let Some(j) = j else { continue };
        let order = order_chunks_from_focus(&j.plan, j.focus);
        if let Some((rank, c)) = order.iter().enumerate().find(|(_, c)| j.state[c.index] == 0) {
            // Rank by seconds until the chunk plays at 1x; behind-playhead chunks rank after.
            let until = (c.start as f64 - j.focus) / 44100.0;
            let key = if until >= -((MODEL_FRAME_COUNT as f64) / 44100.0) { until.max(0.0) } else { 1e6 + rank as f64 } + if j.playing { 0.0 } else { 1e5 };
            if best.as_ref().map(|b| key < b.0).unwrap_or(true) { best = Some((key, d, *c)); }
        }
    }
    let (_, d, c) = best?;
    let j = g.jobs[d].as_mut().unwrap();
    j.state[c.index] = 1;
    Some((d, c, j.generation, j.left.clone(), j.right.clone()))
}

fn worker(wi: usize, eng: &mut dyn StemEngine, sh: &(Mutex<Shared>, Condvar)) {
    let (m, cv) = sh;
    let mut lbuf = vec![0f32; MODEL_FRAME_COUNT];
    let mut rbuf = vec![0f32; MODEL_FRAME_COUNT];
    loop {
        let (d, c, gen, l, r) = {
            let mut g = m.lock().unwrap();
            loop {
                if g.quit { return; }
                if let Some(p) = pick(&mut g) { break p; }
                g = cv.wait(g).unwrap();
            }
        };
        lbuf.fill(0.0); rbuf.fill(0.0);
        lbuf[..c.length].copy_from_slice(&l[c.start..c.start + c.length]);
        rbuf[..c.length].copy_from_slice(&r[c.start..c.start + c.length]);
        let t = Instant::now();
        let res = eng.separate(&lbuf, &rbuf);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let mut g = m.lock().unwrap();
        let Some(j) = g.jobs[d].as_mut() else { continue };
        if j.generation != gen { continue; }
        match res {
            Ok(st) => {
                add_chunk(j, &c, &st);
                j.state[c.index] = 2;
                let since = j.started.elapsed().as_secs_f64() * 1000.0;
                if j.first_chunk_ms.is_none() { j.first_chunk_ms = Some(since); }
                if j.state.iter().all(|s| *s == 2) { j.finished_ms = Some(since); }
                g.log.push(ChunkDone { deck: d, index: c.index, ms, since_load_ms: since, worker: wi });
            }
            Err(e) => { eprintln!("od-stems: chunk {} deck {d}: {e}", c.index); j.state[c.index] = 2; }
        }
        cv.notify_all();
    }
}

fn add_chunk(j: &mut Job, c: &ChunkPlan, st: &StemChunk) {
    let total = j.left.len();
    let first = c.start == 0;
    let last = c.start + c.length >= total;
    let w = transition_window_for(c.length, DEFAULT_OVERLAP);
    for i in 0..c.length {
        let fade_in = !first && i < DEFAULT_OVERLAP;
        let fade_out = !last && i >= c.length.saturating_sub(DEFAULT_OVERLAP);
        let wi = if fade_in || fade_out { w[i] } else { 1.0 };
        let at = c.start + i;
        for p in 0..4 { for ch in 0..2 { j.stems[p][ch][at] += st[p][ch][i] * wi; } }
        j.weight[at] += wi;
    }
    // A region counts as covered once its weights sum to ~1.
    let mut s = None;
    for i in c.start..c.start + c.length {
        if j.weight[i] > 0.999 { if s.is_none() { s = Some(i); } } else if let Some(a) = s.take() { j.covered.add(a, i); }
    }
    if let Some(a) = s { j.covered.add(a, c.start + c.length); }
}

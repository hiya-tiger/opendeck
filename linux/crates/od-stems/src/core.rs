//! Port of src/main/stems/core.ts (planning half).
pub const MODEL_SAMPLE_RATE: u32 = 44100;
pub const MODEL_FRAME_COUNT: usize = 343_980;
pub const DEFAULT_OVERLAP: usize = MODEL_FRAME_COUNT / 4;
pub const BOUNDARY_FADE: f64 = 4096.0;
pub const PART_ORDER: [&str; 4] = ["drums", "bass", "other", "vocals"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkPlan { pub index: usize, pub start: usize, pub length: usize }

pub fn plan_chunks_with(total: usize, frame_count: usize, overlap: usize) -> Vec<ChunkPlan> {
    if total == 0 { return vec![]; }
    let stride = frame_count - overlap;
    (0..).map(|i| i * stride).take_while(|s| *s < total).enumerate().map(|(index, start)| ChunkPlan { index, start, length: frame_count.min(total - start) }).collect()
}
pub fn plan_chunks(total: usize) -> Vec<ChunkPlan> { plan_chunks_with(total, MODEL_FRAME_COUNT, DEFAULT_OVERLAP) }

/// orderChunksFromFocus: the chunk whose body covers the focus, then two ahead for every one behind.
pub fn order_chunks_from_focus(chunks: &[ChunkPlan], focus_frame: f64) -> Vec<ChunkPlan> {
    if chunks.is_empty() { return vec![]; }
    let focus = if focus_frame.is_finite() { focus_frame.max(0.0) } else { 0.0 };
    let mut first = chunks.len() - 1;
    let mut best = f64::NEG_INFINITY;
    for (i, c) in chunks.iter().enumerate() {
        let (s, e) = (c.start as f64, (c.start + c.length) as f64);
        if focus < s || focus >= e { continue; }
        let margin = (focus - s).min(e - focus);
        if margin > best { best = margin; first = i; }
    }
    let mut out = vec![chunks[first]];
    let (mut ahead, mut behind) = (first + 1, first as i64 - 1);
    while ahead < chunks.len() || behind >= 0 {
        for _ in 0..2 { if ahead < chunks.len() { out.push(chunks[ahead]); ahead += 1; } }
        if behind >= 0 { out.push(chunks[behind as usize]); behind -= 1; }
    }
    out
}
pub fn reorder_remaining(all: &[ChunkPlan], done: &[bool], focus: f64) -> Vec<ChunkPlan> {
    order_chunks_from_focus(all, focus).into_iter().filter(|p| !done.get(p.index).copied().unwrap_or(false)).collect()
}
pub fn transition_window_for(length: usize, overlap: usize) -> Vec<f32> {
    let ramp = overlap.max(1);
    (0..length).map(|i| if i < ramp { (i as f64 / ramp as f64) as f32 } else if i >= length.saturating_sub(ramp) { (((length - i) as f64) / ramp as f64).max(0.0) as f32 } else { 1.0 }).collect()
}

#[derive(Debug, Default, Clone)]
pub struct IntervalSet { pub items: Vec<(usize, usize)> }
impl IntervalSet {
    pub fn add(&mut self, start: usize, end: usize) {
        if end <= start { return; }
        let (mut s, mut e, mut placed) = (start, end, false);
        let mut next = vec![];
        for &(a, b) in &self.items {
            if b < s { next.push((a, b)); }
            else if a > e { if !placed { next.push((s, e)); placed = true; } next.push((a, b)); }
            else { s = s.min(a); e = e.max(b); }
        }
        if !placed { next.push((s, e)); }
        self.items = next;
    }
    pub fn find(&self, frame: usize) -> Option<(usize, usize)> {
        for &it in &self.items { if frame >= it.0 && frame < it.1 { return Some(it); } if it.0 > frame { break; } }
        None
    }
    pub fn covers(&self, start: usize, end: usize) -> bool { self.find(start).map(|i| i.1 >= end).unwrap_or(false) }
}
pub fn coverage_at(c: &IntervalSet, frame: usize, total: usize, fade: f64) -> f64 {
    let Some((lo, hi)) = c.find(frame) else { return 0.0 };
    let mut d = f64::INFINITY;
    if lo > 0 { d = d.min((frame - lo) as f64); }
    if hi < total { d = d.min((hi - 1 - frame) as f64); }
    if d.is_infinite() { return 1.0; }
    (d / fade).clamp(0.0, 1.0)
}

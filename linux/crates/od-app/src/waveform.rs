//! GPU waveforms: one egui Mesh per view (quads per pixel column per band),
//! drawn by wgpu. Scrolling (horizontal or vertical, centred playhead, beat
//! grid, cues, loop) and overview (whole track).
use crate::library::Analysis;
use egui::{epaint::Vertex, Color32, Mesh, Pos2, Rect, Shape, Stroke};

pub const LOW: Color32 = Color32::from_rgb(232, 64, 72);
pub const MID: Color32 = Color32::from_rgb(64, 214, 128);
pub const HIGH: Color32 = Color32::from_rgb(77, 140, 254);

#[derive(Default, Clone, Copy)]
pub struct Marks<'a> { pub cue: Option<f64>, pub hot: &'a [Option<f64>], pub loop_range: Option<(f64, f64)>, pub bpm: f64, pub phase: f64 }

fn quad(m: &mut Mesh, r: Rect, c: Color32) {
    let i = m.vertices.len() as u32;
    let uv = egui::epaint::WHITE_UV;
    for p in [r.left_top(), r.right_top(), r.right_bottom(), r.left_bottom()] { m.vertices.push(Vertex { pos: p, uv, color: c }); }
    m.indices.extend_from_slice(&[i, i + 1, i + 2, i, i + 2, i + 3]);
}

#[inline]
fn band(a: &Analysis, t: f64) -> (f32, f32, f32) {
    let i = (t * a.buckets_per_sec) as isize;
    if i < 0 || i as usize >= a.low.len() { return (0.0, 0.0, 0.0); }
    let i = i as usize;
    (a.low[i], a.mid[i], a.high[i])
}

/// Scrolling 3-band waveform; `span` seconds across the long axis.
pub fn scrolling(painter: &egui::Painter, rect: Rect, a: Option<&Analysis>, pos: f64, span: f64, vertical: bool, marks: Marks, deck_color: Color32) {
    painter.rect_filled(rect, 4.0, Color32::from_gray(14));
    let long = if vertical { rect.height() } else { rect.width() };
    let short = if vertical { rect.width() } else { rect.height() };
    let px_to_t = |px: f32| pos + (px as f64 / long as f64 - 0.5) * span;
    let at = |along: f32, across0: f32, across1: f32| -> Rect {
        if vertical { Rect::from_min_max(Pos2::new(rect.left() + across0, rect.bottom() - along - 1.0), Pos2::new(rect.left() + across1, rect.bottom() - along)) }
        else { Rect::from_min_max(Pos2::new(rect.left() + along, rect.top() + across0), Pos2::new(rect.left() + along + 1.0, rect.top() + across1)) }
    };
    if let Some(a) = a {
        let mut m = Mesh::default();
        let mid = short / 2.0;
        let cols = long.max(1.0) as usize;
        m.vertices.reserve(cols * 12);
        m.indices.reserve(cols * 18);
        for px in 0..cols {
            let t = px_to_t(px as f32);
            if t < 0.0 || t > a.duration { continue; }
            let (l, md, h) = band(a, t);
            let sc = mid * 0.95;
            let (hl, hm, hh) = (l.min(1.0) * sc, md.min(1.0) * sc * 0.8, h.min(1.0) * sc * 0.6);
            quad(&mut m, at(px as f32, mid - hl, mid + hl), LOW);
            quad(&mut m, at(px as f32, mid - hm, mid + hm), MID);
            quad(&mut m, at(px as f32, mid - hh, mid + hh), HIGH);
        }
        painter.add(Shape::mesh(m));
        // beat grid
        if marks.bpm > 0.0 {
            let beat = 60.0 / marks.bpm;
            let t0 = px_to_t(0.0);
            let mut k = ((t0 - marks.phase) / beat).floor();
            loop {
                let t = marks.phase + k * beat;
                let px = ((t - pos) / span + 0.5) * long as f64;
                if px > long as f64 { break; }
                if px >= 0.0 { let bar = (k as i64).rem_euclid(4) == 0; painter.rect_filled(at(px as f32, 0.0, if bar { short } else { short * 0.12 }), 0.0, Color32::from_white_alpha(if bar { 70 } else { 40 })); }
                k += 1.0;
            }
        }
    }
    let mark = |t: f64, c: Color32| { let px = ((t - pos) / span + 0.5) * long as f64; if (0.0..=long as f64).contains(&px) { painter.rect_filled(at(px as f32, 0.0, short).expand(0.5), 0.0, c); } };
    if let Some((s, e)) = marks.loop_range {
        let a0 = (((s - pos) / span + 0.5) * long as f64).clamp(0.0, long as f64) as f32;
        let a1 = (((e - pos) / span + 0.5) * long as f64).clamp(0.0, long as f64) as f32;
        let r = if vertical { Rect::from_min_max(Pos2::new(rect.left(), rect.bottom() - a1), Pos2::new(rect.right(), rect.bottom() - a0)) } else { Rect::from_min_max(Pos2::new(rect.left() + a0, rect.top()), Pos2::new(rect.left() + a1, rect.bottom())) };
        painter.rect_filled(r, 0.0, Color32::from_rgba_unmultiplied(80, 200, 120, 40));
    }
    for (i, h) in marks.hot.iter().enumerate() { if let Some(t) = h { mark(*t, cue_color(i)); } }
    if let Some(c) = marks.cue { mark(c, Color32::from_rgb(255, 170, 0)); }
    // playhead
    let ph = if vertical { Rect::from_min_max(Pos2::new(rect.left(), rect.center().y - 1.0), Pos2::new(rect.right(), rect.center().y + 1.0)) } else { Rect::from_min_max(Pos2::new(rect.center().x - 1.0, rect.top()), Pos2::new(rect.center().x + 1.0, rect.bottom())) };
    painter.rect_filled(ph, 0.0, deck_color);
}

pub fn overview(painter: &egui::Painter, rect: Rect, a: Option<&Analysis>, pos: f64, cue: Option<f64>, warn: bool) {
    painter.rect_filled(rect, 3.0, Color32::from_gray(20));
    let Some(a) = a else { return };
    if a.duration <= 0.0 { return; }
    let mut m = Mesh::default();
    let cols = rect.width().max(1.0) as usize;
    let mid = rect.height() / 2.0;
    for px in 0..cols {
        let t0 = px as f64 / cols as f64 * a.duration;
        let t1 = (px + 1) as f64 / cols as f64 * a.duration;
        let (mut l, mut md, mut h) = (0f32, 0f32, 0f32);
        let (i0, i1) = ((t0 * a.buckets_per_sec) as usize, ((t1 * a.buckets_per_sec) as usize).max((t0 * a.buckets_per_sec) as usize + 1));
        for i in i0..i1.min(a.low.len()) { l = l.max(a.low[i]); md = md.max(a.mid[i]); h = h.max(a.high[i]); }
        let x = rect.left() + px as f32;
        let played = t0 < pos;
        let dim = |c: Color32| if played { c.gamma_multiply(0.45) } else { c };
        for (v, c, k) in [(l, LOW, 1.0), (md, MID, 0.8), (h, HIGH, 0.6)] { let hh = v.min(1.0) * mid * k; quad(&mut m, Rect::from_min_max(Pos2::new(x, rect.top() + mid - hh), Pos2::new(x + 1.0, rect.top() + mid + hh)), dim(c)); }
    }
    painter.add(Shape::mesh(m));
    let xp = rect.left() + (pos / a.duration) as f32 * rect.width();
    painter.line_segment([Pos2::new(xp, rect.top()), Pos2::new(xp, rect.bottom())], Stroke::new(2.0, if warn { Color32::RED } else { Color32::WHITE }));
    if let Some(c) = cue { let xc = rect.left() + (c / a.duration) as f32 * rect.width(); painter.line_segment([Pos2::new(xc, rect.top()), Pos2::new(xc, rect.bottom())], Stroke::new(1.0, Color32::from_rgb(255, 170, 0))); }
}

pub fn cue_color(i: usize) -> Color32 {
    const C: [Color32; 8] = [Color32::from_rgb(204, 0, 0), Color32::from_rgb(204, 68, 0), Color32::from_rgb(204, 136, 0), Color32::from_rgb(204, 204, 0), Color32::from_rgb(0, 204, 0), Color32::from_rgb(0, 204, 204), Color32::from_rgb(0, 102, 204), Color32::from_rgb(136, 0, 204)];
    C[i % 8]
}

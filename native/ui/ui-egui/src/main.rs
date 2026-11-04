//! egui (eframe + wgpu) deck mock: 4 scrolling 3-band waveforms + 4 jog platters.
//! `ui-egui frames N` animates N frames then prints frame stats; `ui-egui idle S` shows a
//! static UI for S seconds (no repaint requests) then exits. Prints FIRST_FRAME when the
//! first frame has been submitted. No text is drawn (no fonts bundled).
use eframe::egui::{self, Color32, Pos2, Shape, Stroke};
use std::time::{Duration, Instant};

struct App { mode: String, n: usize, start: Instant, frames: Vec<f64>, cpu: Vec<f64>, last: Option<Instant>, data: Vec<Vec<f32>>, first: bool }

fn synth(seed: u32, n: usize) -> Vec<f32> {
    let mut s = seed.max(1);
    (0..n).map(|i| { s ^= s << 13; s ^= s >> 17; s ^= s << 5; let ph = (i as f32 / 75.0).fract(); (-ph * 8.0).exp() * 0.8 + (s % 100) as f32 / 500.0 }).collect()
}

fn pct(v: &mut Vec<f64>, p: f64) -> f64 { v.sort_by(|a, b| a.partial_cmp(b).unwrap()); if v.is_empty() { return f64::NAN } v[((v.len() - 1) as f64 * p).round() as usize] }

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _f: &mut eframe::Frame) {
        let t0 = Instant::now();
        if let Some(l) = self.last { self.frames.push((t0 - l).as_secs_f64() * 1e3); }
        self.last = Some(t0);
        let fno = self.frames.len();
        egui::CentralPanel::default().frame(egui::Frame::NONE.fill(Color32::from_rgb(17, 17, 17))).show(ctx, |ui| {
            let r = ui.max_rect();
            let p = ui.painter();
            let h = r.height() / 4.0;
            for d in 0..4 {
                let y0 = r.top() + d as f32 * h;
                let jog = (h - 12.0).min(220.0);
                let w = r.width() - jog - 24.0;
                let mid = y0 + h * 0.36;
                let off = (fno * 3 + d * 500) % 30000;
                for (band, (col, scale)) in [(Color32::from_rgb(30, 110, 230), 1.0f32), (Color32::from_rgba_unmultiplied(240, 160, 40, 200), 0.7), (Color32::from_rgba_unmultiplied(250, 250, 250, 190), 0.45)].into_iter().enumerate() {
                    let cols = w as usize;
                    let src = &self.data[d];
                    let mut top = Vec::with_capacity(cols * 2);
                    for i in 0..cols { let v = src[(off + i + band * 7) % src.len()] * scale; top.push(Pos2::new(r.left() + 6.0 + i as f32, mid - v * h * 0.33)); }
                    for i in (0..cols).rev() { let v = src[(off + i + band * 7) % src.len()] * scale; top.push(Pos2::new(r.left() + 6.0 + i as f32, mid + v * h * 0.33)); }
                    // egui tessellates convex polygons only; draw as a vertical-bar mesh instead.
                    let mut mesh = egui::Mesh::default();
                    for i in 0..cols { let a = top[i]; let b = top[cols * 2 - 1 - i]; mesh.add_colored_rect(egui::Rect::from_min_max(Pos2::new(a.x, a.y), Pos2::new(a.x + 1.0, b.y)), col); }
                    p.add(Shape::mesh(mesh));
                }
                p.line_segment([Pos2::new(r.left() + 6.0 + w / 2.0, y0 + 6.0), Pos2::new(r.left() + 6.0 + w / 2.0, y0 + h * 0.72)], Stroke::new(2.0, Color32::from_rgb(255, 40, 60)));
                let c = Pos2::new(r.right() - 6.0 - jog / 2.0, y0 + 6.0 + jog / 2.0);
                p.circle_filled(c, jog / 2.0, Color32::from_rgb(12, 12, 14));
                p.circle_filled(c, jog * 0.15, Color32::from_rgb(200, 30, 50));
                let a = fno as f32 / 60.0 / 1.8 * std::f32::consts::TAU + d as f32;
                p.line_segment([c + egui::vec2(a.sin(), -a.cos()) * jog * 0.16, c + egui::vec2(a.sin(), -a.cos()) * jog * 0.48], Stroke::new(3.0, Color32::WHITE));
            }
        });
        self.cpu.push(t0.elapsed().as_secs_f64() * 1e3);
        if self.first { self.first = false; println!("FIRST_FRAME {:.1}", self.start.elapsed().as_secs_f64() * 1e3); }
        match self.mode.as_str() {
            "frames" => {
                if self.frames.len() >= self.n {
                    let (mut f, mut c) = (self.frames[10..].to_vec(), self.cpu[10..].to_vec());
                    println!("RESULT {{\"kind\":\"ui\",\"toolkit\":\"egui\",\"frames\":{},\"frame_interval_median_ms\":{:.3},\"frame_interval_p99_ms\":{:.3},\"ui_cpu_median_ms\":{:.3},\"ui_cpu_p99_ms\":{:.3}}}", f.len(), pct(&mut f.clone(), 0.5), pct(&mut f, 0.99), pct(&mut c.clone(), 0.5), pct(&mut c, 0.99));
                    ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                } else { ctx.request_repaint(); }
            }
            _ => {
                if self.start.elapsed().as_secs_f64() >= self.n as f64 { ctx.send_viewport_cmd(egui::ViewportCommand::Close); }
                else { ctx.request_repaint_after(Duration::from_millis(250)); }
            }
        }
    }
}

fn main() -> eframe::Result<()> {
    let start = Instant::now();
    let a: Vec<String> = std::env::args().collect();
    let mode = a.get(1).cloned().unwrap_or("frames".into());
    let n = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(600);
    let opts = eframe::NativeOptions { viewport: egui::ViewportBuilder::default().with_inner_size([1920.0, 1080.0]), vsync: true, ..Default::default() };
    eframe::run_native("ui-egui", opts, Box::new(move |cc| {
        cc.egui_ctx.set_fonts(egui::FontDefinitions::empty());
        Ok(Box::new(App { mode, n, start, frames: vec![], cpu: vec![], last: None, data: (0..4).map(|i| synth(i + 1, 40000)).collect(), first: true }))
    }))
}

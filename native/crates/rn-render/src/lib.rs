//! Deck visuals in vello: scrolling 3-band waveform, beat grid, playhead, overview, and the
//! jog platter (rotating record, position marker, progress ring, touch halo).
//! Plus a headless frame-time benchmark on whatever wgpu adapter is present.

use std::f64::consts::{PI, TAU};
use std::time::Instant;

use vello::kurbo::{Affine, BezPath, Circle, Line, Rect, Stroke};
use vello::peniko::{Color, Fill};
use vello::{wgpu, AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene};

pub struct DeckData {
    /// Per-column band peaks for the whole track (low, mid, high), 0..1, at `cols_per_sec`.
    pub low: Vec<f32>,
    pub mid: Vec<f32>,
    pub high: Vec<f32>,
    pub cols_per_sec: f64,
    pub duration: f64,
}

impl DeckData {
    pub fn synthetic(seed: u32, duration: f64) -> Self {
        let cols_per_sec = 150.0;
        let n = (duration * cols_per_sec) as usize;
        let mut s = seed.max(1);
        let mut rnd = move || {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            (s % 1000) as f32 / 1000.0
        };
        let bpm = 120.0 + seed as f64 % 10.0;
        let (mut low, mut mid, mut high) = (Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n));
        for i in 0..n {
            let t = i as f64 / cols_per_sec;
            let ph = (t * bpm / 60.0).fract();
            low.push(((-ph * 8.0).exp() as f32 * 0.9 + 0.05 * rnd()).min(1.0));
            mid.push(0.3 + 0.3 * rnd());
            high.push(((-((t * bpm / 30.0).fract()) * 20.0).exp() as f32 * 0.6 + 0.1 * rnd()).min(1.0));
        }
        Self { low, mid, high, cols_per_sec, duration }
    }
}

pub struct DeckView {
    pub position: f64,
    pub platter_angle: f64,
    pub touched: bool,
    pub bpm: f64,
}

fn band_path(vals: &[f32], start: usize, cols: usize, x0: f64, w: f64, mid_y: f64, h: f64) -> BezPath {
    let mut p = BezPath::new();
    let dx = w / cols as f64;
    let get = |i: usize| vals.get(start + i).copied().unwrap_or(0.0) as f64;
    p.move_to((x0, mid_y));
    for i in 0..cols {
        p.line_to((x0 + i as f64 * dx, mid_y - get(i) * h));
    }
    for i in (0..cols).rev() {
        p.line_to((x0 + i as f64 * dx, mid_y + get(i) * h));
    }
    p.close_path();
    p
}

/// Draw one deck strip into `rect`: zoomed scrolling waveform (left), jog platter (right),
/// overview along the bottom.
pub fn draw_deck(scene: &mut Scene, d: &DeckData, v: &DeckView, rect: Rect) {
    let pad = 6.0;
    let jog_d = (rect.height() - pad * 2.0).min(220.0);
    let wave = Rect::new(rect.x0 + pad, rect.y0 + pad, rect.x1 - jog_d - pad * 3.0, rect.y0 + (rect.height() - pad * 2.0) * 0.72);
    let ov = Rect::new(wave.x0, wave.y1 + pad, wave.x1, rect.y1 - pad);
    scene.fill(Fill::NonZero, Affine::IDENTITY, Color::from_rgb8(18, 20, 26), None, &rect);
    // Scrolling waveform: 8 s window centred on the playhead, one vertex per pixel column.
    let cols = wave.width().max(1.0) as usize;
    let window_s = 8.0;
    let start_t = v.position - window_s / 2.0;
    let col_per_px = window_s * d.cols_per_sec / cols as f64;
    let resample = |src: &[f32]| -> Vec<f32> {
        (0..cols)
            .map(|i| {
                let c = (start_t * d.cols_per_sec + i as f64 * col_per_px).floor();
                if c < 0.0 {
                    0.0
                } else {
                    src.get(c as usize).copied().unwrap_or(0.0)
                }
            })
            .collect()
    };
    let (lo, mi, hi) = (resample(&d.low), resample(&d.mid), resample(&d.high));
    let my = (wave.y0 + wave.y1) / 2.0;
    let hh = wave.height() / 2.0;
    scene.fill(Fill::NonZero, Affine::IDENTITY, Color::from_rgb8(30, 110, 230), None, &band_path(&lo, 0, cols, wave.x0, wave.width(), my, hh));
    scene.fill(Fill::NonZero, Affine::IDENTITY, Color::from_rgba8(240, 160, 40, 200), None, &band_path(&mi, 0, cols, wave.x0, wave.width(), my, hh * 0.7));
    scene.fill(Fill::NonZero, Affine::IDENTITY, Color::from_rgba8(250, 250, 250, 190), None, &band_path(&hi, 0, cols, wave.x0, wave.width(), my, hh * 0.45));
    // Beat grid.
    let beat = 60.0 / v.bpm;
    let first = (start_t / beat).ceil() as i64;
    let last = ((start_t + window_s) / beat).floor() as i64;
    for b in first..=last {
        let x = wave.x0 + (b as f64 * beat - start_t) / window_s * wave.width();
        let a = if b % 4 == 0 { 200 } else { 70 };
        scene.stroke(&Stroke::new(1.0), Affine::IDENTITY, Color::from_rgba8(255, 255, 255, a), None, &Line::new((x, wave.y0), (x, wave.y1)));
    }
    let px = wave.x0 + wave.width() / 2.0;
    scene.stroke(&Stroke::new(2.0), Affine::IDENTITY, Color::from_rgb8(255, 40, 60), None, &Line::new((px, wave.y0), (px, wave.y1)));
    // Overview: whole track, cached shape per frame (rebuilt here to keep the bench honest).
    let ocols = ov.width().max(1.0) as usize;
    let step = d.low.len() as f64 / ocols as f64;
    let ovals: Vec<f32> = (0..ocols)
        .map(|i| {
            let a = (i as f64 * step) as usize;
            let b = (((i + 1) as f64 * step) as usize).min(d.low.len()).max(a + 1);
            d.low[a..b].iter().cloned().fold(0.0, f32::max)
        })
        .collect();
    let oy = (ov.y0 + ov.y1) / 2.0;
    scene.fill(Fill::NonZero, Affine::IDENTITY, Color::from_rgb8(90, 140, 220), None, &band_path(&ovals, 0, ocols, ov.x0, ov.width(), oy, ov.height() / 2.0));
    let ox = ov.x0 + v.position / d.duration * ov.width();
    scene.fill(Fill::NonZero, Affine::IDENTITY, Color::from_rgba8(0, 0, 0, 120), None, &Rect::new(ov.x0, ov.y0, ox, ov.y1));
    scene.stroke(&Stroke::new(1.5), Affine::IDENTITY, Color::from_rgb8(255, 40, 60), None, &Line::new((ox, ov.y0), (ox, ov.y1)));
    // Jog platter.
    let c = (rect.x1 - pad - jog_d / 2.0, rect.y0 + pad + jog_d / 2.0);
    let r = jog_d / 2.0;
    if v.touched {
        scene.fill(Fill::NonZero, Affine::IDENTITY, Color::from_rgba8(80, 200, 255, 90), None, &Circle::new(c, r + 4.0));
    }
    scene.fill(Fill::NonZero, Affine::IDENTITY, Color::from_rgb8(12, 12, 14), None, &Circle::new(c, r));
    for g in 1..8 {
        scene.stroke(&Stroke::new(0.6), Affine::IDENTITY, Color::from_rgba8(255, 255, 255, 28), None, &Circle::new(c, r * (0.35 + g as f64 * 0.08)));
    }
    scene.fill(Fill::NonZero, Affine::IDENTITY, Color::from_rgb8(200, 30, 50), None, &Circle::new(c, r * 0.3));
    let rot = Affine::rotate_about(v.platter_angle, vello::kurbo::Point::new(c.0, c.1));
    scene.stroke(&Stroke::new(3.0), rot, Color::from_rgb8(250, 250, 250), None, &Line::new((c.0, c.1 - r * 0.32), (c.0, c.1 - r * 0.97)));
    // Progress ring (track position).
    let frac = (v.position / d.duration).clamp(0.0, 1.0);
    let mut arc = BezPath::new();
    let segs = 96;
    for i in 0..=((segs as f64 * frac) as usize) {
        let a = -PI / 2.0 + TAU * i as f64 / segs as f64;
        let pt = (c.0 + (r + 1.5) * a.cos(), c.1 + (r + 1.5) * a.sin());
        if i == 0 {
            arc.move_to(pt)
        } else {
            arc.line_to(pt)
        }
    }
    scene.stroke(&Stroke::new(3.0), Affine::IDENTITY, Color::from_rgb8(255, 120, 40), None, &arc);
}

pub struct FrameStats {
    pub adapter: String,
    pub backend: String,
    pub device_type: String,
    pub frames: usize,
    pub median_ms: f64,
    pub p99_ms: f64,
    pub cpu_encode_median_ms: f64,
    pub over_60hz: usize,
    pub over_120hz: usize,
    pub init_ms: f64,
}

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if v.is_empty() {
        return f64::NAN;
    }
    let i = ((v.len() as f64 - 1.0) * p).round() as usize;
    v[i]
}

/// Headless benchmark: `decks` strips at `w`x`h`, `frames` frames, each frame = build scene +
/// render + wait for GPU completion (device poll). Includes the jog platter on every deck.
pub fn bench(decks: usize, w: u32, h: u32, frames: usize, jog_only: bool) -> Result<FrameStats, String> {
    let t_init = Instant::now();
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::from_env_or_default());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
    }))
    .map_err(|e| format!("no adapter: {e}"))?;
    let info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("rn-render"),
        required_limits: adapter.limits(),
        ..Default::default()
    }))
    .map_err(|e| format!("device: {e}"))?;
    let mut renderer = Renderer::new(
        &device,
        RendererOptions { antialiasing_support: AaSupport::area_only(), num_init_threads: std::num::NonZeroUsize::new(1), ..Default::default() },
    )
    .map_err(|e| format!("renderer: {e}"))?;
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("target"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
    let data: Vec<DeckData> = (0..decks).map(|i| DeckData::synthetic(i as u32 + 1, 300.0)).collect();
    let init_ms = t_init.elapsed().as_secs_f64() * 1e3;
    let mut times = Vec::with_capacity(frames);
    let mut enc = Vec::with_capacity(frames);
    let mut scene = Scene::new();
    let strip = h as f64 / decks as f64;
    let warm = 10;
    for f in 0..frames + warm {
        let t0 = Instant::now();
        scene.reset();
        for (i, d) in data.iter().enumerate() {
            let t = 30.0 + f as f64 / 60.0 + i as f64;
            let v = DeckView { position: t, platter_angle: t / 1.8 * TAU, touched: f % 120 < 30, bpm: 120.0 + i as f64 };
            let rect = Rect::new(0.0, i as f64 * strip, w as f64, (i + 1) as f64 * strip);
            if jog_only {
                let jd = strip.min(240.0);
                let jr = Rect::new(w as f64 / 2.0 - jd, i as f64 * strip, w as f64 / 2.0 + jd, i as f64 * strip + jd);
                draw_deck(&mut scene, d, &v, jr);
            } else {
                draw_deck(&mut scene, d, &v, rect);
            }
        }
        let t1 = Instant::now();
        renderer
            .render_to_texture(&device, &queue, &scene, &view, &RenderParams { base_color: Color::BLACK, width: w, height: h, antialiasing_method: AaConfig::Area })
            .map_err(|e| format!("render: {e}"))?;
        device.poll(wgpu::PollType::Wait).map_err(|e| format!("poll: {e}"))?;
        let dt = t0.elapsed().as_secs_f64() * 1e3;
        if f >= warm {
            times.push(dt);
            enc.push((t1 - t0).as_secs_f64() * 1e3);
        }
    }
    let over_60hz = times.iter().filter(|&&t| t > 1000.0 / 60.0).count();
    let over_120hz = times.iter().filter(|&&t| t > 1000.0 / 120.0).count();
    let mut t2 = times.clone();
    Ok(FrameStats {
        adapter: info.name.clone(),
        backend: format!("{:?}", info.backend),
        device_type: format!("{:?}", info.device_type),
        frames,
        median_ms: pct(&mut t2.clone(), 0.5),
        p99_ms: pct(&mut t2, 0.99),
        cpu_encode_median_ms: pct(&mut enc, 0.5),
        over_60hz,
        over_120hz,
        init_ms,
    })
}

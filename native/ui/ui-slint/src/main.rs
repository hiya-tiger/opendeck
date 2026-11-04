//! Slint deck mock (femtovg/OpenGL renderer): 4 scrolling 3-band waveforms (Path elements fed
//! SVG path strings each frame) + 4 jog platters with a rotating marker. Same CLI as ui-egui.
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Instant;

slint::slint! {
    export component Deck inherits Rectangle {
        in property <string> low; in property <string> mid; in property <string> high; in property <string> marker;
        background: #121214;
        Path { x: 6px; y: 6px; width: parent.width - 250px; height: parent.height * 0.72; viewbox-width: 1600; viewbox-height: 200; commands: low; fill: #1e6ee6; }
        Path { x: 6px; y: 6px; width: parent.width - 250px; height: parent.height * 0.72; viewbox-width: 1600; viewbox-height: 200; commands: mid; fill: #f0a028c8; }
        Path { x: 6px; y: 6px; width: parent.width - 250px; height: parent.height * 0.72; viewbox-width: 1600; viewbox-height: 200; commands: high; fill: #fafafabe; }
        Rectangle { x: parent.width - 236px; y: 6px; width: min(parent.height - 12px, 220px); height: self.width; border-radius: self.width / 2; background: #0c0c0e;
            Rectangle { width: parent.width * 0.3; height: self.width; border-radius: self.width / 2; background: #c81e32; }
            Path { width: parent.width; height: parent.height; viewbox-width: 200; viewbox-height: 200; commands: marker; stroke: white; stroke-width: 3px; }
        }
    }
    export component Main inherits Window {
        width: 1920px; height: 1080px; background: #111;
        in property <[string]> low; in property <[string]> mid; in property <[string]> high; in property <[string]> marker;
        VerticalLayout { for i in 4: Deck { low: low[i]; mid: mid[i]; high: high[i]; marker: marker[i]; } }
    }
}

fn synth(seed: u32, n: usize) -> Vec<f32> {
    let mut s = seed.max(1);
    (0..n).map(|i| { s ^= s << 13; s ^= s >> 17; s ^= s << 5; let ph = (i as f32 / 75.0).fract(); (-ph * 8.0).exp() * 0.8 + (s % 100) as f32 / 500.0 }).collect()
}
fn band(src: &[f32], off: usize, scale: f32) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(1600 * 24);
    write!(s, "M 0 100").unwrap();
    for i in 0..1600 { write!(s, " L {} {:.1}", i, 100.0 - src[(off + i) % src.len()] * scale * 95.0).unwrap(); }
    for i in (0..1600).rev() { write!(s, " L {} {:.1}", i, 100.0 + src[(off + i) % src.len()] * scale * 95.0).unwrap(); }
    s.push_str(" Z");
    s
}
fn pct(v: &mut Vec<f64>, p: f64) -> f64 { v.sort_by(|a, b| a.partial_cmp(b).unwrap()); if v.is_empty() { return f64::NAN } v[((v.len() - 1) as f64 * p).round() as usize] }

fn main() {
    let start = Instant::now();
    let a: Vec<String> = std::env::args().collect();
    let mode = a.get(1).cloned().unwrap_or("frames".into());
    let n: usize = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(600);
    let ui = Main::new().unwrap();
    let data: Vec<Vec<f32>> = (0..4).map(|i| synth(i + 1, 40000)).collect();
    let state = Rc::new(RefCell::new((0usize, Vec::<f64>::new(), Vec::<f64>::new(), None::<Instant>, true)));
    let weak = ui.as_weak();
    let update = {
        let data = data.clone();
        let state = state.clone();
        move |ui: &Main| {
            let t0 = Instant::now();
            let f = state.borrow().0;
            let mk = |sc: f32, b: usize| -> slint::ModelRc<slint::SharedString> { Rc::new(slint::VecModel::from((0..4).map(|d| band(&data[d], f * 3 + d * 500 + b * 7, sc).into()).collect::<Vec<slint::SharedString>>())).into() };
            ui.set_low(mk(1.0, 0)); ui.set_mid(mk(0.7, 1)); ui.set_high(mk(0.45, 2));
            let markers: Vec<slint::SharedString> = (0..4).map(|d| { let a = f as f32 / 60.0 / 1.8 * std::f32::consts::TAU + d as f32; format!("M {:.1} {:.1} L {:.1} {:.1}", 100.0 + a.sin() * 32.0, 100.0 - a.cos() * 32.0, 100.0 + a.sin() * 97.0, 100.0 - a.cos() * 97.0).into() }).collect();
            ui.set_marker(Rc::new(slint::VecModel::from(markers)).into());
            state.borrow_mut().2.push(t0.elapsed().as_secs_f64() * 1e3);
        }
    };
    update(&ui);
    let st2 = state.clone();
    let mode2 = mode.clone();
    ui.window().set_rendering_notifier(move |s, _| {
        if let slint::RenderingState::AfterRendering = s {
            let mut st = st2.borrow_mut();
            let now = Instant::now();
            if let Some(l) = st.3 { st.1.push((now - l).as_secs_f64() * 1e3); }
            st.3 = Some(now);
            if st.4 { st.4 = false; println!("FIRST_FRAME {:.1}", start.elapsed().as_secs_f64() * 1e3); }
            if mode2 == "frames" { st.0 += 1; }
        }
    }).expect("rendering notifier");
    let timer = slint::Timer::default();
    let st3 = state.clone();
    let tick = if mode == "frames" { 1 } else { 250 };
    timer.start(slint::TimerMode::Repeated, std::time::Duration::from_millis(tick), move || {
        let Some(ui) = weak.upgrade() else { return };
        if mode == "frames" {
            let done = st3.borrow().1.len() >= n;
            if done {
                let st = st3.borrow();
                let (mut fr, mut c) = (st.1[10..].to_vec(), st.2[10..].to_vec());
                println!("RESULT {{\"kind\":\"ui\",\"toolkit\":\"slint\",\"frames\":{},\"frame_interval_median_ms\":{:.3},\"frame_interval_p99_ms\":{:.3},\"ui_cpu_median_ms\":{:.3},\"ui_cpu_p99_ms\":{:.3}}}", fr.len(), pct(&mut fr.clone(), 0.5), pct(&mut fr, 0.99), pct(&mut c.clone(), 0.5), pct(&mut c, 0.99));
                let _ = slint::quit_event_loop();
                return;
            }
            let f = st3.borrow().0;
            let seen = st3.borrow().2.len();
            if seen <= f { update(&ui); ui.window().request_redraw(); }
        } else if start.elapsed().as_secs_f64() >= n as f64 {
            let _ = slint::quit_event_loop();
        }
    });
    ui.run().unwrap();
}

//! rn-bench: benchmarks for the Rust-native OpenDecks stack. Every result is one line
//! `RESULT {json}` on stdout so CI job logs carry the numbers.
//! Usage: rn-bench <decode DIR | stretch | jog | audio [secs] | db [N] | render [frames] | all DIR>

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rn_engine::deck::{Deck, JogZone, Route};
use rn_engine::midi_jog::{JogEncoding, JogEvent, MidiJog};
use rn_engine::{controllers, decode, library, signal};
use serde_json::json;

const RUNS: usize = 5;

fn out(v: serde_json::Value) {
    println!("RESULT {}", v);
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if v.is_empty() {
        return f64::NAN;
    }
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

fn r3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

// ------------------------------------------------------------------ decode
fn bench_decode(dir: &str) {
    let mut entries: Vec<_> = std::fs::read_dir(dir).expect("fixtures dir").filter_map(|e| e.ok()).map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
        if ext == "json" || ext == "tmp" {
            continue;
        }
        let bytes = std::fs::read(&p).unwrap();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        // warm-up (discarded), then RUNS timed runs.
        match decode::decode_bytes(bytes.clone(), &ext) {
            Err(e) => {
                out(json!({"kind":"decode","file":name,"ok":false,"error":e}));
                continue;
            }
            Ok(_) => {}
        }
        let mut times = vec![];
        let mut last = None;
        for _ in 0..RUNS {
            let b = bytes.clone();
            let t = Instant::now();
            let d = decode::decode_bytes(b, &ext).unwrap();
            times.push(t.elapsed().as_secs_f64() * 1e3);
            last = Some(d);
        }
        let d = last.unwrap();
        let secs = d.frames as f64 / d.rate as f64;
        let med = median(times);
        out(json!({"kind":"decode","file":name,"ok":true,"codec":d.codec,"rate":d.rate,"channels":d.source_channels,
            "frames":d.frames,"audio_s":r3(secs),"median_ms":r3(med),"x_realtime":r3(secs*1e3/med),"decode_errors":d.decode_errors}));
    }
}

// ------------------------------------------------------------------ stretch
fn bench_stretch() {
    let sr = 44100.0;
    let tone = Arc::new(signal::sine_stereo(440.0, sr, 30.0, 0.5));
    let rates = [0.5, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 2.0];
    for &cheaper in &[false, true] {
        let preset = if cheaper { "cheaper" } else { "default" };
        for &rate in &rates {
            let mut times = vec![];
            let mut cents = 0.0;
            let mut resid = 0.0;
            let mut lat = 0;
            for run in 0..RUNS {
                let mut d = Deck::new(tone.clone(), sr as u32, Route::Stretch, cheaper);
                d.tempo = rate;
                d.keylock = true;
                d.play();
                lat = d.stretch_latency();
                let block = 256;
                let blocks = (10.0 * sr) as usize / block; // 10 s of output
                let mut buf = vec![0f32; block * 2];
                let mut mono = Vec::with_capacity(blocks * block);
                let t = Instant::now();
                for _ in 0..blocks {
                    d.process(&mut buf);
                    if run == 0 {
                        mono.extend(buf.chunks_exact(2).map(|f| f[0]));
                    }
                }
                times.push(t.elapsed().as_secs_f64());
                if run == 0 {
                    let seg = &mono[(sr as usize)..(sr as usize * 4)];
                    let f = signal::peak_freq(seg, sr);
                    cents = signal::cents(f, 440.0);
                    resid = signal::residual_db(seg, f, sr);
                }
            }
            let med = median(times);
            out(json!({"kind":"stretch","preset":preset,"rate":rate,"keylock":true,"cpu_pct_per_deck":r3(med/10.0*100.0),
                "pitch_error_cents":r3(cents),"residual_db":r3(resid),"added_latency_frames":lat,"added_latency_ms":r3(lat as f64/sr*1e3)}));
        }
    }
    // Vinyl (no key lock) pitch tracks rate.
    for &rate in &[0.5, 0.8, 1.25, 2.0] {
        let mut d = Deck::new(tone.clone(), sr as u32, Route::Stretch, false);
        d.tempo = rate;
        d.keylock = false;
        d.play();
        let mut buf = vec![0f32; 256 * 2];
        let mut mono = vec![];
        for _ in 0..(4.0 * sr) as usize / 256 {
            d.process(&mut buf);
            mono.extend(buf.chunks_exact(2).map(|f| f[0]));
        }
        let f = signal::peak_freq(&mono[sr as usize..], sr);
        out(json!({"kind":"stretch_vinyl","rate":rate,"expected_hz":440.0*rate,"measured_hz":r3(f),"pitch_error_cents":r3(signal::cents(f,440.0*rate))}));
    }
    // 4 decks at once (two keylocked, two vinyl), cheaper and default.
    for &cheaper in &[false, true] {
        let mut times = vec![];
        for _ in 0..RUNS {
            let mut decks: Vec<Deck> = (0..4)
                .map(|i| {
                    let mut d = Deck::new(tone.clone(), sr as u32, Route::Stretch, cheaper);
                    d.tempo = [1.0, 1.03, 0.97, 1.06][i];
                    d.keylock = i < 2;
                    d.play();
                    d
                })
                .collect();
            let mut buf = vec![0f32; 256 * 2];
            let t = Instant::now();
            for _ in 0..(10.0 * sr) as usize / 256 {
                for d in decks.iter_mut() {
                    d.process(&mut buf);
                }
            }
            times.push(t.elapsed().as_secs_f64());
        }
        out(json!({"kind":"stretch_4deck","preset":if cheaper {"cheaper"} else {"default"},"cpu_pct_total_one_core":r3(median(times)/10.0*100.0)}));
    }
}

// ------------------------------------------------------------------ jog
/// Scratch gesture: hand angle (radians) over time for a "baby scratch" back and forth,
/// then a forward push, a release with a back-spin, and a vinyl brake.
fn gesture_angle(t: f64) -> f64 {
    // 0..2 s: baby scratch, +-0.5 rev at 2 Hz.
    if t < 2.0 {
        (std::f64::consts::TAU * 0.5) * (std::f64::consts::TAU * 2.0 * t).sin()
    } else {
        0.0
    }
}

struct JogRun {
    clicks: usize,
    worst: f64,
    pos_err_frames: f64,
    reverse_frames: f64,
    cpu_pct: f64,
}

/// Drive a deck with input events at `event_hz` (quantised like the input device), render
/// with `route`, measure clicks on a sine and final position error versus the hand.
fn run_scratch(route: Route, event_hz: f64, quant_rad: f64, block: usize) -> JogRun {
    let sr = 44100.0;
    let tone = Arc::new(signal::sine_stereo(440.0, sr, 60.0, 0.5));
    let mut d = Deck::new(tone, sr as u32, route, false);
    d.seek(20.0 * sr);
    let start = d.pos;
    d.jog_touch(true);
    let mut buf = vec![0f32; block * 2];
    let mut mono = vec![];
    let total = (2.0 * sr) as usize;
    let mut emitted = 0.0; // angle already sent
    let mut next_ev = 0.0;
    let mut min_pos = d.pos;
    let mut max_rate: f64 = 0.0;
    let t0 = Instant::now();
    let mut n = 0;
    while n < total {
        let t = n as f64 / sr;
        while next_ev <= t + block as f64 / sr {
            let want = gesture_angle(next_ev);
            let mut delta = want - emitted;
            if quant_rad > 0.0 {
                delta = (delta / quant_rad).trunc() * quant_rad;
            }
            if delta != 0.0 {
                d.jog_move(JogZone::Top, delta);
                emitted += delta;
            }
            next_ev += 1.0 / event_hz;
        }
        d.process(&mut buf);
        max_rate = max_rate.max(d.rate().abs());
        min_pos = min_pos.min(d.pos);
        mono.extend(buf.chunks_exact(2).map(|f| f[0]));
        n += block;
    }
    // settle 100 ms holding still
    for _ in 0..(0.1 * sr) as usize / block {
        d.process(&mut buf);
        mono.extend(buf.chunks_exact(2).map(|f| f[0]));
    }
    let cpu = t0.elapsed().as_secs_f64() / ((total as f64 + 0.1 * sr) / sr) * 100.0;
    let frames_per_rad = sr * 1.8 / std::f64::consts::TAU;
    let expected = start + emitted * frames_per_rad;
    let skip = if route == Route::Stretch { d.stretch_latency() } else { 0 };
    let (clicks, worst) = signal::clicks(&mono[skip.min(mono.len())..], 0.5, 440.0, max_rate.max(1.0) * 1.1, sr, 1.5);
    JogRun { clicks, worst, pos_err_frames: (d.pos - expected).abs(), reverse_frames: start - min_pos, cpu_pct: cpu }
}

/// Input-to-audio latency: deck held still (silent), one jog movement at t=0, first output
/// sample above -40 dBFS. Engine latency only (device buffers come on top).
fn jog_latency(route: Route, block: usize) -> f64 {
    let sr = 44100.0;
    let tone = Arc::new(signal::sine_stereo(440.0, sr, 30.0, 0.5));
    let mut d = Deck::new(tone, sr as u32, route, false);
    d.seek(10.0 * sr);
    d.jog_touch(true);
    let mut buf = vec![0f32; block * 2];
    for _ in 0..(0.5 * sr) as usize / block {
        d.process(&mut buf);
    }
    d.jog_move(JogZone::Top, 0.5); // ~0.14 s of audio forward
    let mut n = 0usize;
    for _ in 0..(1.0 * sr) as usize / block {
        d.process(&mut buf);
        for (i, f) in buf.chunks_exact(2).enumerate() {
            if f[0].abs() > 0.005 {
                return (n + i) as f64 / sr * 1e3;
            }
        }
        n += block;
    }
    f64::NAN
}

fn bench_jog() {
    let sr = 44100.0;
    for &block in &[64usize, 128, 256] {
        for &route in &[Route::Varispeed, Route::Stretch] {
            out(json!({"kind":"jog_latency","route":format!("{:?}",route),"block":block,"engine_ms":r3(jog_latency(route, block)),
                "plus_one_device_buffer_ms":r3(jog_latency(route, block)+block as f64/sr*1e3)}));
        }
    }
    // Inputs: mouse at 60/120/1000 Hz (unquantised), 7-bit relative MIDI at 1 kHz with 2048
    // ticks/rev placeholder resolution, 14-bit absolute at 1 kHz (16384 counts/rev).
    let inputs: [(&str, f64, f64); 5] = [
        ("mouse_60hz", 60.0, 0.0),
        ("mouse_120hz", 120.0, 0.0),
        ("pointer_1000hz", 1000.0, 0.0),
        ("midi_rel7_1khz_2048tpr", 1000.0, std::f64::consts::TAU / 2048.0),
        ("midi_abs14_1khz", 1000.0, std::f64::consts::TAU / 16384.0),
    ];
    for &(name, hz, q) in &inputs {
        for &route in &[Route::Varispeed, Route::Stretch] {
            let r = run_scratch(route, hz, q, 128);
            out(json!({"kind":"jog_scratch","input":name,"route":format!("{:?}",route),"clicks":r.clicks,"worst_d2_over_bound":r3(r.worst),
                "position_error_frames":r3(r.pos_err_frames),"reverse_travel_frames":r3(r.reverse_frames),"cpu_pct_one_deck":r3(r.cpu_pct)}));
        }
    }
    // Back-spin: playing at 1x, flung to -6x and released; slip-mat returns it to +1x.
    for &route in &[Route::Varispeed, Route::Stretch] {
        let tone = Arc::new(signal::sine_stereo(440.0, sr, 60.0, 0.5));
        let mut d = Deck::new(tone, sr as u32, route, false);
        d.seek(30.0 * sr);
        d.play();
        let mut buf = vec![0f32; 128 * 2];
        let mut mono = vec![];
        for _ in 0..50 {
            d.process(&mut buf);
        }
        let p0 = d.pos;
        d.fling(-6.0);
        let mut min_pos = d.pos;
        let mut t_back = 0.0;
        let mut t_recover = f64::NAN;
        for k in 0..(2.0 * sr) as usize / 128 {
            d.process(&mut buf);
            mono.extend(buf.chunks_exact(2).map(|f| f[0]));
            if d.rate() < 0.0 {
                t_back = (k + 1) as f64 * 128.0 / sr;
            }
            if t_recover.is_nan() && (d.rate() - 1.0).abs() < 0.01 {
                t_recover = (k + 1) as f64 * 128.0 / sr;
            }
            min_pos = min_pos.min(d.pos);
        }
        let skip = if route == Route::Stretch { d.stretch_latency() } else { 0 };
        let (clicks, worst) = signal::clicks(&mono[skip..], 0.5, 440.0, 6.6, sr, 1.5);
        out(json!({"kind":"jog_backspin","route":format!("{:?}",route),"reverse_seconds_of_audio":r3((p0-min_pos)/sr),
            "time_running_backwards_s":r3(t_back),"time_to_recover_1x_s":r3(t_recover),"clicks":clicks,"worst_d2_over_bound":r3(worst)}));
    }
    // Vinyl brake (motor off with brake_ms) and nudge (ring) bend measured by pitch.
    for &route in &[Route::Varispeed, Route::Stretch] {
        let tone = Arc::new(signal::sine_stereo(440.0, sr, 60.0, 0.5));
        let mut d = Deck::new(tone.clone(), sr as u32, route, false);
        d.seek(5.0 * sr);
        d.play();
        let mut buf = vec![0f32; 128 * 2];
        for _ in 0..100 {
            d.process(&mut buf);
        }
        d.stop();
        let mut mono = vec![];
        let mut t_stop = f64::NAN;
        for k in 0..(1.5 * sr) as usize / 128 {
            d.process(&mut buf);
            mono.extend(buf.chunks_exact(2).map(|f| f[0]));
            if t_stop.is_nan() && d.rate().abs() < 1e-3 {
                t_stop = (k + 1) as f64 * 128.0 / sr;
            }
        }
        let skip = if route == Route::Stretch { d.stretch_latency() } else { 0 };
        let (clicks, worst) = signal::clicks(&mono[skip..], 0.5, 440.0, 1.1, sr, 1.5);
        out(json!({"kind":"jog_brake","route":format!("{:?}",route),"brake_ms_setting":600,"measured_stop_s":r3(t_stop),"clicks":clicks,"worst_d2_over_bound":r3(worst)}));
        // nudge: ring turned forward at 0.5 rev/s for 1 s while playing with key lock off.
        let mut d = Deck::new(tone, sr as u32, route, false);
        d.keylock = false;
        d.seek(5.0 * sr);
        d.play();
        for _ in 0..100 {
            d.process(&mut buf);
        }
        let mut mono = vec![];
        for _ in 0..(1.0 * sr) as usize / 128 {
            d.jog_move(JogZone::Ring, std::f64::consts::PI * 128.0 / sr); // 0.5 rev/s
            d.process(&mut buf);
            mono.extend(buf.chunks_exact(2).map(|f| f[0]));
        }
        let f = signal::peak_freq(&mono[(0.3 * sr) as usize..], sr);
        out(json!({"kind":"jog_nudge","route":format!("{:?}",route),"ring_rev_per_s":0.5,"expected_bend_pct":12.5,
            "measured_bend_pct":r3((f/440.0-1.0)*100.0)}));
    }
    // MIDI decode: every catalogue entry, encode/decode round trip for each encoding.
    for c in controllers::catalogue() {
        for map in [c.map_deck1.clone(), c.map_deck2.clone()] {
            let mut mj = MidiJog::new(map.clone());
            let st = 0xb0 | map.channel;
            let mut total = 0.0;
            let mut ok = true;
            for t in [-63i32, -5, -1, 1, 7, 63] {
                let v = MidiJog::encode_relative(map.encoding, t);
                match mj.feed([st, map.top_cc, v]) {
                    Some(JogEvent::Move { zone: JogZone::Top, radians }) => total += radians,
                    _ => ok = false,
                }
            }
            let touch = match (map.touch_note, map.touch_cc) {
                (Some(n), _) => mj.feed([0x90 | map.channel, n, 0x7f]) == Some(JogEvent::Touch(true)) && mj.feed([0x90 | map.channel, n, 0]) == Some(JogEvent::Touch(false)),
                (None, Some(cc)) => mj.feed([0xb0 | map.channel, cc, 0x7f]) == Some(JogEvent::Touch(true)) && mj.feed([0xb0 | map.channel, cc, 0]) == Some(JogEvent::Touch(false)),
                _ => false,
            };
            let ring = map.ring_cc.map(|r| matches!(mj.feed([st, r, MidiJog::encode_relative(map.encoding, 3)]), Some(JogEvent::Move { zone: JogZone::Ring, .. })));
            let expect = (-63 - 5 - 1 + 1 + 7 + 63) as f64 / map.ticks_per_rev * std::f64::consts::TAU;
            out(json!({"kind":"midi_jog_map","controller":map.controller,"channel":map.channel+1,"encoding":format!("{:?}",map.encoding),
                "top_ok":ok && (total-expect).abs()<1e-9,"touch_ok":touch,"ring_ok":ring,"ticks_per_rev_documented":c.ticks_per_rev_documented,
                "verified_on_hardware":c.verified_on_hardware,"source":map.source}));
        }
    }
    // 14-bit absolute encoder: wrap-around handling.
    let map = rn_engine::midi_jog::JogMap {
        controller: "generic-14bit",
        source: "MIDI 1.0 spec CC MSB/LSB pairing (n, n+32)",
        channel: 0,
        encoding: JogEncoding::Absolute14,
        top_cc: 0x10,
        ring_cc: None,
        touch_note: Some(0x20),
        touch_cc: None,
        ticks_per_rev: 16384.0,
    };
    let mut mj = MidiJog::new(map);
    let mut acc = 0.0;
    for v in [16300i32, 16380, 10, 90, 16370] {
        let (msb, lsb) = ((v >> 7) as u8, (v & 0x7f) as u8);
        mj.feed([0xb0, 0x10, msb]);
        if let Some(JogEvent::Move { radians, .. }) = mj.feed([0xb0, 0x30, lsb]) {
            acc += radians;
        }
    }
    let expect_counts = (16380 - 16300) + (16384 - 16380 + 10) + (90 - 10) + (16370 - 16384 - 90);
    out(json!({"kind":"midi_jog_abs14","wrap_ok":(acc - expect_counts as f64/16384.0*std::f64::consts::TAU).abs()<1e-9}));
}

// ------------------------------------------------------------------ audio (CPAL)
fn bench_audio(secs: f64) {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let hosts: Vec<String> = cpal::available_hosts().iter().map(|h| format!("{:?}", h)).collect();
    let host = cpal::default_host();
    let devs: Vec<String> = host.output_devices().map(|it| it.filter_map(|d| d.name().ok()).collect()).unwrap_or_default();
    let ins: Vec<String> = host.input_devices().map(|it| it.filter_map(|d| d.name().ok()).collect()).unwrap_or_default();
    out(json!({"kind":"audio_env","hosts":hosts,"default_host":format!("{:?}",host.id()),"outputs":devs,"inputs":ins}));
    let Some(dev) = host.default_output_device() else {
        out(json!({"kind":"audio","ok":false,"error":"no default output device on this runner"}));
        return;
    };
    let name = dev.name().unwrap_or_default();
    let cfg = match dev.default_output_config() {
        Ok(c) => c,
        Err(e) => {
            out(json!({"kind":"audio","ok":false,"device":name,"error":e.to_string()}));
            return;
        }
    };
    let sr = cfg.sample_rate().0;
    let ch = cfg.channels() as usize;
    let range = format!("{:?}", cfg.buffer_size());
    let tone = Arc::new(signal::sine_stereo(440.0, sr as f64, 30.0, 0.2));
    let mut lowest_stable: Option<u32> = None;
    for &bs in &[32u32, 64, 128, 256, 512, 1024] {
        let decks: Vec<Deck> = (0..4)
            .map(|i| {
                let mut d = Deck::new(tone.clone(), sr, Route::Stretch, true);
                d.tempo = [1.0, 1.03, 0.97, 1.06][i];
                d.play();
                d
            })
            .collect();
        let decks = Arc::new(Mutex::new(decks));
        let late = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let errs = Arc::new(AtomicUsize::new(0));
        let max_ns = Arc::new(AtomicU64::new(0));
        let gaps = Arc::new(AtomicUsize::new(0));
        let last = Arc::new(Mutex::new(None::<Instant>));
        let mut scratch = vec![0f32; rn_engine::deck::MAX_BLOCK * 2];
        let mut mix = vec![0f32; rn_engine::deck::MAX_BLOCK * 2];
        let (d2, l2, c2, m2, g2, la2) = (decks.clone(), late.clone(), calls.clone(), max_ns.clone(), gaps.clone(), last.clone());
        let e2 = errs.clone();
        let config = cpal::StreamConfig { channels: ch as u16, sample_rate: cpal::SampleRate(sr), buffer_size: cpal::BufferSize::Fixed(bs) };
        let stream = dev.build_output_stream(
            &config,
            move |data: &mut [f32], _| {
                let t = Instant::now();
                let frames = (data.len() / ch).min(rn_engine::deck::MAX_BLOCK);
                let period = frames as f64 / sr as f64;
                if let Some(prev) = la2.lock().unwrap().replace(t) {
                    if (t - prev).as_secs_f64() > period * 1.8 + 0.002 {
                        g2.fetch_add(1, Ordering::Relaxed);
                    }
                }
                mix[..frames * 2].iter_mut().for_each(|v| *v = 0.0);
                if let Ok(mut ds) = d2.try_lock() {
                    for d in ds.iter_mut() {
                        d.process(&mut scratch[..frames * 2]);
                        for i in 0..frames * 2 {
                            mix[i] += scratch[i] * 0.25;
                        }
                    }
                }
                for (i, f) in data.chunks_mut(ch).enumerate() {
                    if i >= frames {
                        break;
                    }
                    f[0] = mix[2 * i];
                    if ch > 1 {
                        f[1] = mix[2 * i + 1];
                    }
                }
                let el = t.elapsed();
                m2.fetch_max(el.as_nanos() as u64, Ordering::Relaxed);
                if el.as_secs_f64() > period {
                    l2.fetch_add(1, Ordering::Relaxed);
                }
                c2.fetch_add(1, Ordering::Relaxed);
            },
            move |_e| {
                e2.fetch_add(1, Ordering::Relaxed);
            },
            None,
        );
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                out(json!({"kind":"audio_buffer","device":name,"buffer":bs,"ok":false,"error":e.to_string(),"supported":range}));
                continue;
            }
        };
        if let Err(e) = stream.play() {
            out(json!({"kind":"audio_buffer","device":name,"buffer":bs,"ok":false,"error":e.to_string()}));
            continue;
        }
        std::thread::sleep(Duration::from_secs_f64(secs));
        drop(stream);
        let (c, l, g, e) = (calls.load(Ordering::Relaxed), late.load(Ordering::Relaxed), gaps.load(Ordering::Relaxed), errs.load(Ordering::Relaxed));
        let expected = secs * sr as f64 / bs as f64;
        let stable = c as f64 > expected * 0.5 && l == 0 && g == 0 && e == 0;
        if stable && lowest_stable.is_none() {
            lowest_stable = Some(bs);
        }
        out(json!({"kind":"audio_buffer","device":name,"rate":sr,"buffer":bs,"ok":true,"seconds":secs,"callbacks":c,"expected_callbacks":r3(expected),
            "late_callbacks":l,"timing_gaps":g,"stream_errors":e,"worst_callback_us":max_ns.load(Ordering::Relaxed)/1000,
            "period_us":(bs as f64/sr as f64*1e6) as u64,"stable":stable,"decks":4}));
    }
    out(json!({"kind":"audio_lowest_stable","device":name,"buffer":lowest_stable,"latency_ms_one_buffer":lowest_stable.map(|b| r3(b as f64/sr as f64*1e3))}));
    // Hot-plug, simulated: tear the stream down as a device-loss handler would, re-enumerate
    // and rebuild on the (new) default device; time to first callback.
    let mut times = vec![];
    for _ in 0..RUNS {
        let t = Instant::now();
        let host = cpal::default_host();
        let Some(dev) = host.default_output_device() else { break };
        let cfg = dev.default_output_config().unwrap();
        let first = Arc::new(Mutex::new(None::<Instant>));
        let f2 = first.clone();
        let s = dev.build_output_stream(
            &cfg.config(),
            move |d: &mut [f32], _| {
                d.iter_mut().for_each(|v| *v = 0.0);
                f2.lock().unwrap().get_or_insert(Instant::now());
            },
            |_| {},
            None,
        );
        if let Ok(s) = s {
            let _ = s.play();
            let deadline = Instant::now() + Duration::from_secs(2);
            while first.lock().unwrap().is_none() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(1));
            }
            if let Some(f) = *first.lock().unwrap() {
                times.push((f - t).as_secs_f64() * 1e3);
            }
        }
    }
    out(json!({"kind":"audio_hotplug_sim","method":"drop stream + re-enumerate + rebuild default device (no physical unplug)","runs":times.len(),"median_ms_to_first_callback":r3(median(times))}));
    bench_roundtrip(secs.min(5.0));
}

/// Round trip through a loopback (ALSA snd-aloop on Linux CI when it loads): play a click on
/// the default output, capture the default input, find the click.
fn bench_roundtrip(_secs: f64) {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let host = cpal::default_host();
    let want = std::env::var("RN_LOOP_IN").ok();
    let want_out = std::env::var("RN_LOOP_OUT").ok();
    let pick = |devs: Option<Vec<cpal::Device>>, name: &Option<String>| -> Option<cpal::Device> {
        let n = name.as_ref()?;
        devs?.into_iter().find(|d| d.name().map(|x| x.contains(n.as_str())).unwrap_or(false))
    };
    let (Some(o), Some(i)) = (
        pick(host.output_devices().ok().map(|x| x.collect()), &want_out),
        pick(host.input_devices().ok().map(|x| x.collect()), &want),
    ) else {
        out(json!({"kind":"audio_roundtrip","ok":false,"reason":"no loopback pair (set RN_LOOP_OUT/RN_LOOP_IN); not measured"}));
        return;
    };
    for &bs in &[64u32, 128, 256, 512] {
        let sr = 48000u32;
        let cfg = cpal::StreamConfig { channels: 2, sample_rate: cpal::SampleRate(sr), buffer_size: cpal::BufferSize::Fixed(bs) };
        let played = Arc::new(AtomicU64::new(0));
        let start = Instant::now();
        let p2 = played.clone();
        let mut n: u64 = 0;
        let fired = Arc::new(AtomicU64::new(u64::MAX));
        let fz = fired.clone();
        let os = o.build_output_stream(
            &cfg,
            move |d: &mut [f32], _| {
                for f in d.chunks_mut(2) {
                    let v = if n == 24000 { 1.0 } else { 0.0 };
                    if n == 24000 {
                        fz.store(start.elapsed().as_nanos() as u64, Ordering::Relaxed);
                    }
                    f.iter_mut().for_each(|x| *x = v * 0.9);
                    n += 1;
                }
                p2.store(n, Ordering::Relaxed);
            },
            |_| {},
            None,
        );
        let got = Arc::new(AtomicU64::new(u64::MAX));
        let g2 = got.clone();
        let is = i.build_input_stream(
            &cfg,
            move |d: &[f32], _| {
                if d.iter().any(|v| v.abs() > 0.3) && g2.load(Ordering::Relaxed) == u64::MAX {
                    g2.store(start.elapsed().as_nanos() as u64, Ordering::Relaxed);
                }
            },
            |_| {},
            None,
        );
        match (os, is) {
            (Ok(os), Ok(is)) => {
                let _ = is.play();
                let _ = os.play();
                std::thread::sleep(Duration::from_secs(2));
                let (f, g) = (fired.load(Ordering::Relaxed), got.load(Ordering::Relaxed));
                let ms = if f != u64::MAX && g != u64::MAX { Some(r3((g as f64 - f as f64) / 1e6)) } else { None };
                out(json!({"kind":"audio_roundtrip","ok":ms.is_some(),"buffer":bs,"rate":sr,"output":o.name().unwrap_or_default(),"input":i.name().unwrap_or_default(),
                    "method":"wall clock: click written in output callback -> first input callback containing it (includes both buffers)","roundtrip_ms":ms}));
            }
            (a, b) => out(json!({"kind":"audio_roundtrip","ok":false,"buffer":bs,"error":format!("{:?} / {:?}", a.err().map(|e| e.to_string()), b.err().map(|e| e.to_string()))})),
        }
    }
}

// ------------------------------------------------------------------ db
fn bench_db(n: usize) {
    let dir = std::env::temp_dir().join(format!("rn-db-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let tracks = library::synth_tracks(n);
    let mut imp = vec![];
    let mut q: std::collections::BTreeMap<&str, Vec<f64>> = Default::default();
    let mut counts = serde_json::Map::new();
    for run in 0..RUNS {
        let path = dir.join(format!("lib{run}.sqlite"));
        let _ = std::fs::remove_file(&path);
        let t = Instant::now();
        let mut c = library::open(path.to_str().unwrap()).unwrap();
        library::import(&mut c, &tracks).unwrap();
        imp.push(t.elapsed().as_secs_f64() * 1e3);
        drop(c);
        let t = Instant::now();
        let mut c = library::open(path.to_str().unwrap()).unwrap();
        let _ = c.query_row("SELECT count(*) FROM tracks", [], |r| r.get::<_, i64>(0)).unwrap();
        q.entry("open_count_ms").or_default().push(t.elapsed().as_secs_f64() * 1e3);
        macro_rules! time {
            ($k:expr, $e:expr) => {{
                let t = Instant::now();
                let v = $e;
                q.entry($k).or_default().push(t.elapsed().as_secs_f64() * 1e3);
                counts.insert($k.to_string(), json!(v));
            }};
        }
        time!("search_like_ms", library::search_like(&c, "night").unwrap());
        time!("search_fts_prefix_ms", library::search_fts(&c, "nig").unwrap());
        time!("sort_page500_ms", library::sort_page(&c).unwrap());
        time!("sort_all_ms", library::sort_all(&c).unwrap());
        time!("live_playlist_ms", library::live_playlist(&c).unwrap());
        let t = Instant::now();
        library::update_meta(&mut c, 1000).unwrap();
        q.entry("update_meta_1000_ms").or_default().push(t.elapsed().as_secs_f64() * 1e3);
    }
    let mut res = serde_json::Map::new();
    res.insert("kind".into(), json!("db"));
    res.insert("tracks".into(), json!(n));
    res.insert("import_ms".into(), json!(r3(median(imp))));
    for (k, v) in q {
        res.insert(k.into(), json!(r3(median(v))));
    }
    res.insert("result_rows".into(), serde_json::Value::Object(counts));
    out(serde_json::Value::Object(res));
    let _ = std::fs::remove_dir_all(&dir);
}

// ------------------------------------------------------------------ render
fn bench_render(frames: usize) {
    for &(decks, jog_only) in &[(2usize, false), (4, false), (4, true)] {
        let mut meds = vec![];
        let mut p99s = vec![];
        let mut o60 = 0;
        let mut o120 = 0;
        let mut info = None;
        for _ in 0..RUNS {
            match rn_render::bench(decks, 1920, 1080, frames, jog_only) {
                Ok(s) => {
                    meds.push(s.median_ms);
                    p99s.push(s.p99_ms);
                    o60 += s.over_60hz;
                    o120 += s.over_120hz;
                    info = Some((s.adapter, s.backend, s.device_type, s.cpu_encode_median_ms, s.init_ms));
                }
                Err(e) => {
                    out(json!({"kind":"render","decks":decks,"jog_only":jog_only,"ok":false,"error":e}));
                    break;
                }
            }
        }
        if let Some((a, b, t, enc, init)) = info {
            let total = (frames * meds.len()) as f64;
            out(json!({"kind":"render","decks":decks,"jog_only":jog_only,"ok":true,"adapter":a,"backend":b,"device_type":t,"size":"1920x1080",
                "frames_per_run":frames,"runs":meds.len(),"median_ms":r3(median(meds)),"p99_ms":r3(median(p99s)),"cpu_scene_build_median_ms":r3(enc),
                "pct_frames_within_60hz":r3(100.0-o60 as f64/total*100.0),"pct_frames_within_120hz":r3(100.0-o120 as f64/total*100.0),"init_ms":r3(init)}));
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("help");
    out(json!({"kind":"env","os":std::env::consts::OS,"arch":std::env::consts::ARCH,"cpus":std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),"cmd":cmd}));
    match cmd {
        "decode" => bench_decode(args.get(2).map(|s| s.as_str()).unwrap_or("fixtures/audio")),
        "stretch" => bench_stretch(),
        "jog" => bench_jog(),
        "audio" => bench_audio(args.get(2).and_then(|s| s.parse().ok()).unwrap_or(10.0)),
        "db" => bench_db(args.get(2).and_then(|s| s.parse().ok()).unwrap_or(100_000)),
        "render" => bench_render(args.get(2).and_then(|s| s.parse().ok()).unwrap_or(300)),
        _ => eprintln!("usage: rn-bench decode DIR | stretch | jog | audio [secs] | db [N] | render [frames]"),
    }
}

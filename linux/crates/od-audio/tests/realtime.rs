//! The callback must not allocate or free: every command path and every FX
//! runs inside assert_no_alloc with the AllocDisabler as global allocator.
use assert_no_alloc::{assert_no_alloc, AllocDisabler};
use od_audio::{Command, Engine, Pcm};
use od_core::fx::{FxType, FX_DEFS};
use std::sync::Arc;

#[global_allocator]
static A: AllocDisabler = AllocDisabler;

fn tone(sr: f64, secs: f64, hz: f64, mono: bool) -> Arc<Pcm> {
    let n = (sr * secs) as usize;
    let c: Vec<f32> = (0..n).map(|i| (i as f64 * hz * std::f64::consts::TAU / sr).sin() as f32 * 0.5).collect();
    Arc::new(Pcm { channels: if mono { vec![c] } else { vec![c.clone(), c] } })
}

#[test]
fn four_decks_fx_keylock_no_alloc() {
    let sr = 48000;
    let (mut e, mut c) = Engine::new(sr, true);
    for d in 0..4 {
        c.send(Command::Load { deck: d, pcm: tone(sr as f64, 20.0, 110.0 * (d + 1) as f64, d == 3), bpm: 124.0 });
        c.send(Command::Play { deck: d, on: true });
        c.send(Command::Keylock { deck: d, on: d >= 2 });
        c.send(Command::Rate { deck: d, rate: 1.0 + 0.03 * d as f64 });
    }
    c.send(Command::Record(true));
    let mut out = vec![0f32; 256 * 4];
    let mut cue = vec![0f32; 256 * 2];
    for (i, def) in FX_DEFS.iter().enumerate() {
        c.send(Command::Fx { deck: i % 4, kind: def.id, division: "1/4", amount: 0.6, wet: 0.7 });
        c.send(Command::Loop { deck: 1, start: 1.0, end: 1.5, on: i % 2 == 0 });
        c.send(Command::Censor { deck: 0, on: i % 3 == 0 });
        c.send(Command::Pfl { deck: 2, on: true });
        c.send(Command::Crossfader { value: i as f64 / 15.0 });
        c.send(Command::Eq { deck: 0, band: i % 3, db: -6.0 });
        c.send(Command::Kill { deck: 1, band: 0, on: i % 2 == 1 });
        for _ in 0..40 { assert_no_alloc(|| e.process(&mut out, 4, Some(&mut cue))); }
        if let Some(r) = c.rec.as_mut() { while r.pop().is_ok() {} }
    }
    // Loading over a playing deck releases the old buffer to the UI thread, not in the callback.
    c.send(Command::Load { deck: 0, pcm: tone(sr as f64, 5.0, 220.0, false), bpm: 128.0 });
    c.send(Command::Eject { deck: 1 });
    assert_no_alloc(|| e.process(&mut out, 4, Some(&mut cue)));
    c.collect();
    let st = c.status.clone();
    assert!(st.playing(2) && st.playing(3));
    assert!(st.master_peak() > 0.0, "silence");
    assert!(out.iter().all(|v| v.is_finite()));
    let _ = FxType::Off;
}

#[test]
fn keylock_keeps_pitch_varispeed_does_not() {
    // 440 Hz at +8%: varispeed -> ~475 Hz, key-lock -> ~440 Hz (zero-crossing estimate).
    let sr = 48000.0;
    let freq = |keylock: bool| {
        let (mut e, mut c) = Engine::new(48000, false);
        c.send(Command::Load { deck: 0, pcm: tone(sr, 10.0, 440.0, false), bpm: 120.0 });
        c.send(Command::Keylock { deck: 0, on: keylock });
        c.send(Command::Rate { deck: 0, rate: 1.08 });
        c.send(Command::Play { deck: 0, on: true });
        let mut out = vec![0f32; 512 * 2];
        let mut all = vec![];
        for _ in 0..200 { e.process(&mut out, 2, None); all.extend(out.iter().step_by(2).copied()); }
        let tail = &all[all.len() / 2..];
        let zc = tail.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        zc as f64 / (tail.len() as f64 / sr)
    };
    let v = freq(false);
    let k = freq(true);
    assert!((v - 475.2).abs() < 6.0, "varispeed {v}");
    assert!((k - 440.0).abs() < 6.0, "keylock {k}");
}

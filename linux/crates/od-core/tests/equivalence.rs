//! Output equivalence with the TypeScript (vectors from linux/tools/export-ts.mjs).
use od_core::*;
use serde_json::Value;

fn load(name: &str) -> Value { serde_json::from_str(&std::fs::read_to_string(format!("{}/tests/vectors/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()).unwrap() }
fn f(v: &Value) -> f64 { v.as_f64().unwrap() }
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).map(|w| same(v, w)).unwrap_or(false)),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(v, w)| same(v, w)),
        _ => a == b,
    }
}
fn close(a: f64, b: f64, what: &str) { assert!((a - b).abs() <= 1e-12 * b.abs().max(1.0), "{what}: rust {a} vs ts {b}"); }

#[test]
fn beatgrid_matches_ts() {
    let v = load("timing.json");
    for r in v["beatgrid"].as_array().unwrap() {
        let (t, b) = (f(&r["t"]), f(&r["b"]));
        close(beatgrid::snap_to_beat(t, b), f(&r["snap"]), "snap");
        close(beatgrid::wrap_beat_phase(t, b), f(&r["wrap"]), "wrap");
        close(beatgrid::nearest_beat(t, b, 0.12), f(&r["nearest"]), "nearest");
        assert_eq!(beatgrid::format_beat_position(t, b, 0.12), r["fmt"].as_str().unwrap(), "fmt t={t} b={b}");
        close(beatgrid::beat_jump_target(t, b, 4.0, 100.0), f(&r["jump"]), "jump");
        close(beatgrid::beat_jump_target(t, b, -8.0, 100.0), f(&r["jumpBack"]), "jumpBack");
        close(beatgrid::loop_seconds(b, 0.25), f(&r["loop"]), "loop");
    }
}

#[test]
fn sync_matches_ts() {
    let v = load("timing.json");
    for r in v["sync"].as_array().unwrap() {
        let i = sync::SyncInput { master_bpm: f(&r["m"]), target_bpm: f(&r["tb"]), master_position: f(&r["mp"]), target_position: f(&r["tp"]), target_phase: 0.05, master_phase: 0.02, max_tempo_percent: None };
        let o = sync::sync_deck(i);
        close(o.rate, f(&r["rate"]), "rate");
        close(o.tempo_percent, f(&r["tempoPercent"]), "tempo");
        close(o.phase_error_seconds, f(&r["phaseErrorSeconds"]), "phase");
        close(o.seek_to, f(&r["seekTo"]), "seek");
        assert_eq!(o.clamped, r["clamped"].as_bool().unwrap());
        close(sync::nudge_toward_phase(i.master_bpm, i.master_position, i.target_position, 0.03), f(&r["nudge"]), "nudge");
        assert_eq!(sync::tempo_percent_label(o.tempo_percent, 1), r["label"].as_str().unwrap());
    }
}

#[test]
fn fx_mixer_pads_match_ts() {
    let v = load("timing.json");
    let fxv = &v["fx"];
    for r in fxv["filter"].as_array().unwrap() { close(fx::filter_frequency(f(&r[0])), f(&r[1]), "filter"); assert_eq!(fx::filter_is_lowpass(f(&r[0])), r[2].as_bool().unwrap()); }
    for r in fxv["tape"].as_array().unwrap() { close(fx::tape_stop_rate(f(&r[0])), f(&r[1]), "tape"); }
    for r in fxv["tremolo"].as_array().unwrap() { close(fx::tremolo_rate_hz(r[0].as_str().unwrap(), f(&r[1])), f(&r[2]), "trem"); }
    for r in fxv["delay"].as_array().unwrap() { close(fx::delay_seconds(r[0].as_str().unwrap(), f(&r[1])), f(&r[2]), "delay"); }
    for d in fxv["defaults"].as_array().unwrap() {
        let t = fx::FxType::parse(d["id"].as_str().unwrap()).unwrap();
        let p = fx::fx_default(t);
        assert_eq!(p.division, d["division"].as_str().unwrap()); close(p.amount, f(&d["amount"]), "amt"); close(p.wet, f(&d["wet"]), "wet");
    }
    for r in fxv["crush"].as_array().unwrap() {
        let c = fx::crush_curve(f(&r[0]));
        for (a, b) in c.iter().zip(r[1].as_array().unwrap()) { assert_eq!(*a, f(b) as f32); }
    }
    for r in v["mixer"]["cross"].as_array().unwrap() {
        let (l, rt) = mixer::crossfader_gains(f(&r[0]), mixer::CrossfaderCurve::parse(r[1].as_str().unwrap()), r[2].as_bool().unwrap());
        close(l, f(&r[3]), "xl"); close(rt, f(&r[4]), "xr");
    }
    for r in v["mixer"]["chan"].as_array().unwrap() { close(mixer::channel_fader_gain(f(&r[0]), mixer::ChannelFaderCurve::parse(r[1].as_str().unwrap())), f(&r[2]), "chan"); }
    let ids: Vec<&str> = v["pads"]["ids"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
    assert_eq!(ids, pads::PAD_MODE_DEFS.iter().map(|m| m.id).collect::<Vec<_>>());
    for r in v["pads"]["rows"].as_array().unwrap() {
        let i = f(&r[0]);
        close(pads::loop_roll_beats(i), f(&r[1]), "roll"); close(pads::beat_jump_step(i), f(&r[2]), "jump"); close(pads::pitch_play_rate(i), f(&r[3]), "pitch");
        let (s, e) = pads::slice_range(i, 245.3); close(s, f(&r[4]), "s"); close(e, f(&r[5]), "e");
    }
    for r in v["pads"]["release"].as_array().unwrap() { close(pads::rolling_release_position(f(&r[0]), f(&r[1]), f(&r[2]), f(&r[3]), f(&r[4])), f(&r[5]), "release"); }
}

#[test]
fn keymap_matches_ts() {
    let k = keymap::Keymap::global();
    let v = load("keymap.json");
    let mut n = 0;
    for r in v["matches"].as_array().unwrap() {
        let m = r[1].as_u64().unwrap();
        let ev = keymap::KeyEvent { code: r[0].as_str().unwrap(), ctrl: m & 1 != 0, shift: m & 2 != 0, alt: m & 4 != 0, meta: m & 8 != 0, repeat: r[2].as_bool().unwrap() };
        let ctx = keymap::MatchContext { in_text_input: r[3].as_bool().unwrap(), in_bpm_editor: r[4].as_bool().unwrap() };
        let got = k.match_event(&ev, ctx);
        assert_eq!(got.map(|g| k.binding(g).id.as_str()), r[5].as_str(), "{:?} {m}", r[0]);
        if let Some(g) = got { assert_eq!(g.side.name(), r[6].as_str().unwrap()); assert_eq!(g.index.map(|x| x as u64), r[7].as_u64()); n += 1; }
    }
    assert!(n > 100, "only {n} matches");
    for r in v["spans"].as_array().unwrap() { assert_eq!(k.next_span(f(&r[0]), r[1].as_bool().unwrap()), f(&r[2])); }
    for r in v["textScale"].as_array().unwrap() { close(keymap::next_text_scale(f(&r[0]), r[1].as_bool().unwrap()), f(&r[2]), "ts"); }
}

#[test]
fn midi_profiles_match_ts() {
    let p = midi::Profiles::global();
    assert!(p.uncompiled().is_empty(), "regexes that did not compile: {:?}", p.uncompiled());
    let v = load("midi.json");
    for r in v["names"].as_array().unwrap() {
        let name = r[0].as_str().unwrap();
        assert_eq!(p.for_device(name).map(|x| x.id.as_str()), r[1].as_str(), "profile for {name}");
        assert_eq!(p.lookup_hardware(name).map(|x| x.id.as_str()), r[2].as_str(), "lookup {name}");
    }
    for r in v["slabPorts"].as_array().unwrap() { assert_eq!(slab::is_slab_port(r[0].as_str().unwrap()), r[1].as_bool().unwrap(), "{}", r[0]); }
    for r in v["parse"].as_array().unwrap() {
        let bytes: Vec<u8> = r[0].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
        let got = midi::parse_midi_message(&bytes).map(|e| serde_json::to_value(e).unwrap());
        assert!(same(&got.unwrap_or(Value::Null), &r[1]));
    }
}

#[test]
fn slab_decoder_matches_ts() {
    let v = load("slab.json");
    let mut d = slab::SlabDecoder::default();
    for r in v["decode"].as_array().unwrap() {
        let bytes: Vec<u8> = r[0].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
        let got = d.decode(&bytes).map(|e| serde_json::to_value(e).unwrap()).unwrap_or(Value::Null);
        assert!(same(&got, &r[1]), "{bytes:02x?}: {got} vs {}", r[1]);
    }
    for r in v["filter"].as_array().unwrap() { close(slab::filter_amount(f(&r[0])), f(&r[1]), "filter"); }
    for r in v["colors"].as_array().unwrap() { assert_eq!(slab::provisional_color_number(r[0].as_str()) as u64, r[1].as_u64().unwrap(), "{}", r[0]); }
}

#[test]
fn link_wire_format() {
    let mut a = link::LinkState::new("peer-a".into(), 1_000_000.0);
    let mut b = link::LinkState::new("peer-b".into(), 1_000_000.0);
    a.on_enable(); b.on_enable();
    a.set_local_tempo(128.0, 2_000_000.0);
    let pkt = a.packet();
    let s = String::from_utf8(pkt.clone()).unwrap();
    assert_eq!(s, "{\"p\":\"opendeck-link\",\"v\":1,\"peer\":\"peer-a\",\"origin\":\"peer-a\",\"ts\":2000000,\"bpm\":128,\"anchor\":2000000,\"anchorBeat\":0,\"quantum\":4}");
    b.on_message(&pkt, 2_100_000.0);
    assert_eq!(b.timeline.bpm, 128.0);
    assert_eq!(b.counters.adopted, 1);
    b.on_message(&pkt, 2_200_000.0); // same ts+origin: not newer
    assert_eq!(b.counters.adopted, 1);
    b.on_message(b"{\"p\":\"x\"}", 0.0);
    assert_eq!(b.counters.rejected, 1);
    assert!((b.beat_at(2_000_000.0 + 60e6 / 128.0 * 4.0) - 4.0).abs() < 1e-9);
    assert!(b.status_line(None).starts_with("link on · 1 peer · 128.0 BPM"));
}

#[test]
fn usb_always_asks() {
    let mut r = usb::Remembered::new();
    let key = usb::local_media_key("DJ STICK", None, Some(32_000_000_000));
    assert_eq!(usb::decide(&key, &r), usb::Decision::Prompt);
    usb::remember(&mut r, &key, "add", false);
    assert_eq!(usb::decide(&key, &r), usb::Decision::Prompt, "Not-always must not be remembered");
    usb::remember(&mut r, &key, "add", true);
    assert_eq!(usb::decide(&key, &r), usb::Decision::Import);
    assert_eq!(usb::prompt_message("DJ STICK", "this computer", Some(1), false), "USB drive 'DJ STICK' found on this computer (1 track). Add it to your library?");
}

use od_stems::core::*;
use od_stems::scheduler::Scheduler;
use od_stems::{BandSplitEngine, StemEngine};
use serde_json::Value;

#[test]
fn plan_and_order_match_ts() {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../od-core/tests/vectors/stems.json")).unwrap()).unwrap();
    for p in v["plans"].as_array().unwrap() {
        let got: Vec<Vec<u64>> = plan_chunks(p[0].as_u64().unwrap() as usize).iter().map(|c| vec![c.index as u64, c.start as u64, c.length as u64]).collect();
        let want: Vec<Vec<u64>> = p[1].as_array().unwrap().iter().map(|r| r.as_array().unwrap().iter().map(|x| x.as_u64().unwrap()).collect()).collect();
        assert_eq!(got, want);
    }
    for o in v["orders"].as_array().unwrap() {
        let plan = plan_chunks(o[0].as_u64().unwrap() as usize);
        let got: Vec<u64> = order_chunks_from_focus(&plan, o[1].as_f64().unwrap()).iter().map(|c| c.index as u64).collect();
        let want: Vec<u64> = o[2].as_array().unwrap().iter().map(|x| x.as_u64().unwrap()).collect();
        assert_eq!(got, want, "total {} focus {}", o[0], o[1]);
    }
    for w in v["windows"].as_array().unwrap() {
        let got = transition_window_for(w[0].as_u64().unwrap() as usize, w[1].as_u64().unwrap() as usize);
        let want: Vec<f32> = w[2].as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect();
        assert_eq!(got, want);
    }
    let mut s = IntervalSet::default(); s.add(1000, 5000); s.add(20000, 30000); s.add(4000, 9000);
    for c in v["coverage"].as_array().unwrap() { assert_eq!(coverage_at(&s, c[0].as_u64().unwrap() as usize, 30000, BOUNDARY_FADE), c[1].as_f64().unwrap()); }
}

#[test]
fn scheduler_runs_four_decks_playhead_first() {
    let engines: Vec<Box<dyn StemEngine>> = vec![Box::new(BandSplitEngine), Box::new(BandSplitEngine)];
    let s = Scheduler::new(engines, 4);
    let n = 44100 * 30;
    for d in 0..4 { s.load(d, vec![0.1; n], vec![0.1; n], 44100.0 * 12.0, d < 2); }
    let t = std::time::Instant::now();
    while !s.all_done() { assert!(t.elapsed().as_secs() < 60); std::thread::sleep(std::time::Duration::from_millis(5)); }
    let log = s.take_log();
    assert_eq!(log.len(), 4 * plan_chunks(n).len());
    // The first chunk done for each playing deck is the one under the playhead.
    for d in 0..2 { let first = log.iter().find(|c| c.deck == d).unwrap(); assert_eq!(first.index, 1); }
    for d in 0..4 { assert_eq!(s.coverage(d, 44100 * 15), 1.0); }
}

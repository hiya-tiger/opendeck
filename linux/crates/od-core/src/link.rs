//! Port of src/main/link.ts: opendeck-link/1 (D34). Not Ableton Link.
//! Wire format: one UDP datagram = one UTF-8 JSON object (<= 512 bytes) on
//! multicast 239.255.77.88:29876, heartbeat 200 ms, peers expire after 2 s,
//! last-writer-wins on (ts, origin). `LinkState` is the pure state machine
//! (tested against the TS node in CI via scripts/smoke-link-rs); `LinkNode`
//! owns the socket.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};

pub const LINK_PROTOCOL: &str = "opendeck-link";
pub const LINK_PROTOCOL_VERSION: i64 = 1;
pub const LINK_GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 77, 88);
pub const LINK_PORT: u16 = 29876;
pub const HEARTBEAT_MS: u64 = 200;
pub const PEER_TTL_MS: f64 = 2_000.0;
pub const MAX_PACKET_BYTES: usize = 512;

#[derive(Debug, Clone, PartialEq)]
pub struct Timeline { pub bpm: f64, pub anchor_micros: f64, pub anchor_beat: f64, pub quantum: f64, pub ts: f64, pub origin: String }

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Counters { pub sent: u64, pub received: u64, pub adopted: u64, pub rejected: u64 }

pub fn clamp_bpm(b: f64) -> f64 { if !b.is_finite() { 120.0 } else { b.clamp(20.0, 300.0) } }

pub struct LinkState {
    pub peer_id: String,
    pub timeline: Timeline,
    pub peers: HashMap<String, (f64, f64)>,
    pub counters: Counters,
    pub local_bpm: f64,
    pub enabled: bool,
    pre_link_bpm: Option<f64>,
    pub peer_ttl_ms: f64,
}

impl LinkState {
    pub fn new(peer_id: String, now: f64) -> Self {
        let timeline = Timeline { bpm: 120.0, anchor_micros: now, anchor_beat: 0.0, quantum: 4.0, ts: now, origin: peer_id.clone() };
        LinkState { peer_id, timeline, peers: HashMap::new(), counters: Counters::default(), local_bpm: 120.0, enabled: false, pre_link_bpm: None, peer_ttl_ms: PEER_TTL_MS }
    }
    pub fn on_enable(&mut self) { self.pre_link_bpm = Some(self.timeline.bpm); self.enabled = true; }
    pub fn on_disable(&mut self, now: f64) {
        self.enabled = false;
        self.peers.clear();
        let restored = self.pre_link_bpm.unwrap_or(self.timeline.bpm);
        self.timeline = Timeline { bpm: restored, anchor_micros: now, anchor_beat: 0.0, quantum: self.timeline.quantum, ts: now, origin: self.peer_id.clone() };
        self.local_bpm = restored;
        self.pre_link_bpm = None;
    }
    pub fn set_local_tempo(&mut self, bpm: f64, now: f64) {
        let v = clamp_bpm(bpm);
        self.local_bpm = v;
        self.timeline = Timeline { bpm: v, anchor_micros: now, anchor_beat: 0.0, quantum: self.timeline.quantum, ts: now, origin: self.peer_id.clone() };
    }
    pub fn beat_at(&self, now: f64) -> f64 { self.timeline.anchor_beat + ((now - self.timeline.anchor_micros) / 1e6 * self.timeline.bpm) / 60.0 }
    pub fn phase_at(&self, now: f64) -> f64 {
        let q = if self.timeline.quantum > 0.0 { self.timeline.quantum } else { 4.0 };
        let w = self.beat_at(now) % q;
        if w < 0.0 { w + q } else { w }
    }
    /// `now` in microseconds; peers keep last-seen in milliseconds. (The TS
    /// compares a microsecond difference with PEER_TTL_MS, so it drops peers
    /// after 2 ms; see Hark-decisions.md 2026-11-03. The Rust node uses 2 s.)
    pub fn sweep(&mut self, now: f64) { let ttl = self.peer_ttl_ms; let now_ms = now / 1000.0; self.peers.retain(|_, p| now_ms - p.0 <= ttl); }
    pub fn status_line(&self, error: Option<&str>) -> String {
        let bpm = self.timeline.bpm;
        if let (Some(e), false) = (error, self.enabled) { return format!("link unavailable · {e}"); }
        if !self.enabled { return format!("link off · {} BPM", crate::sync::js_to_fixed(bpm, 1)); }
        let n = self.peers.len();
        format!("link on · {} · {} BPM", if n == 1 { "1 peer".to_string() } else { format!("{n} peers") }, crate::sync::js_to_fixed(bpm, 1))
    }
    /// JSON.stringify of the heartbeat packet (same key order as the TS).
    pub fn packet(&self) -> Vec<u8> {
        let t = &self.timeline;
        format!(
            "{{\"p\":\"{}\",\"v\":{},\"peer\":{},\"origin\":{},\"ts\":{},\"bpm\":{},\"anchor\":{},\"anchorBeat\":{},\"quantum\":{}}}",
            LINK_PROTOCOL, LINK_PROTOCOL_VERSION, json!(self.peer_id), json!(t.origin), js_num(t.ts), js_num(t.bpm), js_num(t.anchor_micros), js_num(t.anchor_beat), js_num(t.quantum)
        ).into_bytes()
    }
    fn is_newer(&self, ts: f64, origin: &str) -> bool {
        if ts > self.timeline.ts { return true; }
        if ts < self.timeline.ts { return false; }
        origin > self.timeline.origin.as_str()
    }
    pub fn on_message(&mut self, msg: &[u8], now: f64) {
        if msg.len() > MAX_PACKET_BYTES { self.counters.rejected += 1; return; }
        let Ok(v) = serde_json::from_slice::<Value>(msg) else { self.counters.rejected += 1; return };
        let Some(o) = v.as_object() else { self.counters.rejected += 1; return };
        if o.get("p").and_then(|x| x.as_str()) != Some(LINK_PROTOCOL) || o.get("v").and_then(|x| x.as_f64()) != Some(1.0) { self.counters.rejected += 1; return; }
        let Some(peer) = o.get("peer").and_then(|x| x.as_str()) else { return };
        if peer == self.peer_id { return; }
        let num = |k: &str| o.get(k).and_then(|x| x.as_f64()).filter(|x| x.is_finite());
        let (Some(ts), Some(bpm), Some(anchor), Some(anchor_beat)) = (num("ts"), num("bpm"), num("anchor"), num("anchorBeat")) else { self.counters.rejected += 1; return };
        if !(20.0..=300.0).contains(&bpm) { self.counters.rejected += 1; return; }
        self.counters.received += 1;
        self.peers.insert(peer.to_string(), (now / 1000.0, bpm));
        let origin = o.get("origin").and_then(|x| x.as_str()).unwrap_or(peer).to_string();
        if !self.is_newer(ts, &origin) { return; }
        let quantum = num("quantum").filter(|q| *q > 0.0).unwrap_or(self.timeline.quantum);
        self.timeline = Timeline { bpm, anchor_micros: anchor, anchor_beat, quantum, ts, origin };
        self.counters.adopted += 1;
    }
}

/// Number formatting as JavaScript's JSON.stringify writes it.
pub fn js_num(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e21 { format!("{}", x as i64) } else { format!("{x}") }
}

pub fn now_micros() -> f64 {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    (d.as_micros()) as f64
}

pub fn new_peer_id() -> String {
    let mut b = [0u8; 16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut b).ok();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// Bound socket for the node: SO_REUSEADDR, joined, TTL 1, loopback on (as the TS).
pub fn open_socket(port: u16) -> std::io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    s.set_reuse_address(true)?;
    s.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port).into())?;
    s.join_multicast_v4(&LINK_GROUP, &Ipv4Addr::UNSPECIFIED)?;
    s.set_multicast_ttl_v4(1)?;
    s.set_multicast_loop_v4(true)?;
    s.set_nonblocking(true)?;
    Ok(s.into())
}

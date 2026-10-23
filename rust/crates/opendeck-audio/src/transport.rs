//! Real-time transport state shared between the UI and the render thread.
//!
//! Continuous values are atomics read once per render block. Seeks carry a
//! generation counter so a render thread applies each requested position once,
//! at the start of the next block, without a command queue or a lock.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use crate::render::{LoopRegion, PcmVoice};

fn f64_bits(value: f64) -> u64 {
    value.to_bits()
}

fn bits_f64(value: u64) -> f64 {
    f64::from_bits(value)
}

pub struct TransportState {
    playing: AtomicBool,
    rate_bits: AtomicU64,
    seek_position_bits: AtomicU64,
    seek_generation: AtomicU32,
    position_bits: AtomicU64,
    loop_start_bits: AtomicU64,
    loop_end_bits: AtomicU64,
}

impl TransportState {
    pub fn new(rate: f64) -> Arc<Self> {
        Arc::new(Self {
            playing: AtomicBool::new(false),
            rate_bits: AtomicU64::new(f64_bits(rate)),
            seek_position_bits: AtomicU64::new(0),
            seek_generation: AtomicU32::new(0),
            position_bits: AtomicU64::new(0),
            loop_start_bits: AtomicU64::new(0.0f64.to_bits()),
            loop_end_bits: AtomicU64::new(0.0f64.to_bits()),
        })
    }

    pub fn set_playing(&self, playing: bool) {
        self.playing.store(playing, Ordering::Release);
    }

    pub fn playing(&self) -> bool {
        self.playing.load(Ordering::Acquire)
    }

    pub fn set_rate(&self, rate: f64) {
        self.rate_bits.store(f64_bits(rate), Ordering::Release);
    }

    pub fn rate(&self) -> f64 {
        bits_f64(self.rate_bits.load(Ordering::Acquire))
    }

    pub fn request_seek(&self, frame: f64) {
        self.seek_position_bits.store(f64_bits(frame), Ordering::Release);
        self.seek_generation.fetch_add(1, Ordering::AcqRel);
    }

    pub fn seek(&self, last_generation: &mut u32) -> Option<f64> {
        let generation = self.seek_generation.load(Ordering::Acquire);
        if generation == *last_generation {
            return None;
        }
        *last_generation = generation;
        Some(bits_f64(self.seek_position_bits.load(Ordering::Acquire)))
    }

    pub fn set_loop(&self, loop_region: Option<LoopRegion>) {
        let (start, end) = loop_region
            .map(|region| (region.start, region.end))
            .unwrap_or((0.0, 0.0));
        self.loop_start_bits.store(f64_bits(start), Ordering::Release);
        self.loop_end_bits.store(f64_bits(end), Ordering::Release);
    }

    pub fn loop_region(&self) -> Option<LoopRegion> {
        let start = bits_f64(self.loop_start_bits.load(Ordering::Acquire));
        let end = bits_f64(self.loop_end_bits.load(Ordering::Acquire));
        (end > start).then(|| LoopRegion::new(start, end))
    }

    pub fn publish_position(&self, frame: f64) {
        self.position_bits.store(f64_bits(frame), Ordering::Release);
    }

    pub fn position(&self) -> f64 {
        bits_f64(self.position_bits.load(Ordering::Acquire))
    }
}

/// A voice driven by [`TransportState`], suitable for an audio callback.
pub struct LiveVoice {
    state: Arc<TransportState>,
    voice: PcmVoice,
    seek_generation: u32,
    loop_region: Option<LoopRegion>,
}

impl LiveVoice {
    pub fn new(state: Arc<TransportState>, voice: PcmVoice) -> Self {
        Self {
            state,
            voice,
            seek_generation: 0,
            loop_region: None,
        }
    }

    pub fn voice(&self) -> &PcmVoice {
        &self.voice
    }

    pub fn voice_mut(&mut self) -> &mut PcmVoice {
        &mut self.voice
    }

    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        let frames = left.len().min(right.len());
        left[..frames].fill(0.0);
        right[..frames].fill(0.0);

        if let Some(position) = self.state.seek(&mut self.seek_generation) {
            self.voice.seek(position);
        }
        let loop_region = self.state.loop_region();
        if loop_region != self.loop_region {
            if self.voice.set_loop(loop_region).is_ok() {
                self.loop_region = loop_region;
            }
        }
        self.voice.set_rate(self.state.rate());
        if !self.state.playing() {
            self.state.publish_position(self.voice.position());
            return;
        }
        self.voice.render_add(&mut left[..frames], &mut right[..frames]);
        self.state.publish_position(self.voice.position());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::VoiceOptions;

    fn ramp(frames: usize) -> Vec<f32> {
        (0..frames).map(|value| value as f32).collect()
    }

    fn live() -> (Arc<TransportState>, LiveVoice) {
        let state = TransportState::new(1.0);
        let voice = PcmVoice::new(vec![ramp(64)], VoiceOptions::new()).unwrap();
        let live = LiveVoice::new(state.clone(), voice);
        (state, live)
    }

    #[test]
    fn rate_and_seek_are_applied_at_the_block_boundary() {
        let (state, mut live) = live();
        state.set_playing(true);
        state.set_rate(-1.0);
        state.request_seek(10.0);
        let mut left = [0.0; 4];
        let mut right = [0.0; 4];
        live.render(&mut left, &mut right);
        assert_eq!(left, [10.0, 9.0, 8.0, 7.0]);
        assert_eq!(state.position(), 6.0);
        let mut left = [0.0; 4];
        let mut right = [0.0; 4];
        live.render(&mut left, &mut right);
        assert_eq!(left, [6.0, 5.0, 4.0, 3.0]);
    }

    #[test]
    fn a_seek_is_applied_once() {
        let (state, mut live) = live();
        state.set_playing(true);
        state.request_seek(20.0);
        let mut left = [0.0; 2];
        let mut right = [0.0; 2];
        live.render(&mut left, &mut right);
        assert_eq!(left, [20.0, 21.0]);
        live.render(&mut left, &mut right);
        assert_eq!(left, [22.0, 23.0]);
    }

    #[test]
    fn loop_changes_reach_the_voice() {
        let (state, mut live) = live();
        state.set_playing(true);
        state.request_seek(8.0);
        state.set_loop(Some(LoopRegion::new(2.0, 6.0)));
        let mut left = [0.0; 8];
        let mut right = [0.0; 8];
        live.render(&mut left, &mut right);
        assert_eq!(left, [8.0, 5.0, 2.0, 3.0, 4.0, 5.0, 2.0, 3.0]);
    }

    #[test]
    fn paused_transport_stays_silent_and_holds_position() {
        let (state, mut live) = live();
        state.request_seek(12.0);
        let mut left = [0.0; 4];
        let mut right = [0.0; 4];
        live.render(&mut left, &mut right);
        assert_eq!(left, [0.0; 4]);
        assert_eq!(state.position(), 12.0);
    }

    #[test]
    fn live_transport_loops_for_ten_minutes_without_drift() {
        let frames = 48_000usize * 600;
        let loop_region = LoopRegion::new(1000.0, 5000.0);
        let length = loop_region.len();
        let state = TransportState::new(1.0);
        let voice = PcmVoice::new(
            vec![ramp(10_000)],
            VoiceOptions {
                position: loop_region.start,
                ..VoiceOptions::new()
            },
        )
        .unwrap();
        let mut live = LiveVoice::new(state.clone(), voice);
        state.set_loop(Some(loop_region));
        state.set_playing(true);
        let mut left = [0.0; 128];
        let mut right = [0.0; 128];
        let mut rendered = 0;
        while rendered < frames {
            let count = 128.min(frames - rendered);
            live.render(&mut left[..count], &mut right[..count]);
            rendered += count;
        }
        assert_eq!(
            state.position(),
            loop_region.start + (frames as f64 % length)
        );
    }
}

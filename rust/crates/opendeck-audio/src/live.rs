//! Live render thread that fills a lock-free ring from transport atomics.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::render::PcmVoice;
use crate::ring::{AudioRing, Consumer};
use crate::transport::{LiveVoice, TransportState};

pub struct LiveEngine {
    stop: Arc<AtomicBool>,
    consumer: Consumer,
    handle: Option<JoinHandle<()>>,
    sample_rate: u32,
}

impl LiveEngine {
    pub fn spawn(
        state: Arc<TransportState>,
        voice: PcmVoice,
        ring: AudioRing,
        sample_rate: u32,
        block_frames: usize,
    ) -> Self {
        assert!(block_frames > 0, "block size must be positive");
        let (mut producer, consumer) = ring.split();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let mut live = LiveVoice::new(state, voice);
        let handle = thread::spawn(move || {
            let mut left = vec![0.0f32; block_frames];
            let mut right = vec![0.0f32; block_frames];
            let mut interleaved = vec![0.0f32; block_frames * 2];
            while !thread_stop.load(Ordering::Acquire) {
                if producer.free() < block_frames * 2 {
                    thread::sleep(Duration::from_micros(250));
                    continue;
                }
                live.render(&mut left, &mut right);
                for frame in 0..block_frames {
                    interleaved[frame * 2] = left[frame];
                    interleaved[frame * 2 + 1] = right[frame];
                }
                let mut written = 0;
                while written < interleaved.len() {
                    let count = producer.push(&interleaved[written..]);
                    if count == 0 {
                        break;
                    }
                    written += count;
                }
            }
        });
        Self {
            stop,
            consumer,
            handle: Some(handle),
            sample_rate,
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn available(&self) -> usize {
        self.consumer.available()
    }

    pub fn read(&mut self, samples: &mut [f32]) -> usize {
        self.consumer.pop(samples)
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for LiveEngine {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::VoiceOptions;

    fn ramp(frames: usize) -> Vec<f32> {
        (0..frames).map(|value| value as f32).collect()
    }

    #[test]
    fn render_thread_fills_the_ring_and_follows_atomics() {
        let state = TransportState::new(1.0);
        state.set_playing(true);
        state.request_seek(4.0);
        let voice = PcmVoice::new(vec![ramp(256)], VoiceOptions::new()).unwrap();
        let mut engine = LiveEngine::spawn(state.clone(), voice, AudioRing::new(2048), 48_000, 64);
        let mut output = [0.0f32; 256];
        let mut waited = 0;
        while engine.available() < 256 && waited < 200 {
            thread::sleep(Duration::from_millis(5));
            waited += 1;
        }
        assert_eq!(engine.read(&mut output), 256);
        assert_eq!(&output[..8], &[4.0, 4.0, 5.0, 5.0, 6.0, 6.0, 7.0, 7.0]);
        assert!(state.position() >= 100.0);
        state.set_playing(false);
        let paused_at = state.position();
        thread::sleep(Duration::from_millis(20));
        assert!(state.position() >= paused_at);
        engine.stop();
    }
}

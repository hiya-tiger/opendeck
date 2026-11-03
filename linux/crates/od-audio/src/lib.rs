//! od-audio: the real-time engine for OpenDecks on Linux.
//!
//! Threading model (Hark-decisions.md 2026-11-03):
//! * UI thread -> audio thread: `Command`s over an rtrb SPSC ring (wait-free).
//! * audio thread -> UI: per-deck status in atomics (no locks), and every
//!   `Arc<Pcm>` the audio thread lets go of goes back over a second ring so it
//!   is freed on the UI thread, never in the callback.
//! * audio thread -> recorder: master samples over an rtrb ring to a writer
//!   thread (WAV via hound).
//! * The callback never locks, never allocates, never frees: checked by
//!   tests/no_alloc.rs with assert_no_alloc.
pub mod decode;
pub mod deck;
pub mod dsp;
pub mod engine;
pub mod fx;
pub mod output;
pub mod recorder;

pub use engine::{Command, Controller, Engine, EngineStatus};

/// Decoded audio at the engine's sample rate. Mono files keep one channel
/// and play to both sides (the Electron mono DataCloneError fix, by design).
pub struct Pcm { pub channels: Vec<Vec<f32>> }
impl Pcm {
    pub fn frames(&self) -> usize { self.channels.first().map(|c| c.len()).unwrap_or(0) }
    #[inline]
    pub fn chan(&self) -> (&[f32], &[f32]) {
        let l = &self.channels[0];
        let r = self.channels.get(1).unwrap_or(l);
        (l, r)
    }
}

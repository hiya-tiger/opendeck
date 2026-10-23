//! Sample-accurate PCM transport.
//!
//! The transport renders planar voices into interleaved-free stereo blocks. It is
//! deterministic: rendering `N` frames in one call or in any sequence of block
//! sizes produces the same samples. That property is what makes loops and
//! reverse playback testable without an audio device.

pub mod live;
pub mod render;
pub mod ring;
pub mod transport;

pub use live::LiveEngine;
pub use render::{LoopRegion, PcmVoice, StereoSamples, Transport, VoiceOptions};
pub use ring::{AudioRing, Consumer, Producer};
pub use transport::{LiveVoice, TransportState};

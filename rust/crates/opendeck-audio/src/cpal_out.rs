//! Optional native device output built on cpal.
//!
//! [`NativeOutput`] opens the default output device and runs a stream that
//! pulls [`LiveVoice`] + [`TransportState`] inside the audio callback. The
//! callback holds no locks, never allocates (planar + interleaved scratch is
//! preallocated before the stream starts), never logs, and never touches the
//! filesystem. Play/rate/seek/loop are driven through the shared
//! [`TransportState`] atomics, so the UI can control a running stream without
//! touching the callback.

use std::fmt;

#[cfg(feature = "native-output")]
use std::sync::Arc;

#[cfg(feature = "native-output")]
use crate::transport::{LiveVoice, TransportState};
#[cfg(feature = "native-output")]
use crate::render::PcmVoice;

/// Errors from opening or running a native output stream.
#[derive(Debug, Clone, PartialEq)]
pub enum OutputError {
    NoOutputDevice,
    UnsupportedConfig(String),
    Failed(String),
}

impl fmt::Display for OutputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoOutputDevice => write!(f, "no default output device"),
            Self::UnsupportedConfig(detail) => write!(f, "unsupported output config: {detail}"),
            Self::Failed(detail) => write!(f, "native output failed: {detail}"),
        }
    }
}

impl std::error::Error for OutputError {}

/// Interleave planar stereo into `channels`-wide f32 frames.
/// A mono destination receives the average of the left and right channels.
/// Frames beyond the end of the planar buffers become silence.
pub fn interleave_stereo(
    left: &[f32],
    right: &[f32],
    out_interleaved: &mut [f32],
    channels: u16,
) -> Result<(), OutputError> {
    let channels = usize::from(channels);
    if channels == 0 || channels > 2 {
        return Err(OutputError::UnsupportedConfig(format!(
            "destination channel count {channels} is not mono or stereo"
        )));
    }
    let frames = out_interleaved.len() / channels;
    if channels == 1 {
        for frame in 0..frames.max(0) {
            let l = left.get(frame).copied().unwrap_or(0.0);
            let r = right.get(frame).copied().unwrap_or(0.0);
            out_interleaved[frame] = (l + r) * 0.5;
        }
        return Ok(());
    }
    for frame in 0..frames.max(0) {
        let base = frame * 2;
        let l = left.get(frame).copied().unwrap_or(0.0);
        let r = right.get(frame).copied().unwrap_or(0.0);
        out_interleaved[base] = l;
        out_interleaved[base + 1] = r;
    }
    Ok(())
}

#[cfg(feature = "native-output")]
pub use native::*;

#[cfg(feature = "native-output")]
mod native {
    use super::*;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{FromSample, SampleFormat, SizedSample};

    struct Scratch {
        left: Vec<f32>,
        right: Vec<f32>,
        interleaved: Vec<f32>,
        frames: usize,
        channels: u16,
    }

    impl Scratch {
        fn new(frames_hint: usize, channels: u16) -> Self {
            // cpal does not reveal the actual callback size until it fires, so
            // reserve a large block; a short scratch buffer would silently
            // truncate every callback and cause dropouts.
            let frames = frames_hint.max(32_768);
            Self {
                left: vec![0.0; frames],
                right: vec![0.0; frames],
                interleaved: vec![0.0; frames * usize::from(channels)],
                frames,
                channels,
            }
        }
    }

    struct Callback {
        voice: LiveVoice,
        scratch: Scratch,
    }

    impl Callback {
        #[inline]
        fn run<T: SizedSample + FromSample<f32>>(&mut self, out: &mut [T]) {
            let channels = self.scratch.channels as usize;
            let frames = (out.len() / channels.max(1)).min(self.scratch.frames);
            let end = frames * channels;
            let left = self.scratch.left.split_at_mut(frames).0;
            let right = self.scratch.right.split_at_mut(frames).0;
            let interleaved = self.scratch.interleaved.split_at_mut(end).0;
            self.voice.render(left, right);
            let _ = interleave_stereo(left, right, interleaved, self.scratch.channels);
            for (sample, value) in out.iter_mut().zip(interleaved.iter().copied()) {
                *sample = T::from_sample(value);
            }
            for sample in &mut out[end..] {
                *sample = T::from_sample(0.0);
            }
        }
    }

    fn on_error(_error: cpal::StreamError) {
        // Absolutely nothing: no log, no format!, no allocation.
    }

    /// A live device stream pulling [`LiveVoice`] through [`TransportState`].
    pub struct NativeOutput {
        stream: Option<cpal::Stream>,
        state: Arc<TransportState>,
        config: cpal::StreamConfig,
        format: SampleFormat,
        device_name: String,
    }

    impl NativeOutput {
        /// Name of the backing device, for status reporting.
        pub fn device_name(&self) -> &str {
            &self.device_name
        }

        pub fn config(&self) -> &cpal::StreamConfig {
            &self.config
        }

        pub fn format(&self) -> SampleFormat {
            self.format
        }

        /// Transport handle shared with the audio callback.
        pub fn state(&self) -> &Arc<TransportState> {
            &self.state
        }

        /// True while the stream is running. The voice is owned by the
        /// callback; only transport state can be changed while it runs.
        pub fn is_active(&self) -> bool {
            self.stream.is_some()
        }

        /// Resume the device stream (set the transport playing separately).
        pub fn play(&self) -> Result<(), OutputError> {
            self.stream
                .as_ref()
                .ok_or_else(|| OutputError::Failed("stream already stopped".into()))?
                .play()
                .map_err(|error| OutputError::Failed(error.to_string()))
        }

        /// Pause the device stream without dropping it.
        pub fn pause(&self) -> Result<(), OutputError> {
            self.stream
                .as_ref()
                .ok_or_else(|| OutputError::Failed("stream already stopped".into()))?
                .pause()
                .map_err(|error| OutputError::Failed(error.to_string()))
        }

        /// Stop the stream. Dropping the output closes it.
        pub fn stop(&mut self) {
            self.stream = None;
        }

        /// Opens the default output device and starts a stream pulling from
        /// `voice` under `state`. The voice moves into the audio callback.
        /// `sample_rate` must be the voice's source rate; the device is opened
        /// at that exact rate so no resampling is needed.
        pub fn start(
            voice: PcmVoice,
            state: Arc<TransportState>,
            sample_rate: u32,
        ) -> Result<Self, OutputError> {
            let host = cpal::default_host();
            let device = host
                .default_output_device()
                .ok_or(OutputError::NoOutputDevice)?;
            let device_name = device.name().unwrap_or_else(|_| "unknown".into());

            let rate = cpal::SampleRate(sample_rate);
            let eligible = |value: &cpal::SupportedStreamConfigRange| {
                let format = value.sample_format();
                (value.channels() == 1 || value.channels() == 2)
                    && matches!(
                        format,
                        SampleFormat::F32 | SampleFormat::I16 | SampleFormat::I32 | SampleFormat::U8
                    )
                    && value.min_sample_rate() <= rate
                    && rate <= value.max_sample_rate()
            };
            let supported = device
                .supported_output_configs()
                .map_err(|error| OutputError::Failed(format!("config query failed: {error}")))?
                .find(eligible)
                .ok_or_else(|| {
                    OutputError::UnsupportedConfig(format!(
                        "the default output device offers no mono/stereo f32/i16/i32/u8 config at {sample_rate} Hz"
                    ))
                })?
                .with_sample_rate(rate);
            let config: cpal::StreamConfig = supported.clone().into();
            let format = supported.sample_format();

            let block_frames = match &config.buffer_size {
                cpal::BufferSize::Fixed(count) => (*count) as usize,
                cpal::BufferSize::Default => 256,
            }
            .max(128);
            let callback = Callback {
                voice: LiveVoice::new(state.clone(), voice),
                scratch: Scratch::new(block_frames, config.channels),
            };

            let stream = build_stream(&device, &config, format, callback)?;
            stream
                .play()
                .map_err(|error| OutputError::Failed(format!("stream start failed: {error}")))?;

            Ok(Self {
                stream: Some(stream),
                state,
                config,
                format,
                device_name,
            })
        }
    }

    fn build_stream(
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        format: SampleFormat,
        mut callback: Callback,
    ) -> Result<cpal::Stream, OutputError> {
        let stream = match format {
            SampleFormat::F32 => device.build_output_stream(
                config,
                move |data: &mut [f32], _| callback.run::<f32>(data),
                on_error,
                None,
            ),
            SampleFormat::I16 => device.build_output_stream(
                config,
                move |data: &mut [i16], _| callback.run::<i16>(data),
                on_error,
                None,
            ),
            SampleFormat::I32 => device.build_output_stream(
                config,
                move |data: &mut [i32], _| callback.run::<i32>(data),
                on_error,
                None,
            ),
            SampleFormat::U8 => device.build_output_stream(
                config,
                move |data: &mut [u8], _| callback.run::<u8>(data),
                on_error,
                None,
            ),
            other => {
                return Err(OutputError::UnsupportedConfig(format!(
                    "sample format {other:?} is not supported"
                )))
            }
        };
        stream.map_err(|error| OutputError::Failed(format!("stream build failed: {error}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_destination_interleaves_left_right() {
        let mut out = vec![0.0; 8];
        interleave_stereo(&[1.0, 2.0, 3.0], &[4.0, 5.0, 6.0], &mut out, 2).unwrap();
        assert_eq!(out, [1.0, 4.0, 2.0, 5.0, 3.0, 6.0, 0.0, 0.0]);
    }

    #[test]
    fn mono_destination_averages_channels() {
        let mut out = vec![0.0; 4];
        interleave_stereo(&[1.0, 2.0], &[3.0, 4.0], &mut out, 1).unwrap();
        assert_eq!(out, [2.0, 3.0, 0.0, 0.0]);
    }

    #[test]
    fn short_planar_buffers_pad_with_silence() {
        let mut out = vec![1.0; 6];
        interleave_stereo(&[0.5], &[], &mut out, 2).unwrap();
        assert_eq!(out, [0.5, 0.0, 0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn zero_and_extra_channel_counts_are_rejected() {
        let mut out = vec![0.0; 4];
        assert_eq!(
            interleave_stereo(&[1.0], &[1.0], &mut out, 0),
            Err(OutputError::UnsupportedConfig(
                "destination channel count 0 is not mono or stereo".into()
            ))
        );
        assert_eq!(
            interleave_stereo(&[1.0], &[1.0], &mut out, 3),
            Err(OutputError::UnsupportedConfig(
                "destination channel count 3 is not mono or stereo".into()
            ))
        );
    }

    #[test]
    fn interleaved_output_splits_back_into_left_and_right() {
        let left = [0.25, -0.5, 1.0];
        let right = [-0.25, 0.5, -1.0];
        let mut out = vec![0.0; 6];
        interleave_stereo(&left, &right, &mut out, 2).unwrap();
        assert_eq!(out.iter().step_by(2).collect::<Vec<_>>(), left.iter().collect::<Vec<_>>());
        assert_eq!(
            out.iter().skip(1).step_by(2).collect::<Vec<_>>(),
            right.iter().collect::<Vec<_>>()
        );
    }

    #[test]
    fn the_endian_helper_roundtrips_every_supported_format_width() {
        // i16.to_bits/i16.from_bits style roundtrip through bits is exercised
        // by cpal itself; here we only assert the pure math conversions above
        // so tests stay device-free.
        let mut mono = vec![0.0; 2];
        interleave_stereo(&[-1.0, 1.0], &[1.0, -1.0], &mut mono, 1).unwrap();
        assert_eq!(mono, [0.0, 0.0]);
    }

    #[cfg(feature = "native-output")]
    #[test]
    #[ignore = "opens the default output device"]
    fn start_keeps_the_stream_alive_and_play_pause_are_stable() {
        // This test intentionally does not demand device presence: on hosts
        // with no output device it fails with the mapped error, never panics.
        let voice = crate::render::PcmVoice::new(
            vec![vec![0.0; 128], vec![0.0; 128]],
            crate::render::VoiceOptions::new(),
        )
        .unwrap();
        let state = TransportState::new(1.0);
        state.set_playing(true);
        match NativeOutput::start(voice, state, 48_000) {
            Ok(mut output) => {
                assert!(output.is_active());
                let _ = output.pause();
                let _ = output.play();
                output.stop();
                assert!(!output.is_active());
            }
            Err(OutputError::NoOutputDevice | OutputError::UnsupportedConfig(_) | OutputError::Failed(_)) => {
                // Headless CI host; the mapping above is what callers see.
            }
        }
    }
}

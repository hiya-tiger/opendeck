//! Optional native decoding built on Symphonia 0.5 (MIT).
//!
//! [`decode_file`]/[`decode_bytes`] decode a whole track into planar f32
//! channels. The source sample rate is preserved exactly and nothing is
//! resampled. Tracks with more than two channels are folded down to stereo
//! with a documented heuristic: even-indexed source channels average into the
//! left plane, odd-indexed into the right.
//!
//! Only behind the `decode` feature: the default build pulls no codecs.

use std::path::Path;

/// Planar f32 PCM for one decoded track, ready for [`PcmVoice`](crate::render::PcmVoice).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DecodedTrack {
    /// Planar channels. Stereo: `[left, right]`. Mono: one vector.
    /// More than two source channels is folded to two.
    pub channels: Vec<Vec<f32>>,
    /// Source sample rate, untouched (for example 44_100).
    pub sample_rate: u32,
    /// Total frames per channel.
    pub frames: usize,
    /// Duration in seconds (`frames / sample_rate`).
    pub duration: f64,
}

/// Errors from probing or decoding a track.
#[derive(Debug, Clone, PartialEq)]
pub enum DecodeError {
    /// The stream is empty, corrupt, or the container could not be probed.
    BadInput(String),
    /// The codec inside the container has no enabled decoder.
    UnsupportedCodec(String),
    /// Decoding failed part way through the stream.
    DecodeFailed(String),
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadInput(detail) => write!(f, "cannot read audio from stream: {detail}"),
            Self::UnsupportedCodec(detail) => write!(f, "codec not supported: {detail}"),
            Self::DecodeFailed(detail) => write!(f, "decoding failed: {detail}"),
        }
    }
}

impl std::error::Error for DecodeError {}

impl DecodedTrack {
    /// Move the planar channels into a [`PcmVoice`] without copying.
    pub fn into_voice(
        self,
        options: crate::render::VoiceOptions,
    ) -> Result<crate::render::PcmVoice, String> {
        crate::render::PcmVoice::new(self.channels, options)
    }

    /// Split into (channels, sample rate, frames, duration).
    pub fn into_parts(self) -> (Vec<Vec<f32>>, u32, usize, f64) {
        (self.channels, self.sample_rate, self.frames, self.duration)
    }

    /// Left/right pair for stereo consumers.
    pub fn view_stereo(&self) -> (&[f32], &[f32]) {
        let left = &self.channels[0];
        let right = self.channels.get(1).unwrap_or(left);
        (left, right)
    }
}

#[cfg(feature = "decode")]
pub use symphonia_impl::{decode_bytes, decode_file};

#[cfg(feature = "decode")]
mod symphonia_impl {
    use super::*;
    use std::io::Read;

    use symphonia::core::audio::{AudioBufferRef, SampleBuffer};
    use symphonia::core::codecs::{CODEC_TYPE_NULL, DecoderOptions};
    use symphonia::core::errors::Error as SymphoniaError;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    const MAX_DECODE_CHANNELS: usize = 32;

    /// Decode a file on disk; the file extension becomes the probe hint.
    pub fn decode_file(path: impl AsRef<Path>) -> Result<DecodedTrack, DecodeError> {
        let path = path.as_ref();
        let mut file = std::fs::File::open(path)
            .map_err(|error| DecodeError::BadInput(error.to_string()))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| DecodeError::BadInput(error.to_string()))?;
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        decode_bytes(bytes, extension.as_deref())
    }

    /// Decode an in-memory stream. `extension_hint` ("wav", "mp3", "m4a",
    /// "flac") helps the probe when headers are ambiguous.
    pub fn decode_bytes(
        bytes: Vec<u8>,
        extension_hint: Option<&str>,
    ) -> Result<DecodedTrack, DecodeError> {
        if bytes.is_empty() {
            return Err(DecodeError::BadInput("stream is empty".into()));
        }
        let mut hint = Hint::new();
        if let Some(extension) = extension_hint {
            hint.with_extension(extension);
        }
        let source = MediaSourceStream::new(
            Box::new(std::io::Cursor::new(bytes)) as Box<dyn symphonia::core::io::MediaSource>,
            Default::default(),
        );
        let probe = symphonia::default::get_probe()
            .format(&hint, source, &FormatOptions::default(), &MetadataOptions::default())
            .map_err(|error| DecodeError::BadInput(format!("container could not be probed: {error}")))?;
        let mut format = probe.format;

        let (track_id, codec_params) = format
            .tracks()
            .iter()
            .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
            .map(|track| (track.id, track.codec_params.clone()))
            .ok_or_else(|| DecodeError::UnsupportedCodec("no audio track in container".into()))?;
        let codec = codec_params.codec;

        let mut decoder = symphonia::default::get_codecs()
            .make(&codec_params, &DecoderOptions::default())
            .map_err(|error| DecodeError::UnsupportedCodec(format!("{codec:?}: {error}")))?;

        let mut planar: Vec<Vec<f32>> = Vec::new();
        let mut source_channels: u64 = 0;
        let mut sample_rate: u32 = 0;
        let mut scratch: Option<SampleBuffer<f32>> = None;
        let mut scratch_channels: u64 = 0;
        let mut scratch_max_duration: u64 = 0;
        let mut decode_failures: usize = 0;

        loop {
            let packet = match format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(error)) => {
                    // EOF is the normal end of a whole-track decode.
                    if error.kind() == std::io::ErrorKind::UnexpectedEof {
                        break;
                    }
                    return Err(DecodeError::DecodeFailed(error.to_string()));
                }
                Err(error) => return Err(DecodeError::DecodeFailed(error.to_string())),
            };
            if packet.track_id() != track_id {
                continue;
            }
            let decoded: AudioBufferRef<'_> = match decoder.decode(&packet) {
                Ok(decoded) => decoded,
                // A damaged packet is skipped after a decoder reset, matching
                // how players tolerate stream corruption mid-track.
                Err(SymphoniaError::DecodeError(_)) => {
                    decode_failures += 1;
                    decoder.reset();
                    continue;
                }
                Err(SymphoniaError::ResetRequired) => {
                    decoder.reset();
                    continue;
                }
                Err(error) => return Err(DecodeError::DecodeFailed(error.to_string())),
            };

            let spec = decoded.spec();
            let channel_count = spec.channels.count() as u64;
            if channel_count == 0 {
                return Err(DecodeError::BadInput("the track reports zero channels".into()));
            }
            if channel_count as usize > MAX_DECODE_CHANNELS {
                return Err(DecodeError::UnsupportedCodec(format!(
                    "{channel_count} channels exceeds the supported maximum of {MAX_DECODE_CHANNELS}"
                )));
            }
            if sample_rate == 0 {
                sample_rate = spec.rate;
            } else if sample_rate != spec.rate {
                return Err(DecodeError::DecodeFailed(
                    "the source sample rate changed mid-stream".into(),
                ));
            }
            if let Some(first) = planar.first() {
                if planar.len() as u64 != channel_count {
                    return Err(DecodeError::DecodeFailed(
                        "the channel count changed mid-stream".into(),
                    ));
                }
                let _ = first;
            }

            let frames = decoded.frames() as u64;
            if frames == 0 {
                continue;
            }

            // Convert whatever integer/float format the decoder produced into
            // interleaved f32. Reuse the scratch when it can hold this packet.
            let sample_count = frames as usize * channel_count as usize;
            let reusable = scratch_channels == channel_count
                && scratch_max_duration >= frames
                && scratch.as_ref().is_some_and(|buffer| buffer.samples().len() >= sample_count);
            if reusable {
                if let Some(buffer) = scratch.as_mut() {
                    buffer.copy_interleaved_ref(decoded);
                }
            } else {
                let mut buffer = SampleBuffer::<f32>::new(frames, *spec);
                buffer.copy_interleaved_ref(decoded);
                scratch = Some(buffer);
                scratch_channels = channel_count;
                scratch_max_duration = frames;
                if planar.is_empty() {
                    planar = (0..channel_count).map(|_| Vec::new()).collect();
                    source_channels = channel_count;
                }
            }
            let samples: &[f32] = &scratch.as_ref().unwrap().samples()[..sample_count];

            for chunk in samples.chunks(source_channels.max(1) as usize) {
                for (index, value) in chunk.iter().enumerate() {
                    planar[index].push(*value);
                }
            }
        }

        if planar.is_empty() || sample_rate == 0 || source_frames_len(&planar) == 0 {
            let detail = if decode_failures > 0 {
                format!("{} packet(s) were undecodable", decode_failures)
            } else {
                "no audio frames decoded".to_string()
            };
            return Err(DecodeError::BadInput(detail));
        }

        let channels = fold_to_stereo(planar, source_channels)?;
        let frames = channels[0].len();
        Ok(DecodedTrack {
            channels,
            sample_rate,
            frames,
            duration: frames as f64 / f64::from(sample_rate),
        })
    }

    fn source_frames_len(planar: &[Vec<f32>]) -> usize {
        planar.first().map_or(0, |channel| channel.len())
    }

    /// Fold N channels (>2) down to stereo. Heuristic: source channels with an
    /// even index average into the left plane, odd into the right. 1-2 channel
    /// tracks pass through untouched.
    fn fold_to_stereo(planar: Vec<Vec<f32>>, source_channels: u64) -> Result<Vec<Vec<f32>>, DecodeError> {
        if planar.is_empty() {
            return Err(DecodeError::BadInput("zero channels decoded".into()));
        }
        if source_channels <= 2 {
            return Ok(planar);
        }
        let frames = planar[0].len();
        let mut left = vec![0.0f32; frames];
        let mut right = vec![0.0f32; frames];
        let mut left_weight = 0.0f32;
        let mut right_weight = 0.0f32;
        for (index, channel) in planar.iter().enumerate() {
            let item = if index % 2 == 0 {
                left_weight += 1.0;
                &mut left
            } else {
                right_weight += 1.0;
                &mut right
            };
            for (frame, value) in channel.iter().enumerate() {
                item[frame] += value;
            }
        }
        if left_weight > 0.0 {
            for value in left.iter_mut() {
                *value /= left_weight;
            }
        }
        if right_weight > 0.0 {
            for value in right.iter_mut() {
                *value /= right_weight;
            }
        }
        Ok(vec![left, right])
    }
}

#[cfg(all(test, feature = "decode"))]
mod tests {
    use super::*;

    const RATE: u32 = 44_100;
    const RAMP_LEN: usize = 480;

    fn ramps(len: usize) -> (Vec<i16>, Vec<i16>) {
        let left: Vec<i16> = (0..len).map(|value| value as i16).collect();
        let right: Vec<i16> = (0..len).map(|value| -(value as i16)).collect();
        (left, right)
    }

    fn wav_bytes(channels: u16, samples_l: &[i16], samples_r: &[i16], sample_rate: u32) -> Vec<u8> {
        let frames = samples_l.len();
        let block_align = channels * 2;
        let byte_rate = sample_rate * u32::from(block_align);
        let data_len = (frames * block_align as usize) as u32;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36u32.saturating_add(data_len)).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&sample_rate.to_le_bytes());
        out.extend_from_slice(&byte_rate.to_le_bytes());
        out.extend_from_slice(&block_align.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        for frame in 0..frames {
            out.extend_from_slice(&samples_l[frame].to_le_bytes());
            if channels == 2 {
                out.extend_from_slice(&samples_r[frame].to_le_bytes());
            }
        }
        out
    }

    #[test]
    fn decodes_16bit_stereo_wav_with_exact_values() {
        let (l, r) = ramps(RAMP_LEN);
        let decoded = decode_bytes(wav_bytes(2, &l, &r, RATE), Some("wav")).expect("wav decodes");
        assert_eq!(decoded.frames, RAMP_LEN);
        assert_eq!(decoded.sample_rate, RATE);
        assert_eq!(decoded.channels.len(), 2);
        let (left, right) = decoded.view_stereo();
        // Symphonia normalizes i16 to f32 by dividing by 32768.
        for frame in 0..RAMP_LEN {
            let expected_left = f64::from(frame as i16) / 32_768.0;
            let expected_right = f64::from(-(frame as i16)) / 32_768.0;
            assert!(
                ((left[frame] as f64 - expected_left) as f64).abs() < 1.0e-6,
                "left[{frame}]: {} vs {expected_left}",
                left[frame]
            );
            assert!(
                ((right[frame] as f64 - expected_right) as f64).abs() < 1.0e-6,
                "right[{frame}]: {} vs {expected_right}",
                right[frame]
            );
        }
        assert!((decoded.duration - RAMP_LEN as f64 / f64::from(RATE)).abs() < 1.0e-9);
    }

    #[test]
    fn decodes_16bit_mono_wav_into_one_planar_channel() {
        let (l, _) = ramps(240);
        let decoded = decode_bytes(wav_bytes(1, &l, &l, 48_000), Some("wav")).expect("mono wav");
        assert_eq!(decoded.channels.len(), 1);
        assert_eq!(decoded.frames, 240);
        assert_eq!(decoded.sample_rate, 48_000);
        assert!((decoded.channels[0][100] - 100.0 / 32_768.0).abs() < 1.0e-6);
    }

    #[test]
    fn empty_stream_is_rejected() {
        assert_eq!(
            decode_bytes(Vec::new(), None),
            Err(DecodeError::BadInput("stream is empty".into()))
        );
    }

    #[test]
    fn truncated_and_invalid_streams_are_rejected() {
        let (l, r) = ramps(64);
        let mut bytes = wav_bytes(2, &l, &r, RATE);
        bytes.truncate(24);
        let result = decode_bytes(bytes, Some("wav"));
        assert!(
            matches!(result, Err(DecodeError::BadInput(_))),
            "truncated stream must be BadInput, got {result:?}"
        );
        let garbage = vec![0xFFu8; 4096];
        let result = decode_bytes(garbage, None);
        assert!(
            matches!(result, Err(DecodeError::BadInput(_) | DecodeError::UnsupportedCodec(_))),
            "garbage must not decode, got {result:?}"
        );
    }

    #[test]
    fn into_voice_moves_the_channels_without_recopying() {
        let (l, r) = ramps(64);
        let decoded = decode_bytes(wav_bytes(2, &l, &r, RATE), Some("wav")).expect("wav decodes");
        let voice = decoded
            .into_voice(crate::render::VoiceOptions::new())
            .expect("voice");
        assert_eq!(voice.frames(), 64);
        assert_eq!(voice.position(), 0.0);
    }
}

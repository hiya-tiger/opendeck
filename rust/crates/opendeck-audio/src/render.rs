//! Voice mixing and offline rendering.

/// A loop window in sample frames. The end is exclusive.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LoopRegion {
    pub start: f64,
    pub end: f64,
}

impl LoopRegion {
    pub fn new(start: f64, end: f64) -> Self {
        Self { start, end }
    }

    pub fn len(&self) -> f64 {
        self.end - self.start
    }
}

#[derive(Clone, Debug, Default)]
pub struct VoiceOptions {
    pub position: f64,
    pub rate: f64,
    pub gain: f32,
    pub loop_region: Option<LoopRegion>,
}

impl VoiceOptions {
    pub fn new() -> Self {
        Self {
            position: 0.0,
            rate: 1.0,
            gain: 1.0,
            loop_region: None,
        }
    }
}

/// A single read cursor into planar PCM data.
#[derive(Clone, Debug)]
pub struct PcmVoice {
    channels: Vec<Vec<f32>>,
    frames: usize,
    position: f64,
    rate: f64,
    gain: f32,
    loop_region: Option<LoopRegion>,
    ended: bool,
}

const MIN_RATE: f64 = -16.0;
const MAX_RATE: f64 = 16.0;

impl PcmVoice {
    pub fn new(channels: Vec<Vec<f32>>, options: VoiceOptions) -> Result<Self, String> {
        let first = channels.first().ok_or("voice needs at least one channel")?;
        let frames = first.len();
        if channels.iter().any(|channel| channel.len() != frames) {
            return Err("voice channels must be equal length".into());
        }
        let rate = if options.rate.is_finite() {
            options.rate.clamp(MIN_RATE, MAX_RATE)
        } else {
            1.0
        };
        let voice = Self {
            channels,
            frames,
            position: options.position,
            rate,
            gain: options.gain,
            loop_region: options.loop_region,
            ended: false,
        };
        voice.validate_loop()?;
        Ok(voice)
    }

    fn validate_loop(&self) -> Result<(), String> {
        if let Some(region) = self.loop_region {
            if !region.start.is_finite() || !region.end.is_finite() {
                return Err("loop bounds must be finite".into());
            }
            if region.end <= region.start {
                return Err("loop end must be after loop start".into());
            }
            if region.start < 0.0 || region.end > self.frames as f64 {
                return Err("loop is outside the track".into());
            }
        }
        Ok(())
    }

    pub fn frames(&self) -> usize {
        self.frames
    }

    pub fn position(&self) -> f64 {
        self.position
    }

    pub fn ended(&self) -> bool {
        self.ended
    }

    pub fn seek(&mut self, frame: f64) {
        let last = self.frames.saturating_sub(1) as f64;
        self.position = frame.clamp(0.0, last);
        self.ended = false;
    }

    pub fn set_rate(&mut self, rate: f64) {
        self.rate = if rate.is_finite() {
            rate.clamp(MIN_RATE, MAX_RATE)
        } else {
            1.0
        };
    }

    pub fn set_loop(&mut self, region: Option<LoopRegion>) -> Result<(), String> {
        self.loop_region = region;
        self.validate_loop()
    }

    fn wrap(&mut self) {
        let Some(region) = self.loop_region else {
            return;
        };
        let len = region.len();
        if self.rate >= 0.0 {
            if self.position >= region.end {
                self.position = region.start + (self.position - region.start) % len;
            }
        } else if self.position < region.start {
            self.position = region.end - (region.end - self.position) % len;
        }
    }

    /// Add this voice into a stereo block.
    pub fn render_add(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.ended {
            return;
        }
        let count = left.len().min(right.len());
        let last = self.frames.saturating_sub(1);
        let channels = std::mem::take(&mut self.channels);
        let src_left = &channels[0];
        let src_right = if channels.len() > 1 { &channels[1] } else { &channels[0] };
        let gain = self.gain;
        let mut position = self.position;
        let mut rate = self.rate;
        let loop_region = self.loop_region;

        for i in 0..count {
            if position < 0.0 || position > last as f64 {
                if loop_region.is_none() {
                    self.ended = true;
                    break;
                }
                self.wrap();
                if position < 0.0 || position > last as f64 {
                    self.ended = true;
                    break;
                }
            }
            let index = position.floor() as usize;
            let frac = (position - index as f64) as f32;
            let (left_sample, right_sample) = if index >= last {
                (src_left[last], src_right[last])
            } else {
                (
                    src_left[index] + (src_left[index + 1] - src_left[index]) * frac,
                    src_right[index] + (src_right[index + 1] - src_right[index]) * frac,
                )
            };
            left[i] += left_sample * gain;
            right[i] += right_sample * gain;
            position += rate;
            if let Some(region) = loop_region {
                if rate >= 0.0 {
                    if position >= region.end {
                        position = region.start + (position - region.start) % region.len();
                    }
                } else if position < region.start {
                    position = region.end - (region.end - position) % region.len();
                }
            }
            rate = self.rate;
        }

        self.channels = channels;
        self.position = position;
        if self.loop_region.is_none() && (position < 0.0 || position > last as f64) {
            self.ended = true;
        }
    }
}

/// The handful of fields the UI needs from a deck source.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StereoSamples {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

pub struct Transport {
    voices: Vec<PcmVoice>,
    sample_rate: u32,
}

impl Transport {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            voices: Vec::new(),
            sample_rate,
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn add_voice(&mut self, voice: PcmVoice) -> usize {
        self.voices.push(voice);
        self.voices.len() - 1
    }

    pub fn voice(&mut self, index: usize) -> Option<&mut PcmVoice> {
        self.voices.get_mut(index)
    }

    pub fn clear(&mut self) {
        self.voices.clear();
    }

    pub fn render_block(&mut self, left: &mut [f32], right: &mut [f32]) {
        let count = left.len().min(right.len());
        left[..count].fill(0.0);
        right[..count].fill(0.0);
        for voice in &mut self.voices {
            voice.render_add(left, right);
        }
    }

    /// Render any number of frames in fixed blocks.
    pub fn render_offline(&mut self, frames: usize, block_size: usize) -> StereoSamples {
        assert!(block_size > 0, "block size must be positive");
        let mut out = StereoSamples {
            left: vec![0.0; frames],
            right: vec![0.0; frames],
        };
        let mut block_left = vec![0.0; block_size];
        let mut block_right = vec![0.0; block_size];
        let mut offset = 0;
        while offset < frames {
            let count = block_size.min(frames - offset);
            self.render_block(&mut block_left[..count], &mut block_right[..count]);
            out.left[offset..offset + count].copy_from_slice(&block_left[..count]);
            out.right[offset..offset + count].copy_from_slice(&block_right[..count]);
            offset += count;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp(frames: usize) -> Vec<f32> {
        (0..frames).map(|value| value as f32).collect()
    }

    fn render(
        frames: usize,
        block_size: usize,
        rate: f64,
        position: f64,
        loop_region: Option<LoopRegion>,
    ) -> Vec<f32> {
        let options = VoiceOptions {
            position,
            rate,
            gain: 1.0,
            loop_region,
        };
        let mut transport = Transport::new(48_000);
        transport.add_voice(PcmVoice::new(vec![ramp(frames)], options).unwrap());
        transport.render_offline(frames, block_size).left
    }

    #[test]
    fn unity_rate_reproduces_the_buffer() {
        assert_eq!(render(16, 16, 1.0, 0.0, None), ramp(16));
    }

    #[test]
    fn double_rate_resamples() {
        let mut transport = Transport::new(48_000);
        transport.add_voice(
            PcmVoice::new(
                vec![ramp(16)],
                VoiceOptions {
                    rate: 2.0,
                    ..VoiceOptions::new()
                },
            )
            .unwrap(),
        );
        let out = transport.render_offline(8, 8).left;
        assert_eq!(out, vec![0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0]);
    }

    #[test]
    fn reverse_plays_backwards() {
        assert_eq!(
            render(8, 8, -1.0, 7.0, None),
            vec![7.0, 6.0, 5.0, 4.0, 3.0, 2.0, 1.0, 0.0]
        );
    }

    #[test]
    fn loop_wraps_on_the_sample_boundary() {
        let loop_region = Some(LoopRegion::new(2.0, 6.0));
        assert_eq!(
            render(10, 10, 1.0, 2.0, loop_region),
            vec![2.0, 3.0, 4.0, 5.0, 2.0, 3.0, 4.0, 5.0, 2.0, 3.0]
        );
    }

    #[test]
    fn reverse_loop_wraps_backwards() {
        let loop_region = Some(LoopRegion::new(2.0, 6.0));
        assert_eq!(
            render(8, 8, -1.0, 5.0, loop_region),
            vec![5.0, 4.0, 3.0, 2.0, 5.0, 4.0, 3.0, 2.0]
        );
    }

    #[test]
    fn block_size_does_not_change_output() {
        let loop_region = Some(LoopRegion::new(13.0, 97.0));
        let reference = render(200, 200, 0.7, 13.0, loop_region);
        for block_size in [1, 2, 3, 7, 16, 64, 128] {
            assert_eq!(render(200, block_size, 0.7, 13.0, loop_region), reference);
        }
    }

    #[test]
    fn reverse_loop_is_block_size_invariant() {
        let loop_region = Some(LoopRegion::new(11.0, 83.0));
        let reference = render(150, 150, -0.83, 40.0, loop_region);
        for block_size in [1, 5, 32, 128] {
            assert_eq!(render(150, block_size, -0.83, 40.0, loop_region), reference);
        }
    }

    #[test]
    fn voice_stops_at_the_end() {
        let mut transport = Transport::new(48_000);
        transport.add_voice(PcmVoice::new(vec![ramp(4)], VoiceOptions::new()).unwrap());
        let out = transport.render_offline(8, 2).left;
        assert_eq!(out, vec![0.0, 1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 0.0]);
        assert!(transport.voice(0).unwrap().ended());
    }

    #[test]
    fn voices_mix_with_gain_and_stereo() {
        let mut transport = Transport::new(48_000);
        transport.add_voice(
            PcmVoice::new(
                vec![ramp(4), ramp(4).into_iter().map(|v| v + 10.0).collect()],
                VoiceOptions {
                    gain: 0.5,
                    ..VoiceOptions::new()
                },
            )
            .unwrap(),
        );
        transport.add_voice(
            PcmVoice::new(
                vec![ramp(4)],
                VoiceOptions {
                    gain: 0.25,
                    position: 1.0,
                    ..VoiceOptions::new()
                },
            )
            .unwrap(),
        );
        let rendered = transport.render_offline(4, 4);
        assert_eq!(rendered.left, vec![0.25, 1.0, 1.75, 1.5]);
        assert_eq!(rendered.right, vec![5.25, 6.0, 6.75, 6.5]);
    }

    #[test]
    fn invalid_loops_are_rejected() {
        assert!(PcmVoice::new(
            vec![ramp(8)],
            VoiceOptions {
                loop_region: Some(LoopRegion::new(6.0, 2.0)),
                ..VoiceOptions::new()
            }
        )
        .is_err());
        assert!(PcmVoice::new(
            vec![ramp(8)],
            VoiceOptions {
                loop_region: Some(LoopRegion::new(0.0, 9.0)),
                ..VoiceOptions::new()
            }
        )
        .is_err());
    }

    #[test]
    fn ten_minutes_of_looping_stays_on_the_exact_sample() {
        let frames = 48_000usize * 600;
        let loop_region = LoopRegion::new(1000.0, 5000.0);
        let length = loop_region.end - loop_region.start;
        let options = VoiceOptions {
            position: loop_region.start,
            rate: 1.0,
            gain: 1.0,
            loop_region: Some(loop_region),
        };
        let mut transport = Transport::new(48_000);
        transport.add_voice(PcmVoice::new(vec![ramp(10_000)], options).unwrap());
        let mut left = [0.0f32; 128];
        let mut right = [0.0f32; 128];
        let mut offset = 0;
        while offset < frames {
            let count = 128.min(frames - offset);
            transport.render_block(&mut left[..count], &mut right[..count]);
            offset += count;
        }
        let position = transport.voice(0).unwrap().position();
        assert_eq!(position, loop_region.start + (frames as f64 % length));

        let options = VoiceOptions {
            position: loop_region.end - 1.0,
            rate: -1.0,
            gain: 1.0,
            loop_region: Some(loop_region),
        };
        let mut reverse = Transport::new(48_000);
        reverse.add_voice(PcmVoice::new(vec![ramp(10_000)], options).unwrap());
        let mut offset = 0;
        while offset < frames {
            let count = 128.min(frames - offset);
            reverse.render_block(&mut left[..count], &mut right[..count]);
            offset += count;
        }
        let expected = loop_region.end - 1.0 - (frames as f64 % length);
        assert_eq!(reverse.voice(0).unwrap().position(), expected);
    }
}

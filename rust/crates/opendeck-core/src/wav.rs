use std::fmt;

#[derive(Debug)]
pub enum WavError {
    TooShort,
    NotRiff,
    Unsupported,
}

impl fmt::Display for WavError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WavError::TooShort => write!(f, "file is too short to be a WAV"),
            WavError::NotRiff => write!(f, "missing RIFF/WAVE header"),
            WavError::Unsupported => write!(f, "only 8/16/24/32-bit PCM WAV is supported"),
        }
    }
}

impl std::error::Error for WavError {}

fn u16_at(bytes: &[u8], offset: usize) -> u32 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]]) as u32
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

pub struct WavData {
    pub samples: Vec<f32>,
    pub sample_rate: f32,
    pub channels: u16,
}

pub fn read_wav(bytes: &[u8]) -> Result<WavData, WavError> {
    if bytes.len() < 44 {
        return Err(WavError::TooShort);
    }
    if &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(WavError::NotRiff);
    }

    let mut cursor = 12usize;
    let mut channels = 1u16;
    let mut sample_rate = 44100.0f32;
    let mut bits = 16u16;
    let mut data: Option<(usize, usize)> = None;

    while cursor + 8 <= bytes.len() {
        let id = &bytes[cursor..cursor + 4];
        let size = u32_at(bytes, cursor + 4) as usize;
        let body = cursor + 8;
        if id == b"fmt " && body + 16 <= bytes.len() {
            channels = u16_at(bytes, body + 2) as u16;
            sample_rate = u32_at(bytes, body + 4) as f32;
            bits = u16_at(bytes, body + 14) as u16;
        } else if id == b"data" {
            let end = (body + size).min(bytes.len());
            data = Some((body, end));
        }
        cursor = body + size + (size & 1);
    }

    let (start, end) = data.ok_or(WavError::NotRiff)?;
    if channels == 0 || !(8..=32).contains(&bits) {
        return Err(WavError::Unsupported);
    }

    let frame_bytes = (bits as usize / 8) * channels as usize;
    if frame_bytes == 0 {
        return Err(WavError::Unsupported);
    }
    let frames = (end - start) / frame_bytes;
    let mut samples = Vec::with_capacity(frames);

    for frame in 0..frames {
        let mut sum = 0.0f32;
        for channel in 0..channels as usize {
            let offset = start + frame * frame_bytes + channel * (bits as usize / 8);
            let value = match bits {
                8 => (bytes[offset] as f32 - 128.0) / 128.0,
                16 => i16::from_le_bytes([bytes[offset], bytes[offset + 1]]) as f32 / 32768.0,
                24 => {
                    let raw = i32::from_le_bytes([
                        bytes[offset],
                        bytes[offset + 1],
                        bytes[offset + 2],
                        if bytes[offset + 2] & 0x80 != 0 { 0xff } else { 0x00 },
                    ]);
                    raw as f32 / 8_388_608.0
                }
                32 => i32::from_le_bytes([
                    bytes[offset],
                    bytes[offset + 1],
                    bytes[offset + 2],
                    bytes[offset + 3],
                ]) as f32
                    / 2_147_483_648.0,
                _ => return Err(WavError::Unsupported),
            };
            sum += value;
        }
        samples.push(sum / channels as f32);
    }

    Ok(WavData {
        samples,
        sample_rate,
        channels,
    })
}

pub fn read_wav_mono(bytes: &[u8]) -> Result<(Vec<f32>, f32), WavError> {
    let data = read_wav(bytes)?;
    Ok((data.samples, data.sample_rate))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_16bit(samples: &[f32], sample_rate: u32) -> Vec<u8> {
        let data_len = samples.len() * 2;
        let mut out = Vec::with_capacity(44 + data_len);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&sample_rate.to_le_bytes());
        out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data_len as u32).to_le_bytes());
        for sample in samples {
            let clamped = (sample * 32767.0).clamp(-32767.0, 32767.0) as i16;
            out.extend_from_slice(&clamped.to_le_bytes());
        }
        out
    }

    #[test]
    fn round_trips_pcm() {
        let original: Vec<f32> = (0..1000)
            .map(|i| (2.0 * std::f32::consts::PI * 60.0 * i as f32 / 44100.0).sin() * 0.5)
            .collect();
        let bytes = encode_16bit(&original, 44100);
        let (samples, rate) = read_wav_mono(&bytes).unwrap();
        assert_eq!(rate, 44100.0);
        assert_eq!(samples.len(), original.len());
        for (a, b) in samples.iter().zip(original.iter()) {
            assert!((a - b).abs() < 0.001);
        }
    }

    #[test]
    fn rejects_short_files() {
        assert!(matches!(read_wav(b"RIFF"), Err(WavError::TooShort)));
    }
}

//! Decoding through Symphonia 0.5 (MPL-2.0, see docs/benchmarks/rust-native.md licence notes)
//! plus libopus (BSD-3-Clause) through `symphonia-adapter-libopus` for Opus, which Symphonia
//! does not decode. Output: interleaved stereo f32 at the file's own rate.

use std::io::Cursor;
use std::sync::OnceLock;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CodecRegistry, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[derive(Debug, Clone)]
pub struct Decoded {
    pub rate: u32,
    pub source_channels: usize,
    pub frames: usize,
    /// Interleaved stereo.
    pub pcm: Vec<f32>,
    pub codec: String,
    pub decode_errors: usize,
}

fn registry() -> &'static CodecRegistry {
    static REG: OnceLock<CodecRegistry> = OnceLock::new();
    REG.get_or_init(|| {
        let mut reg = CodecRegistry::new();
        symphonia::default::register_enabled_codecs(&mut reg);
        #[cfg(feature = "opus")]
        reg.register_all::<symphonia_adapter_libopus::OpusDecoder>();
        reg
    })
}

pub fn decode_file(path: &std::path::Path) -> Result<Decoded, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    decode_bytes(bytes, ext)
}

/// Decode a whole file held in memory (the benchmark times this, not disk I/O).
pub fn decode_bytes(bytes: Vec<u8>, ext: &str) -> Result<Decoded, String> {
    let mss = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let mut hint = Hint::new();
    if !ext.is_empty() {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("probe: {e}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("no audio track")?
        .clone();
    let reg = registry();
    let codec = reg
        .get_codec(track.codec_params.codec)
        .map(|d| d.short_name.to_string())
        .unwrap_or_else(|| format!("{:?}", track.codec_params.codec));
    let mut decoder = reg
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("codec {codec}: {e}"))?;
    let mut pcm: Vec<f32> = Vec::with_capacity(track.codec_params.n_frames.unwrap_or(0) as usize * 2);
    let mut rate = track.codec_params.sample_rate.unwrap_or(0);
    let mut chans = track.codec_params.channels.map(|c| c.count()).unwrap_or(0);
    let mut sbuf: Option<SampleBuffer<f32>> = None;
    let mut errors = 0usize;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Error::ResetRequired) => break,
            Err(e) => return Err(format!("demux: {e}")),
        };
        if packet.track_id() != track.id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buf) => {
                let spec = *buf.spec();
                rate = spec.rate;
                chans = spec.channels.count();
                let need = buf.capacity() as u64;
                if sbuf.as_ref().map(|b| b.capacity() < need as usize * chans).unwrap_or(true) {
                    sbuf = Some(SampleBuffer::<f32>::new(need, spec));
                }
                let sb = sbuf.as_mut().unwrap();
                sb.copy_interleaved_ref(buf);
                let s = sb.samples();
                match chans {
                    1 => s.iter().for_each(|&v| {
                        pcm.push(v);
                        pcm.push(v)
                    }),
                    2 => pcm.extend_from_slice(s),
                    n => s.chunks_exact(n).for_each(|f| {
                        pcm.push(f[0]);
                        pcm.push(f[1])
                    }),
                }
            }
            Err(Error::DecodeError(_)) => errors += 1,
            Err(Error::IoError(_)) => errors += 1,
            Err(e) => return Err(format!("decode: {e}")),
        }
    }
    Ok(Decoded { rate, source_channels: chans, frames: pcm.len() / 2, pcm, codec, decode_errors: errors })
}

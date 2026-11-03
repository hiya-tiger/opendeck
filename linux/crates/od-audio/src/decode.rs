//! File decoding off the audio thread: WAV (hound), FLAC (claxon), Ogg
//! Vorbis (lewton), MP3 (minimp3), plus the benchmark `.f32` fixtures.
//! All permissive. AAC/M4A/ALAC have no permissive pure decoder here yet:
//! documented gap (docs/linux/egui-parity.md).
use crate::Pcm;
use std::path::Path;

pub struct Decoded { pub sample_rate: u32, pub channels: Vec<Vec<f32>> }

pub fn decode_file(path: &Path) -> Result<Decoded, String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "wav" | "wave" => wav(path),
        "flac" => flac(path),
        "ogg" | "oga" => ogg(path),
        "mp3" => mp3(path),
        "f32" => od_core::load_track(path).map(|(sr, ch)| Decoded { sample_rate: sr as u32, channels: ch }).map_err(|e| e.to_string()),
        other => Err(format!("unsupported format .{other} (AAC/M4A/ALAC/AIFF not yet on Linux)")),
    }
}

fn wav(p: &Path) -> Result<Decoded, String> {
    let mut r = hound::WavReader::open(p).map_err(|e| e.to_string())?;
    let spec = r.spec();
    let nch = spec.channels as usize;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
        hound::SampleFormat::Int => { let scale = 1.0 / (1u64 << (spec.bits_per_sample - 1)) as f32; r.samples::<i32>().map(|s| s.unwrap_or(0) as f32 * scale).collect() }
    };
    Ok(Decoded { sample_rate: spec.sample_rate, channels: deinterleave(&samples, nch) })
}
fn flac(p: &Path) -> Result<Decoded, String> {
    let mut r = claxon::FlacReader::open(p).map_err(|e| e.to_string())?;
    let info = r.streaminfo();
    let scale = 1.0 / (1u64 << (info.bits_per_sample - 1)) as f32;
    let s: Vec<f32> = r.samples().map(|x| x.unwrap_or(0) as f32 * scale).collect();
    Ok(Decoded { sample_rate: info.sample_rate, channels: deinterleave(&s, info.channels as usize) })
}
fn ogg(p: &Path) -> Result<Decoded, String> {
    let f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut r = lewton::inside_ogg::OggStreamReader::new(f).map_err(|e| e.to_string())?;
    let nch = r.ident_hdr.audio_channels as usize;
    let sr = r.ident_hdr.audio_sample_rate;
    let mut s = vec![];
    while let Some(pk) = r.read_dec_packet_itl().map_err(|e| e.to_string())? { s.extend(pk.into_iter().map(|v| v as f32 / 32768.0)); }
    Ok(Decoded { sample_rate: sr, channels: deinterleave(&s, nch) })
}
fn mp3(p: &Path) -> Result<Decoded, String> {
    let f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut d = minimp3::Decoder::new(f);
    let (mut s, mut sr, mut nch) = (vec![], 44100u32, 2usize);
    loop {
        match d.next_frame() {
            Ok(fr) => { sr = fr.sample_rate as u32; nch = fr.channels; s.extend(fr.data.into_iter().map(|v| v as f32 / 32768.0)); }
            Err(minimp3::Error::Eof) => break,
            Err(minimp3::Error::SkippedData) => continue,
            Err(e) => return Err(format!("{e:?}")),
        }
    }
    Ok(Decoded { sample_rate: sr, channels: deinterleave(&s, nch) })
}
fn deinterleave(s: &[f32], nch: usize) -> Vec<Vec<f32>> {
    let nch = nch.max(1);
    let frames = s.len() / nch;
    (0..nch.min(2)).map(|c| (0..frames).map(|i| s[i * nch + c]).collect()).collect()
}

/// Linear resample to the engine rate (off the audio thread).
pub fn to_engine_rate(d: Decoded, engine_sr: u32) -> Pcm {
    if d.sample_rate == engine_sr || d.channels.is_empty() { return Pcm { channels: d.channels }; }
    let ratio = d.sample_rate as f64 / engine_sr as f64;
    let n_in = d.channels[0].len();
    let n_out = ((n_in as f64) / ratio) as usize;
    let channels = d.channels.iter().map(|c| (0..n_out).map(|i| { let x = i as f64 * ratio; let j = x as usize; let f = (x - j as f64) as f32; let a = c[j.min(n_in - 1)]; let b = c[(j + 1).min(n_in - 1)]; a + (b - a) * f }).collect()).collect();
    Pcm { channels }
}

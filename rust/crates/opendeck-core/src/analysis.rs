use crate::dsp::{hann, magnitudes, magnitudes_into, rms};

#[derive(Clone, Debug, Default)]
pub struct BandPeaks {
    pub low: Vec<f32>,
    pub mid: Vec<f32>,
    pub high: Vec<f32>,
}

#[derive(Clone, Debug, Default)]
pub struct Key {
    pub key: String,
    pub camelot: String,
    pub major: bool,
    pub confidence: f32,
}

#[derive(Clone, Debug, Default)]
pub struct Analysis {
    pub bpm: f32,
    pub confidence: f32,
    pub beat_phase: f32,
    pub peaks: Vec<f32>,
    pub bands: BandPeaks,
    pub duration: f32,
    pub chroma: [f32; 12],
    pub key: Key,
}

pub fn peaks(samples: &[f32], buckets: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; buckets];
    if samples.is_empty() || buckets == 0 {
        return out;
    }
    let block = (samples.len() / buckets).max(1);
    for (i, slot) in out.iter_mut().enumerate() {
        let start = i * block;
        let end = (start + block).min(samples.len());
        if start >= end {
            break;
        }
        let mut max = 0.0f32;
        for value in &samples[start..end] {
            let abs = value.abs();
            if abs > max {
                max = abs;
            }
        }
        *slot = max;
    }
    out
}

pub fn band_peaks(samples: &[f32], sample_rate: f32, buckets: usize) -> BandPeaks {
    let mut bands = BandPeaks {
        low: vec![0.0; buckets],
        mid: vec![0.0; buckets],
        high: vec![0.0; buckets],
    };
    if samples.is_empty() || buckets == 0 {
        return bands;
    }
    let block = (samples.len() / buckets).max(1);
    let a_low = 1.0 - (-2.0 * std::f32::consts::PI * 180.0 / sample_rate).exp();
    let a_mid = 1.0 - (-2.0 * std::f32::consts::PI * 2600.0 / sample_rate).exp();
    let (mut lp_low, mut lp_mid) = (0.0f32, 0.0f32);
    let (mut peak_low, mut peak_mid, mut peak_high) = (1e-9f32, 1e-9f32, 1e-9f32);

    for i in 0..buckets {
        let start = i * block;
        let end = (start + block).min(samples.len());
        if start >= end {
            break;
        }
        let (mut e_low, mut e_mid, mut e_high) = (0.0f32, 0.0f32, 0.0f32);
        for value in &samples[start..end] {
            lp_low += a_low * (value - lp_low);
            lp_mid += a_mid * (value - lp_mid);
            let low = lp_low;
            let mid = lp_mid - lp_low;
            let high = value - lp_mid;
            e_low += low * low;
            e_mid += mid * mid;
            e_high += high * high;
        }
        let n = (end - start) as f32;
        bands.low[i] = (e_low / n).sqrt();
        bands.mid[i] = (e_mid / n).sqrt();
        bands.high[i] = (e_high / n).sqrt();
        peak_low = peak_low.max(bands.low[i]);
        peak_mid = peak_mid.max(bands.mid[i]);
        peak_high = peak_high.max(bands.high[i]);
    }

    for i in 0..buckets {
        bands.low[i] = (bands.low[i] / peak_low).min(1.0);
        bands.mid[i] = (bands.mid[i] / peak_mid).min(1.0);
        bands.high[i] = (bands.high[i] / peak_high).min(1.0);
    }
    for band in [&mut bands.low, &mut bands.mid, &mut bands.high] {
        let mut prev = band[0];
        for i in 1..buckets.saturating_sub(1) {
            let next = band[i];
            band[i] = (prev * 0.25 + next * 0.5 + band[i + 1] * 0.25).min(1.0);
            prev = next;
        }
    }
    bands
}

pub fn spectral_flux(samples: &[f32], window: usize) -> (Vec<f32>, f32) {
    if samples.len() < window || window == 0 {
        return (Vec::new(), 0.0);
    }
    let hop = window / 2;
    let hann_window = hann(window);
    let half = window / 2;
    let mut re = vec![0.0f32; window];
    let mut im = vec![0.0f32; window];
    let mut mag = vec![0.0f32; half];
    let mut previous = vec![0.0f32; half];
    let mut has_previous = false;
    let mut flux = Vec::new();
    let mut cursor = 0usize;
    while cursor + window <= samples.len() {
        magnitudes_into(
            &samples[cursor..cursor + window],
            &hann_window,
            &mut re,
            &mut im,
            &mut mag,
        );
        if has_previous {
            let mut sum = 0.0f32;
            for i in 0..half {
                let diff = mag[i] - previous[i];
                if diff > 0.0 {
                    sum += diff;
                }
            }
            flux.push(sum);
        } else {
            has_previous = true;
        }
        previous.copy_from_slice(&mag);
        cursor += hop;
    }
    let peak = flux.iter().cloned().fold(0.0f32, f32::max);
    if peak > 0.0 {
        for value in flux.iter_mut() {
            *value /= peak;
        }
    }
    (flux, window as f32)
}

fn beat_phase(flux: &[f32], frame_rate: f32, bpm: f32) -> f32 {
    if bpm <= 0.0 || flux.is_empty() {
        return 0.0;
    }
    let beat_frames = 60.0 / bpm * frame_rate;
    if beat_frames < 1.0 {
        return 0.0;
    }
    let steps = beat_frames.ceil() as usize;
    let mut best_phase = 0.0f32;
    let mut best_score = f32::MIN;
    for step in 0..steps.max(1) {
        let phase = step as f32;
        let mut score = 0.0f32;
        let mut index = phase;
        let mut count = 0.0f32;
        while (index as usize) < flux.len() {
            score += flux[index as usize];
            count += 1.0;
            index += beat_frames;
        }
        if count > 0.0 {
            score /= count;
        }
        if score > best_score {
            best_score = score;
            best_phase = phase;
        }
    }
    best_phase / frame_rate
}

pub fn estimate_bpm(flux: &[f32], frame_rate: f32, min_bpm: f32, max_bpm: f32) -> (f32, f32, f32) {
    if flux.is_empty() || frame_rate <= 0.0 {
        return (0.0, 0.0, 0.0);
    }
    let peak = flux.iter().cloned().fold(0.0f32, f32::max);
    if peak <= 1e-6 || (flux.len() as f32) < frame_rate * 4.0 {
        return (0.0, 0.0, 0.0);
    }
    let min_lag = ((60.0 / max_bpm) * frame_rate).floor().max(2.0) as usize;
    let max_lag = (((60.0 / min_bpm) * frame_rate).ceil() as usize).min(flux.len().saturating_sub(2));
    if max_lag <= min_lag {
        return (0.0, 0.0, 0.0);
    }

    let mut best_lag = 0usize;
    let mut best_score = f32::MIN;
    let mut scores = vec![0.0f32; max_lag + 1];
    for lag in min_lag..=max_lag {
        let mut sum = 0.0f32;
        let mut energy_a = 0.0f32;
        let mut energy_b = 0.0f32;
        for i in lag..flux.len() {
            sum += flux[i] * flux[i - lag];
            energy_a += flux[i] * flux[i];
            energy_b += flux[i - lag] * flux[i - lag];
        }
        let denom = (energy_a.sqrt() * energy_b.sqrt()).max(1e-9);
        let score = sum / denom;
        scores[lag] = score;
        if score > best_score {
            best_score = score;
            best_lag = lag;
        }
    }
    if best_lag == 0 {
        return (0.0, 0.0, 0.0);
    }

    let mut refined = best_lag as f32;
    if best_lag > min_lag && best_lag < max_lag {
        let left = scores[best_lag - 1];
        let center = scores[best_lag];
        let right = scores[best_lag + 1];
        let denom = left - 2.0 * center + right;
        if denom.abs() > 1e-9 {
            let offset = 0.5 * (left - right) / denom;
            if offset.abs() < 1.0 {
                refined += offset;
            }
        }
    }

    let mut bpm = 60.0 * frame_rate / refined;
    while bpm < min_bpm {
        bpm *= 2.0;
    }
    while bpm > max_bpm {
        bpm /= 2.0;
    }
    let confidence = best_score.max(0.0).min(1.0);
    (bpm, confidence, beat_phase(flux, frame_rate, bpm))
}

pub fn chroma(samples: &[f32], sample_rate: f32) -> [f32; 12] {
    let mut out = [0.0f32; 12];
    let window = 4096usize;
    if samples.len() < window {
        return out;
    }
    let hop = window / 2;
    let hann_window = hann(window);
    let mut cursor = 0usize;
    while cursor + window <= samples.len() {
        let mag = magnitudes(&samples[cursor..cursor + window], &hann_window);
        for (i, value) in mag.iter().enumerate() {
            let freq = i as f32 * sample_rate / window as f32;
            if !(55.0..=2000.0).contains(&freq) {
                continue;
            }
            let midi = 69.0 + 12.0 * (freq / 440.0).log2();
            let pitch = ((midi.round() as i32 % 12) + 12) % 12;
            out[pitch as usize] += value;
        }
        cursor += hop;
    }
    let sum: f32 = out.iter().sum();
    if sum > 0.0 {
        for value in out.iter_mut() {
            *value /= sum;
        }
    }
    let _ = rms(samples);
    out
}

const PITCH_CLASSES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];
const MAJOR_PROFILE: [f32; 12] = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE: [f32; 12] = [
    6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];
const CAMELOT_MAJOR: [&str; 12] = [
    "8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B",
];
const CAMELOT_MINOR: [&str; 12] = [
    "5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A",
];

pub fn detect_key(chroma: &[f32; 12]) -> Key {
    let sum: f32 = chroma.iter().sum();
    if sum <= 1e-6 {
        return Key {
            key: "--".into(),
            camelot: "--".into(),
            major: true,
            confidence: 0.0,
        };
    }
    let normalized: Vec<f32> = chroma.iter().map(|value| value / sum).collect();
    let mut best_root = 0usize;
    let mut best_major = true;
    let mut best_score = f32::NEG_INFINITY;
    let mut second_score = f32::NEG_INFINITY;
    for root in 0..12 {
        for major in [true, false] {
            let profile = if major { MAJOR_PROFILE } else { MINOR_PROFILE };
            let mut score = 0.0f32;
            for i in 0..12 {
                score += normalized[(root + i) % 12] * profile[i];
            }
            if score > best_score {
                second_score = best_score;
                best_score = score;
                best_root = root;
                best_major = major;
            } else if score > second_score {
                second_score = score;
            }
        }
    }
    let confidence = if best_score > 0.0 {
        ((best_score - second_score) / best_score).clamp(0.0, 1.0)
    } else {
        0.0
    };
    Key {
        key: format!(
            "{} {}",
            PITCH_CLASSES[best_root],
            if best_major { "maj" } else { "min" }
        ),
        camelot: if best_major {
            CAMELOT_MAJOR[best_root].to_string()
        } else {
            CAMELOT_MINOR[best_root].to_string()
        },
        major: best_major,
        confidence,
    }
}

pub fn analyze_mono(samples: &[f32], sample_rate: f32, buckets: usize) -> Analysis {
    let (flux, window) = spectral_flux(samples, 1024);
    let frame_rate = sample_rate / (window.max(1.0) / 2.0);
    let (bpm, confidence, beat_phase) = estimate_bpm(&flux, frame_rate, 70.0, 190.0);
    let chroma = chroma(samples, sample_rate);
    Analysis {
        bpm,
        confidence,
        beat_phase,
        peaks: peaks(samples, buckets),
        bands: band_peaks(samples, sample_rate, buckets),
        duration: samples.len() as f32 / sample_rate,
        chroma,
        key: detect_key(&chroma),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click_track(bpm: f32, seconds: f32, sample_rate: f32) -> Vec<f32> {
        let mut out = vec![0.0f32; (seconds * sample_rate) as usize];
        let beat = 60.0 / bpm;
        let mut t = 0.0f32;
        while t < seconds {
            let start = (t * sample_rate) as usize;
            for i in 0..(sample_rate * 0.06) as usize {
                let index = start + i;
                if index >= out.len() {
                    break;
                }
                let env = (-(i as f32) / (sample_rate * 0.02)).exp();
                out[index] += (2.0 * std::f32::consts::PI * 62.0 * i as f32 / sample_rate).sin() * env * 0.9;
            }
            t += beat;
        }
        out
    }

    #[test]
    fn peaks_track_loudness() {
        let sample_rate = 44100.0;
        let mut samples = click_track(128.0, 8.0, sample_rate);
        let quiet_start = (samples.len() / 2) as usize;
        for value in samples.iter_mut().skip(quiet_start) {
            *value *= 0.2;
        }
        let out = peaks(&samples, 400);
        let loud: f32 = out[..100].iter().cloned().fold(0.0, f32::max);
        let quiet: f32 = out[300..].iter().cloned().fold(0.0, f32::max);
        assert!(loud > quiet * 3.0, "loud {loud} quiet {quiet}");
        assert!(quiet > 0.0);
    }

    #[test]
    fn band_peaks_split_bass_and_treble() {
        let sample_rate = 44100.0;
        let n = (sample_rate * 4.0) as usize;
        let mut samples = vec![0.0f32; n];
        for i in 0..n / 2 {
            samples[i] = (2.0 * std::f32::consts::PI * 60.0 * i as f32 / sample_rate).sin() * 0.8;
        }
        for i in n / 2..n {
            samples[i] = (2.0 * std::f32::consts::PI * 9000.0 * i as f32 / sample_rate).sin() * 0.8;
        }
        let bands = band_peaks(&samples, sample_rate, 200);
        let low_first: f32 = bands.low[..80].iter().cloned().fold(0.0, f32::max);
        let low_last: f32 = bands.low[120..].iter().cloned().fold(0.0, f32::max);
        let high_first: f32 = bands.high[..80].iter().cloned().fold(0.0, f32::max);
        let high_last: f32 = bands.high[120..].iter().cloned().fold(0.0, f32::max);
        assert!(low_first > low_last);
        assert!(high_last > high_first);
    }

    #[test]
    fn bpm_matches_click_track() {
        for bpm in [100.0f32, 128.0, 174.0] {
            let sample_rate = 44100.0;
            let samples = click_track(bpm, 24.0, sample_rate);
            let result = analyze_mono(&samples, sample_rate, 400);
            assert!(
                (result.bpm - bpm).abs() <= 2.0,
                "expected {bpm}, got {} (confidence {})",
                result.bpm,
                result.confidence
            );
            assert!(result.beat_phase >= 0.0 && result.beat_phase < 60.0 / result.bpm);
        }
    }

    #[test]
    fn chroma_favours_played_pitch() {
        let sample_rate = 44100.0;
        let n = (sample_rate * 3.0) as usize;
        let samples: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sample_rate).sin() * 0.7)
            .collect();
        let result = chroma(&samples, sample_rate);
        let best = result
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap()
            .0;
        assert_eq!(best, 9, "A should dominate, got index {best}");
    }

    #[test]
    fn key_names_played_root() {
        let sample_rate = 44100.0;
        let n = (sample_rate * 4.0) as usize;
        let samples: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sample_rate).sin() * 0.7)
            .collect();
        let key = detect_key(&chroma(&samples, sample_rate));
        assert!(key.key.starts_with("A "), "expected A root, got {}", key.key);
        assert!(key.camelot.ends_with('A') || key.camelot.ends_with('B'));
    }
}

//! Faithful port of src/renderer/engine/analyze.ts + fft.ts.
//!
//! JavaScript does every arithmetic step in f64 and rounds to f32 only when a
//! value is stored into a Float32Array. This port keeps exactly that shape:
//! locals are f64, arrays are Vec<f32>, and every store is `as f32`. Loop
//! orders, comparisons and Math.round semantics follow the TS line by line, so
//! the output matches the TS output (see tests/equivalence.rs).

use std::f64::consts::PI;

pub struct Audio<'a> {
    pub sample_rate: f64,
    pub length: usize,
    pub channels: &'a [Vec<f32>],
}

#[derive(Debug, Clone)]
pub struct KeyResult {
    pub key: String,
    pub camelot: String,
    pub confidence: f64,
}

#[derive(Debug, Clone)]
pub struct AnalysisResult {
    pub bpm: f64,
    pub confidence: f64,
    pub beat_phase: f64,
    pub key: KeyResult,
    pub peaks: Vec<f32>,
    pub low: Vec<f32>,
    pub mid: Vec<f32>,
    pub high: Vec<f32>,
    pub duration: f64,
}

const PITCH_CLASSES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MAJOR_PROFILE: [f64; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE: [f64; 12] = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const CAMELOT_MAJOR: [&str; 12] = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const CAMELOT_MINOR: [&str; 12] = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];

/// JS Math.round: round half towards +infinity.
#[inline]
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

#[inline]
fn jmax(a: f64, b: f64) -> f64 {
    // Math.max for finite inputs.
    if a >= b { a } else { b }
}
#[inline]
fn jmin(a: f64, b: f64) -> f64 {
    if a <= b { a } else { b }
}

pub fn mono_mix<'a>(a: &Audio<'a>) -> std::borrow::Cow<'a, [f32]> {
    let n = a.channels.len();
    if n <= 1 {
        return std::borrow::Cow::Borrowed(&a.channels[0][..]);
    }
    let mut out = vec![0f32; a.length];
    for data in a.channels {
        for i in 0..data.len().min(a.length) {
            out[i] = (out[i] as f64 + data[i] as f64 / n as f64) as f32;
        }
    }
    std::borrow::Cow::Owned(out)
}

pub fn peaks(a: &Audio, buckets: usize) -> Vec<f32> {
    let mut out = vec![0f32; buckets];
    let length = a.length;
    let block = (length / buckets).max(1);
    let nch = a.channels.len() as f64;
    for i in 0..buckets {
        let start = i * block;
        let end = length.min(start + block);
        let mut max = 0f64;
        let mut s = start;
        while s < end {
            let mut sum = 0f64;
            for c in a.channels {
                sum += c[s] as f64;
            }
            let value = (sum / nch).abs();
            if value > max {
                max = value;
            }
            s += 2;
        }
        out[i] = max as f32;
    }
    out
}

pub fn band_peaks(a: &Audio, buckets: usize) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let mut low = vec![0f32; buckets];
    let mut mid = vec![0f32; buckets];
    let mut high = vec![0f32; buckets];
    let length = a.length;
    let block = (length / buckets).max(1);
    let nch = a.channels.len() as f64;
    let sr = a.sample_rate;
    let a_low = 1.0 - ((-2.0 * PI * 180.0) / sr).exp();
    let a_mid = 1.0 - ((-2.0 * PI * 2600.0) / sr).exp();
    let (mut lp_low, mut lp_mid) = (0f64, 0f64);
    let (mut peak_low, mut peak_mid, mut peak_high) = (1e-9f64, 1e-9f64, 1e-9f64);
    for i in 0..buckets {
        let start = i * block;
        let end = length.min(start + block);
        let (mut e_low, mut e_mid, mut e_high) = (0f64, 0f64, 0f64);
        let mut count = 0usize;
        let mut s = start;
        while s < end {
            let mut mix = 0f64;
            for c in a.channels {
                mix += c[s] as f64;
            }
            mix /= nch;
            lp_low += a_low * (mix - lp_low);
            lp_mid += a_mid * (mix - lp_mid);
            let bl = lp_low;
            let bm = lp_mid - lp_low;
            let bh = mix - lp_mid;
            e_low += bl * bl;
            e_mid += bm * bm;
            e_high += bh * bh;
            count += 1;
            s += 2;
        }
        let n = count.max(1) as f64;
        low[i] = (e_low / n).sqrt() as f32;
        mid[i] = (e_mid / n).sqrt() as f32;
        high[i] = (e_high / n).sqrt() as f32;
        if low[i] as f64 > peak_low {
            peak_low = low[i] as f64;
        }
        if mid[i] as f64 > peak_mid {
            peak_mid = mid[i] as f64;
        }
        if high[i] as f64 > peak_high {
            peak_high = high[i] as f64;
        }
    }
    for i in 0..buckets {
        low[i] = jmin(1.0, low[i] as f64 / peak_low) as f32;
        mid[i] = jmin(1.0, mid[i] as f64 / peak_mid) as f32;
        high[i] = jmin(1.0, high[i] as f64 / peak_high) as f32;
    }
    for band in [&mut low, &mut mid, &mut high] {
        if buckets == 0 {
            continue;
        }
        let mut prev = band[0] as f64;
        let mut i = 1;
        while i + 1 < buckets {
            let next = band[i] as f64;
            band[i] = jmin(1.0, prev * 0.25 + next * 0.5 + band[i + 1] as f64 * 0.25) as f32;
            prev = next;
            i += 1;
        }
    }
    (low, mid, high)
}

pub fn mono_envelope(a: &Audio, window: usize) -> Vec<f32> {
    let data = mono_mix(a);
    let frames = data.len() / window;
    let mut env = vec![0f32; frames];
    for i in 0..frames {
        let start = i * window;
        let mut sum = 0f64;
        for s in start..start + window {
            let v = data[s] as f64;
            sum += v * v;
        }
        env[i] = (sum / window as f64).sqrt() as f32;
    }
    env
}

pub fn onset_envelope(a: &Audio, window: usize) -> (Vec<f32>, f64) {
    let env = mono_envelope(a, window);
    let mut flux = vec![0f32; env.len()];
    for i in 1..env.len() {
        let rising = env[i] as f64 - env[i - 1] as f64;
        flux[i] = if rising > 0.0 { rising as f32 } else { 0.0 };
    }
    let mut mean = 0f64;
    for v in &flux {
        mean += *v as f64;
    }
    mean /= (flux.len().max(1)) as f64;
    let mut peak = 0f64;
    for v in flux.iter_mut() {
        *v = jmax(0.0, *v as f64 - mean * 1.5) as f32;
        if *v as f64 > peak {
            peak = *v as f64;
        }
    }
    if peak > 0.0 {
        for v in flux.iter_mut() {
            *v = (*v as f64 / peak) as f32;
        }
    }
    (flux, a.sample_rate / window as f64)
}

#[inline]
fn flux_at(flux: &[f32], idx: i64) -> f64 {
    if idx < 0 || idx as usize >= flux.len() { 0.0 } else { flux[idx as usize] as f64 }
}

pub fn detect_bpm(a: &Audio) -> (f64, f64, f64) {
    let (min_bpm, max_bpm) = (70.0f64, 190.0f64);
    let (flux, frame_rate) = onset_envelope(a, 512);
    let mut peak = 0f64;
    for v in &flux {
        if *v as f64 > peak {
            peak = *v as f64;
        }
    }
    if peak <= 1e-6 || (flux.len() as f64) < frame_rate * 4.0 {
        return (0.0, 0.0, 0.0);
    }
    let min_lag = jmax(2.0, ((60.0 / max_bpm) * frame_rate).floor()) as i64;
    let max_lag = jmin(flux.len() as f64 - 2.0, ((60.0 / min_bpm) * frame_rate).ceil()) as i64;
    if max_lag <= min_lag {
        return (0.0, 0.0, 0.0);
    }
    let ac_len = (max_lag * 3 + 2) as usize;
    let mut ac = vec![0f32; ac_len];
    let n = flux.len();
    for lag in min_lag as usize..ac_len {
        let mut sum = 0f64;
        let mut norm = 0f64;
        for i in lag..n {
            let x = flux[i] as f64;
            let y = flux[i - lag] as f64;
            sum += x * y;
            norm += y * y;
        }
        let d = if norm == 0.0 { 1.0 } else { norm };
        ac[lag] = (sum / d.sqrt()) as f32;
    }
    let mut scores = vec![0f32; (max_lag + 2) as usize];
    for lag in min_lag..=max_lag {
        let mut sum = ac[lag as usize] as f64;
        let mut weight = 1f64;
        for multiple in 2..=3i64 {
            let at = lag * multiple;
            if at as usize >= ac_len {
                break;
            }
            sum += ac[at as usize] as f64 * 0.5;
            weight += 0.5;
        }
        scores[lag as usize] = (sum / weight) as f32;
    }
    let mut best_lag = min_lag;
    let mut best_score = f64::NEG_INFINITY;
    let mut total = 0f64;
    for lag in min_lag..=max_lag {
        let s = scores[lag as usize] as f64;
        total += s;
        if s > best_score {
            best_score = s;
            best_lag = lag;
        }
    }
    let mean = total / (max_lag - min_lag + 1) as f64;
    let confidence = if best_score > 0.0 {
        jmax(0.0, jmin(1.0, (best_score - mean) / (best_score + mean + 1e-9)))
    } else {
        0.0
    };
    let mut refined = best_lag as f64;
    if best_lag > min_lag && best_lag < max_lag {
        let a1 = scores[(best_lag - 1) as usize] as f64;
        let b1 = scores[best_lag as usize] as f64;
        let c1 = scores[(best_lag + 1) as usize] as f64;
        let denom = a1 - 2.0 * b1 + c1;
        if denom.abs() > 1e-9 {
            refined = best_lag as f64 + (0.5 * (a1 - c1)) / denom;
        }
    }
    let mut bpm = (60.0 * frame_rate) / refined;
    while bpm < min_bpm * 1.25 {
        bpm *= 2.0;
    }
    while bpm > max_bpm {
        bpm /= 2.0;
    }
    bpm = refine_tempo(&flux, frame_rate, bpm, min_bpm, max_bpm);
    (bpm, confidence, detect_beat_phase(&flux, frame_rate, bpm))
}

pub fn refine_tempo(flux: &[f32], frame_rate: f64, guess: f64, min_bpm: f64, max_bpm: f64) -> f64 {
    let mut best_bpm = guess;
    let mut best_score = f64::NEG_INFINITY;
    let low = jmax(min_bpm, guess * 0.97);
    let high = jmin(max_bpm, guess * 1.03);
    let len = flux.len() as f64;
    let mut candidate = low;
    while candidate <= high {
        let fpb = (60.0 / candidate) * frame_rate;
        let phases = jmax(1.0, (fpb / 0.5).floor()) as i64;
        for pi in 0..phases {
            let phase = (pi as f64 / phases as f64) * fpb;
            let mut sum = 0f64;
            let mut count = 0i64;
            let mut beat = 0i64;
            loop {
                let frame = js_round(phase + beat as f64 * fpb);
                if frame >= len {
                    break;
                }
                let f = frame as i64;
                let mut local = 0f64;
                for d in -1..=1i64 {
                    local = jmax(local, flux_at(flux, f + d));
                }
                sum += local;
                count += 1;
                beat += 1;
            }
            if count > 2 {
                let score = sum / count as f64;
                if score > best_score {
                    best_score = score;
                    best_bpm = candidate;
                }
            }
        }
        candidate += 0.05;
    }
    js_round(best_bpm * 10.0) / 10.0
}

pub fn detect_beat_phase(flux: &[f32], frame_rate: f64, bpm: f64) -> f64 {
    if bpm <= 0.0 {
        return 0.0;
    }
    let fpb = (60.0 / bpm) * frame_rate;
    if fpb < 2.0 {
        return 0.0;
    }
    let candidates = jmax(1.0, fpb.floor()) as i64;
    let len = flux.len() as f64;
    let mut best_offset = 0i64;
    let mut best_energy = -1f64;
    for offset in 0..candidates {
        let mut energy = 0f64;
        let mut beat = 0i64;
        loop {
            let frame = js_round(offset as f64 + beat as f64 * fpb);
            if frame >= len {
                break;
            }
            let f = frame as i64;
            let mut local = 0f64;
            for d in -1..=1i64 {
                local = jmax(local, flux_at(flux, f + d));
            }
            energy += local;
            beat += 1;
        }
        if energy > best_energy {
            best_energy = energy;
            best_offset = offset;
        }
    }
    (best_offset as f64 / frame_rate) % (60.0 / bpm)
}

pub fn hann_window(size: usize) -> Vec<f32> {
    (0..size).map(|i| (0.5 - 0.5 * ((2.0 * PI * i as f64) / (size as f64 - 1.0)).cos()) as f32).collect()
}

/// fft.ts fftMagnitudes, with the same Float32Array rounding on every store.
pub fn fft_magnitudes(input: &[f32], size: usize, re: &mut Vec<f32>, im: &mut Vec<f32>) -> Vec<f32> {
    re.clear();
    re.resize(size, 0.0);
    im.clear();
    im.resize(size, 0.0);
    let copy = size.min(input.len());
    re[..copy].copy_from_slice(&input[..copy]);
    let mut j = 0usize;
    for i in 1..size {
        let mut bit = size >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= size {
        let angle = (-2.0 * PI) / len as f64;
        let w_re = angle.cos();
        let w_im = angle.sin();
        let half = len / 2;
        let mut i = 0;
        while i < size {
            let mut cur_re = 1f64;
            let mut cur_im = 0f64;
            for k in 0..half {
                let a = i + k;
                let b = a + half;
                let rb = re[b] as f64;
                let ib = im[b] as f64;
                let b_re = rb * cur_re - ib * cur_im;
                let b_im = rb * cur_im + ib * cur_re;
                re[b] = (re[a] as f64 - b_re) as f32;
                im[b] = (im[a] as f64 - b_im) as f32;
                re[a] = (re[a] as f64 + b_re) as f32;
                im[a] = (im[a] as f64 + b_im) as f32;
                let next_re = cur_re * w_re - cur_im * w_im;
                cur_im = cur_re * w_im + cur_im * w_re;
                cur_re = next_re;
            }
            i += len;
        }
        len <<= 1;
    }
    (0..size / 2).map(|i| (re[i] as f64).hypot(im[i] as f64) as f32).collect()
}

pub fn detect_key(a: &Audio) -> KeyResult {
    let size = 4096usize;
    let hop = 2048usize;
    let window = hann_window(size);
    let mut chroma = [0f32; 12];
    let mono = mono_mix(a);
    let frames_f = ((mono.len() as f64 - size as f64) / hop as f64).floor();
    let max_frames = jmin(900.0, jmax(1.0, frames_f)) as usize;
    let step = jmax(1.0, (max_frames as f64 / 240.0).floor()) as usize;
    let bin_hz = a.sample_rate / size as f64;
    let mut slice = vec![0f32; size];
    let (mut re, mut im) = (Vec::new(), Vec::new());
    let mut frame = 0usize;
    while frame < max_frames {
        let start = frame * hop;
        if start + size > mono.len() {
            break;
        }
        for i in 0..size {
            slice[i] = (mono[start + i] as f64 * window[i] as f64) as f32;
        }
        let mags = fft_magnitudes(&slice, size, &mut re, &mut im);
        let mut frame_max = 0f64;
        for m in &mags {
            if *m as f64 > frame_max {
                frame_max = *m as f64;
            }
        }
        if frame_max > 1e-4 {
            for bin in 3..mags.len() - 1 {
                let hz = bin as f64 * bin_hz;
                if !(55.0..=5000.0).contains(&hz) {
                    continue;
                }
                let m = mags[bin] as f64;
                if m < frame_max * 1e-3 {
                    continue;
                }
                if m < mags[bin - 1] as f64 || m < mags[bin + 1] as f64 {
                    continue;
                }
                let midi = 69.0 + 12.0 * (hz / 440.0).log2();
                let pc = ((js_round(midi) as i64 % 12) + 12) % 12;
                let ow = 1.0 / (1.0 + (hz - 440.0).abs() / 2000.0);
                chroma[pc as usize] = (chroma[pc as usize] as f64 + m * ow) as f32;
            }
        }
        frame += step;
    }
    let mut sum = 0f64;
    for c in &chroma {
        sum += *c as f64;
    }
    if sum <= 1e-6 {
        return KeyResult { key: "--".into(), camelot: "--".into(), confidence: 0.0 };
    }
    for c in chroma.iter_mut() {
        *c = (*c as f64 / sum) as f32;
    }
    let (mut best_root, mut best_major, mut best_score) = (0usize, true, f64::NEG_INFINITY);
    let mut second = f64::NEG_INFINITY;
    for root in 0..12 {
        for major in [true, false] {
            let profile = if major { &MAJOR_PROFILE } else { &MINOR_PROFILE };
            let mut dot = 0f64;
            for i in 0..12 {
                dot += chroma[(root + i) % 12] as f64 * profile[i];
            }
            if dot > best_score {
                second = best_score;
                best_root = root;
                best_major = major;
                best_score = dot;
            } else if dot > second {
                second = dot;
            }
        }
    }
    let confidence = if best_score > 0.0 { jmax(0.0, jmin(1.0, (best_score - second) / best_score)) } else { 0.0 };
    KeyResult {
        key: format!("{} {}", PITCH_CLASSES[best_root], if best_major { "maj" } else { "min" }),
        camelot: (if best_major { CAMELOT_MAJOR[best_root] } else { CAMELOT_MINOR[best_root] }).to_string(),
        confidence,
    }
}

/// analyzeBuffer(). The four independent passes run on separate cores
/// (rayon::join); each pass is the sequential TS algorithm, so results are
/// identical to running them one after another.
pub fn analyze(a: &Audio, buckets: usize) -> AnalysisResult {
    let ((bpm, key), (pk, bands)) = rayon::join(
        || rayon::join(|| detect_bpm(a), || detect_key(a)),
        || rayon::join(|| peaks(a, buckets), || band_peaks(a, buckets)),
    );
    AnalysisResult {
        bpm: bpm.0,
        confidence: bpm.1,
        beat_phase: bpm.2,
        key,
        peaks: pk,
        low: bands.0,
        mid: bands.1,
        high: bands.2,
        duration: a.length as f64 / a.sample_rate,
    }
}

//! Test signals and measurements: pitch (FFT peak + parabolic interpolation), residual
//! (THD+N-style) and click detection (second-difference spikes on a sine).

use std::f64::consts::PI;

pub fn sine_stereo(freq: f64, sr: f64, seconds: f64, amp: f32) -> Vec<f32> {
    let n = (sr * seconds) as usize;
    let mut v = Vec::with_capacity(n * 2);
    for i in 0..n {
        let s = (2.0 * PI * freq * i as f64 / sr).sin() as f32 * amp;
        v.push(s);
        v.push(s);
    }
    v
}

fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * PI / len as f64;
        for s in (0..n).step_by(len) {
            for k in 0..len / 2 {
                let (wr, wi) = ((ang * k as f64).cos(), (ang * k as f64).sin());
                let (ar, ai) = (re[s + k + len / 2], im[s + k + len / 2]);
                let (tr, ti) = (ar * wr - ai * wi, ar * wi + ai * wr);
                re[s + k + len / 2] = re[s + k] - tr;
                im[s + k + len / 2] = im[s + k] - ti;
                re[s + k] += tr;
                im[s + k] += ti;
            }
        }
        len <<= 1;
    }
}

/// Dominant frequency of a mono signal (Hann window, 2^k samples, parabolic peak).
pub fn peak_freq(mono: &[f32], sr: f64) -> f64 {
    let mut n = 1;
    while n * 2 <= mono.len() && n < (1 << 17) {
        n *= 2;
    }
    let mut re: Vec<f64> = (0..n).map(|i| mono[i] as f64 * (0.5 - 0.5 * (2.0 * PI * i as f64 / n as f64).cos())).collect();
    let mut im = vec![0.0; n];
    fft(&mut re, &mut im);
    let mag: Vec<f64> = (0..n / 2).map(|i| (re[i] * re[i] + im[i] * im[i]).sqrt().max(1e-30).ln()).collect();
    let k = (2..n / 2 - 1).max_by(|&a, &b| mag[a].partial_cmp(&mag[b]).unwrap()).unwrap();
    let (a, b, c) = (mag[k - 1], mag[k], mag[k + 1]);
    let p = 0.5 * (a - c) / (a - 2.0 * b + c);
    (k as f64 + p) * sr / n as f64
}

pub fn cents(measured: f64, expected: f64) -> f64 {
    1200.0 * (measured / expected).log2()
}

/// Residual after removing the best-fit sine at `freq` (least squares), in dB re signal.
pub fn residual_db(mono: &[f32], freq: f64, sr: f64) -> f64 {
    let (mut ss, mut cc, mut sc, mut ys, mut yc) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for (i, &y) in mono.iter().enumerate() {
        let ph = 2.0 * PI * freq * i as f64 / sr;
        let (s, c) = ph.sin_cos();
        ss += s * s;
        cc += c * c;
        sc += s * c;
        ys += y as f64 * s;
        yc += y as f64 * c;
    }
    let det = ss * cc - sc * sc;
    let a = (ys * cc - yc * sc) / det;
    let b = (yc * ss - ys * sc) / det;
    let (mut e, mut p) = (0.0, 0.0);
    for (i, &y) in mono.iter().enumerate() {
        let ph = 2.0 * PI * freq * i as f64 / sr;
        let fit = a * ph.sin() + b * ph.cos();
        e += (y as f64 - fit).powi(2);
        p += (y as f64).powi(2);
    }
    10.0 * (e / p.max(1e-30)).log10()
}

/// Clicks in a sine played at a time-varying rate: samples whose second difference exceeds
/// what a sine of amplitude `amp` at frequency `freq * max_rate` can produce (x `slack`).
/// Returns (click count, worst ratio over the bound).
pub fn clicks(mono: &[f32], amp: f64, freq: f64, max_rate: f64, sr: f64, slack: f64) -> (usize, f64) {
    let w = 2.0 * PI * freq * max_rate.max(0.05) / sr;
    let bound = amp * w * w * slack + 1e-4;
    let mut count = 0;
    let mut worst: f64 = 0.0;
    let mut last_click = usize::MAX - 1000;
    for i in 2..mono.len() {
        let d2 = (mono[i] as f64 - 2.0 * mono[i - 1] as f64 + mono[i - 2] as f64).abs();
        worst = worst.max(d2 / bound);
        if d2 > bound && i.wrapping_sub(last_click) > 64 {
            count += 1;
            last_click = i;
        }
    }
    (count, worst)
}

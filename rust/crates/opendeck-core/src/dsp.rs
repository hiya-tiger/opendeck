pub fn hann(size: usize) -> Vec<f32> {
    (0..size)
        .map(|i| 0.5 - 0.5 * ((2.0 * std::f32::consts::PI * i as f32) / size as f32).cos())
        .collect()
}

pub fn fft_in_place(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    if n <= 1 {
        return;
    }
    debug_assert!(n.is_power_of_two(), "fft length must be a power of two");

    let mut j = 0usize;
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

    let mut len = 2usize;
    while len <= n {
        let angle = -2.0 * std::f32::consts::PI / len as f32;
        let (wr, wi) = (angle.cos(), angle.sin());
        let mut i = 0usize;
        while i < n {
            let mut cur_r = 1.0f32;
            let mut cur_i = 0.0f32;
            for k in 0..len / 2 {
                let ur = re[i + k];
                let ui = im[i + k];
                let vr = re[i + k + len / 2] * cur_r - im[i + k + len / 2] * cur_i;
                let vi = re[i + k + len / 2] * cur_i + im[i + k + len / 2] * cur_r;
                re[i + k] = ur + vr;
                im[i + k] = ui + vi;
                re[i + k + len / 2] = ur - vr;
                im[i + k + len / 2] = ui - vi;
                let next_r = cur_r * wr - cur_i * wi;
                cur_i = cur_r * wi + cur_i * wr;
                cur_r = next_r;
            }
            i += len;
        }
        len <<= 1;
    }
}

pub fn magnitudes(frame: &[f32], window: &[f32]) -> Vec<f32> {
    let n = frame.len().min(window.len());
    let mut re: Vec<f32> = (0..n).map(|i| frame[i] * window[i]).collect();
    let mut im = vec![0.0f32; n];
    fft_in_place(&mut re, &mut im);
    let half = n / 2;
    (0..half).map(|i| (re[i] * re[i] + im[i] * im[i]).sqrt()).collect()
}

pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
}

export function fftMagnitudes(input: Float32Array, size: number): Float32Array {
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const copy = Math.min(size, input.length);
  for (let i = 0; i < copy; i += 1) re[i] = input[i];

  for (let i = 1, j = 0; i < size; i += 1) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= size; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < size; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const a = i + k;
        const b = a + len / 2;
        const bRe = re[b] * curRe - im[b] * curIm;
        const bIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - bRe;
        im[b] = im[a] - bIm;
        re[a] += bRe;
        im[a] += bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  const out = new Float32Array(size / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Math.hypot(re[i], im[i]);
  return out;
}

export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
}

import { fftMagnitudes, hannWindow } from "./fft.ts";

export interface AudioLike {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  readonly duration?: number;
  getChannelData(channel: number): Float32Array;
}

export interface BpmResult {
  bpm: number;
  confidence: number;
  beatPhase: number;
}

export interface KeyResult {
  key: string;
  camelot: string;
  mode: "major" | "minor";
  confidence: number;
}

export interface BandPeaks {
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
}

export interface AnalysisResult extends BpmResult {
  key: KeyResult;
  peaks: Float32Array;
  bands: BandPeaks;
  duration: number;
}

const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];
const CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];

export function monoMix(buffer: AudioLike): Float32Array {
  const channels = buffer.numberOfChannels;
  if (channels <= 1) return buffer.getChannelData(0);
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < channels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i += 1) out[i] += data[i] / channels;
  }
  return out;
}

export function peaks(buffer: AudioLike, buckets: number): Float32Array {
  const out = new Float32Array(buckets);
  const length = buffer.length;
  const block = Math.max(1, Math.floor(length / buckets));
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));
  for (let i = 0; i < buckets; i += 1) {
    const start = i * block;
    const end = Math.min(length, start + block);
    let max = 0;
    for (let s = start; s < end; s += 2) {
      let sum = 0;
      for (let c = 0; c < channels.length; c += 1) sum += channels[c][s];
      const value = Math.abs(sum / channels.length);
      if (value > max) max = value;
    }
    out[i] = max;
  }
  return out;
}

export function bandPeaks(buffer: AudioLike, buckets: number): BandPeaks {
  const low = new Float32Array(buckets);
  const mid = new Float32Array(buckets);
  const high = new Float32Array(buckets);
  const length = buffer.length;
  const block = Math.max(1, Math.floor(length / buckets));
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));
  const sr = buffer.sampleRate;
  const aLow = 1 - Math.exp((-2 * Math.PI * 180) / sr);
  const aMid = 1 - Math.exp((-2 * Math.PI * 2600) / sr);
  let lpLow = 0;
  let lpMid = 0;
  let peakLow = 1e-9;
  let peakMid = 1e-9;
  let peakHigh = 1e-9;

  for (let i = 0; i < buckets; i += 1) {
    const start = i * block;
    const end = Math.min(length, start + block);
    let eLow = 0;
    let eMid = 0;
    let eHigh = 0;
    let count = 0;
    for (let s = start; s < end; s += 2) {
      let mix = 0;
      for (let c = 0; c < channels.length; c += 1) mix += channels[c][s];
      mix /= channels.length;
      lpLow += aLow * (mix - lpLow);
      lpMid += aMid * (mix - lpMid);
      const bandLow = lpLow;
      const bandMid = lpMid - lpLow;
      const bandHigh = mix - lpMid;
      eLow += bandLow * bandLow;
      eMid += bandMid * bandMid;
      eHigh += bandHigh * bandHigh;
      count += 1;
    }
    const n = Math.max(1, count);
    low[i] = Math.sqrt(eLow / n);
    mid[i] = Math.sqrt(eMid / n);
    high[i] = Math.sqrt(eHigh / n);
    if (low[i] > peakLow) peakLow = low[i];
    if (mid[i] > peakMid) peakMid = mid[i];
    if (high[i] > peakHigh) peakHigh = high[i];
  }

  for (let i = 0; i < buckets; i += 1) {
    low[i] = Math.min(1, low[i] / peakLow);
    mid[i] = Math.min(1, mid[i] / peakMid);
    high[i] = Math.min(1, high[i] / peakHigh);
  }
  for (const band of [low, mid, high]) {
    let prev = band[0];
    for (let i = 1; i < buckets - 1; i += 1) {
      const next = band[i];
      band[i] = Math.min(1, prev * 0.25 + next * 0.5 + band[i + 1] * 0.25);
      prev = next;
    }
  }
  return { low, mid, high };
}

export function monoEnvelope(buffer: AudioLike, windowSize = 512): Float32Array {
  const data = monoMix(buffer);
  const frames = Math.floor(data.length / windowSize);
  const env = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const start = i * windowSize;
    let sum = 0;
    for (let s = start; s < start + windowSize; s += 1) {
      const value = data[s];
      sum += value * value;
    }
    env[i] = Math.sqrt(sum / windowSize);
  }
  return env;
}

export function onsetEnvelope(buffer: AudioLike, windowSize = 512): { flux: Float32Array; frameRate: number } {
  const env = monoEnvelope(buffer, windowSize);
  const flux = new Float32Array(env.length);
  for (let i = 1; i < env.length; i += 1) {
    const rising = env[i] - env[i - 1];
    flux[i] = rising > 0 ? rising : 0;
  }
  let mean = 0;
  for (let i = 0; i < flux.length; i += 1) mean += flux[i];
  mean /= Math.max(1, flux.length);
  let peak = 0;
  for (let i = 0; i < flux.length; i += 1) {
    flux[i] = Math.max(0, flux[i] - mean * 1.5);
    if (flux[i] > peak) peak = flux[i];
  }
  if (peak > 0) for (let i = 0; i < flux.length; i += 1) flux[i] /= peak;
  return { flux, frameRate: buffer.sampleRate / windowSize };
}

interface BpmOptions {
  minBpm?: number;
  maxBpm?: number;
  windowSize?: number;
}

export function detectBpm(buffer: AudioLike, options: BpmOptions = {}): BpmResult {
  const minBpm = options.minBpm ?? 70;
  const maxBpm = options.maxBpm ?? 190;
  const { flux, frameRate } = onsetEnvelope(buffer, options.windowSize ?? 512);

  let peak = 0;
  for (let i = 0; i < flux.length; i += 1) if (flux[i] > peak) peak = flux[i];
  if (peak <= 1e-6 || flux.length < frameRate * 4) return { bpm: 0, confidence: 0, beatPhase: 0 };

  const minLag = Math.max(2, Math.floor((60 / maxBpm) * frameRate));
  const maxLag = Math.min(flux.length - 2, Math.ceil((60 / minBpm) * frameRate));
  if (maxLag <= minLag) return { bpm: 0, confidence: 0, beatPhase: 0 };

  const ac = new Float32Array(maxLag * 3 + 2);
  for (let lag = minLag; lag < ac.length; lag += 1) {
    let sum = 0;
    let norm = 0;
    for (let i = lag; i < flux.length; i += 1) {
      sum += flux[i] * flux[i - lag];
      norm += flux[i - lag] * flux[i - lag];
    }
    ac[lag] = sum / Math.sqrt(norm || 1);
  }

  const scores = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = ac[lag];
    let weight = 1;
    for (let multiple = 2; multiple <= 3; multiple += 1) {
      const at = lag * multiple;
      if (at >= ac.length) break;
      sum += ac[at] * 0.5;
      weight += 0.5;
    }
    scores[lag] = sum / weight;
  }

  let bestLag = minLag;
  let bestScore = -Infinity;
  let total = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    total += scores[lag];
    if (scores[lag] > bestScore) {
      bestScore = scores[lag];
      bestLag = lag;
    }
  }
  const mean = total / (maxLag - minLag + 1);
  const confidence = bestScore > 0 ? Math.max(0, Math.min(1, (bestScore - mean) / (bestScore + mean + 1e-9))) : 0;

  let refined = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = scores[bestLag - 1];
    const b = scores[bestLag];
    const c = scores[bestLag + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-9) refined = bestLag + (0.5 * (a - c)) / denom;
  }

  let bpm = (60 * frameRate) / refined;
  while (bpm < minBpm * 1.25) bpm *= 2;
  while (bpm > maxBpm) bpm /= 2;
  bpm = refineTempo(flux, frameRate, bpm, minBpm, maxBpm);
  return { bpm, confidence, beatPhase: detectBeatPhase(flux, frameRate, bpm) };
}

export function refineTempo(
  flux: Float32Array,
  frameRate: number,
  guess: number,
  minBpm = 70,
  maxBpm = 190,
): number {
  let bestBpm = guess;
  let bestScore = -Infinity;
  const low = Math.max(minBpm, guess * 0.97);
  const high = Math.min(maxBpm, guess * 1.03);
  for (let candidate = low; candidate <= high; candidate += 0.05) {
    const framesPerBeat = (60 / candidate) * frameRate;
    const phases = Math.max(1, Math.floor(framesPerBeat / 0.5));
    for (let phaseIndex = 0; phaseIndex < phases; phaseIndex += 1) {
      const phase = (phaseIndex / phases) * framesPerBeat;
      let sum = 0;
      let count = 0;
      for (let beat = 0; ; beat += 1) {
        const frame = Math.round(phase + beat * framesPerBeat);
        if (frame >= flux.length) break;
        let local = 0;
        for (let d = -1; d <= 1; d += 1) local = Math.max(local, flux[frame + d] || 0);
        sum += local;
        count += 1;
      }
      if (count > 2) {
        const score = sum / count;
        if (score > bestScore) {
          bestScore = score;
          bestBpm = candidate;
        }
      }
    }
  }
  return Math.round(bestBpm * 10) / 10;
}

export function detectBeatPhase(flux: Float32Array, frameRate: number, bpm: number): number {
  if (bpm <= 0) return 0;
  const framesPerBeat = (60 / bpm) * frameRate;
  if (framesPerBeat < 2) return 0;
  const candidates = Math.max(1, Math.floor(framesPerBeat));
  let bestOffset = 0;
  let bestEnergy = -1;
  for (let offset = 0; offset < candidates; offset += 1) {
    let energy = 0;
    for (let beat = 0; ; beat += 1) {
      const frame = Math.round(offset + beat * framesPerBeat);
      if (frame >= flux.length) break;
      let local = 0;
      for (let d = -1; d <= 1; d += 1) local = Math.max(local, flux[frame + d] || 0);
      energy += local;
    }
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestOffset = offset;
    }
  }
  return (bestOffset / frameRate) % (60 / bpm);
}

export function detectKey(buffer: AudioLike): KeyResult {
  const size = 4096;
  const hop = 2048;
  const window = hannWindow(size);
  const chroma = new Float32Array(12);
  const mono = monoMix(buffer);
  const maxFrames = Math.min(900, Math.max(1, Math.floor((mono.length - size) / hop)));
  const step = Math.max(1, Math.floor(maxFrames / 240));
  const binHz = buffer.sampleRate / size;

  for (let frame = 0; frame < maxFrames; frame += step) {
    const start = frame * hop;
    if (start + size > mono.length) break;
    const slice = new Float32Array(size);
    for (let i = 0; i < size; i += 1) slice[i] = mono[start + i] * window[i];
    const mags = fftMagnitudes(slice, size);
    let frameMax = 0;
    for (let bin = 0; bin < mags.length; bin += 1) if (mags[bin] > frameMax) frameMax = mags[bin];
    if (frameMax <= 1e-4) continue;
    for (let bin = 3; bin < mags.length - 1; bin += 1) {
      const hz = bin * binHz;
      if (hz < 55 || hz > 5000) continue;
      if (mags[bin] < frameMax * 1e-3) continue;
      if (mags[bin] < mags[bin - 1] || mags[bin] < mags[bin + 1]) continue;
      const midi = 69 + 12 * Math.log2(hz / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      const octaveWeight = 1 / (1 + Math.abs(hz - 440) / 2000);
      chroma[pc] += mags[bin] * octaveWeight;
    }
  }

  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += chroma[i];
  if (sum <= 1e-6) return { key: "--", camelot: "--", mode: "major", confidence: 0 };
  for (let i = 0; i < 12; i += 1) chroma[i] /= sum;

  let best = { root: 0, mode: "major" as "major" | "minor", score: -Infinity };
  let second = -Infinity;
  for (let root = 0; root < 12; root += 1) {
    for (const mode of ["major", "minor"] as const) {
      const profile = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
      let dot = 0;
      for (let i = 0; i < 12; i += 1) dot += chroma[(root + i) % 12] * profile[i];
      if (dot > best.score) {
        second = best.score;
        best = { root, mode, score: dot };
      } else if (dot > second) {
        second = dot;
      }
    }
  }
  const confidence = best.score > 0 ? Math.max(0, Math.min(1, (best.score - second) / best.score)) : 0;
  const camelot = best.mode === "major" ? CAMELOT_MAJOR[best.root] : CAMELOT_MINOR[best.root];
  return {
    key: `${PITCH_CLASSES[best.root]} ${best.mode === "major" ? "maj" : "min"}`,
    camelot,
    mode: best.mode,
    confidence,
  };
}

export function analyzeBuffer(buffer: AudioLike, bucketCount = 2000): AnalysisResult {
  const bpm = detectBpm(buffer);
  const key = detectKey(buffer);
  return {
    ...bpm,
    key,
    peaks: peaks(buffer, bucketCount),
    bands: bandPeaks(buffer, bucketCount),
    duration: buffer.duration ?? buffer.length / buffer.sampleRate,
  };
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((part) => String(part).padStart(2, "0")).join(":");
}

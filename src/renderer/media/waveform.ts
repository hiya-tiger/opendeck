import type { BandPeaks } from "../engine/analyze.ts";

export interface LoopRegion {
  start: number;
  end: number;
}

export interface WaveMarker {
  time: number;
  color: string;
  label?: string;
}

interface Fit {
  w: number;
  h: number;
  dpr: number;
}

function fit(canvas: HTMLCanvasElement): Fit {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr };
}

const BG = "#0b111c";
const CUE = "#f0a726";

const LOW_RGB: [number, number, number] = [255, 92, 64];
const MID_RGB: [number, number, number] = [64, 214, 128];
const HIGH_RGB: [number, number, number] = [88, 156, 255];

interface Column {
  color: string;
  dim: string;
}

class WaveColors {
  private cache: Column[] | null = null;
  private signature = "";

  build(peaks: Float32Array, bands?: BandPeaks): Column[] {
    const key = `${peaks.length}:${bands ? bands.low.length : 0}`;
    if (this.cache && this.signature === key) return this.cache;
    const out: Column[] = new Array(peaks.length);
    for (let i = 0; i < peaks.length; i += 1) {
      if (!bands) {
        out[i] = { color: "#4d6bfe", dim: "#2f3b52" };
        continue;
      }
      const low = bands.low[i] ?? 0;
      const mid = bands.mid[i] ?? 0;
      const high = bands.high[i] ?? 0;
      const total = low + mid + high || 1;
      const r = (LOW_RGB[0] * low + MID_RGB[0] * mid + HIGH_RGB[0] * high) / total;
      const g = (LOW_RGB[1] * low + MID_RGB[1] * mid + HIGH_RGB[1] * high) / total;
      const b = (LOW_RGB[2] * low + MID_RGB[2] * mid + HIGH_RGB[2] * high) / total;
      out[i] = {
        color: `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`,
        dim: `rgb(${Math.round(r * 0.32)}, ${Math.round(g * 0.32)}, ${Math.round(b * 0.32)})`,
      };
    }
    this.cache = out;
    this.signature = key;
    return out;
  }
}

function markerFlag(
  c: CanvasRenderingContext2D,
  x: number,
  h: number,
  color: string,
  width: number,
  full = false,
): void {
  c.fillStyle = color;
  if (full) {
    c.fillRect(x, 0, Math.max(1, width), h);
    return;
  }
  const size = Math.max(4, width * 3);
  c.beginPath();
  c.moveTo(x, 0);
  c.lineTo(x + size, 0);
  c.lineTo(x, size);
  c.closePath();
  c.fill();
  c.globalAlpha = 0.55;
  c.fillRect(x, 0, Math.max(1, width), h * 0.55);
  c.globalAlpha = 1;
}

function drawEmpty(c: CanvasRenderingContext2D, w: number, h: number, dpr: number, text: string): void {
  c.clearRect(0, 0, w, h);
  const gradient = c.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, "#0d1420");
  gradient.addColorStop(1, BG);
  c.fillStyle = gradient;
  c.fillRect(0, 0, w, h);
  c.strokeStyle = "rgba(120, 148, 255, 0.05)";
  c.lineWidth = 1;
  for (let x = 0; x < w; x += 24 * dpr) {
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x, h);
    c.stroke();
  }
  c.fillStyle = "#44516b";
  c.font = `${11 * dpr}px Inter, "Segoe UI", sans-serif`;
  c.textAlign = "center";
  c.fillText(text, w / 2, h / 2 + 4 * dpr);
}

function displayGain(peaks: Float32Array): number {
  let max = 0;
  for (let i = 0; i < peaks.length; i += 1) if (peaks[i] > max) max = peaks[i];
  if (max < 0.02) return 1;
  return Math.min(12, 1 / max);
}

function shaped(peak: number, gain: number): number {
  return Math.pow(Math.min(1, peak * gain), 0.82);
}

export class Waveform {
  peaks: Float32Array | null = null;
  bands: BandPeaks | null = null;
  gain = 1;
  duration = 0;
  progress = 0;
  cue = 0;
  loop: LoopRegion | null = null;
  hotCues: WaveMarker[] = [];
  private seekHandler: ((seconds: number) => void) | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly colors = new WaveColors();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    canvas.style.cursor = "pointer";
    canvas.addEventListener("pointerdown", (event) => {
      if (!this.peaks || !this.seekHandler) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      this.seekHandler(ratio * this.duration);
    });
  }

  onSeek(fn: (seconds: number) => void): void {
    this.seekHandler = fn;
  }

  setPeaks(peaks: Float32Array, duration: number, bands?: BandPeaks): void {
    this.peaks = peaks;
    this.bands = bands ?? null;
    this.gain = displayGain(peaks);
    this.duration = duration;
    this.draw();
  }

  setProgress(seconds: number): void {
    this.progress = seconds;
    this.draw();
  }

  setCue(seconds: number): void {
    this.cue = seconds;
    this.draw();
  }

  setLoop(loop: LoopRegion | null): void {
    this.loop = loop;
    this.draw();
  }

  setHotCues(cues: WaveMarker[]): void {
    this.hotCues = cues;
    this.draw();
  }

  clear(): void {
    this.peaks = null;
    this.bands = null;
    this.gain = 1;
    this.duration = 0;
    this.progress = 0;
    this.cue = 0;
    this.loop = null;
    this.hotCues = [];
    this.draw();
  }

  draw(): void {
    const { w, h, dpr } = fit(this.canvas);
    const c = this.ctx;
    if (!this.peaks || !this.duration) {
      drawEmpty(c, w, h, dpr, "Load a track to see its waveform");
      return;
    }

    const gradient = c.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, "#0d1522");
    gradient.addColorStop(0.5, BG);
    gradient.addColorStop(1, "#080c14");
    c.fillStyle = gradient;
    c.fillRect(0, 0, w, h);

    const mid = h / 2;
    const pxPerPeak = w / this.peaks.length;
    const barWidth = Math.max(1, pxPerPeak * 0.78);
    const playedX = (this.progress / this.duration) * w;
    const colors = this.colors.build(this.peaks, this.bands ?? undefined);

    if (this.loop) {
      const x1 = (this.loop.start / this.duration) * w;
      const x2 = (this.loop.end / this.duration) * w;
      c.fillStyle = "rgba(77, 107, 254, 0.16)";
      c.fillRect(x1, 0, Math.max(1, x2 - x1), h);
    }

    c.save();
    c.beginPath();
    c.rect(0, 0, playedX, h);
    c.clip();
    for (let i = 0; i < this.peaks.length; i += 1) {
      const amp = shaped(this.peaks[i], this.gain) * (h * 0.46);
      c.fillStyle = colors[i].color;
      c.fillRect(i * pxPerPeak, mid - amp, barWidth, amp * 2);
    }
    c.restore();

    c.save();
    c.beginPath();
    c.rect(playedX, 0, w - playedX, h);
    c.clip();
    for (let i = 0; i < this.peaks.length; i += 1) {
      const amp = shaped(this.peaks[i], this.gain) * (h * 0.46);
      c.fillStyle = colors[i].dim;
      c.fillRect(i * pxPerPeak, mid - amp, barWidth, amp * 2);
    }
    c.restore();

    c.strokeStyle = "rgba(255, 255, 255, 0.06)";
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0, mid);
    c.lineTo(w, mid);
    c.stroke();

    for (const cue of this.hotCues) {
      if (!cue.time) continue;
      const x = (cue.time / this.duration) * w;
      markerFlag(c, x, h, cue.color, dpr);
    }

    if (this.loop) {
      const x1 = (this.loop.start / this.duration) * w;
      const x2 = (this.loop.end / this.duration) * w;
      c.fillStyle = "rgba(120, 148, 255, 0.9)";
      c.fillRect(x1, 0, Math.max(1, dpr), h);
      c.fillRect(x2 - dpr, 0, Math.max(1, dpr), h);
      c.fillStyle = "rgba(120, 148, 255, 0.35)";
      c.fillRect(x1, 0, Math.max(1, x2 - x1), Math.max(1, 2 * dpr));
    }

    if (this.cue > 0) {
      const x = (this.cue / this.duration) * w;
      markerFlag(c, x, h, CUE, Math.max(1, 2 * dpr), true);
      c.fillStyle = CUE;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x + 7 * dpr, 0);
      c.lineTo(x, 7 * dpr);
      c.closePath();
      c.fill();
    }

    c.shadowColor = "rgba(255, 255, 255, 0.85)";
    c.shadowBlur = 7 * dpr;
    c.fillStyle = "#ffffff";
    c.fillRect(playedX - dpr, 0, Math.max(1, 2 * dpr), h);
    c.shadowBlur = 0;
  }
}

export class ZoomWaveform {
  peaks: Float32Array | null = null;
  bands: BandPeaks | null = null;
  gain = 1;
  duration = 0;
  progress = 0;
  bpm = 0;
  beatPhase = 0;
  loop: LoopRegion | null = null;
  hotCues: WaveMarker[] = [];
  vertical = false;
  private readonly span: number;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly colors = new WaveColors();

  constructor(canvas: HTMLCanvasElement, spanSeconds = 8) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.span = spanSeconds;
  }

  setPeaks(peaks: Float32Array, duration: number, bands?: BandPeaks): void {
    this.peaks = peaks;
    this.bands = bands ?? null;
    this.gain = displayGain(peaks);
    this.duration = duration;
  }

  setBpm(bpm: number, beatPhase = 0): void {
    this.bpm = bpm;
    this.beatPhase = beatPhase;
  }

  setLoop(loop: LoopRegion | null): void {
    this.loop = loop;
  }

  setHotCues(cues: WaveMarker[]): void {
    this.hotCues = cues;
  }

  setVertical(value: boolean): void {
    this.vertical = value;
  }

  update(progress: number): void {
    this.progress = progress;
    this.draw();
  }

  draw(): void {
    const { w, h, dpr } = fit(this.canvas);
    const c = this.ctx;
    if (!this.peaks || !this.duration) {
      drawEmpty(c, w, h, dpr, "beat grid");
      return;
    }

    const vertical = this.vertical;
    const len = vertical ? h : w;
    let cross = vertical ? w : h;
    let mid = cross / 2;

    const gradient = c.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, "#0d1522");
    gradient.addColorStop(0.5, BG);
    gradient.addColorStop(1, "#080c14");
    c.fillStyle = gradient;
    c.fillRect(0, 0, w, h);

    const column = vertical ? Math.min(w, 300 * dpr) : w;
    if (vertical && column < w) {
      c.save();
      c.translate((w - column) / 2, 0);
      cross = column;
      mid = column / 2;
    }

    const start = Math.max(0, this.progress - this.span / 2);
    const end = Math.min(this.duration, start + this.span);
    const i0 = Math.floor((start / this.duration) * this.peaks.length);
    const i1 = Math.ceil((end / this.duration) * this.peaks.length);
    const count = Math.max(1, i1 - i0);
    const barSize = Math.max(1, (len / count) * 0.72);
    const colors = this.colors.build(this.peaks, this.bands ?? undefined);

    if (this.bpm > 0) {
      const beat = 60 / this.bpm;
      const phase = this.beatPhase % beat;
      const first = Math.ceil((start - phase) / beat) * beat + phase;
      for (let t = first; t < end; t += beat) {
        const pos = ((t - start) / this.span) * len;
        const index = Math.round((t - phase) / beat);
        const isBar = index % 4 === 0;
        c.fillStyle = isBar ? "rgba(120, 148, 255, 0.4)" : "rgba(120, 148, 255, 0.14)";
        const lineW = isBar ? Math.max(1, 1.6 * dpr) : 1;
        if (vertical) c.fillRect(0, pos, cross, lineW);
        else c.fillRect(pos, 0, lineW, cross);
        if (isBar) {
          c.fillStyle = "rgba(160, 180, 255, 0.55)";
          if (vertical) c.fillRect(0, pos, 3 * dpr, Math.max(1, 3 * dpr));
          else c.fillRect(pos, cross - 3 * dpr, Math.max(1, 3 * dpr), 3 * dpr);
        }
      }
    }

    if (this.loop) {
      const p1 = ((this.loop.start - start) / this.span) * len;
      const p2 = ((this.loop.end - start) / this.span) * len;
      c.fillStyle = "rgba(77, 107, 254, 0.12)";
      if (vertical) c.fillRect(0, p1, cross, Math.max(1, p2 - p1));
      else c.fillRect(p1, 0, Math.max(1, p2 - p1), cross);
    }

    for (let i = i0; i < i1; i += 1) {
      const pos = ((i - i0) / count) * len;
      const amp = shaped(this.peaks[i] || 0, this.gain) * (cross * 0.44);
      const column = colors[i] ?? { color: "#4d6bfe", dim: "#2f3b52" };
      c.fillStyle = column.color;
      if (vertical) c.fillRect(mid - amp, pos, amp * 2, barSize);
      else c.fillRect(pos, mid - amp, barSize, amp * 2);
    }

    c.strokeStyle = "rgba(255, 255, 255, 0.08)";
    c.lineWidth = 1;
    c.beginPath();
    if (vertical) {
      c.moveTo(mid, 0);
      c.lineTo(mid, h);
    } else {
      c.moveTo(0, mid);
      c.lineTo(w, mid);
    }
    c.stroke();

    for (const cue of this.hotCues) {
      if (cue.time < start || cue.time > end) continue;
      const pos = ((cue.time - start) / this.span) * len;
      c.fillStyle = cue.color;
      if (vertical) {
        c.fillRect(0, pos, cross, Math.max(1, 2 * dpr));
        c.beginPath();
        c.moveTo(0, pos);
        c.lineTo(6 * dpr, pos);
        c.lineTo(0, pos + 6 * dpr);
      } else {
        c.fillRect(pos, 0, Math.max(1, 2 * dpr), cross);
        c.beginPath();
        c.moveTo(pos, 0);
        c.lineTo(pos + 6 * dpr, 0);
        c.lineTo(pos, 6 * dpr);
      }
      c.closePath();
      c.fill();
    }

    if (this.loop) {
      const p1 = ((this.loop.start - start) / this.span) * len;
      const p2 = ((this.loop.end - start) / this.span) * len;
      c.strokeStyle = "rgba(120, 148, 255, 0.9)";
      c.lineWidth = dpr;
      if (vertical) c.strokeRect(0, p1, cross, Math.max(1, p2 - p1));
      else c.strokeRect(p1, 0, Math.max(1, p2 - p1), cross);
    }

    c.shadowColor = "rgba(255, 255, 255, 0.9)";
    c.shadowBlur = 8 * dpr;
    c.fillStyle = "#ffffff";
    if (vertical) c.fillRect(0, len / 2 - dpr, cross, Math.max(1, 2 * dpr));
    else c.fillRect(len / 2 - dpr, 0, Math.max(1, 2 * dpr), cross);
    c.shadowBlur = 0;

    if (vertical && column < w) c.restore();
  }
}

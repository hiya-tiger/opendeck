// UI frame-time test for the Electron side of the Linux benchmark (D46):
// four of the app's own ZoomWaveform canvases (3-band, 8 s span) scrolling
// over four playing PcmSource decks (C/D key-locked at +3 %), the same scene
// the egui build runs with --bench-scroll. Frame time = requestAnimationFrame
// deltas after a 2 s warm-up. POSTs the JSON result to /result.
import { PcmSource } from "../../src/renderer/engine/pcm-source.ts";
import { ZoomWaveform } from "../../src/renderer/media/waveform.ts";

const params = new URLSearchParams(location.search);
const SECONDS = Number(params.get("seconds") ?? 30);

async function main(): Promise<void> {
  const ctx = new AudioContext({ latencyHint: "interactive" });
  if (ctx.state !== "running") await ctx.resume().catch(() => undefined);
  const sr = ctx.sampleRate;
  const dur = 120;
  const waves: ZoomWaveform[] = [];
  const decks: PcmSource[] = [];
  document.body.style.margin = "0";
  document.body.style.background = "#0e0e0e";
  for (let d = 0; d < 4; d += 1) {
    const canvas = document.createElement("canvas");
    canvas.style.width = "100%"; canvas.style.height = "110px"; canvas.style.display = "block";
    canvas.width = 1400; canvas.height = 110;
    document.body.appendChild(canvas);
    const n = dur * 150;
    const peaks = new Float32Array(n), low = new Float32Array(n), mid = new Float32Array(n), high = new Float32Array(n);
    for (let i = 0; i < n; i += 1) { const b = (i % 75) / 75; low[i] = Math.exp(-b * 6) * 0.9; mid[i] = 0.3 + 0.2 * Math.sin(i / 13 + d); high[i] = 0.2 + 0.15 * Math.sin(i / 3.7); peaks[i] = Math.max(low[i], mid[i], high[i]); }
    const w = new ZoomWaveform(canvas, 8);
    w.setPeaks(peaks, dur, { low, mid, high } as never);
    w.setBpm([120, 124, 128, 132][d], 0);
    waves.push(w);
    const buf = ctx.createBuffer(2, 30 * sr, sr);
    for (let c = 0; c < 2; c += 1) { const ch = buf.getChannelData(c); for (let i = 0; i < ch.length; i += 1) ch[i] = 0.05 * Math.sin(2 * Math.PI * (110 + 40 * d) * i / sr); }
    const src = new PcmSource(ctx, ctx.destination, { gain: 0.25 });
    await src.load(buf, 0);
    src.setLoop(0, buf.length - 1);
    if (d >= 2) { src.setKeylock(true); src.setRate(1.03); }
    decks.push(src);
  }
  await Promise.all(decks.map((s) => s.play(0)));
  const frames: number[] = [];
  const t0 = performance.now();
  let last = t0;
  await new Promise<void>((resolve) => {
    const step = (now: number): void => {
      const el = (now - t0) / 1000;
      for (let d = 0; d < 4; d += 1) { waves[d].update(((el * (d >= 2 ? 1.03 : 1)) % dur) / dur); waves[d].draw(); decks[d].tick(); }
      if (el > 2) frames.push(now - last);
      last = now;
      if (el >= SECONDS + 2) resolve(); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  const s = [...frames].sort((a, b) => a - b);
  const q = (p: number): number => s[Math.round((s.length - 1) * p)] ?? 0;
  await fetch("/result", { method: "POST", body: JSON.stringify({ frames: s.length, frameMsMedian: q(0.5), frameMsP95: q(0.95), frameMsP99: q(0.99), frameMsMax: q(1), fps: s.length / SECONDS, appUnderruns: decks.map((d) => d.underruns) }) });
}
main().catch(async (e) => { await fetch("/result", { method: "POST", body: JSON.stringify({ error: String((e as Error)?.stack ?? e) }) }); });

// AudioWorklet playback-glitch test: four decks of the app's own PcmSource
// (the AudioWorklet engine; decks C and D with keylock on, through the
// Signalsmith stretch path, at +3% tempo), looping for ?seconds (default 300).
// Two counters, summed per run:
//   appUnderruns   PcmSource.underruns, the app's own xrun counter (position
//                  stalled > 90 ms while playing), polled through tick()
//   contextStalls  50 ms windows in which AudioContext.currentTime advanced
//                  less than half the wall-clock time (the audio device starved)
// The page POSTs the JSON result to /result on the loopback server it came from.
import { PcmSource } from "../../src/renderer/engine/pcm-source.ts";

const params = new URLSearchParams(location.search);
const SECONDS = Number(params.get("seconds") ?? 300);
const status = (t: string): void => { document.body.textContent = t; };

async function main(): Promise<void> {
  const ctx = new AudioContext({ latencyHint: "interactive" });
  if (ctx.state !== "running") await ctx.resume().catch(() => undefined);
  const sr = ctx.sampleRate;
  const decks: PcmSource[] = [];
  for (let d = 0; d < 4; d += 1) {
    const len = 30 * sr;
    const buf = ctx.createBuffer(2, len, sr);
    const bpm = [120, 124, 128, 132][d];
    const beat = (60 / bpm) * sr;
    for (let c = 0; c < 2; c += 1) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < len; i += 1) {
        const ib = i % beat;
        ch[i] = 0.12 * Math.sin(2 * Math.PI * (55 + 70 * Math.exp(-ib / 900)) * (ib / sr)) * Math.exp(-ib / 5000) + 0.03 * Math.sin(2 * Math.PI * (220 + 30 * d) * (i / sr));
      }
    }
    const src = new PcmSource(ctx, ctx.destination, { gain: 0.25 });
    await src.load(buf, 0);
    src.setLoop(0, len - 1);
    if (d >= 2) { src.setKeylock(true); src.setRate(1.03); }
    decks.push(src);
  }
  await Promise.all(decks.map((s) => s.play(0)));
  let stalls = 0;
  let lastWall = performance.now();
  let lastAudio = ctx.currentTime;
  const tick = setInterval(() => {
    for (const s of decks) s.tick();
    const now = performance.now();
    const wall = (now - lastWall) / 1000;
    if (wall >= 0.05) {
      const audio = ctx.currentTime - lastAudio;
      if (audio < wall * 0.5) stalls += 1;
      lastWall = now;
      lastAudio = ctx.currentTime;
    }
  }, 10);
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      const el = (performance.now() - t0) / 1000;
      status(`playing ${el.toFixed(0)} / ${SECONDS} s`);
      if (el >= SECONDS) { clearInterval(iv); resolve(); }
    }, 1000);
  });
  clearInterval(tick);
  const result = {
    host: params.get("host"), userAgent: navigator.userAgent, seconds: SECONDS, sampleRate: sr, baseLatency: ctx.baseLatency, outputLatency: (ctx as { outputLatency?: number }).outputLatency ?? null,
    ctxState: ctx.state, engines: decks.map((s) => s.engineMode),
    appUnderruns: decks.map((s) => s.underruns), contextStalls: stalls, audioSeconds: ctx.currentTime,
  };
  await fetch("/result", { method: "POST", body: JSON.stringify(result) });
  status("done");
}
main().catch(async (e) => { await fetch("/result", { method: "POST", body: JSON.stringify({ error: String(e && (e as Error).stack || e) }) }); });

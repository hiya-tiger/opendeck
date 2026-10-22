import { PcmSource } from "../src/renderer/engine/pcm-source.ts";

interface SmokeResult {
  ok: boolean;
  rms: number;
  position: number;
  loopPosition: number;
  looped: boolean;
  error?: string;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function rms(analyser: AnalyserNode): Promise<number> {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const value of data) {
    const sample = (value - 128) / 128;
    sum += sample * sample;
  }
  return Math.sqrt(sum / data.length);
}

async function run(): Promise<SmokeResult> {
  const result: SmokeResult = { ok: false, rms: 0, position: 0, loopPosition: 0, looped: false };
  const ctx = new AudioContext({ latencyHint: "interactive" });
  try {
    await ctx.resume();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.connect(ctx.destination);
    const pcm = new PcmSource(ctx, analyser);
    const buffer = ctx.createBuffer(2, ctx.sampleRate * 2, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.sin((2 * Math.PI * 440 * i) / ctx.sampleRate) * 0.5;
    }

    pcm.load(buffer);
    await pcm.play();
    await wait(350);
    result.rms = await rms(analyser);
    result.position = pcm.positionSamples / ctx.sampleRate;

    pcm.seek(Math.round(ctx.sampleRate * 1.0));
    await wait(120);
    result.position = pcm.positionSamples / ctx.sampleRate;

    pcm.setLoop(Math.round(ctx.sampleRate * 0.5), Math.round(ctx.sampleRate * 0.75));
    pcm.seek(Math.round(ctx.sampleRate * 0.7));
    await wait(300);
    result.loopPosition = pcm.positionSamples / ctx.sampleRate;
    result.looped = result.loopPosition >= 0.5 && result.loopPosition <= 0.76;

    result.ok = result.rms > 0.05 && result.position > 1.05 && result.looped;
    pcm.pause();
    pcm.dispose();
  } catch (error) {
    result.error = (error as Error).message;
  } finally {
    await ctx.close();
  }
  return result;
}

declare global {
  interface Window {
    __smoke?: Promise<SmokeResult>;
  }
}

window.__smoke = run();

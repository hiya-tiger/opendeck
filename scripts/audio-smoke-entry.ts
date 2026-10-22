import { Deck } from "../src/renderer/engine/deck.ts";
import { PcmSource } from "../src/renderer/engine/pcm-source.ts";

interface SmokeResult {
  ok: boolean;
  rms: number;
  position: number;
  loopPosition: number;
  looped: boolean;
  deckEngine: string;
  deckRms: number;
  deckPosition: number;
  deckLoopPosition: number;
  error?: string;
}

function wavTone(seconds: number, sampleRate: number): Uint8Array {
  const frames = Math.round(seconds * sampleRate);
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + frames * 4, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5 * 32767);
    view.setInt16(44 + i * 4, sample, true);
    view.setInt16(46 + i * 4, sample, true);
  }
  return bytes;
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
  const result: SmokeResult = {
    ok: false,
    rms: 0,
    position: 0,
    loopPosition: 0,
    looped: false,
    deckEngine: "media",
    deckRms: 0,
    deckPosition: 0,
    deckLoopPosition: 0,
  };
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

    pcm.pause();
    pcm.dispose();

    const deck = new Deck(ctx, "A", ctx.destination);
    try {
      const file = new File([wavTone(2, ctx.sampleRate)], "smoke.wav", { type: "audio/wav" });
      await deck.load(file, { bpm: 120 });
      deck.setKeylock(false);
      for (let i = 0; i < 40 && deck.engine !== "pcm"; i += 1) await wait(50);
      result.deckEngine = deck.engine;
      await deck.play();
      await wait(350);
      result.deckRms = deck.level;
      result.deckPosition = deck.currentTime;
      deck.setLoopRange(0.5, 0.75, true);
      await wait(300);
      result.deckLoopPosition = deck.currentTime;
      deck.pause();
    } finally {
      deck.destroy();
    }

    result.ok =
      result.rms > 0.05 &&
      result.position > 1.05 &&
      result.looped &&
      result.deckEngine === "pcm" &&
      result.deckRms > 0.05 &&
      result.deckPosition > 0.1 &&
      result.deckLoopPosition >= 0.49 &&
      result.deckLoopPosition <= 0.76;
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

import { Deck } from "../src/renderer/engine/deck.ts";
import { PcmSource } from "../src/renderer/engine/pcm-source.ts";
import { VideoMixer, computeAspectRect, shouldResyncVideoElement } from "../src/renderer/engine/video-mixer.ts";

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
  deckLatency: number;
  deckPitch: boolean;
  pitchShiftChecked: boolean;
  censorChecked: boolean;
  customFxChecked: boolean;
  reversed: boolean;
  deckPlaying: boolean;
  stemParts: number;
  stemRms: number;
  stemPosition: number;
  stemScratch: boolean;
  stemPlatterScratch: boolean;
  stemPlaying: boolean;
  stemEngine: string;
  videoSyncChecked: boolean;
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

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (check()) return true;
    await wait(50);
  }
  return check();
}

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
    deckLatency: 1,
    deckPitch: false,
    pitchShiftChecked: false,
    censorChecked: false,
    customFxChecked: false,
    reversed: false,
    deckPlaying: false,
    stemParts: 0,
    stemRms: 0,
    stemPosition: 0,
    stemScratch: false,
    stemPlatterScratch: false,
    stemPlaying: false,
    stemEngine: "media",
    videoSyncChecked: false,
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

    await pcm.load(buffer);
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
      for (let i = 0; i < 40 && deck.engine !== "pcm"; i += 1) await wait(50);
      result.deckEngine = deck.engine;
      result.deckLatency = deck.latencySeconds;
      result.deckPitch = deck.pitchPreserved;
      deck.setPitchShift(3);
      result.pitchShiftChecked = deck.pitchShift === 3;
      deck.setPitchShift(0);
      deck.setCustomFxChain([
        { type: "filter", division: "1/4", amount: 0.6, wet: 0.7, enabled: true },
        { type: "echo", division: "1/8", amount: 0.4, wet: 0.5, enabled: true },
      ]);
      result.customFxChecked = deck.customFxChain.length === 2 && deck.fx === "filter";
      deck.setCustomFxChain([]);
      deck.setFx("off");

      await deck.play();
      await waitFor(() => deck.currentTime > 0.1, 3000);
      await wait(200);
      result.deckRms = deck.level;
      result.deckPosition = deck.currentTime;
      result.deckPlaying = deck.playing;
      deck.setReturnMode(true);
      deck.beginReverseOnHold();
      const reverseActive = deck.censorActive;
      await wait(40);
      deck.endReverseOnHold();
      result.censorChecked = Boolean(reverseActive) && !deck.censorActive && Boolean(deck.returnMode);
      deck.setReturnMode(false);
      deck.setLoopRange(0.5, 0.75, true);
      await waitFor(() => deck.currentTime >= 0.49, 1500);
      result.deckLoopPosition = deck.currentTime;
      const beforeReverse = deck.currentTime;
      deck.setLoopRange(0.5, 0.75, false);
      deck.driveTimecode(-1, beforeReverse);
      result.reversed = await waitFor(() => deck.currentTime < beforeReverse - 0.01, 1500);
      deck.pause();

      const stems: Partial<Record<"drums" | "bass" | "other" | "vocals", AudioBuffer>> = {};
      const tones: Record<"drums" | "bass" | "other" | "vocals", number> = { drums: 220, bass: 110, other: 330, vocals: 440 };
      for (const [part, hz] of Object.entries(tones)) {
        const stem = ctx.createBuffer(2, ctx.sampleRate * 2, ctx.sampleRate);
        for (let channel = 0; channel < 2; channel += 1) {
          const data = stem.getChannelData(channel);
          for (let i = 0; i < data.length; i += 1) data[i] = Math.sin((2 * Math.PI * hz * i) / ctx.sampleRate) * 0.22;
        }
        stems[part as "drums" | "bass" | "other" | "vocals"] = stem;
      }
      deck.setRate(1);
      await deck.loadStems(stems);
      result.stemParts = deck.stemsLoaded.length;
      deck.setVocalsOnly(true);
      await deck.play();
      await waitFor(() => deck.currentTime > 0.1, 3000);
      await wait(200);
      result.stemRms = deck.level;
      result.stemPosition = deck.currentTime;
      result.stemPlaying = deck.playing;
      result.stemEngine = deck.engine;
      result.stemScratch = deck.beginPartScratch("drums");
      await wait(120);
      deck.endPartScratch();
      result.stemScratch = result.stemScratch && deck.partScratching === null;

      deck.beginScratch();
      const platterStarted = deck.scratchingActive;
      deck.scratchDrive(1, 0.04);
      await wait(60);
      deck.endScratch();
      result.stemPlatterScratch = Boolean(platterStarted) && !deck.scratchingActive;
      deck.pause();

      const vm = new VideoMixer();
      vm.loadVideo("A", "blob:smoke-video-a", "smoke-a.mp4", 2);
      const vSlotFwd = vm.syncDeck("A", { currentTime: deck.currentTime, duration: 2, playing: true, rate: 1 });
      const vSyncFwd = shouldResyncVideoElement(vSlotFwd.currentTime, vSlotFwd.currentTime, true, 1, false, false);
      const vSlotRev = vm.syncDeck("A", { currentTime: 0.4, duration: 2, playing: true, rate: -1, reversed: true });
      const vSyncRev = shouldResyncVideoElement(0.6, vSlotRev.currentTime, true, -1, true, false);
      vm.setCrossfader(-0.5);
      const w = vm.weights();
      const fit = computeAspectRect(1920, 1080, 1280, 720, "fit");
      result.videoSyncChecked =
        vSyncFwd.shouldPlay === true &&
        vSyncRev.shouldPlay === false &&
        vSyncRev.seek === true &&
        w.left === 0.75 &&
        w.right === 0.25 &&
        fit.width === 1280 &&
        fit.height === 720;

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
      result.deckLoopPosition <= 0.76 &&
      result.deckLatency > 0 &&
      result.deckLatency < 0.01 &&
      result.deckPitch &&
      result.pitchShiftChecked &&
      result.censorChecked &&
      result.customFxChecked &&
      result.reversed &&
      result.stemParts === 4 &&
      result.stemRms > 0.05 &&
      result.stemPosition > 0.1 &&
      result.stemScratch &&
      result.stemPlatterScratch &&
      result.videoSyncChecked;
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

window.addEventListener("error", (event) => {
  console.log("SMOKE ERROR", event.message, event.filename, event.lineno, event.error?.stack);
});
window.addEventListener("unhandledrejection", (event) => {
  console.log("SMOKE REJECTION", String(event.reason), event.reason?.stack);
});

window.__smoke = run();

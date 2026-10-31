import { Deck } from "../src/renderer/engine/deck.ts";
import { PcmSource } from "../src/renderer/engine/pcm-source.ts";
import { VideoMixer, computeAspectRect, shouldResyncVideoElement } from "../src/renderer/engine/video-mixer.ts";
import { buildStemBands } from "../src/renderer/engine/stem-bands.ts";
import { createFxShell } from "../src/renderer/engine/fx-shell.ts";

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
  startupMs: number;
  fxOffGainDb: number;
  bandWorstDb: number;
  directThdnDb: number;
  stretchThdnDb: number;
  stretchEngaged: boolean;
  stretchLatency: number;
  directRestored: boolean;
  playEmitted: boolean;
  pauseEmitted: boolean;
  fxOffAfterUseDb: number;
  baseLatency: number;
  outputLatency: number;
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


/** Magnitude of one sine at `hz` after passing it through `build`. */
async function graphGain(
  hz: number,
  build: (ctx: OfflineAudioContext, source: AudioNode) => AudioNode,
): Promise<number> {
  const sr = 48000;
  const ctx = new OfflineAudioContext(2, sr, sr);
  const src = ctx.createBufferSource();
  const buf = ctx.createBuffer(2, sr, sr);
  for (let c = 0; c < 2; c += 1) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i += 1) d[i] = Math.sin((2 * Math.PI * hz * i) / sr) * 0.25;
  }
  src.buffer = buf;
  build(ctx, src).connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0).subarray(Math.round(sr * 0.15));
  const k = (2 * Math.PI * hz) / sr;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < data.length; i += 1) {
    const s0 = data[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const mag = Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / (data.length / 2);
  return mag > 0 ? 20 * Math.log10(mag / 0.25) : -120;
}

function fftPower(x: Float32Array): Float64Array {
  const n = x.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i += 1) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const t = re[i]; re[i] = re[j]; re[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k += 1) {
        const wr = Math.cos(a * k);
        const wi = Math.sin(a * k);
        const h = i + k + len / 2;
        const vr = re[h] * wr - im[h] * wi;
        const vi = re[h] * wi + im[h] * wr;
        re[h] = re[i + k] - vr; im[h] = im[i + k] - vi;
        re[i + k] += vr; im[i + k] += vi;
      }
    }
  }
  const p = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i += 1) p[i] = re[i] * re[i] + im[i] * im[i];
  return p;
}

/** THD+N in dB: energy away from the expected tones over energy at them (up to 16 kHz). */
function thdn(x: Float32Array, sampleRate: number, tones: number[]): number {
  const p = fftPower(x);
  const binHz = sampleRate / x.length;
  let signal = 0;
  let noise = 0;
  for (let i = 2; i < p.length; i += 1) {
    const f = i * binHz;
    if (f > 16000) break;
    if (tones.some((t) => Math.abs(f - t) < 6 * binHz)) signal += p[i];
    else noise += p[i];
  }
  return signal > 0 ? 10 * Math.log10(noise / signal) : 99;
}

const FIDELITY_TONES = [80, 440, 2500];

function toneBuffer(ctx: BaseAudioContext, seconds: number, tones: number[]): AudioBuffer {
  const buffer = ctx.createBuffer(2, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      let sum = 0;
      for (const t of tones) sum += Math.sin((2 * Math.PI * t * i) / ctx.sampleRate) * (0.6 / tones.length);
      data[i] = sum;
    }
  }
  return buffer;
}

/**
 * Plays a three-tone mix through PcmSource at 1.0x (must be the direct,
 * transparent path), then at 1.03x with key lock (must engage Signalsmith with
 * usable quality), then back at 1.0x (must return to direct).
 */
async function fidelityReport(ctx: AudioContext): Promise<{
  directThdnDb: number;
  stretchThdnDb: number;
  stretchEngaged: boolean;
  stretchLatency: number;
  directRestored: boolean;
}> {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 32768;
  analyser.connect(ctx.destination);
  const pcm = new PcmSource(ctx, analyser);
  const capture = (): Float32Array => {
    const x = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(x);
    return x;
  };
  try {
    await pcm.load(toneBuffer(ctx, 8, FIDELITY_TONES));
    pcm.setKeylock(true);
    await pcm.play();
    await wait(1200);
    const directThdnDb = thdn(capture(), ctx.sampleRate, FIDELITY_TONES);
    pcm.setRate(1.03);
    const stretchEngaged = await waitFor(() => pcm.engineMode === "stretch", 3000);
    await wait(1300);
    const stretchThdnDb = thdn(capture(), ctx.sampleRate, FIDELITY_TONES);
    const stretchLatency = pcm.latencySeconds;
    pcm.setRate(1);
    const directRestored = pcm.engineMode === "direct" && pcm.isPlaying;
    return { directThdnDb, stretchThdnDb, stretchEngaged, stretchLatency, directRestored };
  } finally {
    pcm.pause();
    pcm.dispose();
    analyser.disconnect();
  }
}

/**
 * The deck's fixed signal path must be transparent at unity. These two checks
 * pin the defects that made the build sound malformed:
 *  - the FX shell summed dry+wet at construction (+6.02 dB into the limiter)
 *  - the parallel Butterworth band split notched -14.6/-9.8/-17.4 dB at the
 *    three crossovers
 */
async function graphReport(): Promise<{ fxOffGainDb: number; bandWorstDb: number }> {
  const fxOffGainDb = await graphGain(1000, (ctx, source) => {
    const shell = createFxShell(ctx);
    source.connect(shell.input);
    return shell.output;
  });
  let bandWorstDb = 0;
  for (const hz of [60, 120, 180, 300, 800, 1500, 5000, 8000, 12000]) {
    const gain = await graphGain(hz, (ctx, source) => {
      const bus = ctx.createGain();
      buildStemBands(ctx, source, bus);
      return bus;
    });
    if (Math.abs(gain) > Math.abs(bandWorstDb)) bandWorstDb = gain;
  }
  return { fxOffGainDb, bandWorstDb };
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
    startupMs: -1,
    fxOffGainDb: 99,
    bandWorstDb: 99,
    directThdnDb: 99,
    stretchThdnDb: 99,
    stretchEngaged: false,
    stretchLatency: -1,
    directRestored: false,
    playEmitted: false,
    pauseEmitted: false,
    fxOffAfterUseDb: 99,
    baseLatency: -1,
    outputLatency: -1,
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
    const startupStart = performance.now();
    await pcm.play();
    // Poll for the first audible block instead of sleeping a fixed 350 ms: the
    // PCM engine has to ingest the buffer before it can render, and a fixed
    // sleep made this probe report a silent deck on slower runs. The real
    // start-up time is recorded either way.
    for (let i = 0; i < 80; i += 1) {
      if ((await rms(analyser)) > 0.01) break;
      await wait(25);
    }
    result.startupMs = Math.round(performance.now() - startupStart);
    await wait(150);
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

    const graph = await graphReport();
    result.fxOffGainDb = Number(graph.fxOffGainDb.toFixed(3));
    result.bandWorstDb = Number(graph.bandWorstDb.toFixed(3));
    const fidelity = await fidelityReport(ctx);
    result.directThdnDb = Number(fidelity.directThdnDb.toFixed(1));
    result.stretchThdnDb = Number(fidelity.stretchThdnDb.toFixed(1));
    result.stretchEngaged = fidelity.stretchEngaged;
    result.stretchLatency = fidelity.stretchLatency;
    result.directRestored = fidelity.directRestored;
    result.baseLatency = ctx.baseLatency;
    result.outputLatency = typeof ctx.outputLatency === "number" ? ctx.outputLatency : -1;

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

      // FX "off" after an effect was used must be unity: measure the deck level
      // with wet left up from the custom chain above.
      deck.setFxWet(1);
      let emits = 0;
      const previousUpdate = deck.onUpdate;
      deck.onUpdate = (state) => {
        emits += 1;
        previousUpdate?.(state);
      };
      await deck.play();
      result.playEmitted = emits > 0;
      await waitFor(() => deck.currentTime > 0.1, 3000);
      await wait(200);
      result.deckRms = deck.level;
      // The tone is 0.5 peak (0.354 RMS); deck fader 0.85 and cross gain 0.707.
      result.fxOffAfterUseDb = Number((20 * Math.log10(result.deckRms / (0.3536 * 0.85 * Math.SQRT1_2))).toFixed(2));
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
      emits = 0;
      deck.pause();
      result.pauseEmitted = emits > 0;
      deck.onUpdate = previousUpdate;

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
      Math.abs(result.fxOffGainDb) < 0.2 &&
      result.directThdnDb < -50 &&
      result.stretchEngaged &&
      result.stretchThdnDb < -40 &&
      result.stretchLatency > 0 &&
      result.stretchLatency < 0.2 &&
      result.directRestored &&
      result.playEmitted &&
      result.pauseEmitted &&
      Math.abs(result.fxOffAfterUseDb) < 1 &&
      Math.abs(result.bandWorstDb) < 0.5 &&
      result.startupMs >= 0 &&
      result.startupMs < 1500 &&
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

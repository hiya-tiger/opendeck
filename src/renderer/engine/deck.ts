import {
  beatSeconds,
  nearestBeat,
  snapToBeat,
  loopSeconds,
  createBeatGrid,
  setBeatGridLock,
  toggleBeatGridLock,
  setBeatGridBpm,
  shiftBeatGrid,
  setGridDownbeat,
  adjustBeatGridBpm,
  scaleBeatGridBpm,
  tapBeatGridBpm,
  type EditableBeatGrid,
} from "./beatgrid.ts";
import { defaultStemGains, type StemId } from "./stems.ts";
import { buildStemBands } from "./stem-bands.ts";
import { createFxShell } from "./fx-shell.ts";
import { PARTS, defaultPartMix, partGains, type PartId, type PartMix } from "./parts.ts";
import {
  fxDefault,
  filterFrequency,
  filterType,
  crushCurve,
  delaySeconds,
  wetGain,
  tremoloRateHz,
  tapeStopRate,
  type CustomFxSlot,
  type Division,
  type FxType,
} from "./fx.ts";
import { censorReleasePosition, rollingReleasePosition } from "./pad-modes.ts";
import { ScratchVoice } from "./scratch-voice.ts";
import { PcmSource } from "./pcm-source.ts";
import { Platter } from "./platter.ts";

export type DeckId = "A" | "B" | "C" | "D";

const sha256Hex = async (data: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export interface DeckTrackInfo {
  id: string;
  title: string;
  bpm: number;
  beatPhase: number;
  key: string;
  camelot: string;
}

export interface HotCue {
  time: number;
  color: string;
  name?: string;
}

export const HOT_CUE_COLORS = [
  "#4d6bfe",
  "#23b5a5",
  "#f0a726",
  "#e8567a",
  "#7c5cff",
  "#33a3dc",
  "#8fbf3f",
  "#d3724a",
];

export interface DeckState {
  playing: boolean;
  currentTime: number;
  duration: number;
  rate: number;
  tempoPercent: number;
  bpm: number;
  loopActive: boolean;
  loopStart: number;
  loopEnd: number;
  loopBeats: number;
  cue: number;
  hotCues: (HotCue | null)[];
  fx: FxType;
  fxWet: number;
  keylock: boolean;
  title: string;
  pitchShift?: number;
  returnMode?: boolean;
  slipActive?: boolean;
  censorActive?: boolean;
  beatgridLocked?: boolean;
  trackEndWarning?: boolean;
}

interface FxChain {
  input: GainNode;
  output: GainNode;
  dry: GainNode;
  wet: GainNode;
  nodes: AudioNode[];
  lfos: OscillatorNode[];
  delay?: DelayNode;
  feedback?: GainNode;
  filter?: BiquadFilterNode;
  shaper?: WaveShaperNode;
  allpass?: BiquadFilterNode[];
  lfoGains?: GainNode[];
  lfoOsc?: OscillatorNode;
  lfoDepth?: GainNode;
  type: FxType;
}

export class Deck {
  readonly id: DeckId;
  readonly ctx: AudioContext;
  readonly el: HTMLAudioElement;
  readonly info: DeckTrackInfo = { id: "", title: "No track", bpm: 0, beatPhase: 0, key: "--", camelot: "--" };

  private source: MediaElementAudioSourceNode;
  private deckInput: GainNode;
  private pcm: PcmSource;
  private pcmBuffer: AudioBuffer | null = null;
  private pcmActive = false;
  private splitter: ChannelSplitterNode;
  private bands: Record<StemId, { nodes: AudioNode[]; gain: GainNode; fx: BiquadFilterNode }>;
  private stemBus: GainNode;
  private trim: GainNode;
  private eq: { low: BiquadFilterNode; mid: BiquadFilterNode; high: BiquadFilterNode };
  private fader: GainNode;
  private cross: GainNode;
  private fxChain: FxChain;
  private analyser: AnalyserNode;
  private scratch: ScratchVoice;
  private scratching = false;
  private partMix: PartMix = defaultPartMix();
  private stemVoices: Partial<Record<PartId, PcmSource>> = {};
  private stemBuffers: Partial<Record<PartId, AudioBuffer>> = {};
  private partNodes: Partial<Record<PartId, { filter: BiquadFilterNode; gain: GainNode }>> = {};
  private partScratches: Partial<Record<PartId, ScratchVoice>> = {};
  private partScratchId: PartId | null = null;
  private partLoopId: PartId | null = null;
  private stemActive = false;
  private pcmHash = "";
  private readonly platter = new Platter();

  cuePoint = 0;
  loopStart = 0;
  loopEnd = 0;
  loopBeats = 4;
  loopActive = false;
  returnMode = false;
  beatgrid: EditableBeatGrid = createBeatGrid(0, 0, false);
  customFxChain: CustomFxSlot[] = [];
  loadLock = false;
  repeatTrack = false;
  autoplayNext = false;
  trackGainDb = 0;
  startTimeMs = 0;
  stopTimeMs = 0;
  playbackMode: "INT" | "REL" | "ABS" = "INT";
  eqKill: Record<"low" | "mid" | "high", boolean> = { low: false, mid: false, high: false };
  isolatorMode = false;

  private eqValuesDb: Record<"low" | "mid" | "high", number> = { low: 0, mid: 0, high: 0 };
  private trimLinear = 1;
  private pitchShiftSemitones = 0;
  private slipEngaged = false;
  private slipEntryPos = 0;
  private slipEntryMs = 0;
  private slipEntryRate = 1;
  private censorEngaged = false;
  private censorEntryPos = 0;
  private censorEntryMs = 0;
  private censorForwardRate = 1;
  private tapHistoryMs: number[] = [];
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  private partLoopStart = 0;
  private partLoopEnd = 0;
  private cueList: (HotCue | null)[] = new Array(8).fill(null);
  private cueVersion = 0;
  private readonly levelData = new Uint8Array(256);
  private stateCache: DeckState | null = null;
  private rate = 1;
  private tempoPercent = 0;
  private keylock = true;
  private pitchRange = 50;
  private fxType: FxType = "off";
  private fxDivision: Division = "1/4";
  private fxAmount = 0.5;
  private fxWet = 0;
  private stemGains: Record<StemId, number> = defaultStemGains();
  private stemMuted: Record<StemId, boolean> = { low: false, lowmid: false, highmid: false, high: false };
  private stemSolo: StemId | null = null;
  private quantize = true;
  private destroyed = false;

  onUpdate: ((state: DeckState) => void) | null = null;
  onTrackEnded: ((deck: Deck) => void) | null = null;

  constructor(ctx: AudioContext, id: DeckId, destination: AudioNode) {
    this.id = id;
    this.ctx = ctx;

    this.el = document.createElement("audio");
    this.el.preload = "auto";
    this.el.preservesPitch = true;

    this.source = ctx.createMediaElementSource(this.el);
    this.deckInput = ctx.createGain();
    this.source.connect(this.deckInput);
    this.pcm = new PcmSource(ctx, this.deckInput, {
      onEnded: () => this.handleEnded(),
    });
    this.splitter = ctx.createChannelSplitter(2);

    this.stemBus = ctx.createGain();
    this.bands = {} as Record<StemId, { nodes: AudioNode[]; gain: GainNode; fx: BiquadFilterNode }>;

    this.bands = buildStemBands(ctx, this.deckInput, this.stemBus);

    for (const part of PARTS) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 20000;
      filter.Q.value = 0.7;
      const gain = ctx.createGain();
      filter.connect(gain);
      gain.connect(this.stemBus);
      this.partNodes[part.id] = { filter, gain };
      this.partScratches[part.id] = new ScratchVoice(ctx, filter);
    }

    this.trim = ctx.createGain();
    this.scratch = new ScratchVoice(ctx, this.trim);

    this.eq = {
      low: ctx.createBiquadFilter(),
      mid: ctx.createBiquadFilter(),
      high: ctx.createBiquadFilter(),
    };
    this.eq.low.type = "lowshelf";
    this.eq.low.frequency.value = 180;
    this.eq.mid.type = "peaking";
    this.eq.mid.frequency.value = 1200;
    this.eq.mid.Q.value = 0.9;
    this.eq.high.type = "highshelf";
    this.eq.high.frequency.value = 6000;

    this.fader = ctx.createGain();
    this.fader.gain.value = 0.85;
    this.cross = ctx.createGain();
    this.cross.gain.value = Math.SQRT1_2;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.55;

    this.stemBus.connect(this.trim);
    this.trim.connect(this.eq.low);
    this.eq.low.connect(this.eq.mid);
    this.eq.mid.connect(this.eq.high);
    this.fxChain = this.buildFx();
    this.eq.high.connect(this.fxChain.input);
    this.fxChain.output.connect(this.fader);
    this.fader.connect(this.cross);
    this.cross.connect(this.analyser);
    this.cross.connect(destination);
    void this.splitter;

    this.el.addEventListener("ended", () => this.handleEnded());
    this.el.addEventListener("play", () => this.emit());
    this.el.addEventListener("pause", () => this.emit());
    this.setFx("off");
  }

  private handleEnded(): void {
    if (this.repeatTrack && this.duration > 0) {
      this.seek(0);
      void this.play();
      return;
    }
    this.emit();
    this.onTrackEnded?.(this);
  }

  get hotCues(): (HotCue | null)[] {
    return this.cueList;
  }

  set hotCues(value: (HotCue | null)[]) {
    this.cueList = value;
    this.cueVersion += 1;
  }

  get hotCueVersion(): number {
    return this.cueVersion;
  }

  private buildFx(): FxChain {
    const shell = createFxShell(this.ctx);
    return { ...shell, nodes: [], lfos: [], type: "off" };
  }

  private teardownFx(): void {
    try {
      const chain = this.fxChain;
      chain.input.disconnect();
      chain.dry.disconnect();
      chain.wet.disconnect();
      for (const node of chain.nodes) node.disconnect();
      for (const lfo of chain.lfos) lfo.stop();
    } catch {
      // already disconnected
    }
    this.fxChain.nodes = [];
    this.fxChain.lfos = [];
    this.fxChain.delay = undefined;
    this.fxChain.feedback = undefined;
    this.fxChain.filter = undefined;
    this.fxChain.shaper = undefined;
    this.fxChain.allpass = undefined;
    this.fxChain.lfoOsc = undefined;
    this.fxChain.lfoDepth = undefined;
    this.fxChain.input.connect(this.fxChain.dry);
    this.fxChain.dry.connect(this.fxChain.output);
    this.fxChain.input.connect(this.fxChain.wet);
    this.fxChain.wet.connect(this.fxChain.output);
  }

  private buildChain(type: FxType): void {
    this.teardownFx();
    const ctx = this.ctx;
    const chain = this.fxChain;
    chain.type = type;

    if (type === "filter") {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 18000;
      filter.Q.value = 0.9;
      chain.nodes.push(filter);
      chain.input.connect(filter);
      filter.connect(chain.wet);
      chain.filter = filter;
      chain.dry.gain.value = 0;
      return;
    }

    if (type === "echo" || type === "delay") {
      const delay = ctx.createDelay(4);
      const feedback = ctx.createGain();
      const tone = ctx.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.value = 4200;
      chain.nodes.push(delay, feedback, tone);
      chain.input.connect(delay);
      delay.connect(tone);
      tone.connect(feedback);
      if (type === "delay") {
        const pan = ctx.createStereoPanner();
        pan.pan.value = 0.35;
        const reversePan = ctx.createStereoPanner();
        reversePan.pan.value = -0.35;
        feedback.connect(reversePan);
        reversePan.connect(delay);
        delay.connect(pan);
        pan.connect(chain.wet);
        chain.nodes.push(pan, reversePan);
      } else {
        feedback.connect(delay);
        delay.connect(chain.wet);
      }
      chain.delay = delay;
      chain.feedback = feedback;
      return;
    }

    if (type === "combo-filter-echo") {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 8000;
      filter.Q.value = 2.2;
      const delay = ctx.createDelay(4);
      const feedback = ctx.createGain();
      const tone = ctx.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.value = 3800;
      chain.nodes.push(filter, delay, feedback, tone);
      chain.input.connect(filter);
      filter.connect(chain.wet);
      filter.connect(delay);
      delay.connect(tone);
      tone.connect(feedback);
      feedback.connect(delay);
      delay.connect(chain.wet);
      chain.filter = filter;
      chain.delay = delay;
      chain.feedback = feedback;
      return;
    }

    if (type === "reverb") {
      const convolver = ctx.createConvolver();
      convolver.buffer = this.impulse(2.4, 2.2);
      const pre = ctx.createBiquadFilter();
      pre.type = "highpass";
      pre.frequency.value = 260;
      chain.nodes.push(convolver, pre);
      chain.input.connect(pre);
      pre.connect(convolver);
      convolver.connect(chain.wet);
      return;
    }

    if (type === "flanger") {
      const delay = ctx.createDelay(0.05);
      delay.delayTime.value = 0.003;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.5;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.28;
      const depth = ctx.createGain();
      depth.gain.value = 0.0018;
      lfo.connect(depth);
      depth.connect(delay.delayTime);
      lfo.start();
      chain.nodes.push(delay, feedback, depth);
      chain.lfos.push(lfo);
      chain.input.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(chain.wet);
      chain.delay = delay;
      chain.feedback = feedback;
      return;
    }

    if (type === "phaser") {
      const stages: BiquadFilterNode[] = [];
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.16;
      const depth = ctx.createGain();
      depth.gain.value = 700;
      lfo.connect(depth);
      lfo.start();
      chain.lfos.push(lfo);
      let last: AudioNode = chain.input;
      for (let i = 0; i < 4; i += 1) {
        const stage = ctx.createBiquadFilter();
        stage.type = "allpass";
        stage.frequency.value = 320 + i * 420;
        stage.Q.value = 0.5;
        depth.connect(stage.frequency);
        last.connect(stage);
        last = stage;
        stages.push(stage);
      }
      const feedback = ctx.createGain();
      feedback.gain.value = 0.35;
      last.connect(chain.wet);
      last.connect(feedback);
      feedback.connect(stages[0]);
      chain.nodes.push(...stages, depth, feedback);
      chain.allpass = stages;
      return;
    }

    if (type === "crush") {
      const shaper = ctx.createWaveShaper();
      shaper.curve = crushCurve(0.6);
      const tone = ctx.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.value = 9000;
      chain.nodes.push(shaper, tone);
      chain.input.connect(shaper);
      shaper.connect(tone);
      tone.connect(chain.wet);
      chain.shaper = shaper;
      chain.dry.gain.value = 0.25;
      return;
    }

    if (type === "tremolo" || type === "gate") {
      const modGain = ctx.createGain();
      modGain.gain.value = 0.5;
      const lfo = ctx.createOscillator();
      lfo.type = type === "gate" ? "square" : "sine";
      lfo.frequency.value = tremoloRateHz(this.fxDivision, this.info.bpm || 120);
      const depth = ctx.createGain();
      depth.gain.value = 0.45;
      lfo.connect(depth);
      depth.connect(modGain.gain);
      lfo.start();
      chain.nodes.push(modGain, depth);
      chain.lfos.push(lfo);
      chain.input.connect(modGain);
      modGain.connect(chain.wet);
      chain.lfoOsc = lfo;
      chain.lfoDepth = depth;
      chain.dry.gain.value = 0.15;
      return;
    }

    if (type === "tape-stop" || type === "brake") {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 14000;
      chain.nodes.push(filter);
      chain.input.connect(filter);
      filter.connect(chain.wet);
      chain.filter = filter;
      chain.dry.gain.value = 0;
      return;
    }

    chain.dry.gain.value = 1;
    chain.wet.gain.value = 0;
  }

  private impulse(seconds: number, decay: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = this.ctx.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      let seed = channel === 0 ? 1234 : 5678;
      const step = Math.pow(0.015, decay / length);
      let envelope = 1;
      for (let i = 0; i < length; i += 1) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const noise = (seed / 0x7fffffff) * 2 - 1;
        data[i] = noise * envelope;
        envelope *= step;
      }
    }
    return buffer;
  }

  async load(source: File | string, info: Partial<DeckTrackInfo> = {}): Promise<void> {
    if (this.loadLock && this.playing) {
      return;
    }
    this.pause();
    this.clearStems();
    this.pcm.clear();
    this.pcmBuffer = null;
    this.pcmHash = "";
    this.pcmActive = false;
    this.scratch.stop();
    this.scratching = false;
    this.scratch.clear();
    const local =
      typeof source !== "string" || /^(blob:|file:)/i.test(source);
    const url = typeof source === "string" ? source : URL.createObjectURL(source);
    if (local) {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Could not read audio");
      const data = await response.arrayBuffer();
      this.pcmHash = await sha256Hex(data);
      const buffer = await this.ctx.decodeAudioData(data);
      this.pcmBuffer = buffer;
      this.scratch.setBuffer(buffer);
      await this.pcm.load(buffer, 0);
      // Build the key-lock engine in the background so the first tempo move
      // does not wait on a cold Signalsmith start. Playback does not need it.
      this.pcm.prewarm();
      this.pcmActive = true;
      this.el.removeAttribute("src");
      this.el.load();
      if (typeof source !== "string") URL.revokeObjectURL(url);
    } else {
      this.el.src = url;
      this.el.load();
      await new Promise<void>((resolve, reject) => {
        const ok = (): void => {
          cleanup();
          resolve();
        };
        const bad = (): void => {
          cleanup();
          reject(new Error("Could not decode audio"));
        };
        const cleanup = (): void => {
          this.el.removeEventListener("loadedmetadata", ok);
          this.el.removeEventListener("error", bad);
        };
        this.el.addEventListener("loadedmetadata", ok);
        this.el.addEventListener("error", bad);
      });
    }
    this.cuePoint = 0;
    this.loopActive = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.hotCues = new Array(8).fill(null);
    this.setRate(1);
    this.tempoPercent = 0;
    this.pitchShiftSemitones = 0;
    this.pcm.setPitchShift(0);
    Object.assign(this.info, {
      id: info.id ?? (typeof source === "string" ? source : source.name),
      title: info.title ?? (typeof source === "string" ? source : source.name.replace(/\.[^.]+$/, "")),
      bpm: info.bpm ?? 0,
      beatPhase: info.beatPhase ?? 0,
      key: info.key ?? "--",
      camelot: info.camelot ?? "--",
    });
    this.beatgrid = createBeatGrid(this.info.bpm, this.info.beatPhase, false);
    this.emit();
  }

  eject(): void {
    if (this.loadLock && this.playing) return;
    this.pause();
    this.clearStems();
    this.pcm.clear();
    this.pcmBuffer = null;
    this.pcmHash = "";
    this.pcmActive = false;
    this.scratch.stop();
    this.scratching = false;
    this.scratch.clear();
    this.el.removeAttribute("src");
    this.el.load();
    this.cuePoint = 0;
    this.loopActive = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.hotCues = new Array(8).fill(null);
    this.pitchShiftSemitones = 0;
    Object.assign(this.info, { id: "", title: "No track", bpm: 0, beatPhase: 0, key: "--", camelot: "--" });
    this.beatgrid = createBeatGrid(0, 0, false);
    this.emit();
  }

  async cloneFrom(other: Deck): Promise<void> {
    if (this.loadLock && this.playing) return;
    this.pause();
    this.clearStems();
    this.pcm.clear();
    this.pcmBuffer = other.pcmBuffer;
    this.pcmHash = other.pcmHash;
    Object.assign(this.info, { ...other.info });
    this.beatgrid = {
      ...other.beatgrid,
      markers: other.beatgrid.markers.map((m) => ({ ...m })),
    };
    this.cuePoint = other.cuePoint;
    this.hotCues = other.hotCues.map((cue) => (cue ? { ...cue } : null));
    this.loopStart = other.loopStart;
    this.loopEnd = other.loopEnd;
    this.loopBeats = other.loopBeats;
    this.loopActive = other.loopActive;
    this.keylock = other.keylock;
    this.pitchShiftSemitones = other.pitchShiftSemitones;
    this.tempoPercent = other.tempoPercent;
    this.rate = other.rate;

    const targetTime = other.currentTime;
    if (this.pcmBuffer) {
      this.scratch.setBuffer(this.pcmBuffer);
      const startSample = Math.round(targetTime * this.pcmBuffer.sampleRate);
      await this.pcm.load(this.pcmBuffer, startSample);
      this.pcmActive = true;
      this.pcm.setKeylock(this.keylock);
      this.pcm.setPitchShift(this.pitchShiftSemitones);
      this.pcm.setRate(this.rate);
      this.applyPcmLoop();
      if (other.playing) {
        await this.pcm.play(startSample);
      }
    } else if (other.stemActive) {
      await this.loadStems(other.stemBuffers);
      this.seek(targetTime);
      if (other.playing) {
        await this.play();
      }
    } else if (other.el.src) {
      this.el.src = other.el.src;
      this.el.currentTime = targetTime;
      this.el.preservesPitch = this.keylock;
      if (this.rate > 0) this.el.playbackRate = this.rate;
      if (other.playing) void this.play();
    }
    this.emit();
  }

  get scratchReady(): boolean {
    return this.scratch.hasBuffer || (this.stemActive && PARTS.some((p) => Boolean(this.partScratches[p.id]?.hasBuffer)));
  }

  get audioBuffer(): AudioBuffer | null {
    return this.pcmBuffer;
  }

  get audioHash(): string {
    return this.pcmHash;
  }

  get hasStems(): boolean {
    return this.stemActive;
  }

  get stemsLoaded(): PartId[] {
    return PARTS.map((part) => part.id).filter((id) => Boolean(this.stemBuffers[id]));
  }

  private stemReference(): PcmSource | null {
    const preferred: PartId[] = this.partScratchId === "drums" ? ["bass", "other", "vocals", "drums"] : ["drums", "bass", "other", "vocals"];
    for (const id of preferred) {
      const voice = this.stemVoices[id];
      if (voice?.hasBuffer) return voice;
    }
    return null;
  }

  private clearStems(): void {
    for (const id of PARTS.map((part) => part.id)) {
      this.stemVoices[id]?.dispose();
      this.partScratches[id]?.stop();
    }
    this.stemVoices = {};
    this.stemBuffers = {};
    this.partScratchId = null;
    this.partLoopId = null;
    this.stemActive = false;
  }

  /**
   * Switches the deck to the four part voices. The playhead stays where it is
   * (it used to jump to 0). With `live`, a deck that is playing the full mix
   * keeps playing: the part voices start silent at the mix's position and the
   * two crossfade over ~15 ms, so progressive stems can arrive mid-track.
   */
  async loadStems(buffers: Partial<Record<PartId, AudioBuffer>>, options: { live?: boolean } = {}): Promise<void> {
    const at = this.currentTime;
    const mix = this.pcmBuffer;
    const live = Boolean(options.live && this.playing && !this.stemActive && this.pcmActive && mix && !this.scratching);
    if (!live) this.pause();
    this.clearStems();
    if (!live) {
      this.pcm.clear();
      this.pcmBuffer = null;
      this.pcmActive = false;
    }
    const loaded = PARTS.map((part) => part.id).filter((id) => Boolean(buffers[id]));
    if (!loaded.length) {
      this.emit();
      return;
    }
    const voices: PcmSource[] = [];
    for (const id of loaded) {
      const buffer = buffers[id];
      const node = this.partNodes[id];
      if (!buffer || !node) continue;
      this.stemBuffers[id] = buffer;
      this.partScratches[id]?.setBuffer(buffer);
      const voice = new PcmSource(this.ctx, node.filter, { onEnded: () => this.emit() });
      this.stemVoices[id] = voice;
      if (live) voice.output.gain.value = 0;
      voice.setRate(this.rate);
      voice.setKeylock(this.keylock);
      voice.setPitchShift(this.pitchShiftSemitones);
      const position = Math.max(0, Math.min(buffer.length - 1, Math.round(at * buffer.sampleRate)));
      await voice.load(buffer, position);
      voices.push(voice);
    }
    this.stemActive = true;
    this.applyPartGains();
    this.applyPcmLoop();
    if (live && mix) {
      await Promise.all(voices.map((voice) => voice.play()));
      // Line the parts up with where the mix is now (it kept playing while the
      // voices were built), then crossfade.
      const now = this.pcm.positionSamples;
      const fade = this.ctx.currentTime;
      for (const voice of voices) {
        voice.seek(Math.round((now / mix.sampleRate) * (this.stemBuffers.drums?.sampleRate ?? mix.sampleRate)));
        voice.output.gain.setTargetAtTime(1, fade, 0.004);
      }
      this.pcm.output.gain.setTargetAtTime(0, fade, 0.004);
      setTimeout(() => {
        if (this.pcmBuffer !== mix || !this.stemActive) return;
        this.pcm.clear();
        this.pcm.output.gain.cancelScheduledValues(this.ctx.currentTime);
        this.pcm.output.gain.value = 1;
        this.pcmBuffer = null;
        this.pcmActive = false;
      }, 160);
    }
    this.emit();
  }

  /**
   * Writes a finished region of separated parts into the playing stems
   * (progressive separation). Arrays are consumed (transferred to the audio
   * thread).
   */
  patchStems(start: number, parts: Partial<Record<PartId, [Float32Array, Float32Array]>>): void {
    if (!this.stemActive) return;
    for (const part of PARTS) {
      const data = parts[part.id];
      const buffer = this.stemBuffers[part.id];
      if (!data || !buffer || start >= buffer.length) continue;
      const [left, right] = data;
      buffer.copyToChannel(left as Float32Array<ArrayBuffer>, 0, start);
      if (buffer.numberOfChannels > 1) buffer.copyToChannel(right as Float32Array<ArrayBuffer>, 1, start);
      this.partScratches[part.id]?.patch(start, left, right);
      this.stemVoices[part.id]?.patch(start, left, right);
    }
  }

  /** Progressive separation finished: bring any lagging engine up to date. */
  finishStems(): void {
    for (const part of PARTS) this.stemVoices[part.id]?.flushPatches();
  }

  get partMixState(): PartMix {
    return {
      gain: { ...this.partMix.gain },
      muted: { ...this.partMix.muted },
      solo: this.partMix.solo,
    };
  }

  setPartGain(id: PartId, value: number): void {
    this.partMix.gain[id] = Math.max(0, Math.min(1.5, value));
    this.applyPartGains();
  }

  setPartMuted(id: PartId, muted: boolean): void {
    this.partMix.muted[id] = muted;
    this.applyPartGains();
  }

  setPartSolo(id: PartId | null): void {
    this.partMix.solo = id;
    this.applyPartGains();
  }

  get soloPart(): PartId | null {
    return this.partMix.solo;
  }

  setPartFilter(id: PartId, enabled: boolean): void {
    const node = this.partNodes[id];
    if (!node) return;
    const cutoff: Record<PartId, number> = { drums: 7000, bass: 350, other: 4000, vocals: 5000 };
    node.filter.type = "lowpass";
    node.filter.frequency.setTargetAtTime(enabled ? cutoff[id] : 20000, this.ctx.currentTime, 0.015);
    node.filter.Q.setTargetAtTime(enabled ? 9 : 0.7, this.ctx.currentTime, 0.015);
  }

  private applyPartGains(): void {
    const gains = partGains(this.partMix);
    for (const part of PARTS) {
      this.partNodes[part.id]?.gain.gain.setTargetAtTime(gains[part.id], this.ctx.currentTime, 0.01);
    }
  }

  get partScratching(): PartId | null {
    return this.partScratchId;
  }

  beginPartScratch(id: PartId): boolean {
    if (!this.stemActive || this.partScratchId) return false;
    const scratch = this.partScratches[id];
    const voice = this.stemVoices[id];
    if (!scratch?.hasBuffer || !voice?.hasBuffer) return false;
    this.partScratchId = id;
    voice.pause();
    scratch.stop();
    void scratch.start(this.currentTime);
    return true;
  }

  partScratchRate(rate: number): void {
    if (!this.partScratchId) return;
    this.partScratches[this.partScratchId]?.setRate(rate);
  }

  endPartScratch(): void {
    const id = this.partScratchId;
    if (!id) return;
    const scratch = this.partScratches[id];
    const voice = this.stemVoices[id];
    const wasPlaying = this.playing;
    scratch?.stop();
    this.partScratchId = null;
    const at = this.currentTime;
    const rate = voice?.hasBuffer ? this.stemBuffers[id]?.sampleRate ?? this.ctx.sampleRate : this.ctx.sampleRate;
    voice?.seek(Math.round(at * rate));
    if (wasPlaying) void voice?.play(Math.round(at * rate));
    this.emit();
  }

  get partLoop(): PartId | null {
    return this.partLoopId;
  }

  setPartLoop(id: PartId | null, start = 0, end = 0): void {
    this.partLoopId = id;
    if (id && end > start) {
      this.partLoopStart = Math.max(0, start);
      this.partLoopEnd = Math.min(this.duration || Infinity, end);
    }
    this.applyPcmLoop();
    this.emit();
  }

  setVocalsOnly(on: boolean): void {
    this.setPartSolo(on ? "vocals" : null);
  }

  get vocalsOnly(): boolean {
    return this.partMix.solo === "vocals";
  }

  setInstrumental(on: boolean): void {
    this.partMix.solo = null;
    this.partMix.muted.vocals = on;
    this.applyPartGains();
    this.emit();
  }

  get instrumental(): boolean {
    return this.partMix.muted.vocals && this.partMix.solo === null;
  }

  get scratchingActive(): boolean {
    return this.scratching;
  }

  beginScratch(): void {
    if (this.scratching) return;
    if (this.returnMode && !this.slipEngaged) {
      this.beginSlip(this.currentTime);
    }
    this.scratching = true;
    this.platter.reset();
    const nowPos = this.currentTime;
    if (this.stemActive) {
      for (const part of PARTS) {
        const ps = this.partScratches[part.id];
        if (ps?.hasBuffer) {
          ps.stop();
          void ps.start(nowPos);
        }
      }
    }
    this.scratch.stop();
    void this.scratch.start(nowPos);
  }

  scratchDrive(deltaDegrees: number, dt: number): void {
    if (!this.scratching) return;
    this.platter.drive((deltaDegrees * Math.PI) / 180, dt);
    this.scratch.setRate(this.platter.rate);
    if (this.stemActive) {
      for (const part of PARTS) this.partScratches[part.id]?.setRate(this.platter.rate);
    }
  }

  scratchCoast(dt: number): void {
    if (!this.scratching) return;
    this.platter.coast(dt);
    this.scratch.setRate(this.platter.rate);
    if (this.stemActive) {
      for (const part of PARTS) this.partScratches[part.id]?.setRate(this.platter.rate);
    }
  }

  scratchRate(rate: number): void {
    if (!this.scratching) return;
    this.scratch.setRate(rate);
    if (this.stemActive) {
      for (const part of PARTS) this.partScratches[part.id]?.setRate(rate);
    }
  }

  endScratch(): void {
    this.scratching = false;
    this.platter.reset();
    this.scratch.stop();
    if (this.stemActive) {
      for (const part of PARTS) this.partScratches[part.id]?.stop();
    }
    if (this.returnMode && this.slipEngaged) {
      this.endSlip();
    }
  }

  setReturnMode(enabled: boolean): void {
    this.returnMode = Boolean(enabled);
    if (!this.returnMode) {
      this.slipEngaged = false;
    }
    this.emit();
  }

  toggleReturnMode(): boolean {
    this.setReturnMode(!this.returnMode);
    return this.returnMode;
  }

  get slip(): boolean {
    return this.returnMode;
  }

  setSlip(enabled: boolean): void {
    this.setReturnMode(enabled);
  }

  get slipActive(): boolean {
    return this.slipEngaged;
  }

  get slipPositionSeconds(): number {
    if (!this.slipEngaged) return this.currentTime;
    return rollingReleasePosition(
      this.slipEntryPos,
      this.slipEntryMs,
      performance.now(),
      this.slipEntryRate,
      this.duration,
    );
  }

  beginSlip(atPosition = this.currentTime, nowMs = performance.now()): void {
    this.slipEngaged = true;
    this.slipEntryPos = atPosition;
    this.slipEntryMs = nowMs;
    this.slipEntryRate = this.rate;
    this.emit();
  }

  endSlip(nowMs = performance.now()): number {
    if (!this.slipEngaged) return this.currentTime;
    const target = rollingReleasePosition(
      this.slipEntryPos,
      this.slipEntryMs,
      nowMs,
      this.slipEntryRate,
      this.duration,
    );
    this.slipEngaged = false;
    this.seek(target);
    return target;
  }

  beginReturnAction(atPosition = this.currentTime, nowMs = performance.now()): void {
    if (!this.returnMode) return;
    this.beginSlip(atPosition, nowMs);
  }

  endReturnAction(nowMs = performance.now()): number {
    if (!this.returnMode || !this.slipEngaged) return this.currentTime;
    return this.endSlip(nowMs);
  }

  get censorActive(): boolean {
    return this.censorEngaged;
  }

  get censor(): boolean {
    return this.censorEngaged;
  }

  get reverseOnHoldActive(): boolean {
    return this.censorEngaged;
  }

  beginReverseOnHold(nowMs = performance.now()): void {
    if (this.censorEngaged) return;
    this.censorEngaged = true;
    this.censorEntryPos = this.currentTime;
    this.censorEntryMs = nowMs;
    this.censorForwardRate = Math.abs(this.rate) || 1;
    this.setRate(-this.censorForwardRate);
    this.emit();
  }

  endReverseOnHold(nowMs = performance.now()): number {
    if (!this.censorEngaged) return this.currentTime;
    const target = censorReleasePosition(
      this.censorEntryPos,
      this.censorEntryMs,
      nowMs,
      this.censorForwardRate,
      this.duration,
    );
    this.censorEngaged = false;
    this.setRate(this.censorForwardRate);
    this.seek(target);
    this.emit();
    return target;
  }

  beginCensor(nowMs = performance.now()): void {
    this.beginReverseOnHold(nowMs);
  }

  endCensor(nowMs = performance.now()): number {
    return this.endReverseOnHold(nowMs);
  }

  setCensor(active: boolean, nowMs = performance.now()): void {
    if (active) this.beginReverseOnHold(nowMs);
    else this.endReverseOnHold(nowMs);
  }

  get duration(): number {
    if (this.stemActive) {
      const buffer = Object.values(this.stemBuffers).find(Boolean);
      if (buffer) return buffer.duration;
    }
    if (this.pcmBuffer) return this.pcmBuffer.duration;
    return Number.isFinite(this.el.duration) ? this.el.duration : 0;
  }

  get currentTime(): number {
    if (this.stemActive) {
      const voice = this.stemReference();
      const buffer = voice ? Object.values(this.stemBuffers).find(Boolean) : null;
      if (voice && buffer) return voice.positionSamples / buffer.sampleRate;
      return 0;
    }
    if (this.pcmActive && this.pcmBuffer) {
      return this.pcm.positionSamples / this.pcmBuffer.sampleRate;
    }
    return this.el.currentTime;
  }

  get playing(): boolean {
    if (this.stemActive) return Boolean(this.stemReference()?.isPlaying);
    if (this.pcmActive) return this.pcm.isPlaying;
    return !this.el.paused && !this.el.ended;
  }

  get engine(): "media" | "pcm" {
    return this.stemActive || this.pcmActive ? "pcm" : "media";
  }

  private syncEngine(): void {
    if (!this.pcmBuffer) {
      if (this.pcmActive) {
        this.pcm.pause();
        this.pcmActive = false;
      }
      return;
    }
    if (!this.pcmActive) {
      const time = this.currentTime;
      const wasPlaying = this.playing;
      this.el.pause();
      this.pcmActive = true;
      this.pcm.seek(Math.round(time * this.pcmBuffer.sampleRate));
      this.pcm.setRate(this.rate);
      this.applyPcmLoop();
      if (wasPlaying) void this.pcm.play();
    } else {
      this.applyPcmLoop();
    }
  }

  private applyPcmLoop(): void {
    if (this.stemActive) {
      for (const part of PARTS) {
        const voice = this.stemVoices[part.id];
        const buffer = this.stemBuffers[part.id];
        if (!voice || !buffer) continue;
        const start = this.partLoopId ? this.partLoopStart : this.loopStart;
        const end = this.partLoopId ? this.partLoopEnd : this.loopEnd;
        const active = this.partLoopId ? this.partLoopId === part.id : this.loopActive;
        if (active && end > start) voice.setLoop(Math.round(start * buffer.sampleRate), Math.round(end * buffer.sampleRate));
        else voice.setLoop(null, null);
      }
      return;
    }
    if (!this.pcmBuffer) return;
    if (this.loopActive && this.loopEnd > this.loopStart) {
      this.pcm.setLoop(
        Math.round(this.loopStart * this.pcmBuffer.sampleRate),
        Math.round(this.loopEnd * this.pcmBuffer.sampleRate),
      );
    } else {
      this.pcm.setLoop(null, null);
    }
  }

  get hasTrack(): boolean {
    return this.duration > 0 && (this.pcmBuffer !== null || Boolean(this.el.src));
  }

  get trackEndWarning(): boolean {
    if (!this.playing || this.duration <= 0) return false;
    const remaining = this.duration - this.currentTime;
    return remaining > 0 && remaining <= 30;
  }

  get level(): number {
    const data = this.levelData;
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const value = (data[i] - 128) / 128;
      sum += value * value;
    }
    return Math.sqrt(sum / data.length);
  }

  async play(): Promise<void> {
    if (this.stemActive) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      if (this.currentTime >= this.duration - 0.05) this.seek(0);
      await Promise.all(PARTS.map((part) => {
        const voice = this.stemVoices[part.id];
        if (!voice?.hasBuffer || this.partScratchId === part.id) return Promise.resolve();
        return voice.play();
      }));
      this.emit();
      return;
    }
    if (!this.el.src && !this.pcmBuffer) return;
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.syncEngine();
    if (this.pcmActive) {
      if (this.currentTime >= this.duration - 0.05) this.seek(0);
      await this.pcm.play();
      // The PCM path fires no media-element "play" event, so nothing woke the
      // UI loop and the waveform stood still until a scratch emitted.
      this.emit();
      return;
    }
    try {
      await this.el.play();
    } catch {
      // interrupted by a new load
    }
  }

  pause(): void {
    this.el.pause();
    this.pcm.pause();
    for (const part of PARTS) this.stemVoices[part.id]?.pause();
    if (this.partScratchId) {
      this.partScratches[this.partScratchId]?.stop();
      this.partScratchId = null;
    }
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  seek(seconds: number): void {
    const limit = this.duration;
    const target = Math.max(0, Math.min(seconds, limit ? limit - 0.02 : 0));
    this.el.currentTime = target;
    if (this.stemActive) {
      for (const part of PARTS) {
        const voice = this.stemVoices[part.id];
        const buffer = this.stemBuffers[part.id];
        if (voice && buffer) voice.seek(Math.round(target * buffer.sampleRate));
      }
      this.emit();
      return;
    }
    if (this.pcmBuffer) this.pcm.seek(Math.round(target * this.pcmBuffer.sampleRate));
    this.emit();
  }

  setRate(rate: number): void {
    const clamped = Math.max(-4, Math.min(4, rate));
    this.rate = clamped;
    this.el.preservesPitch = this.keylock;
    if (clamped > 0) this.el.playbackRate = clamped;
    else this.el.pause();
    this.pcm.setRate(clamped);
    for (const part of PARTS) this.stemVoices[part.id]?.setRate(clamped);
    this.emit();
  }

  setTempoPercent(percent: number): void {
    this.tempoPercent = percent;
    this.setRate(1 + percent / 100);
  }

  get tempo(): number {
    return this.tempoPercent;
  }

  get playbackRate(): number {
    return this.rate;
  }

  setPitchRange(percent: number): void {
    this.pitchRange = percent;
    this.emit();
  }

  cyclePitchRange(): number {
    const ranges = [8, 16, 50];
    const idx = ranges.indexOf(this.pitchRange);
    this.pitchRange = ranges[(idx + 1) % ranges.length]!;
    this.emit();
    return this.pitchRange;
  }

  get pitchRangePercent(): number {
    return this.pitchRange;
  }

  setKeylock(enabled: boolean): void {
    this.keylock = enabled;
    this.el.preservesPitch = enabled;
    this.pcm.setKeylock(enabled);
    for (const part of PARTS) this.stemVoices[part.id]?.setKeylock(enabled);
    this.syncEngine();
    this.emit();
  }

  get pitchShift(): number {
    return this.pitchShiftSemitones;
  }

  setPitchShift(semitones: number): void {
    const clamped = Number.isFinite(semitones) ? Math.max(-12, Math.min(12, semitones)) : 0;
    this.pitchShiftSemitones = clamped;
    this.pcm.setPitchShift(clamped);
    for (const part of PARTS) this.stemVoices[part.id]?.setPitchShift(clamped);
    this.emit();
  }

  shiftKeySemitones(delta: number): number {
    this.setPitchShift(this.pitchShiftSemitones + delta);
    return this.pitchShiftSemitones;
  }

  resetKeyShift(): void {
    this.setPitchShift(0);
  }

  setReverse(enabled: boolean): void {
    this.setRate(enabled ? -Math.abs(this.rate) : Math.abs(this.rate));
  }

  nudge(deltaRate: number, durationMs = 180): void {
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    const baseRate = 1 + this.tempoPercent / 100;
    this.setRate(baseRate + deltaRate);
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      this.setRate(1 + this.tempoPercent / 100);
    }, Math.max(20, durationMs));
  }

  setLoadLock(locked: boolean): void {
    this.loadLock = Boolean(locked);
    this.emit();
  }

  setRepeat(enabled: boolean): void {
    this.repeatTrack = Boolean(enabled);
    this.el.loop = this.repeatTrack;
    this.emit();
  }

  get repeat(): boolean {
    return this.repeatTrack;
  }

  setAutoplay(enabled: boolean): void {
    this.autoplayNext = Boolean(enabled);
    this.emit();
  }

  setStartStopRamp(startMs: number, stopMs: number): void {
    this.startTimeMs = Math.max(0, Math.min(4000, startMs));
    this.stopTimeMs = Math.max(0, Math.min(4000, stopMs));
  }

  setPlaybackMode(mode: "INT" | "REL" | "ABS"): void {
    this.playbackMode = mode;
    this.emit();
  }

  driveTimecode(rate: number, positionSeconds: number | null): void {
    const clamped = Math.max(-4, Math.min(4, Number.isFinite(rate) ? rate : 0));
    const active = Math.abs(clamped) > 0.02;
    if (this.stemActive) {
      this.rate = clamped;
      this.el.preservesPitch = this.keylock;
      if (clamped > 0) this.el.playbackRate = clamped;
      for (const part of PARTS) {
        const voice = this.stemVoices[part.id];
        const buffer = this.stemBuffers[part.id];
        if (!voice || !buffer) continue;
        const pos = positionSeconds === null
          ? null
          : Math.round(positionSeconds * buffer.sampleRate);
        voice.drive(clamped, pos, active);
      }
      this.emit();
      return;
    }
    if (!this.pcmBuffer) {
      this.setRate(Math.max(0.02, clamped));
      if (positionSeconds !== null) this.seek(positionSeconds);
      if (active && !this.playing) void this.play();
      else if (!active) this.pause();
      return;
    }
    this.rate = clamped;
    this.el.preservesPitch = this.keylock;
    if (clamped > 0) this.el.playbackRate = clamped;
    const position = positionSeconds === null
      ? null
      : Math.round(positionSeconds * this.pcmBuffer.sampleRate);
    this.pcm.drive(clamped, position, active);
    this.emit();
  }

  get reversed(): boolean {
    return this.rate < 0;
  }

  get latencySeconds(): number {
    return this.pcm.latencySeconds;
  }

  get underruns(): number {
    return this.pcm.underruns;
  }

  get pitchPreserved(): boolean {
    return this.keylock && this.pcm.pitchPreserved;
  }

  get keylockOn(): boolean {
    return this.keylock;
  }

  private applyEqBand(band: "low" | "mid" | "high"): void {
    const killed = this.eqKill[band];
    const db = this.eqValuesDb[band];
    if (killed) {
      this.eq[band].gain.value = -60;
      return;
    }
    if (this.isolatorMode && db <= -17.5) {
      this.eq[band].gain.value = -60;
      return;
    }
    this.eq[band].gain.value = db;
  }

  setEq(band: "low" | "mid" | "high", db: number): void {
    this.eqValuesDb[band] = db;
    this.applyEqBand(band);
  }

  setEqKill(band: "low" | "mid" | "high", killed: boolean): void {
    this.eqKill[band] = Boolean(killed);
    this.applyEqBand(band);
    this.emit();
  }

  toggleEqKill(band: "low" | "mid" | "high"): boolean {
    this.setEqKill(band, !this.eqKill[band]);
    return this.eqKill[band];
  }

  setIsolatorMode(enabled: boolean): void {
    this.isolatorMode = Boolean(enabled);
    this.applyEqBand("low");
    this.applyEqBand("mid");
    this.applyEqBand("high");
    this.emit();
  }

  get eqIsolator(): boolean {
    return this.isolatorMode;
  }

  setEqIsolator(enabled: boolean): void {
    this.setIsolatorMode(enabled);
  }

  private applyTrimGain(): void {
    const dbFactor = Math.pow(10, this.trackGainDb / 20);
    this.trim.gain.value = this.trimLinear * dbFactor;
  }

  setTrim(value: number): void {
    this.trimLinear = value;
    this.applyTrimGain();
  }

  setTrackGainDb(db: number): void {
    this.trackGainDb = Number.isFinite(db) ? Math.max(-24, Math.min(24, db)) : 0;
    this.applyTrimGain();
    this.emit();
  }

  setChannelGain(value: number): void {
    this.fader.gain.value = value;
  }

  setCrossGain(value: number): void {
    this.cross.gain.value = value;
  }

  setStemGain(id: StemId, value: number): void {
    this.stemGains[id] = value;
    this.applyStemGains();
  }

  setStemMuted(id: StemId, muted: boolean): void {
    this.stemMuted[id] = muted;
    this.applyStemGains();
  }

  setStemSolo(id: StemId | null): void {
    this.stemSolo = id;
    this.applyStemGains();
  }

  setBandFilter(id: StemId, enabled: boolean): void {
    const cutoff: Record<StemId, number> = { low: 90, lowmid: 350, highmid: 2000, high: 7000 };
    const fx = this.bands[id].fx;
    fx.type = "lowpass";
    fx.frequency.setTargetAtTime(enabled ? cutoff[id] : 24000, this.ctx.currentTime, 0.015);
    fx.Q.setTargetAtTime(enabled ? 7 : 0.5, this.ctx.currentTime, 0.015);
  }

  private applyStemGains(): void {
    for (const id of Object.keys(this.bands) as StemId[]) {
      const soloed = this.stemSolo === null || this.stemSolo === id;
      const audible = soloed && !this.stemMuted[id];
      this.bands[id].gain.gain.setTargetAtTime(audible ? this.stemGains[id] : 0, this.ctx.currentTime, 0.01);
    }
  }

  setBpm(bpm: number, beatPhase = 0): void {
    if (this.beatgrid.locked) return;
    this.info.bpm = bpm;
    this.info.beatPhase = beatPhase;
    this.beatgrid = createBeatGrid(bpm, beatPhase, false, this.beatgrid.markers);
    this.tickFx();
    this.emit();
  }

  setBeatGrid(grid: EditableBeatGrid): void {
    this.beatgrid = {
      ...grid,
      markers: grid.markers.map((m) => ({ ...m })),
    };
    this.info.bpm = this.beatgrid.bpm;
    this.info.beatPhase = this.beatgrid.firstBeatSeconds;
    this.tickFx();
    this.emit();
  }

  get beatgridLocked(): boolean {
    return this.beatgrid.locked;
  }

  setBeatgridLocked(locked: boolean): void {
    this.beatgrid = setBeatGridLock(this.beatgrid, locked);
    this.emit();
  }

  toggleBeatgridLock(): boolean {
    this.beatgrid = toggleBeatGridLock(this.beatgrid);
    this.emit();
    return this.beatgrid.locked;
  }

  shiftGrid(deltaSeconds: number): void {
    if (this.beatgrid.locked) return;
    this.beatgrid = shiftBeatGrid(this.beatgrid, deltaSeconds);
    this.info.beatPhase = this.beatgrid.firstBeatSeconds;
    this.emit();
  }

  setGridDownbeatHere(): void {
    if (this.beatgrid.locked) return;
    this.beatgrid = setGridDownbeat(this.beatgrid, this.currentTime);
    this.info.beatPhase = this.beatgrid.firstBeatSeconds;
    this.emit();
  }

  adjustGridBpm(deltaBpm: number): void {
    if (this.beatgrid.locked) return;
    this.beatgrid = adjustBeatGridBpm(this.beatgrid, deltaBpm);
    this.info.bpm = this.beatgrid.bpm;
    this.tickFx();
    this.emit();
  }

  scaleGridBpm(factor: number): void {
    if (this.beatgrid.locked) return;
    this.beatgrid = scaleBeatGridBpm(this.beatgrid, factor);
    this.info.bpm = this.beatgrid.bpm;
    this.tickFx();
    this.emit();
  }

  tapGridBpm(nowMs = performance.now()): number {
    if (this.beatgrid.locked) return this.info.bpm;
    if (this.tapHistoryMs.length > 0 && nowMs - this.tapHistoryMs[this.tapHistoryMs.length - 1]! > 2500) {
      this.tapHistoryMs = [];
    }
    this.tapHistoryMs.push(nowMs);
    if (this.tapHistoryMs.length > 8) this.tapHistoryMs.shift();
    if (this.tapHistoryMs.length >= 2) {
      const tapped = tapBeatGridBpm(this.tapHistoryMs);
      if (tapped !== null) this.beatgrid = setBeatGridBpm(this.beatgrid, tapped);
      this.info.bpm = this.beatgrid.bpm;
      this.tickFx();
      this.emit();
    }
    return this.info.bpm;
  }

  tapBpm(nowMs = performance.now()): number {
    return this.tapGridBpm(nowMs);
  }

  setCustomFxChain(slots: CustomFxSlot[]): void {
    this.customFxChain = slots.slice(0, 3).map((s) => ({ ...s }));
    const activeSlot = this.customFxChain.find((s) => s.enabled && s.type !== "off");
    if (activeSlot) {
      this.fxDivision = activeSlot.division;
      this.fxAmount = activeSlot.amount;
      this.fxWet = activeSlot.wet;
      this.setFx(activeSlot.type);
    }
    this.emit();
  }

  setFx(type: FxType): void {
    if (type === this.fxType) return;
    this.fxType = type;
    this.buildChain(type);
    if (type !== "off" && this.fxWet <= 0) this.fxWet = fxDefault(type).wet;
    this.applyFxParams();
    this.emit();
  }

  get fx(): FxType {
    return this.fxType;
  }

  setFxDivision(division: Division): void {
    this.fxDivision = division;
    this.tickFx();
  }

  setFxAmount(amount: number): void {
    this.fxAmount = Math.max(0, Math.min(1, amount));
    this.applyFxParams();
  }

  setFxWet(wet: number): void {
    this.fxWet = wetGain(wet);
    this.applyFxParams();
  }

  private applyFxParams(): void {
    const chain = this.fxChain;
    const type = chain.type;
    if (type === "off") {
      // "off" is input -> dry/wet -> output with no effect between, so any wet
      // gain is a second copy of the dry signal (up to +4 dB into the limiter).
      chain.wet.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
      chain.dry.gain.setTargetAtTime(1, this.ctx.currentTime, 0.02);
      return;
    }
    chain.wet.gain.setTargetAtTime(this.fxWet, this.ctx.currentTime, 0.02);
    if (type === "filter" || type === "crush" || type === "tape-stop" || type === "brake") {
      chain.dry.gain.setTargetAtTime(type === "crush" ? 0.25 : 0, this.ctx.currentTime, 0.02);
    } else {
      chain.dry.gain.setTargetAtTime(1 - this.fxWet * 0.35, this.ctx.currentTime, 0.02);
    }
    if ((type === "filter" || type === "combo-filter-echo") && chain.filter) {
      const bipolar = this.fxAmount * 2 - 1;
      chain.filter.type = filterType(bipolar) as BiquadFilterType;
      chain.filter.frequency.setTargetAtTime(filterFrequency(bipolar), this.ctx.currentTime, 0.02);
      chain.filter.Q.value = 1 + this.fxAmount * 8;
    }
    if ((type === "echo" || type === "delay" || type === "combo-filter-echo") && chain.delay && chain.feedback) {
      const seconds = this.info.bpm > 0 ? delaySeconds(this.fxDivision, this.info.bpm) : 0.35;
      chain.delay.delayTime.setTargetAtTime(Math.min(3.8, seconds), this.ctx.currentTime, 0.05);
      chain.feedback.gain.setTargetAtTime(0.2 + this.fxAmount * 0.62, this.ctx.currentTime, 0.02);
    }
    if (type === "crush" && chain.shaper) chain.shaper.curve = crushCurve(0.15 + this.fxAmount * 0.8);
    if (type === "flanger" && chain.feedback) chain.feedback.gain.setTargetAtTime(0.2 + this.fxAmount * 0.7, this.ctx.currentTime, 0.02);
    if (type === "phaser" && chain.allpass) {
      chain.allpass.forEach((stage, i) => stage.frequency.setTargetAtTime(180 + this.fxAmount * (300 + i * 500), this.ctx.currentTime, 0.03));
    }
    if ((type === "tremolo" || type === "gate") && chain.lfoOsc && chain.lfoDepth) {
      chain.lfoOsc.frequency.setTargetAtTime(
        tremoloRateHz(this.fxDivision, this.info.bpm || 120),
        this.ctx.currentTime,
        0.02,
      );
      chain.lfoDepth.gain.setTargetAtTime(0.15 + this.fxAmount * 0.35, this.ctx.currentTime, 0.02);
    }
    if ((type === "tape-stop" || type === "brake") && chain.filter) {
      const sweepRate = tapeStopRate(this.fxAmount * this.fxWet);
      chain.filter.frequency.setTargetAtTime(Math.max(120, 16000 * sweepRate), this.ctx.currentTime, 0.03);
    }
  }

  private tickFx(): void {
    if (
      this.fxType === "echo" ||
      this.fxType === "delay" ||
      this.fxType === "combo-filter-echo" ||
      this.fxType === "tremolo" ||
      this.fxType === "gate"
    ) {
      this.applyFxParams();
    }
  }

  setCue(time: number): void {
    this.cuePoint = Math.max(0, Math.min(time, this.duration));
    this.emit();
  }

  jumpToCue(): void {
    this.seek(this.cuePoint);
  }

  setHotCue(index: number, time?: number): void {
    if (index < 0 || index >= 8) return;
    const at = time ?? this.currentTime;
    const snapped = this.quantize && this.info.bpm ? snapToBeat(at, this.info.bpm) : at;
    this.cueList[index] = { time: Math.max(0, Math.min(snapped, this.duration)), color: HOT_CUE_COLORS[index] };
    this.cueVersion += 1;
    this.emit();
  }

  clearHotCue(index: number): void {
    this.cueList[index] = null;
    this.cueVersion += 1;
    this.emit();
  }

  setHotCueStyle(index: number, style: { color?: string; name?: string }): void {
    const cue = this.cueList[index];
    if (!cue) return;
    if (style.color) cue.color = style.color;
    if (style.name !== undefined) cue.name = style.name.trim().slice(0, 32);
    this.cueVersion += 1;
    this.emit();
  }

  jumpHotCue(index: number): void {
    const cue = this.hotCues[index];
    if (!cue) {
      this.setHotCue(index);
      return;
    }
    if (this.returnMode && !this.slipEngaged) {
      this.beginSlip(this.currentTime);
    }
    this.seek(cue.time);
  }

  releaseHotCue(): void {
    if (this.returnMode && this.slipEngaged) {
      this.endSlip();
    }
  }

  setLoop(start: number, beats: number, active = true): void {
    const bpm = this.info.bpm || 120;
    const length = loopSeconds(bpm, beats);
    const startTime = this.quantize ? nearestBeat(start, bpm, this.info.beatPhase) : start;
    this.loopBeats = beats;
    this.loopStart = Math.max(0, startTime);
    this.loopEnd = Math.min(this.duration || Infinity, this.loopStart + length);
    this.loopActive = active;
    this.applyPcmLoop();
    if (active) this.seek(this.loopStart);
    this.emit();
  }

  setLoopRange(start: number, end: number, active = false): void {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    this.loopStart = Math.max(0, start);
    this.loopEnd = Math.min(this.duration || Infinity, end);
    this.loopActive = active;
    const bpm = this.info.bpm;
    if (bpm > 0) this.loopBeats = Math.max(1 / 8, (this.loopEnd - this.loopStart) / beatSeconds(bpm));
    this.applyPcmLoop();
    if (active) this.seek(this.loopStart);
    this.emit();
  }

  toggleLoop(): void {
    if (!this.loopEnd) {
      this.setLoop(this.currentTime, this.loopBeats, true);
      return;
    }
    this.loopActive = !this.loopActive;
    this.applyPcmLoop();
    if (this.loopActive) this.seek(this.loopStart);
    this.emit();
  }

  setLoopBeats(beats: number): void {
    this.loopBeats = beats;
    if (this.loopActive) this.setLoop(this.loopStart, beats, true);
    else this.emit();
  }

  halveLoop(): void {
    const next = Math.max(1 / 8, this.loopBeats / 2);
    this.setLoopBeats(next);
  }

  doubleLoop(): void {
    const next = Math.min(32, this.loopBeats * 2);
    this.setLoopBeats(next);
  }

  shiftLoop(beats: number): void {
    if (!this.loopEnd) return;
    const delta = beatSeconds(this.info.bpm || 120) * beats;
    this.setLoop(this.loopStart + delta, this.loopBeats, this.loopActive);
  }

  beatJump(beats: number): void {
    const bpm = this.info.bpm || 120;
    this.seek(this.currentTime + beatSeconds(bpm) * beats);
    if (this.loopActive) {
      this.loopStart += beatSeconds(bpm) * beats;
      this.loopEnd += beatSeconds(bpm) * beats;
      this.applyPcmLoop();
    }
  }

  setQuantize(enabled: boolean): void {
    this.quantize = enabled;
  }

  tick(): void {
    if (this.destroyed) return;
    if (this.stemActive) {
      for (const part of PARTS) this.stemVoices[part.id]?.tick();
      this.emit();
      return;
    }
    if (this.pcmActive) this.pcm.tick();
    if (!this.pcmActive && this.loopActive && this.loopEnd > this.loopStart && this.playing) {
      if (this.currentTime >= this.loopEnd - 0.005 || this.currentTime < this.loopStart - 0.5) {
        this.seek(this.loopStart);
      }
    }
    this.emit();
  }

  state(): DeckState {
    const state =
      this.stateCache ??
      (this.stateCache = {
        playing: false,
        currentTime: 0,
        duration: 0,
        rate: 1,
        tempoPercent: 0,
        bpm: 0,
        loopActive: false,
        loopStart: 0,
        loopEnd: 0,
        loopBeats: 4,
        cue: 0,
        hotCues: this.cueList,
        fx: "off",
        fxWet: 0,
        keylock: true,
        title: "",
      });
    state.playing = this.playing;
    state.currentTime = this.currentTime;
    state.duration = this.duration;
    state.rate = this.rate;
    state.tempoPercent = this.tempoPercent;
    state.bpm = this.info.bpm;
    state.loopActive = this.loopActive;
    state.loopStart = this.loopStart;
    state.loopEnd = this.loopEnd;
    state.loopBeats = this.loopBeats;
    state.cue = this.cuePoint;
    state.hotCues = this.cueList;
    state.fx = this.fxType;
    state.fxWet = this.fxWet;
    state.keylock = this.keylock;
    state.title = this.info.title;
    state.pitchShift = this.pitchShiftSemitones;
    state.returnMode = this.returnMode;
    state.slipActive = this.slipEngaged;
    state.censorActive = this.censorEngaged;
    state.beatgridLocked = this.beatgrid.locked;
    state.trackEndWarning = this.trackEndWarning;
    return state;
  }

  private emit(): void {
    this.onUpdate?.(this.state());
  }

  destroy(): void {
    this.destroyed = true;
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    this.el.pause();
    this.el.src = "";
    this.scratch.dispose();
    for (const part of PARTS) {
      this.partScratches[part.id]?.dispose();
      this.stemVoices[part.id]?.dispose();
    }
    this.pcm.clear();
    this.pcm.dispose();
    this.teardownFx();
    this.source.disconnect();
    this.analyser.disconnect();
  }
}

import { beatSeconds, nearestBeat, snapToBeat, loopSeconds } from "./beatgrid.ts";
import { defaultStemGains, STEM_CROSSOVERS, type StemId } from "./stems.ts";
import { fxDefault, filterFrequency, filterType, crushCurve, delaySeconds, wetGain, type Division, type FxType } from "./fx.ts";
import { ScratchVoice } from "./scratch-voice.ts";
import { PcmSource } from "./pcm-source.ts";
import { Platter } from "./platter.ts";

export type DeckId = "A" | "B";

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
  private bands: Record<StemId, { nodes: AudioNode[]; gain: GainNode }>;
  private stemBus: GainNode;
  private trim: GainNode;
  private eq: { low: BiquadFilterNode; mid: BiquadFilterNode; high: BiquadFilterNode };
  private fader: GainNode;
  private cross: GainNode;
  private fxChain: FxChain;
  private analyser: AnalyserNode;
  private scratch: ScratchVoice;
  private scratching = false;
  private readonly platter = new Platter();

  cuePoint = 0;
  loopStart = 0;
  loopEnd = 0;
  loopBeats = 4;
  loopActive = false;
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
      onEnded: () => this.emit(),
    });
    this.splitter = ctx.createChannelSplitter(2);

    this.stemBus = ctx.createGain();
    this.bands = {} as Record<StemId, { nodes: AudioNode[]; gain: GainNode }>;

    const makeBand = (nodes: AudioNode[]): { nodes: AudioNode[]; gain: GainNode } => {
      const gain = ctx.createGain();
      let last: AudioNode = this.deckInput;
      const chain: AudioNode[] = [];
      for (const node of nodes) {
        last.connect(node);
        chain.push(node);
        last = node;
      }
      last.connect(gain);
      gain.connect(this.stemBus);
      return { nodes: chain, gain };
    };

    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = STEM_CROSSOVERS.low;
    low.Q.value = 0.7;

    const lowmidHp = ctx.createBiquadFilter();
    lowmidHp.type = "highpass";
    lowmidHp.frequency.value = STEM_CROSSOVERS.low;
    lowmidHp.Q.value = 0.7;
    const lowmidLp = ctx.createBiquadFilter();
    lowmidLp.type = "lowpass";
    lowmidLp.frequency.value = STEM_CROSSOVERS.lowmid;
    lowmidLp.Q.value = 0.7;

    const highmidHp = ctx.createBiquadFilter();
    highmidHp.type = "highpass";
    highmidHp.frequency.value = STEM_CROSSOVERS.lowmid;
    highmidHp.Q.value = 0.7;
    const highmidLp = ctx.createBiquadFilter();
    highmidLp.type = "lowpass";
    highmidLp.frequency.value = STEM_CROSSOVERS.highmid;
    highmidLp.Q.value = 0.7;

    const high = ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = STEM_CROSSOVERS.highmid;
    high.Q.value = 0.7;

    this.bands.low = makeBand([low]);
    this.bands.lowmid = makeBand([lowmidHp, lowmidLp]);
    this.bands.highmid = makeBand([highmidHp, highmidLp]);
    this.bands.high = makeBand([high]);

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

    this.el.addEventListener("ended", () => this.emit());
    this.el.addEventListener("play", () => this.emit());
    this.el.addEventListener("pause", () => this.emit());
    this.setFx("off");
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
    const ctx = this.ctx;
    const input = ctx.createGain();
    const output = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    input.connect(dry);
    dry.connect(output);
    input.connect(wet);
    wet.connect(output);
    return { input, output, dry, wet, nodes: [], lfos: [], type: "off" };
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
    this.pause();
    this.pcm.clear();
    this.pcmBuffer = null;
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
      const buffer = await this.ctx.decodeAudioData(data);
      this.pcmBuffer = buffer;
      this.scratch.setBuffer(buffer);
      await this.pcm.load(buffer, 0);
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
    Object.assign(this.info, {
      id: info.id ?? (typeof source === "string" ? source : source.name),
      title: info.title ?? (typeof source === "string" ? source : source.name.replace(/\.[^.]+$/, "")),
      bpm: info.bpm ?? 0,
      beatPhase: info.beatPhase ?? 0,
      key: info.key ?? "--",
      camelot: info.camelot ?? "--",
    });
    this.emit();
  }

  get scratchReady(): boolean {
    return this.scratch.hasBuffer;
  }

  get scratchingActive(): boolean {
    return this.scratching;
  }

  beginScratch(): void {
    if (this.scratching) return;
    this.scratching = true;
    this.platter.reset();
    this.scratch.stop();
    void this.scratch.start(this.currentTime);
  }

  scratchDrive(deltaDegrees: number, dt: number): void {
    if (!this.scratching) return;
    this.platter.drive((deltaDegrees * Math.PI) / 180, dt);
    this.scratch.setRate(this.platter.rate);
  }

  scratchCoast(dt: number): void {
    if (!this.scratching) return;
    this.platter.coast(dt);
    this.scratch.setRate(this.platter.rate);
  }

  scratchRate(rate: number): void {
    if (!this.scratching) return;
    this.scratch.setRate(rate);
  }

  endScratch(): void {
    this.scratching = false;
    this.platter.reset();
    this.scratch.stop();
  }

  get duration(): number {
    if (this.pcmBuffer) return this.pcmBuffer.duration;
    return Number.isFinite(this.el.duration) ? this.el.duration : 0;
  }

  get currentTime(): number {
    if (this.pcmActive && this.pcmBuffer) {
      return this.pcm.positionSamples / this.pcmBuffer.sampleRate;
    }
    return this.el.currentTime;
  }

  get playing(): boolean {
    if (this.pcmActive) return this.pcm.isPlaying;
    return !this.el.paused && !this.el.ended;
  }

  get engine(): "media" | "pcm" {
    return this.pcmActive ? "pcm" : "media";
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
    if (!this.el.src && !this.pcmBuffer) return;
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.syncEngine();
    if (this.pcmActive) {
      if (this.currentTime >= this.duration - 0.05) this.seek(0);
      await this.pcm.play();
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
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  seek(seconds: number): void {
    const limit = this.duration;
    const target = Math.max(0, Math.min(seconds, limit ? limit - 0.02 : 0));
    this.el.currentTime = target;
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
  }

  get pitchRangePercent(): number {
    return this.pitchRange;
  }

  setKeylock(enabled: boolean): void {
    this.keylock = enabled;
    this.el.preservesPitch = enabled;
    this.pcm.setKeylock(enabled);
    this.syncEngine();
    this.emit();
  }

  setReverse(enabled: boolean): void {
    this.setRate(enabled ? -Math.abs(this.rate) : Math.abs(this.rate));
  }

  driveTimecode(rate: number, positionSeconds: number | null): void {
    const clamped = Math.max(-4, Math.min(4, Number.isFinite(rate) ? rate : 0));
    const active = Math.abs(clamped) > 0.02;
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

  setEq(band: "low" | "mid" | "high", db: number): void {
    this.eq[band].gain.value = db;
  }

  setTrim(value: number): void {
    this.trim.gain.value = value;
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

  private applyStemGains(): void {
    for (const id of Object.keys(this.bands) as StemId[]) {
      const soloed = this.stemSolo === null || this.stemSolo === id;
      const audible = soloed && !this.stemMuted[id];
      this.bands[id].gain.gain.setTargetAtTime(audible ? this.stemGains[id] : 0, this.ctx.currentTime, 0.01);
    }
  }

  setBpm(bpm: number, beatPhase = 0): void {
    this.info.bpm = bpm;
    this.info.beatPhase = beatPhase;
    this.tickFx();
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
    chain.wet.gain.setTargetAtTime(this.fxWet, this.ctx.currentTime, 0.02);
    if (type === "filter" || type === "crush") {
      chain.dry.gain.setTargetAtTime(type === "crush" ? 0.25 : 0, this.ctx.currentTime, 0.02);
    } else {
      chain.dry.gain.setTargetAtTime(1 - this.fxWet * 0.35, this.ctx.currentTime, 0.02);
    }
    if (type === "filter" && chain.filter) {
      const bipolar = this.fxAmount * 2 - 1;
      chain.filter.type = filterType(bipolar) as BiquadFilterType;
      chain.filter.frequency.setTargetAtTime(filterFrequency(bipolar), this.ctx.currentTime, 0.02);
      chain.filter.Q.value = 1 + this.fxAmount * 8;
    }
    if ((type === "echo" || type === "delay") && chain.delay && chain.feedback) {
      const seconds = this.info.bpm > 0 ? delaySeconds(this.fxDivision, this.info.bpm) : 0.35;
      chain.delay.delayTime.setTargetAtTime(Math.min(3.8, seconds), this.ctx.currentTime, 0.05);
      chain.feedback.gain.setTargetAtTime(0.2 + this.fxAmount * 0.62, this.ctx.currentTime, 0.02);
    }
    if (type === "crush" && chain.shaper) chain.shaper.curve = crushCurve(0.15 + this.fxAmount * 0.8);
    if (type === "flanger" && chain.feedback) chain.feedback.gain.setTargetAtTime(0.2 + this.fxAmount * 0.7, this.ctx.currentTime, 0.02);
    if (type === "phaser" && chain.allpass) {
      chain.allpass.forEach((stage, i) => stage.frequency.setTargetAtTime(180 + this.fxAmount * (300 + i * 500), this.ctx.currentTime, 0.03));
    }
  }

  private tickFx(): void {
    if (this.fxType === "echo" || this.fxType === "delay") this.applyFxParams();
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

  jumpHotCue(index: number): void {
    const cue = this.hotCues[index];
    if (!cue) {
      this.setHotCue(index);
      return;
    }
    this.seek(cue.time);
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
    return state;
  }

  private emit(): void {
    this.onUpdate?.(this.state());
  }

  destroy(): void {
    this.destroyed = true;
    this.el.pause();
    this.el.src = "";
    this.scratch.dispose();
    this.pcm.clear();
    this.pcm.dispose();
    this.teardownFx();
    this.source.disconnect();
    this.analyser.disconnect();
  }
}

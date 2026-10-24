import { Deck, type DeckId } from "./deck.ts";

export type CrossfaderCurve = "smooth" | "fast" | "cut";
export type ChannelFaderCurve = "linear" | "log" | "logarithmic" | "sharp";
export type CrossfaderAssign = "A" | "B" | "THRU";

export interface CrossfaderGains {
  a: number;
  b: number;
  c: number;
  d: number;
}

export function crossfaderGains(
  value: number,
  curve: CrossfaderCurve = "smooth",
  reversed = false,
): CrossfaderGains {
  const raw = Math.max(0, Math.min(1, value));
  const x = reversed ? 1 - raw : raw;
  let left = 0;
  let right = 0;
  if (curve === "cut") {
    left = x <= 0.92 ? 1 : 0;
    right = x >= 0.08 ? 1 : 0;
    if (value < 0.5 && !reversed) right = 0;
    else if (value >= 0.5 && !reversed) left = 0;
    else if (reversed) {
      left = x < 0.5 ? 1 : 0;
      right = x < 0.5 ? 0 : 1;
    }
  } else if (curve === "fast") {
    left = Math.pow(1 - x, 2);
    right = Math.pow(x, 2);
  } else {
    left = Math.cos((x * Math.PI) / 2);
    right = Math.sin((x * Math.PI) / 2);
  }
  return { a: left, b: right, c: left, d: right };
}

export function channelFaderGain(value: number, curve: ChannelFaderCurve = "linear"): number {
  const x = Math.max(0, Math.min(1, value));
  if (curve === "log" || curve === "logarithmic") return Math.pow(x, 2.2);
  if (curve === "sharp") return x > 0.05 ? Math.pow(x, 0.55) : (x / 0.05) * Math.pow(0.05, 0.55);
  return x;
}

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  seconds: number;
}

export class Mixer {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly booth: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly streamDest: MediaStreamAudioDestinationNode;
  readonly masterAnalyser: AnalyserNode;
  readonly decks: Partial<Record<DeckId, Deck>> = {};
  private readonly levelData = new Uint8Array(256);

  private auxGain: GainNode;
  private auxSource: MediaStreamAudioSourceNode | null = null;
  private auxStream: MediaStream | null = null;
  private crossValue = 0.5;
  private crossCurve: CrossfaderCurve = "smooth";
  private crossReversed = false;
  private chanCurve: ChannelFaderCurve = "linear";
  private deckAssign: Record<DeckId, CrossfaderAssign> = {
    A: "A",
    B: "B",
    C: "A",
    D: "B",
  };
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private recordStartedAt = 0;
  private recordMime = "";

  constructor() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;

    this.booth = this.ctx.createGain();
    this.booth.gain.value = 0.8;

    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 14;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    this.streamDest = this.ctx.createMediaStreamDestination();
    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this.masterAnalyser.smoothingTimeConstant = 0.55;

    this.master.connect(this.limiter);
    this.master.connect(this.booth);
    this.limiter.connect(this.ctx.destination);
    this.limiter.connect(this.streamDest);
    this.limiter.connect(this.masterAnalyser);

    this.auxGain = this.ctx.createGain();
    this.auxGain.gain.value = 0.8;
    this.auxGain.connect(this.master);
  }

  deck(id: DeckId): Deck {
    if (!this.decks[id]) {
      this.decks[id] = new Deck(this.ctx, id, this.master);
      this.applyCrossfader();
    }
    return this.decks[id]!;
  }

  private applyCrossfader(): void {
    const gains = crossfaderGains(this.crossValue, this.crossCurve, this.crossReversed);
    for (const id of ["A", "B", "C", "D"] as const) {
      const deck = this.decks[id];
      if (!deck) continue;
      const assign = this.deckAssign[id];
      if (assign === "THRU") deck.setCrossGain(1);
      else if (assign === "A") deck.setCrossGain(gains.a);
      else deck.setCrossGain(gains.b);
    }
  }

  setCrossfader(value: number, curve: CrossfaderCurve = this.crossCurve): void {
    this.crossValue = Math.max(0, Math.min(1, value));
    this.crossCurve = curve;
    this.applyCrossfader();
  }

  setCrossfaderReverse(reversed: boolean): void {
    this.crossReversed = Boolean(reversed);
    this.applyCrossfader();
  }

  get crossfaderReverse(): boolean {
    return this.crossReversed;
  }

  setDeckAssign(id: DeckId, assign: CrossfaderAssign): void {
    this.deckAssign[id] = assign;
    this.applyCrossfader();
  }

  getDeckAssign(id: DeckId): CrossfaderAssign {
    return this.deckAssign[id];
  }

  setChannelCurve(curve: ChannelFaderCurve): void {
    this.chanCurve = curve;
  }

  get channelCurve(): ChannelFaderCurve {
    return this.chanCurve;
  }

  setMaster(value: number): void {
    this.master.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
  }

  setBoothGain(value: number): void {
    this.booth.gain.setTargetAtTime(Math.max(0, Math.min(1.5, value)), this.ctx.currentTime, 0.01);
  }

  get boothGainValue(): number {
    return this.booth.gain.value;
  }

  get limiterReductionDb(): number {
    return typeof this.limiter.reduction === "number" ? this.limiter.reduction : 0;
  }

  get limiterActive(): boolean {
    return this.limiterReductionDb < -0.5;
  }

  limiterWarning(): boolean {
    return this.limiterActive;
  }

  get crossfader(): number {
    return this.crossValue;
  }

  get crossfaderStyle(): CrossfaderCurve {
    return this.crossCurve;
  }

  setAuxStream(stream: MediaStream | null): void {
    this.auxSource?.disconnect();
    for (const track of this.auxStream?.getTracks() ?? []) track.stop();
    this.auxSource = null;
    this.auxStream = stream;
    if (stream) {
      this.auxSource = this.ctx.createMediaStreamSource(stream);
      this.auxSource.connect(this.auxGain);
    }
  }

  setAuxGain(value: number): void {
    this.auxGain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
  }

  hasAux(): boolean {
    return Boolean(this.auxSource);
  }

  getStream(): MediaStream {
    return this.streamDest.stream;
  }

  level(): number {
    const data = this.levelData;
    this.masterAnalyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const value = (data[i] - 128) / 128;
      sum += value * value;
    }
    return Math.sqrt(sum / data.length);
  }

  async resume(): Promise<void> {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  get recording(): boolean {
    return this.recorder?.state === "recording";
  }

  startRecording(): void {
    if (this.recorder) return;
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find(
      (type) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type),
    );
    this.recordMime = mime ?? "";
    this.chunks = [];
    this.recorder = new MediaRecorder(this.getStream(), mime ? { mimeType: mime, audioBitsPerSecond: 256000 } : undefined);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size) this.chunks.push(event.data);
    };
    this.recorder.start(500);
    this.recordStartedAt = Date.now();
  }

  stopRecording(): Promise<RecordingResult | null> {
    const recorder = this.recorder;
    if (!recorder) return Promise.resolve(null);
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.recordMime || "audio/webm" });
        const result: RecordingResult = {
          blob,
          mimeType: this.recordMime || "audio/webm",
          seconds: (Date.now() - this.recordStartedAt) / 1000,
        };
        this.recorder = null;
        this.chunks = [];
        resolve(result);
      };
      recorder.stop();
    });
  }

  get recordedSeconds(): number {
    return this.recordStartedAt ? (Date.now() - this.recordStartedAt) / 1000 : 0;
  }

  destroy(): void {
    this.setAuxStream(null);
    this.recorder?.stop();
    this.master.disconnect();
  }
}

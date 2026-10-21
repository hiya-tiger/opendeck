import { Deck, type DeckId } from "./deck.ts";

export type CrossfaderCurve = "smooth" | "fast" | "cut";

export interface CrossfaderGains {
  a: number;
  b: number;
}

export function crossfaderGains(value: number, curve: CrossfaderCurve = "smooth"): CrossfaderGains {
  const x = Math.max(0, Math.min(1, value));
  if (curve === "cut") {
    return x < 0.5 ? { a: 1, b: 0 } : { a: 0, b: 1 };
  }
  if (curve === "fast") {
    return { a: Math.pow(1 - x, 2), b: Math.pow(x, 2) };
  }
  return { a: Math.cos((x * Math.PI) / 2), b: Math.sin((x * Math.PI) / 2) };
}

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  seconds: number;
}

export class Mixer {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly streamDest: MediaStreamAudioDestinationNode;
  readonly masterAnalyser: AnalyserNode;
  readonly decks: Partial<Record<DeckId, Deck>> = {};

  private auxGain: GainNode;
  private auxSource: MediaStreamAudioSourceNode | null = null;
  private auxStream: MediaStream | null = null;
  private crossValue = 0.5;
  private crossCurve: CrossfaderCurve = "smooth";
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private recordStartedAt = 0;
  private recordMime = "";

  constructor() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;

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
    this.limiter.connect(this.ctx.destination);
    this.limiter.connect(this.streamDest);
    this.limiter.connect(this.masterAnalyser);

    this.auxGain = this.ctx.createGain();
    this.auxGain.gain.value = 0.8;
    this.auxGain.connect(this.master);
  }

  deck(id: DeckId): Deck {
    if (!this.decks[id]) this.decks[id] = new Deck(this.ctx, id, this.master);
    return this.decks[id]!;
  }

  setCrossfader(value: number, curve: CrossfaderCurve = this.crossCurve): void {
    this.crossValue = Math.max(0, Math.min(1, value));
    this.crossCurve = curve;
    const gains = crossfaderGains(this.crossValue, curve);
    this.decks.A?.setCrossGain(gains.a);
    this.decks.B?.setCrossGain(gains.b);
  }

  setMaster(value: number): void {
    this.master.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
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
    const data = new Uint8Array(this.masterAnalyser.fftSize);
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

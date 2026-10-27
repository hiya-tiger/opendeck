import type { StretchNode } from "signalsmith-stretch";

export const WORKLET_SOURCE = `
class OpenDeckPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = null;
    this.right = null;
    this.position = 0;
    this.rate = 1;
    this.gain = 1;
    this.playing = false;
    this.loopStart = -1;
    this.loopEnd = -1;
    this.frames = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data.type === "buffer") {
        this.left = data.left;
        this.right = data.right;
        this.position = data.position || 0;
        this.playing = false;
      } else if (data.type === "play") {
        if (data.position !== undefined) this.position = data.position;
        this.playing = true;
      } else if (data.type === "pause") {
        this.playing = false;
        this.port.postMessage({ type: "position", position: this.position });
      } else if (data.type === "seek") {
        this.position = data.position;
        this.port.postMessage({ type: "position", position: this.position });
      } else if (data.type === "rate") {
        this.rate = data.rate;
      } else if (data.type === "gain") {
        this.gain = data.gain;
      } else if (data.type === "loop") {
        this.loopStart = data.start;
        this.loopEnd = data.end;
      } else if (data.type === "clear") {
        this.left = null;
        this.right = null;
        this.playing = false;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const leftOut = out[0];
    const rightOut = out[1] || out[0];
    const left = this.left;
    const right = this.right;
    if (!left || !this.playing) {
      leftOut.fill(0);
      if (rightOut !== leftOut) rightOut.fill(0);
      return true;
    }
    const last = left.length - 1;
    const gain = this.gain;
    let position = this.position;
    for (let i = 0; i < leftOut.length; i += 1) {
      if (position < 0 || position > last) {
        if (this.loopStart < 0) {
          this.playing = false;
          leftOut[i] = 0;
          rightOut[i] = 0;
          continue;
        }
        this.wrap();
      }
      const index = position | 0;
      if (index >= last) {
        leftOut[i] = left[last] * gain;
        rightOut[i] = right[last] * gain;
      } else {
        const frac = position - index;
        leftOut[i] = (left[index] + (left[index + 1] - left[index]) * frac) * gain;
        rightOut[i] = (right[index] + (right[index + 1] - right[index]) * frac) * gain;
      }
      position += this.rate;
      if (this.loopStart >= 0) {
        if (this.rate >= 0) {
          if (position >= this.loopEnd) {
            position = this.loopStart + ((position - this.loopStart) % (this.loopEnd - this.loopStart));
          }
        } else if (position < this.loopStart) {
          position = this.loopEnd - ((this.loopEnd - position) % (this.loopEnd - this.loopStart));
        }
      }
    }
    this.position = position;
    if ((this.frames++ & 15) === 0 || !this.playing) {
      this.port.postMessage({ type: "position", position });
    }
    if (this.loopStart < 0 && (position < 0 || position > last)) {
      if (this.playing) this.port.postMessage({ type: "ended" });
      this.playing = false;
    }
    return true;
  }

  wrap() {
    const length = this.loopEnd - this.loopStart;
    if (length <= 0) { this.playing = false; return; }
    if (this.rate >= 0) {
      if (this.position >= this.loopEnd) {
        this.position = this.loopStart + ((this.position - this.loopStart) % length);
      }
    } else if (this.position < this.loopStart) {
      this.position = this.loopEnd - ((this.loopEnd - this.position) % length);
    }
  }
}
registerProcessor("opendeck-pcm", OpenDeckPcmProcessor);
`;

export interface PcmSourceOptions {
  gain?: number;
  onEnded?: () => void;
  onPosition?: (samples: number) => void;
}

class WorkletPcmSource {
  private readonly ctx: AudioContext;
  private readonly gainNode: GainNode;
  private node: AudioWorkletNode | null = null;
  private ready: Promise<void> | null = null;
  private left: Float32Array | null = null;
  private right: Float32Array | null = null;
  private loaded = false;
  private playing = false;
  private position = 0;
  private rate = 1;
  private loop: { start: number; end: number } | null = null;
  private options: PcmSourceOptions;

  constructor(ctx: AudioContext, destination: AudioNode, options: PcmSourceOptions = {}) {
    this.ctx = ctx;
    this.options = options;
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = options.gain ?? 1;
    this.gainNode.connect(destination);
  }

  get hasBuffer(): boolean {
    return this.loaded;
  }

  get output(): GainNode {
    return this.gainNode;
  }

  get positionSamples(): number {
    return this.position;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  setGain(gain: number): void {
    this.gainNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
  }

  load(buffer: AudioBuffer, position = 0): void {
    const left = buffer.getChannelData(0).slice();
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : left.slice();
    this.left = left;
    this.right = right;
    this.loaded = true;
    this.playing = false;
    this.position = position;
    this.sendBuffer(position);
  }

  private sendBuffer(position: number): void {
    if (!this.node || !this.left || !this.right) return;
    this.node.port.postMessage(
      { type: "buffer", left: this.left, right: this.right, position },
      [this.left.buffer, this.right.buffer],
    );
    this.left = null;
    this.right = null;
  }

  clear(): void {
    this.left = null;
    this.right = null;
    this.loaded = false;
    this.playing = false;
    this.position = 0;
    this.node?.port.postMessage({ type: "clear" });
  }

  private prepare(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (!this.ctx.audioWorklet) throw new Error("AudioWorklet is not available");
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
      try {
        await this.ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(this.ctx, "opendeck-pcm", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.port.onmessage = (event) => {
        if (event.data?.type === "position") {
          this.position = event.data.position;
          this.options.onPosition?.(this.position);
        } else if (event.data?.type === "ended") {
          this.playing = false;
          this.options.onEnded?.();
        }
      };
      node.connect(this.gainNode);
      node.port.postMessage({ type: "rate", rate: this.rate });
      if (this.loop) node.port.postMessage({ type: "loop", start: this.loop.start, end: this.loop.end });
      this.node = node;
      this.sendBuffer(this.position);
    })();
    return this.ready;
  }

  async play(position?: number): Promise<void> {
    if (!this.loaded) return;
    try {
      await this.prepare();
    } catch {
      return;
    }
    if (!this.node) return;
    if (position !== undefined) this.position = position;
    this.playing = true;
    this.node.port.postMessage({ type: "play", position: this.position });
  }

  pause(): void {
    this.playing = false;
    this.node?.port.postMessage({ type: "pause" });
  }

  seek(position: number): void {
    this.position = position;
    this.node?.port.postMessage({ type: "seek", position });
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.node?.port.postMessage({ type: "rate", rate });
  }

  setLoop(start: number | null, end: number | null): void {
    this.loop = start === null || end === null || end <= start ? null : { start, end };
    if (this.loop) this.node?.port.postMessage({ type: "loop", start: this.loop.start, end: this.loop.end });
    else this.node?.port.postMessage({ type: "loop", start: -1, end: -1 });
  }

  dispose(): void {
    this.pause();
    this.node?.disconnect();
    this.gainNode.disconnect();
    this.node = null;
  }
}

export class PcmSource {
  private readonly ctx: AudioContext;
  private readonly gainNode: GainNode;
  private readonly destination: AudioNode;
  private stretch: StretchNode | null = null;
  private fallback: WorkletPcmSource | null = null;
  private ready: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private buffer: AudioBuffer | null = null;
  private loaded = false;
  private playing = false;
  private rate = 1;
  private keylock = true;
  private pitchShiftSemitones = 0;
  private loop: { start: number; end: number } | null = null;
  private targetPosition: number | null = null;
  private reportedPosition = 0;
  private commandAt = 0;
  private latency = 0;
  private underrunCount = 0;
  private lastTickAt = 0;
  private lastTickPosition = 0;
  private lastLoopWrapAt = 0;
  private options: PcmSourceOptions;

  constructor(ctx: AudioContext, destination: AudioNode, options: PcmSourceOptions = {}) {
    this.ctx = ctx;
    this.destination = destination;
    this.options = options;
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = options.gain ?? 1;
    this.gainNode.connect(destination);
  }

  get hasBuffer(): boolean {
    return this.loaded;
  }

  get output(): GainNode {
    return this.gainNode;
  }

  get positionSamples(): number {
    if (this.fallback) return this.fallback.positionSamples;
    return Math.round(this.positionSeconds() * (this.buffer?.sampleRate ?? this.ctx.sampleRate));
  }

  get isPlaying(): boolean {
    if (this.fallback) return this.fallback.isPlaying;
    return this.playing;
  }

  get latencySeconds(): number {
    if (this.fallback) return this.ctx.baseLatency;
    return this.latency;
  }

  get underruns(): number {
    return this.underrunCount;
  }

  get pitchPreserved(): boolean {
    return this.stretch !== null;
  }

  get pitchShift(): number {
    return this.pitchShiftSemitones;
  }

  setGain(gain: number): void {
    this.gainNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
  }

  private setTarget(seconds: number): void {
    this.targetPosition = Math.max(0, Math.min(seconds, this.durationSeconds()));
    this.commandAt = performance.now();
    this.reportedPosition = this.targetPosition;
  }

  private durationSeconds(): number {
    return this.buffer?.duration ?? 0;
  }

  private positionSeconds(): number {
    if (this.targetPosition !== null && performance.now() - this.commandAt < 140) {
      return this.targetPosition;
    }
    if (this.stretch) {
      const reported = this.stretch.inputTime;
      if (Number.isFinite(reported) && reported >= 0) {
        this.reportedPosition = reported;
        return reported;
      }
    }
    return this.reportedPosition;
  }

  private semitones(): number {
    const base = this.keylock ? 0 : 12 * Math.log2(Math.max(0.01, Math.abs(this.rate)));
    return Math.max(-24, Math.min(24, base + this.pitchShiftSemitones));
  }

  private fallbackEffectiveRate(): number {
    if (this.pitchShiftSemitones === 0) return this.rate;
    return this.rate * Math.pow(2, this.pitchShiftSemitones / 12);
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work, work).catch(() => undefined);
    this.chain = next;
    return next;
  }

  private async ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      try {
        const module = await import("signalsmith-stretch");
        const node = await module.default(this.ctx, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        await node.configure({ blockMs: 8, intervalMs: 2 });
        await node.setUpdateInterval(0.02, (time) => {
          if (!Number.isFinite(time)) return;
          this.reportedPosition = Math.max(0, time);
          if (this.targetPosition !== null && Math.abs(this.reportedPosition - this.targetPosition) < 0.08) {
            this.targetPosition = null;
          }
        });
        node.connect(this.gainNode);
        this.latency = await node.latency();
        this.stretch = node;
      } catch {
        this.fallback = new WorkletPcmSource(this.ctx, this.gainNode);
      }
    })();
    return this.ready;
  }

  async load(buffer: AudioBuffer, position = 0): Promise<void> {
    this.loaded = true;
    this.buffer = buffer;
    this.playing = false;
    this.setTarget(position / buffer.sampleRate);
    await this.ensure();
    this.setTarget(position / buffer.sampleRate);
    if (this.fallback) {
      this.fallback.load(buffer, position);
      this.fallback.setRate(this.fallbackEffectiveRate());
      return;
    }
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    await this.enqueue(async () => {
      const node = this.stretch;
      if (!node) return;
      await node.schedule({ active: false, input: position / buffer.sampleRate, rate: this.rate, semitones: this.semitones() });
      await node.dropBuffers();
      await node.addBuffers([left, right]);
      await this.applyLoop();
    });
  }

  clear(): void {
    this.loaded = false;
    this.playing = false;
    this.buffer = null;
    this.targetPosition = 0;
    this.reportedPosition = 0;
    if (this.fallback) {
      this.fallback.clear();
      return;
    }
    this.enqueue(async () => {
      await this.stretch?.schedule({ active: false, input: 0 });
      await this.stretch?.dropBuffers();
    });
  }

  async play(position?: number): Promise<void> {
    if (!this.loaded) return;
    await this.ensure();
    if (position !== undefined) this.setTarget(position / (this.buffer?.sampleRate ?? this.ctx.sampleRate));
    if (this.fallback) {
      await this.fallback.play(position ?? this.positionSamples);
      return;
    }
    this.playing = true;
    this.setTarget(this.positionSeconds());
    await this.enqueue(async () => {
      const node = this.stretch;
      if (!node) return;
      await node.schedule({
        active: true,
        input: this.targetPosition ?? this.reportedPosition,
        rate: this.rate,
        semitones: this.semitones(),
        output: this.ctx.currentTime,
      });
      await this.applyLoop();
    });
  }

  pause(): void {
    this.playing = false;
    this.setTarget(this.positionSeconds());
    if (this.fallback) {
      this.fallback.pause();
      return;
    }
    this.enqueue(async () => {
      await this.stretch?.schedule({
        active: false,
        input: this.targetPosition ?? this.reportedPosition,
        rate: this.rate,
      });
    });
  }

  seek(position: number): void {
    const seconds = position / (this.buffer?.sampleRate ?? this.ctx.sampleRate);
    this.setTarget(seconds);
    if (this.fallback) {
      this.fallback.seek(position);
      return;
    }
    if (!this.stretch) return;
    this.enqueue(async () => {
      await this.stretch?.schedule({
        active: this.playing,
        input: seconds,
        rate: this.rate,
        semitones: this.semitones(),
      });
      this.applyLoop();
    });
  }

  drive(rate: number, position: number | null, active = true): void {
    this.rate = Math.max(-4, Math.min(4, Number.isFinite(rate) ? rate : 1));
    this.playing = active;
    if (position !== null) this.setTarget(position / (this.buffer?.sampleRate ?? this.ctx.sampleRate));
    if (this.fallback) {
      this.fallback.setRate(this.fallbackEffectiveRate());
      if (active) void this.fallback.play(position ?? this.positionSamples);
      else this.fallback.pause();
      return;
    }
    if (!this.stretch) return;
    const seconds = position === null ? undefined : position / (this.buffer?.sampleRate ?? this.ctx.sampleRate);
    this.enqueue(async () => {
      const node = this.stretch;
      if (!node) return;
      await node.schedule({
        active,
        input: seconds,
        rate: this.rate,
        semitones: this.semitones(),
        output: this.ctx.currentTime + 0.02,
      });
      await this.applyLoop();
    });
  }

  setRate(rate: number): void {
    this.rate = Math.max(-4, Math.min(4, Number.isFinite(rate) ? rate : 1));
    if (this.fallback) {
      this.fallback.setRate(this.fallbackEffectiveRate());
      return;
    }
    if (!this.stretch) return;
    this.setTarget(this.positionSeconds());
    this.enqueue(async () => {
      await this.stretch?.schedule({
        active: this.playing,
        input: this.targetPosition ?? this.reportedPosition,
        rate: this.rate,
        semitones: this.semitones(),
      });
      this.applyLoop();
    });
  }

  setKeylock(enabled: boolean): void {
    this.keylock = enabled;
    this.setRate(this.rate);
  }

  setPitchShift(semitones: number): void {
    const clamped = Number.isFinite(semitones) ? Math.max(-12, Math.min(12, semitones)) : 0;
    this.pitchShiftSemitones = clamped;
    this.setRate(this.rate);
  }

  setLoop(start: number | null, end: number | null): void {
    this.loop = start === null || end === null || end <= start ? null : { start, end };
    if (this.fallback) {
      this.fallback.setLoop(start, end);
      return;
    }
    if (!this.stretch) return;
    this.enqueue(async () => {
      this.applyLoop();
    });
  }

  private async applyLoop(): Promise<void> {
    const node = this.stretch;
    if (!node) return;
    const sampleRate = this.buffer?.sampleRate ?? this.ctx.sampleRate;
    const loop = this.loop;
    await node.schedule({
      loopStart: loop ? loop.start / sampleRate : 0,
      loopEnd: loop ? loop.end / sampleRate : 0,
    });
  }

  tick(): void {
    if (this.fallback) return;
    if (!this.playing || !this.stretch) return;
    const now = performance.now();
    const position = this.positionSeconds();
    const duration = this.durationSeconds();
    if (this.rate >= 0 && duration > 0 && position >= duration - 0.002) {
      this.pause();
      this.options.onEnded?.();
      return;
    }
    if (this.rate < 0 && position <= 0.002) {
      this.pause();
      return;
    }
    if (this.loop && this.rate < 0) {
      const start = this.loop.start / (this.buffer?.sampleRate ?? this.ctx.sampleRate);
      const end = this.loop.end / (this.buffer?.sampleRate ?? this.ctx.sampleRate);
      if (position <= start + 0.003 && now - this.lastLoopWrapAt > 250) {
        this.lastLoopWrapAt = now;
        this.seek(end);
        return;
      }
    }
    if (this.lastTickAt && Math.abs(position - this.lastTickPosition) < 0.0005) {
      if (now - this.lastTickAt > 90) {
        this.underrunCount += 1;
        this.lastTickAt = now;
      }
    } else {
      this.lastTickAt = now;
      this.lastTickPosition = position;
    }
  }

  dispose(): void {
    this.pause();
    this.stretch?.disconnect();
    this.fallback?.dispose();
    this.gainNode.disconnect();
    this.stretch = null;
    this.fallback = null;
    void this.destination;
  }
}

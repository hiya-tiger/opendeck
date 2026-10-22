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

export class PcmSource {
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

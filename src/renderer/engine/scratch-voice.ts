const WORKLET_SOURCE = `
class OpenDeckScratchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = null;
    this.right = null;
    this.position = 0;
    this.rate = 0;
    this.active = false;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data.type === "buffer") {
        this.left = data.left;
        this.right = data.right;
        this.position = data.position;
      } else if (data.type === "start") {
        this.position = data.position;
        this.rate = 0;
        this.active = true;
      } else if (data.type === "rate") {
        this.rate = data.rate;
      } else if (data.type === "stop") {
        this.active = false;
        this.rate = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const leftOut = out[0];
    const rightOut = out[1] || out[0];
    const left = this.left;
    const right = this.right;
    if (!left || !this.active) {
      leftOut.fill(0);
      if (rightOut !== leftOut) rightOut.fill(0);
      return true;
    }
    const step = this.rate;
    if (Math.abs(this.rate) < 0.02) {
      leftOut.fill(0);
      if (rightOut !== leftOut) rightOut.fill(0);
      return true;
    }
    const last = left.length - 2;
    for (let i = 0; i < leftOut.length; i += 1) {
      const pos = this.position;
      if (pos >= 0 && pos <= last) {
        const index = pos | 0;
        const frac = pos - index;
        leftOut[i] = left[index] + (left[index + 1] - left[index]) * frac;
        rightOut[i] = right[index] + (right[index + 1] - right[index]) * frac;
      } else {
        leftOut[i] = 0;
        rightOut[i] = 0;
      }
      this.position += step;
      if (this.position < 0) this.position = 0;
      if (this.position > last) this.position = last;
    }
    return true;
  }
}
registerProcessor("opendeck-scratch", OpenDeckScratchProcessor);
`;

export const MAX_SCRATCH_RATE = 6;

export class ScratchVoice {
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private node: AudioWorkletNode | null = null;
  private ready: Promise<void> | null = null;
  private buffer: AudioBuffer | null = null;
  private active = false;
  private pendingRate = 0;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(destination);
  }

  get hasBuffer(): boolean {
    return Boolean(this.buffer);
  }

  setBuffer(buffer: AudioBuffer): void {
    this.buffer = buffer;
    if (this.node) {
      this.node.port.postMessage({
        type: "buffer",
        left: buffer.getChannelData(0),
        right: buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0),
        position: 0,
      });
    }
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
      const node = new AudioWorkletNode(this.ctx, "opendeck-scratch", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.connect(this.gain);
      this.node = node;
      if (this.buffer) {
        node.port.postMessage({
          type: "buffer",
          left: this.buffer.getChannelData(0),
          right:
            this.buffer.numberOfChannels > 1
              ? this.buffer.getChannelData(1)
              : this.buffer.getChannelData(0),
          position: 0,
        });
      }
    })();
    return this.ready;
  }

  async start(position: number): Promise<void> {
    if (!this.buffer) return;
    try {
      await this.prepare();
    } catch {
      return;
    }
    if (!this.node) return;
    this.active = true;
    this.node.port.postMessage({ type: "start", position });
    this.node.port.postMessage({ type: "rate", rate: this.pendingRate });
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(0, now);
    this.gain.gain.linearRampToValueAtTime(1, now + 0.006);
  }

  setRate(rate: number): void {
    const clamped = Math.max(-MAX_SCRATCH_RATE, Math.min(MAX_SCRATCH_RATE, rate));
    this.pendingRate = clamped;
    if (!this.active || !this.node) return;
    this.node.port.postMessage({ type: "rate", rate: clamped });
  }

  stop(): void {
    this.pendingRate = 0;
    if (!this.active) return;
    this.active = false;
    this.node?.port.postMessage({ type: "stop" });
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(0, now + 0.012);
  }

  dispose(): void {
    this.stop();
    this.node?.disconnect();
    this.gain.disconnect();
    this.node = null;
  }
}


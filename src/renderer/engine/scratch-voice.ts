const WORKLET_SOURCE = `
class OpenDecksScratchProcessor extends AudioWorkletProcessor {
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
      } else if (data.type === "clear") {
        this.active = false;
        this.left = null;
        this.right = null;
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
registerProcessor("opendeck-scratch", OpenDecksScratchProcessor);
`;

const scratchModules = new WeakMap<BaseAudioContext, Promise<void>>();

/**
 * Adds the scratch processor once per context. A deck builds five scratch
 * voices (platter plus one per part), and every repeat registerProcessor threw
 * inside the worklet scope.
 */
function addScratchModule(ctx: BaseAudioContext): Promise<void> {
  let pending = scratchModules.get(ctx);
  if (!pending) {
    pending = (async () => {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
    pending.catch(() => scratchModules.delete(ctx));
    scratchModules.set(ctx, pending);
  }
  return pending;
}

export const MAX_SCRATCH_RATE = 6;

export class ScratchVoice {
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private node: AudioWorkletNode | null = null;
  private ready: Promise<void> | null = null;
  private left: Float32Array | null = null;
  private right: Float32Array | null = null;
  private loaded = false;
  private active = false;
  private pendingRate = 0;
  private startToken = 0;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(destination);
  }

  get hasBuffer(): boolean {
    return this.loaded;
  }

  setBuffer(buffer: AudioBuffer): void {
    const left = buffer.getChannelData(0).slice();
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : left.slice();
    this.left = left;
    this.right = right;
    this.loaded = true;
    this.sendBuffer(0);
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
    this.stop();
    this.left = null;
    this.right = null;
    this.loaded = false;
    this.node?.port.postMessage({ type: "clear" });
  }

  private prepare(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (!this.ctx.audioWorklet) throw new Error("AudioWorklet is not available");
      await addScratchModule(this.ctx);
      const node = new AudioWorkletNode(this.ctx, "opendeck-scratch", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.connect(this.gain);
      this.node = node;
      this.sendBuffer(0);
    })();
    return this.ready;
  }

  async start(position: number): Promise<void> {
    if (!this.loaded) return;
    const token = ++this.startToken;
    try {
      await this.prepare();
    } catch {
      return;
    }
    if (!this.node || token !== this.startToken || !this.loaded) return;
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
    this.startToken += 1;
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


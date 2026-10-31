import type { StretchNode, StretchSchedule } from "signalsmith-stretch";

export const WORKLET_SOURCE = `
class OpenDecksPcmProcessor extends AudioWorkletProcessor {
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
    this.seq = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (typeof data.seq === "number") this.seq = data.seq;
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
        this.port.postMessage({ type: "position", position: this.position, seq: this.seq });
      } else if (data.type === "seek") {
        this.position = data.position;
        this.port.postMessage({ type: "position", position: this.position, seq: this.seq });
      } else if (data.type === "rate") {
        this.rate = data.rate;
      } else if (data.type === "gain") {
        this.gain = data.gain;
      } else if (data.type === "loop") {
        this.loopStart = data.start;
        this.loopEnd = data.end;
      } else if (data.type === "patch") {
        // In-place region update (progressive stems). Copies at most one
        // chunk (~8 s) between render quanta.
        if (this.left && this.right) {
          const start = data.start | 0;
          const n = Math.min(data.left.length, this.left.length - start);
          if (start >= 0 && n > 0) {
            this.left.set(n === data.left.length ? data.left : data.left.subarray(0, n), start);
            this.right.set(n === data.right.length ? data.right : data.right.subarray(0, n), start);
          }
        }
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
      this.port.postMessage({ type: "position", position, seq: this.seq });
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
registerProcessor("opendeck-pcm", OpenDecksPcmProcessor);
`;

export interface PcmSourceOptions {
  gain?: number;
  onEnded?: () => void;
  onPosition?: (samples: number) => void;
}

const pcmModules = new WeakMap<BaseAudioContext, Promise<void>>();

/**
 * Adds the PCM processor module once per context. Every voice used to add its
 * own copy, and each repeat `registerProcessor("opendeck-pcm")` threw inside the
 * worklet scope (the "Uncaught @69 blob:" lines in the smoke log).
 */
function addPcmModule(ctx: BaseAudioContext): Promise<void> {
  let pending = pcmModules.get(ctx);
  if (!pending) {
    pending = (async () => {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
    pending.catch(() => pcmModules.delete(ctx));
    pcmModules.set(ctx, pending);
  }
  return pending;
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
  private frames = 0;
  private positionAt = 0;
  /**
   * Bumped on every command that sets the position. The processor echoes the
   * last one it applied, so a position report already in flight when the main
   * thread seeks cannot drag the playhead back to where it was.
   */
  private seq = 0;

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

  /**
   * The processor reports its position every 16 render quanta (~46 ms at
   * 44.1 kHz). Drawing the waveform straight from that value steps visibly at
   * 60 fps, so extrapolate from the last report at the current rate.
   */
  get positionSamples(): number {
    if (!this.playing || !this.positionAt) return this.position;
    const elapsed = Math.min(0.1, Math.max(0, (performance.now() - this.positionAt) / 1000));
    let next = this.position + elapsed * this.ctx.sampleRate * this.rate;
    const loop = this.loop;
    if (loop && loop.end > loop.start) {
      const length = loop.end - loop.start;
      if (this.rate >= 0 && next >= loop.end) next = loop.start + ((next - loop.start) % length);
      else if (this.rate < 0 && next < loop.start) next = loop.end - ((loop.end - next) % length);
    }
    return Math.max(0, Math.min(next, this.frames > 0 ? this.frames - 1 : next));
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  setGain(gain: number): void {
    this.gainNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
  }

  load(buffer: AudioBuffer, position = 0): void {
    this.frames = buffer.length;
    this.positionAt = 0;
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
      { type: "buffer", left: this.left, right: this.right, position, seq: ++this.seq },
      [this.left.buffer, this.right.buffer],
    );
    this.left = null;
    this.right = null;
  }

  clear(): void {
    this.left = null;
    this.right = null;
    this.frames = 0;
    this.positionAt = 0;
    this.loaded = false;
    this.playing = false;
    this.position = 0;
    this.node?.port.postMessage({ type: "clear" });
  }

  /**
   * Overwrites frames [start, start + left.length) of the loaded buffer
   * without interrupting playback. The arrays are transferred when they own
   * their whole ArrayBuffer, so callers must not reuse them.
   */
  patch(start: number, left: Float32Array, right: Float32Array): void {
    if (!this.loaded) return;
    if (this.left && this.right) {
      // Not handed to the processor yet: patch the pending copy.
      const n = Math.max(0, Math.min(left.length, this.left.length - start));
      if (n > 0) {
        this.left.set(left.subarray(0, n), start);
        this.right.set(right.subarray(0, n), start);
      }
      return;
    }
    if (!this.node) return;
    const own = (a: Float32Array): Float32Array => (a.byteOffset === 0 && a.byteLength === a.buffer.byteLength ? a : a.slice());
    const l = own(left);
    const r = own(right);
    this.node.port.postMessage({ type: "patch", start, left: l, right: r }, [l.buffer as ArrayBuffer, r.buffer as ArrayBuffer]);
  }

  private prepare(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (!this.ctx.audioWorklet) throw new Error("AudioWorklet is not available");
      await addPcmModule(this.ctx);
      const node = new AudioWorkletNode(this.ctx, "opendeck-pcm", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.port.onmessage = (event) => {
        if (event.data?.type === "position") {
          if (typeof event.data.seq === "number" && event.data.seq !== this.seq) return;
          this.position = event.data.position;
          this.positionAt = performance.now();
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
    this.positionAt = performance.now();
    this.node.port.postMessage({ type: "play", position: this.position, seq: ++this.seq });
  }

  pause(): void {
    this.position = this.positionSamples;
    this.playing = false;
    this.node?.port.postMessage({ type: "pause" });
  }

  seek(position: number): void {
    this.position = position;
    this.positionAt = performance.now();
    this.node?.port.postMessage({ type: "seek", position, seq: ++this.seq });
  }

  setRate(rate: number): void {
    this.position = this.positionSamples;
    this.positionAt = performance.now();
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

/** Signalsmith block/interval. See D18: 8 ms blocks measured +4..+11 dB THD+N. */
export const STRETCH_CONFIG = { blockMs: 120, intervalMs: 30, splitComputation: false } as const;

/** Rate within this distance of 1.0 counts as unity and plays bit-transparent. */
const UNITY_EPSILON = 1e-6;

/**
 * Deck PCM transport with two engines behind one interface:
 *
 *  - `direct`: the plain interpolating AudioWorklet. Bit-transparent at 1.0x,
 *    vinyl-style (pitch follows tempo) at any other rate. Used whenever pitch
 *    does not need to be held: unity rate, or key lock off with no key shift.
 *  - `stretch`: Signalsmith Stretch, built lazily the first time key lock at a
 *    non-unity rate or a key shift is asked for.
 *
 * Every track used to play through Signalsmith, configured with 8 ms blocks,
 * even at 1.0x. That measured +4.3 dB THD+N on a 55/110 Hz pair and +9.7 dB on
 * an 80/440/2500 Hz mix (noise louder than the music), against -59/-57 dB for
 * direct playback, and each idle node kept running an FFT every 2 ms.
 */
export class PcmSource {
  private readonly ctx: AudioContext;
  private readonly gainNode: GainNode;
  private readonly destination: AudioNode;
  private readonly direct: WorkletPcmSource;
  private stretch: StretchNode | null = null;
  private stretchFailed = false;
  private stretchLoaded = false;
  private useStretch = false;
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
  private switchToken = 0;
  private options: PcmSourceOptions;

  constructor(ctx: AudioContext, destination: AudioNode, options: PcmSourceOptions = {}) {
    this.ctx = ctx;
    this.destination = destination;
    this.options = options;
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = options.gain ?? 1;
    this.gainNode.connect(destination);
    this.direct = new WorkletPcmSource(ctx, this.gainNode, {
      onEnded: () => {
        if (this.useStretch) return;
        this.playing = false;
        this.options.onEnded?.();
      },
    });
  }

  get hasBuffer(): boolean {
    return this.loaded;
  }

  get output(): GainNode {
    return this.gainNode;
  }

  /** Which engine is rendering right now. */
  get engineMode(): "direct" | "stretch" {
    return this.useStretch ? "stretch" : "direct";
  }

  get positionSamples(): number {
    if (!this.useStretch) return this.direct.positionSamples;
    return Math.round(this.positionSeconds() * this.sampleRate());
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Engine latency of the active path: one render quantum direct, the stretch block otherwise. */
  get latencySeconds(): number {
    if (!this.useStretch) return 128 / this.ctx.sampleRate;
    return this.latency;
  }

  get underruns(): number {
    return this.underrunCount;
  }

  /** True when pitch hold is available (the stretch engine loaded, or can still load). */
  get pitchPreserved(): boolean {
    return !this.stretchFailed;
  }

  get pitchShift(): number {
    return this.pitchShiftSemitones;
  }

  setGain(gain: number): void {
    this.gainNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
  }

  private sampleRate(): number {
    return this.buffer?.sampleRate ?? this.ctx.sampleRate;
  }

  private wantsStretch(): boolean {
    if (this.stretchFailed) return false;
    if (this.pitchShiftSemitones !== 0) return true;
    return this.keylock && Math.abs(this.rate - 1) > UNITY_EPSILON;
  }

  private directRate(): number {
    // Only reached with no key shift, or when the stretch engine failed to load.
    if (this.pitchShiftSemitones === 0) return this.rate;
    return this.rate * Math.pow(2, this.pitchShiftSemitones / 12);
  }

  private setTarget(seconds: number): void {
    const safe = Number.isFinite(seconds) ? seconds : this.reportedPosition;
    this.targetPosition = Math.max(0, Math.min(safe, this.durationSeconds()));
    this.commandAt = performance.now();
    this.reportedPosition = this.targetPosition;
  }

  /**
   * `StretchNode#schedule` merges the object it is given over the previous
   * segment, so an explicitly-undefined `input` overwrites the segment's real
   * input with `undefined` and every later `inputTime` becomes NaN. Drop any
   * non-finite field instead of forwarding it.
   */
  private async scheduleStretch(options: StretchSchedule): Promise<void> {
    const node = this.stretch;
    if (!node) return;
    const safe: StretchSchedule = { ...options };
    if (typeof safe.input !== "number" || !Number.isFinite(safe.input)) delete safe.input;
    if (typeof safe.rate !== "number" || !Number.isFinite(safe.rate)) safe.rate = this.rate;
    if (typeof safe.output !== "number" || !Number.isFinite(safe.output)) delete safe.output;
    await node.schedule(safe);
  }

  private durationSeconds(): number {
    return this.buffer?.duration ?? 0;
  }

  private positionSeconds(): number {
    if (!this.useStretch) return this.direct.positionSamples / this.sampleRate();
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
        await node.configure({ ...STRETCH_CONFIG });
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
        await node.schedule({ active: false, input: 0, rate: 1, semitones: 0, output: this.ctx.currentTime });
      } catch {
        this.stretchFailed = true;
        this.stretch = null;
      }
    })();
    return this.ready;
  }

  /** Gives the current buffer to the stretch node if it does not have it yet. */
  private async ensureStretchBuffer(): Promise<boolean> {
    await this.ensure();
    if (!this.stretch || !this.buffer) return false;
    if (this.stretchLoaded) return true;
    const buffer = this.buffer;
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    await this.enqueue(async () => {
      if (!this.stretch) return;
      await this.scheduleStretch({ active: false, input: 0, rate: this.rate, semitones: this.semitones() });
      await this.stretch.dropBuffers();
      await this.stretch.addBuffers([left, right]);
    });
    // `addBuffers` resolves before the processor applies the buffers; a time
    // map scheduled in the same task is clamped against an empty range.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (this.buffer !== buffer) return false;
    this.stretchLoaded = true;
    return true;
  }

  /**
   * Builds the stretch node ahead of the first tempo change so key lock engages
   * without a cold start. Optional: the direct engine needs no warm-up.
   */
  prewarm(): void {
    if (this.stretchFailed) return;
    void this.ensureStretchBuffer();
  }

  /** Moves playback to whichever engine the current rate, key lock and key shift want. */
  private updateEngine(): void {
    const want = this.wantsStretch();
    if (want === this.useStretch) return;
    const token = ++this.switchToken;
    if (!want) {
      const samples = this.positionSamples;
      this.useStretch = false;
      void this.enqueue(async () => {
        await this.scheduleStretch({ active: false, rate: this.rate });
      });
      this.direct.setRate(this.directRate());
      this.direct.seek(samples);
      // No position argument: play() awaits the worklet, and a seek issued in
      // the meantime must win over the position captured here.
      if (this.playing) void this.direct.play();
      return;
    }
    void (async () => {
      const ok = await this.ensureStretchBuffer();
      if (!ok || token !== this.switchToken || !this.wantsStretch()) {
        if (!ok) this.direct.setRate(this.directRate());
        return;
      }
      const samples = this.direct.positionSamples;
      const seconds = samples / this.sampleRate();
      this.useStretch = true;
      this.setTarget(seconds);
      this.direct.pause();
      await this.enqueue(async () => {
        await this.scheduleStretch({
          active: this.playing,
          input: seconds,
          rate: this.rate,
          semitones: this.semitones(),
          output: this.ctx.currentTime,
        });
        await this.applyLoop();
      });
    })();
  }

  async load(buffer: AudioBuffer, position = 0): Promise<void> {
    this.switchToken += 1;
    this.loaded = true;
    this.buffer = buffer;
    this.stretchLoaded = false;
    this.playing = false;
    this.useStretch = false;
    this.setTarget(position / buffer.sampleRate);
    if (this.stretch) {
      void this.enqueue(async () => {
        await this.scheduleStretch({ active: false, input: 0 });
      });
    }
    this.direct.load(buffer, position);
    this.direct.setRate(this.directRate());
    if (this.loop) this.direct.setLoop(this.loop.start, this.loop.end);
    if (this.wantsStretch()) this.updateEngine();
  }

  /**
   * Updates frames of the loaded buffer in place while it plays (progressive
   * stems). The caller has already written the same frames into the
   * AudioBuffer passed to load(); the direct engine gets the region at once,
   * the stretch engine (key lock / key shift) is resynced from the AudioBuffer
   * at most every few seconds, or on its next load if it is idle.
   */
  patch(start: number, left: Float32Array, right: Float32Array): void {
    if (!this.loaded) return;
    this.direct.patch(start, left, right);
    if (!this.stretchLoaded) return;
    if (!this.useStretch) {
      // Idle stretch engine: reload lazily the next time key lock needs it.
      this.stretchLoaded = false;
      return;
    }
    this.scheduleStretchResync();
  }

  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private lastResyncAt = 0;

  /** Pushes the patched buffer into the stretch node now (end of a progressive load). */
  flushPatches(): void {
    if (this.resyncTimer) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
    if (this.useStretch && this.stretchLoaded) this.resyncStretch();
    else this.stretchLoaded = false;
  }

  private scheduleStretchResync(): void {
    if (this.resyncTimer) return;
    const wait = Math.max(0, 4000 - (performance.now() - this.lastResyncAt));
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      this.resyncStretch();
    }, wait);
  }

  private resyncStretch(): void {
    const buffer = this.buffer;
    if (!buffer || !this.stretch) return;
    this.lastResyncAt = performance.now();
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    void this.enqueue(async () => {
      const node = this.stretch;
      if (!node || this.buffer !== buffer) return;
      // Posted back to back so the processor swaps buffers between two render
      // quanta at worst; the time map (position, rate, loop) is untouched.
      const dropped = node.dropBuffers();
      const added = node.addBuffers([left, right]);
      await Promise.all([dropped, added]);
    });
  }

  clear(): void {
    if (this.resyncTimer) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
    this.switchToken += 1;
    this.loaded = false;
    this.playing = false;
    this.buffer = null;
    this.stretchLoaded = false;
    this.useStretch = false;
    this.targetPosition = 0;
    this.reportedPosition = 0;
    this.direct.clear();
    if (!this.stretch) return;
    void this.enqueue(async () => {
      await this.scheduleStretch({ active: false, input: 0 });
      await this.stretch?.dropBuffers();
    });
  }

  async play(position?: number): Promise<void> {
    if (!this.loaded) return;
    this.playing = true;
    if (!this.useStretch) {
      await this.direct.play(position);
      return;
    }
    if (position !== undefined) this.setTarget(position / this.sampleRate());
    this.setTarget(this.positionSeconds());
    await this.enqueue(async () => {
      if (!this.stretch) return;
      await this.scheduleStretch({
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
    if (!this.useStretch) {
      this.direct.pause();
      return;
    }
    this.setTarget(this.positionSeconds());
    void this.enqueue(async () => {
      await this.scheduleStretch({
        active: false,
        input: this.targetPosition ?? this.reportedPosition,
        rate: this.rate,
      });
    });
  }

  seek(position: number): void {
    const seconds = position / this.sampleRate();
    this.setTarget(seconds);
    this.direct.seek(position);
    if (!this.useStretch || !this.stretch) return;
    void this.enqueue(async () => {
      await this.scheduleStretch({
        active: this.playing,
        input: seconds,
        rate: this.rate,
        semitones: this.semitones(),
      });
      await this.applyLoop();
    });
  }

  drive(rate: number, position: number | null, active = true): void {
    this.rate = Math.max(-4, Math.min(4, Number.isFinite(rate) ? rate : 1));
    const wasPlaying = this.playing;
    this.playing = active;
    if (position !== null) this.setTarget(position / this.sampleRate());
    this.updateEngine();
    if (!this.useStretch) {
      this.direct.setRate(this.directRate());
      if (position !== null) this.direct.seek(position);
      if (active && (!wasPlaying || !this.direct.isPlaying)) void this.direct.play();
      else if (!active) this.direct.pause();
      return;
    }
    if (!this.stretch) return;
    const seconds = position === null ? undefined : position / this.sampleRate();
    void this.enqueue(async () => {
      if (!this.stretch) return;
      await this.scheduleStretch({
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
    this.updateEngine();
    if (!this.useStretch) {
      this.direct.setRate(this.directRate());
      return;
    }
    if (!this.stretch) return;
    this.setTarget(this.positionSeconds());
    void this.enqueue(async () => {
      await this.scheduleStretch({
        active: this.playing,
        input: this.targetPosition ?? this.reportedPosition,
        rate: this.rate,
        semitones: this.semitones(),
      });
      await this.applyLoop();
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
    this.direct.setLoop(start, end);
    if (!this.stretch) return;
    void this.enqueue(async () => {
      await this.applyLoop();
    });
  }

  private async applyLoop(): Promise<void> {
    if (!this.stretch) return;
    const sampleRate = this.sampleRate();
    const loop = this.loop;
    await this.scheduleStretch({
      loopStart: loop ? loop.start / sampleRate : 0,
      loopEnd: loop ? loop.end / sampleRate : 0,
    });
  }

  tick(): void {
    if (!this.useStretch) return;
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
      const start = this.loop.start / this.sampleRate();
      if (position <= start + 0.003 && now - this.lastLoopWrapAt > 250) {
        this.lastLoopWrapAt = now;
        // seek() takes samples: this used to pass seconds and jump to ~0.
        this.seek(this.loop.end);
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
    this.direct.dispose();
    this.gainNode.disconnect();
    this.stretch = null;
    void this.destination;
  }
}
